import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkCandidates,
  loadSavedObservation,
  observeCandidates,
  splitCandidates,
} from "nnanything/browser";
import {
  createStableNodeRefRegistry,
  observeLiveDom,
  readBasicKindTrainingRequest,
  stableNodeRefFor,
} from "nnanything/browser-classify";

// F08 structure: explicit parent refs and nested scope boundaries are facts.
// A wrapper may add a hop to the parent chain, but it does not change which
// ancestor an object belongs to, and absolute depth stays out of student input.

const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

const style = {
  display: "block",
  visibility: "visible",
  position: "static",
  transform: "none",
  translate: "none",
  rotate: "none",
  scale: "none",
  perspective: "none",
  overflowX: "visible",
  overflowY: "visible",
  clipPath: "none",
  clip: "auto",
  opacity: "1",
  zIndex: "auto",
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
  backgroundColor: "rgba(0, 0, 0, 0)",
  backgroundImage: "none",
  backgroundClip: "border-box",
  maskImage: "none",
  webkitMaskImage: "none",
  backdropFilter: "none",
  webkitBackdropFilter: "none",
  filter: "none",
  mixBlendMode: "normal",
  isolation: "auto",
  contain: "none",
  content: "none",
};

function baseElement(tagName, overrides = {}) {
  const rect = overrides.rect ?? { x: 0, y: 0, width: 40, height: 20 };
  const attributes = overrides.attributes ?? {};
  return {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    namespaceURI: XHTML_NAMESPACE,
    parentElement: null,
    children: [],
    childNodes: [],
    childElementCount: 0,
    id: attributes.id ?? "",
    classList: [],
    isConnected: true,
    shadowRoot: null,
    matches: () => false,
    querySelectorAll: () => [],
    getAttribute: name => Object.hasOwn(attributes, name) ? attributes[name] : null,
    hasAttribute: name => Object.hasOwn(attributes, name),
    getBoundingClientRect: () => ({ ...rect }),
    getClientRects: () => [{ ...rect }],
  };
}

function setChildren(parent, children) {
  parent.children = children;
  parent.childNodes = [...children];
  parent.childElementCount = children.length;
  for (const child of children) child.parentElement = parent;
}

function makeDocument(html) {
  return {
    documentElement: html,
    body: html,
    baseURI: "https://fixture.test/page",
    activeElement: null,
    fullscreenElement: null,
    getElementById: () => null,
  };
}

function observeDom(dom, prefix) {
  const registry = createStableNodeRefRegistry(prefix);
  const snapshot = observeLiveDom({
    document: dom.document,
    window: dom.window,
    registry,
    excludeRoot: null,
    snapshotRef: prefix,
    documentRef: "fixture",
  });
  return { registry, snapshot };
}

function nodeMap(snapshot) {
  return new Map(snapshot.observation.nodes.map(node => [node.nodeRef, node]));
}

function parentChain(snapshot, startRef) {
  const byRef = nodeMap(snapshot);
  const chain = [];
  let current = byRef.get(startRef) ?? null;
  while (current !== null) {
    chain.push(current);
    current = current.parentRef === null ? null : byRef.get(current.parentRef) ?? null;
  }
  return chain;
}

function structureDom() {
  const html = baseElement("html", { rect: { x: 0, y: 0, width: 800, height: 600 } });
  const group = baseElement("div", { rect: { x: 10, y: 10, width: 300, height: 200 } });
  const cardA = baseElement("div", { rect: { x: 20, y: 20, width: 140, height: 100 } });
  const leafA = baseElement("span", { rect: { x: 30, y: 30, width: 80, height: 20 } });
  const cardB = baseElement("div", { rect: { x: 170, y: 20, width: 120, height: 100 } });
  setChildren(html, [group]);
  setChildren(group, [cardA, cardB]);
  setChildren(cardA, [leafA]);
  const document = makeDocument(html);
  const window = { innerWidth: 800, innerHeight: 600, getComputedStyle: () => style };
  return { document, window, html, group, cardA, leafA, cardB };
}

