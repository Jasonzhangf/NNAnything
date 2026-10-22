import assert from "node:assert/strict";
import { test } from "node:test";
import { createStableNodeRefRegistry, observeLiveDom, stableNodeRefFor } from "nnanything/browser-classify";

// F05 live observation: self-state attributes are captured as neutral facts,
// known-false for the element kinds that own them, absent (unobserved) otherwise.

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
  return {
    nodeType: 1,
    tagName,
    parentElement: null,
    children: [],
    childNodes: [],
    childElementCount: 0,
    id: "",
    classList: [],
    matches: () => false,
    querySelectorAll: () => [],
    getAttribute: () => null,
    hasAttribute: () => false,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 40, height: 20 }),
    getClientRects: () => [{ x: 0, y: 0, width: 40, height: 20 }],
    ...overrides,
  };
}

function stateDom() {
  const html = baseElement("HTML");
  const checkbox = baseElement("INPUT", {
    type: "checkbox",
    checked: true,
    parentElement: html,
    getAttribute: name => name === "aria-checked" ? "true" : null,
  });
  const readonlyInput = baseElement("INPUT", {
    type: "text",
    parentElement: html,
    hasAttribute: name => name === "readonly",
    getAttribute: name => name === "readonly" ? "" : name === "aria-readonly" ? "true" : null,
  });
  const details = baseElement("DETAILS", {
    parentElement: html,
    hasAttribute: name => name === "open",
    getAttribute: name => name === "open" ? "" : null,
  });
  const option = baseElement("OPTION", {
    parentElement: html,
    selected: true,
    hasAttribute: name => name === "selected",
    getAttribute: name => name === "selected" ? "" : null,
  });
  const plainInput = baseElement("INPUT", { type: "text", parentElement: html });
  html.children = [checkbox, readonlyInput, details, option, plainInput];
  html.childNodes = html.children;
  html.childElementCount = html.children.length;
  const document = { documentElement: html, body: html, baseURI: "https://fixture.test/page", activeElement: null };
  const window = { innerWidth: 800, innerHeight: 600, getComputedStyle: () => style };
  return { document, window, html, checkbox, readonlyInput, details, option, plainInput };
}

test("live observation captures self-state booleans only where the state exists", () => {
  const dom = stateDom();
  const registry = createStableNodeRefRegistry("f05-state");
  const snapshot = observeLiveDom({ document: dom.document, window: dom.window, registry, excludeRoot: null, snapshotRef: "f05-state", documentRef: "fixture" });
  const byRef = new Map(snapshot.observation.nodes.map(node => [node.nodeRef, node]));
  const ref = element => stableNodeRefFor(registry, element);

  const checkboxNode = byRef.get(ref(dom.checkbox));
  assert.equal(checkboxNode.attributes.checked, true);
  assert.equal(checkboxNode.attributes["aria-checked"], "true");

  const readonlyNode = byRef.get(ref(dom.readonlyInput));
  assert.equal(readonlyNode.attributes.readonly, true);

  const detailsNode = byRef.get(ref(dom.details));
  assert.equal(detailsNode.attributes.open, true);

  const optionNode = byRef.get(ref(dom.option));
  assert.equal(optionNode.attributes.selected, true);

  const plainNode = byRef.get(ref(dom.plainInput));
  // A text input owns the readonly state: absent means known false, not unobserved.
  assert.equal(plainNode.attributes.readonly, false);
  // checked/open/selected do not exist for a plain text input.
  assert.equal(Object.hasOwn(plainNode.attributes, "checked"), false);
  assert.equal(Object.hasOwn(plainNode.attributes, "open"), false);
  assert.equal(Object.hasOwn(plainNode.attributes, "selected"), false);
});

test("aria-readonly alone does not claim native readonly; a disagreement is an explicit conflict", () => {
  const html = baseElement("HTML");
  const onlyAria = baseElement("INPUT", {
    type: "text", parentElement: html,
    getAttribute: name => name === "aria-readonly" ? "true" : null,
  });
  const native = baseElement("INPUT", {
    type: "text", parentElement: html,
    hasAttribute: name => name === "readonly",
    getAttribute: name => name === "readonly" ? "" : null,
  });
  const both = baseElement("INPUT", {
    type: "text", parentElement: html,
    hasAttribute: name => name === "readonly",
    getAttribute: name => name === "readonly" ? "" : name === "aria-readonly" ? "true" : null,
  });
  for (const node of [onlyAria, native, both]) node.parentElement = html;
  html.children = [onlyAria, native, both];
  html.childNodes = html.children;
  html.childElementCount = 3;
  const document = { documentElement: html, body: html, baseURI: "https://fixture.test/readonly", activeElement: null };
  const window = { innerWidth: 800, innerHeight: 600, getComputedStyle: () => style };
  const registry = createStableNodeRefRegistry("f05-readonly");
  const snapshot = observeLiveDom({ document, window, registry, excludeRoot: null, snapshotRef: "f05-readonly", documentRef: "fixture" });
  const evidence = snapshot.evidence;
  const ref = element => stableNodeRefFor(registry, element);

  // Only aria-readonly: the native input is editable, so this is a conflict,
  // never a certain readonly claim.
  const only = evidence.get(ref(onlyAria));
  assert.equal(only.readonlyState, "conflict");
  const nativeNode = evidence.get(ref(native));
  assert.equal(nativeNode.readonlyState, "readonly");
  const bothNode = evidence.get(ref(both));
  assert.equal(bothNode.readonlyState, "readonly");
});

test("selected reports the live choice, and the default declaration stays separate", () => {
  const html = baseElement("HTML");
  const liveOption = baseElement("OPTION", {
    parentElement: html,
    selected: false, // user changed the selection away from the declared default
    hasAttribute: name => name === "selected",
    getAttribute: name => name === "selected" ? "" : null,
  });
  const defaultOption = baseElement("OPTION", {
    parentElement: html,
    selected: true,
    hasAttribute: name => name === "selected",
    getAttribute: name => name === "selected" ? "" : null,
  });
  for (const node of [liveOption, defaultOption]) node.parentElement = html;
  html.children = [liveOption, defaultOption];
  html.childNodes = html.children;
  html.childElementCount = 2;
  const document = { documentElement: html, body: html, baseURI: "https://fixture.test/select", activeElement: null };
  const window = { innerWidth: 800, innerHeight: 600, getComputedStyle: () => style };
  const registry = createStableNodeRefRegistry("f05-select");
  const snapshot = observeLiveDom({ document, window, registry, excludeRoot: null, snapshotRef: "f05-select", documentRef: "fixture" });
  const evidence = snapshot.evidence;
  const ref = element => stableNodeRefFor(registry, element);
  const byNode = (snap, nodeRef) => snap.observation.nodes.find(node => node.nodeRef === nodeRef);

  // The live property says false while the default attribute says true.
  const live = evidence.get(ref(liveOption));
  assert.equal(live.selectedDeclaration, true);
  const liveNode = byNode(snapshot, ref(liveOption));
  assert.equal(liveNode.attributes.selected, false);
  const chosen = evidence.get(ref(defaultOption));
  assert.equal(chosen.selectedDeclaration, true);
  const chosenNode = byNode(snapshot, ref(defaultOption));
  assert.equal(chosenNode.attributes.selected, true);
});