test("F08 parent and sibling refs point to direct parents and survive reload", () => {
  const dom = structureDom();
  const { registry, snapshot } = observeDom(dom, "f08-parent");
  const byRef = nodeMap(snapshot);
  const nodeFor = element => byRef.get(stableNodeRefFor(registry, element));

  const htmlNode = nodeFor(dom.html);
  const groupNode = nodeFor(dom.group);
  const cardANode = nodeFor(dom.cardA);
  const leafANode = nodeFor(dom.leafA);
  const cardBNode = nodeFor(dom.cardB);

  assert.equal(groupNode.parentRef, htmlNode.nodeRef);
  assert.equal(cardANode.parentRef, groupNode.nodeRef);
  assert.equal(leafANode.parentRef, cardANode.nodeRef);
  assert.equal(cardBNode.parentRef, groupNode.nodeRef);

  assert.equal(cardANode.parentRef, cardBNode.parentRef);
  assert.notEqual(cardANode.parentRef, cardBNode.nodeRef);
  assert.notEqual(cardBNode.parentRef, cardANode.nodeRef);
  assert.notEqual(cardANode.nodeRef, cardBNode.nodeRef);

  const reloaded = loadSavedObservation(structuredClone(snapshot.observation));
  const reloadedByRef = nodeMap({ observation: reloaded });
  for (const element of [dom.html, dom.group, dom.cardA, dom.leafA, dom.cardB]) {
    const original = nodeFor(element);
    assert.equal(reloadedByRef.get(original.nodeRef).parentRef, original.parentRef);
  }

  const rect = { x: 0, y: 0, width: 10, height: 10 };
  assert.throws(() => loadSavedObservation({
    viewport: { x: 0, y: 0, width: 800, height: 600 },
    nodes: [{ nodeRef: "orphan", parentRef: "missing-parent", tag: "div", rect, fragments: [rect], clippedRect: rect }],
  }), /unknown nodeRef|parentRef/i);

  assert.throws(() => loadSavedObservation({
    viewport: { x: 0, y: 0, width: 800, height: 600 },
    nodes: [
      { nodeRef: "cycle-a", parentRef: "cycle-b", tag: "div", rect, fragments: [rect], clippedRect: rect },
      { nodeRef: "cycle-b", parentRef: "cycle-a", tag: "div", rect, fragments: [rect], clippedRect: rect },
    ],
  }), /cycle/i);
});

function nestedScopeDom() {
  const html = baseElement("html", { rect: { x: 0, y: 0, width: 800, height: 600 } });
  const outer = baseElement("div", { rect: { x: 10, y: 10, width: 300, height: 200 } });
  const inner = baseElement("div", { rect: { x: 20, y: 20, width: 200, height: 160 } });
  const leafA = baseElement("span", { rect: { x: 30, y: 30, width: 80, height: 30 } });
  const leafB = baseElement("span", { rect: { x: 120, y: 30, width: 80, height: 30 } });
  const outerSibling = baseElement("div", { rect: { x: 400, y: 10, width: 100, height: 50 } });
  setChildren(html, [outer, outerSibling]);
  setChildren(outer, [inner]);
  setChildren(inner, [leafA, leafB]);
  const document = makeDocument(html);
  const window = { innerWidth: 800, innerHeight: 600, getComputedStyle: () => style };
  return { document, window, html, outer, inner, leafA, leafB, outerSibling };
}

test("F08 nested scope expands preorder and only explicit subtree exclusion prunes", () => {
  const dom = nestedScopeDom();
  const { registry, snapshot } = observeDom(dom, "f08-scope");
  const ref = element => stableNodeRefFor(registry, element);
  const htmlRef = ref(dom.html);
  const outerRef = ref(dom.outer);
  const innerRef = ref(dom.inner);
  const leafARef = ref(dom.leafA);
  const leafBRef = ref(dom.leafB);
  const siblingRef = ref(dom.outerSibling);

  const split = splitCandidates(observeCandidates({ observation: snapshot.observation }));
  assert.deepEqual(split.candidateRefs, [htmlRef, outerRef, innerRef, leafARef, leafBRef, siblingRef]);

  const byRef = new Map(split.slots.map(slot => [slot.nodeRef, slot]));
  for (const refValue of [outerRef, innerRef, leafARef, leafBRef]) {
    assert.equal(byRef.get(refValue).status, "ok");
  }
  assert.ok(split.slots.findIndex(slot => slot.nodeRef === outerRef) < split.slots.findIndex(slot => slot.nodeRef === innerRef));
  assert.ok(split.slots.findIndex(slot => slot.nodeRef === innerRef) < split.slots.findIndex(slot => slot.nodeRef === leafARef));
  assert.ok(split.slots.findIndex(slot => slot.nodeRef === leafARef) < split.slots.findIndex(slot => slot.nodeRef === leafBRef));
  assert.ok(split.slots.findIndex(slot => slot.nodeRef === leafBRef) < split.slots.findIndex(slot => slot.nodeRef === siblingRef));

  // A self verdict filters the container itself; it does not prune the descendants.
  const deniedOuter = checkCandidates(split, { viewportOnly: true, deny: [{ nodeRef: outerRef }] });
  const deniedByRef = new Map(deniedOuter.slots.map(slot => [slot.nodeRef, slot]));
  assert.equal(deniedByRef.get(outerRef).status, "filtered_out");
  assert.equal(deniedByRef.get(outerRef).reasons[0], "deny_match");
  assert.equal(deniedByRef.get(innerRef).status, "ok");
  assert.equal(deniedByRef.get(leafARef).status, "ok");
  assert.equal(deniedByRef.get(leafBRef).status, "ok");

  // Only excludeSubtrees removes the container and every descendant.
  const excludedOuter = checkCandidates(split, { viewportOnly: true, excludeSubtrees: [{ nodeRef: outerRef }] });
  const excludedByRef = new Map(excludedOuter.slots.map(slot => [slot.nodeRef, slot]));
  for (const refValue of [outerRef, innerRef, leafARef, leafBRef]) {
    assert.equal(excludedByRef.get(refValue).status, "filtered_out");
    assert.equal(excludedByRef.get(refValue).reasons[0], "subtree_excluded");
  }
  assert.equal(excludedByRef.get(siblingRef).status, "ok");
  assert.deepEqual(excludedOuter.candidateRefs, [htmlRef, siblingRef]);
});

function wrapperDom(withWrapper) {
  const html = baseElement("html", { rect: { x: 0, y: 0, width: 800, height: 600 } });
  const group = baseElement("div", { rect: { x: 10, y: 10, width: 300, height: 200 } });
  const card = baseElement("div", { rect: { x: 20, y: 20, width: 140, height: 100 } });
  const leaf = baseElement("span", { rect: { x: 30, y: 30, width: 80, height: 20 } });
  const wrapper = withWrapper
    ? baseElement("div", { rect: { x: 10, y: 10, width: 300, height: 200 } })
    : null;
  setChildren(html, [group]);
  if (wrapper === null) {
    setChildren(group, [card]);
  } else {
    setChildren(group, [wrapper]);
    setChildren(wrapper, [card]);
  }
  setChildren(card, [leaf]);
  const document = makeDocument(html);
  const window = { innerWidth: 800, innerHeight: 600, getComputedStyle: () => style };
  return { document, window, html, group, card, leaf, wrapper };
}

test("F08 a nonsemantic wrapper preserves the ancestor chain and depth stays out of student features", () => {
  const plainDom = wrapperDom(false);
  const plain = observeDom(plainDom, "f08-plain");
  const plainLeafRef = stableNodeRefFor(plain.registry, plainDom.leaf);
  const plainChain = parentChain(plain.snapshot, plainLeafRef);
  assert.equal(plainChain[1].nodeRef, stableNodeRefFor(plain.registry, plainDom.card));
  assert.equal(plainChain[2].nodeRef, stableNodeRefFor(plain.registry, plainDom.group));
  assert.equal(plainChain[3].nodeRef, stableNodeRefFor(plain.registry, plainDom.html));
  assert.equal(plain.snapshot.resolveElement(plainChain[2].nodeRef), plainDom.group);

  const wrappedDom = wrapperDom(true);
  const wrapped = observeDom(wrappedDom, "f08-wrapped");
  const wrappedLeafRef = stableNodeRefFor(wrapped.registry, wrappedDom.leaf);
  const wrappedChain = parentChain(wrapped.snapshot, wrappedLeafRef);
  assert.equal(wrappedChain[1].nodeRef, stableNodeRefFor(wrapped.registry, wrappedDom.card));
  assert.equal(wrappedChain[2].nodeRef, stableNodeRefFor(wrapped.registry, wrappedDom.wrapper));
  assert.equal(wrappedChain[3].nodeRef, stableNodeRefFor(wrapped.registry, wrappedDom.group));
  assert.equal(wrappedChain[4].nodeRef, stableNodeRefFor(wrapped.registry, wrappedDom.html));

  const wrapperNode = wrapped.snapshot.observation.nodes.find(node => node.nodeRef === stableNodeRefFor(wrapped.registry, wrappedDom.wrapper));
  assert.equal(wrapperNode.tag, "div");
  assert.equal(wrapperNode.role, null);
  assert.equal(wrapperNode.attributes["aria-label"], undefined);
  assert.equal(wrapped.snapshot.evidence.get(wrapperNode.nodeRef).textSummary, null);

  // The leaf still points at the same direct parent. Only the ancestor path above
  // the card gains one wrapper hop; the group and root remain reachable.
  assert.equal(wrapped.snapshot.resolveElement(wrappedChain[1].nodeRef), wrappedDom.card);
  assert.equal(wrapped.snapshot.resolveElement(wrappedChain[3].nodeRef), wrappedDom.group);
  assert.equal(wrapped.snapshot.resolveElement(wrappedChain[4].nodeRef), wrappedDom.html);
  assert.notEqual(wrappedChain.length, plainChain.length);
  assert.equal(wrappedChain.length, plainChain.length + 1);

  const trainingRequest = {
    schemaVersion: 1,
    taskId: "dom.basic-kinds.v1",
    rows: [{
      sampleId: "f08-wrapper-depth",
      inputRef: { snapshotRef: "f08-wrapped", documentRef: "fixture", frameRef: "top", nodeRef: wrappedLeafRef, index: 0 },
      provenanceRef: "f08-evidence",
      sourceAssociations: { snapshotRefs: ["f08-wrapped"], postRefs: [], assetRefs: [] },
      candidateQualification: { status: "ok", reasons: [] },
      captureCoverage: { frameContent: "captured", directChildren: "complete" },
      properties: { tag: "span", role: null, childElementCount: 0, positiveAreaChildCount: 0 },
      proposal: { ruleRef: "rule-text", label: "text", status: "matched" },
      review: { status: "verified", expectedLabel: "text", reviewerRef: "reviewer-f08", evidenceRef: "f08-evidence", otherReason: null },
    }],
  };
  const parsed = readBasicKindTrainingRequest(trainingRequest);
  const studentProperties = parsed.rows[0].properties;
  assert.equal("depth" in studentProperties, false);
  assert.equal("absoluteDepth" in studentProperties, false);

  const leakyRequest = structuredClone(trainingRequest);
  leakyRequest.rows[0].properties.depth = 3;
  assert.throws(() => readBasicKindTrainingRequest(leakyRequest), /unsupported.*field/i);
});
