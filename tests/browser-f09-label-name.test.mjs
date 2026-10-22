import assert from "node:assert/strict";
import { test } from "node:test";
import { createStableNodeRefRegistry, observeLiveDom, stableNodeRefFor } from "nnanything/browser-classify";

// F09 label/caption/accessible-name: the accessible name is a separate value
// from visible text, binds by node reference (never by matching wording), and
// an unresolvable label reference stays explicitly unknown.

const style = {
  display: "block", visibility: "visible", position: "static", transform: "none", translate: "none",
  rotate: "none", scale: "none", perspective: "none", overflowX: "visible", overflowY: "visible",
  clipPath: "none", clip: "auto", opacity: "1", zIndex: "auto", pointerEvents: "auto", cursor: "auto",
  borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: "0px", borderLeftWidth: "0px",
  borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none",
  borderTopColor: "rgba(0, 0, 0, 0)", borderRightColor: "rgba(0, 0, 0, 0)", borderBottomColor: "rgba(0, 0, 0, 0)",
  borderLeftColor: "rgba(0, 0, 0, 0)", borderTopLeftRadius: "0px", borderTopRightRadius: "0px",
  borderBottomLeftRadius: "0px", borderBottomRightRadius: "0px", backgroundColor: "rgba(0, 0, 0, 0)",
  backgroundImage: "none", backgroundClip: "border-box", maskImage: "none", webkitMaskImage: "none",
  backdropFilter: "none", webkitBackdropFilter: "none", filter: "none", mixBlendMode: "normal",
  isolation: "auto", contain: "none", content: "none",
};

function element(tagName, attrs = {}, overrides = {}) {
  return {
    nodeType: 1, tagName, parentElement: null, children: [], childNodes: [], childElementCount: 0,
    id: attrs.id ?? "", classList: [], matches: () => false, querySelectorAll: () => [],
    getAttribute: name => attrs[name] ?? null, hasAttribute: name => Object.hasOwn(attrs, name),
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 40, height: 20 }),
    getClientRects: () => [{ x: 0, y: 0, width: 40, height: 20 }],
    ...overrides,
  };
}

function labelDom() {
  const html = element("HTML");
  const byId = new Map();

  // Visible caption element that says "删除".
  const captionA = element("SPAN", { id: "cap-a" }, { childNodes: [{ nodeType: 3, textContent: "删除" }] });
  // A second, unrelated element with identical wording.
  const captionB = element("SPAN", { id: "cap-b" }, { childNodes: [{ nodeType: 3, textContent: "删除" }] });
  // Button whose aria-labelledby points at captionA, not at captionB.
  const button = element("BUTTON", { "aria-labelledby": "cap-a" });
  // Button with a visible caption and a different aria-label.
  const captioned = element("BUTTON", { "aria-label": "确认下单" }, { childNodes: [{ nodeType: 3, textContent: "提交" }] });
  // Button whose label reference does not resolve.
  const brokenRef = element("BUTTON", { "aria-labelledby": "missing-id" });
  // Adjacent text that must not become a label.
  const plainButton = element("BUTTON", {}, { childNodes: [{ nodeType: 3, textContent: "普通按钮" }] });
  const adjacentText = element("SPAN", { id: "adjacent" }, { childNodes: [{ nodeType: 3, textContent: "相邻文字" }] });

  for (const node of [captionA, captionB, button, captioned, brokenRef, plainButton, adjacentText]) {
    node.parentElement = html;
    if (node.id) byId.set(node.id, node);
  }
  html.children = [captionA, captionB, button, captioned, brokenRef, plainButton, adjacentText];
  html.childNodes = html.children;
  html.childElementCount = html.children.length;
  const document = {
    documentElement: html, body: html, baseURI: "https://fixture.test/page", activeElement: null,
    getElementById: id => byId.get(id) ?? null,
  };
  const window = { innerWidth: 800, innerHeight: 600, getComputedStyle: () => style };
  return { document, window, html, captionA, captionB, button, captioned, brokenRef, plainButton, adjacentText };
}

function observe(dom) {
  const registry = createStableNodeRefRegistry("f09-label");
  const snapshot = observeLiveDom({ document: dom.document, window: dom.window, registry, excludeRoot: null, snapshotRef: "f09-label", documentRef: "fixture" });
  const refOf = element => stableNodeRefFor(registry, element);
  return { snapshot, refOf };
}

test("aria-labelledby binds by node reference, not by matching wording", () => {
  const dom = labelDom();
  const { snapshot, refOf } = observe(dom);
  const button = snapshot.evidence.get(refOf(dom.button));
  assert.equal(button.accessibleNameSource, "aria-labelledby");
  assert.deepEqual(button.labelledByRefs, [refOf(dom.captionA)]);
  assert.equal(button.labelledByUnresolved, false);
  // The button resolved to caption A's wording, not to the identical caption B.
  assert.notDeepEqual(button.labelledByRefs, [refOf(dom.captionB)]);
  assert.equal(button.accessibleName, "删除");
});

test("visible caption stays separate from a differing aria-label", () => {
  const dom = labelDom();
  const { snapshot, refOf } = observe(dom);
  const captioned = snapshot.evidence.get(refOf(dom.captioned));
  assert.equal(captioned.accessibleName, "确认下单");
  assert.equal(captioned.accessibleNameSource, "aria-label");
  // The display text remains its own field and is not overwritten by the name.
  assert.equal(captioned.textSummary, "提交");
});

test("adjacent text never becomes a label on its own", () => {
  const dom = labelDom();
  const { snapshot, refOf } = observe(dom);
  const plain = snapshot.evidence.get(refOf(dom.plainButton));
  assert.equal(plain.accessibleName, null);
  assert.equal(plain.accessibleNameSource, null);
  assert.deepEqual(plain.labelledByRefs, []);
  const adjacent = snapshot.evidence.get(refOf(dom.adjacentText));
  assert.equal(adjacent.accessibleName, null);
});

test("an unresolvable label reference stays explicitly unknown", () => {
  const dom = labelDom();
  const { snapshot, refOf } = observe(dom);
  const broken = snapshot.evidence.get(refOf(dom.brokenRef));
  assert.equal(broken.accessibleNameSource, "aria-labelledby");
  assert.equal(broken.labelledByUnresolved, true);
  assert.deepEqual(broken.labelledByRefs, []);
  assert.equal(broken.accessibleName, null);
});

test("a forward labelledby reference resolves because binding happens after traversal", () => {
  const html = element("HTML");
  const byId = new Map();
  const label = element("SPAN", { id: "forward-label" }, { childNodes: [{ nodeType: 3, textContent: "前向标签" }] });
  const button = element("BUTTON", { "aria-labelledby": "forward-label" });
  // The label is declared after the button in document order and visited second.
  for (const node of [button, label]) { node.parentElement = html; byId.set(node.id, node); }
  html.children = [button, label]; html.childNodes = html.children; html.childElementCount = 2;
  const document = { documentElement: html, body: html, baseURI: "https://fixture.test/forward", activeElement: null, getElementById: id => byId.get(id) ?? null };
  const window = { innerWidth: 800, innerHeight: 600, getComputedStyle: () => style };
  const registry = createStableNodeRefRegistry("f09-forward");
  const snapshot = observeLiveDom({ document, window, registry, excludeRoot: null, snapshotRef: "f09-forward", documentRef: "forward" });
  const evidence = snapshot.evidence.get(stableNodeRefFor(registry, button));
  assert.equal(evidence.accessibleNameSource, "aria-labelledby");
  assert.deepEqual(evidence.labelledByRefs, [stableNodeRefFor(registry, label)]);
  assert.equal(evidence.labelledByUnresolved, false);
  assert.equal(evidence.accessibleName, "前向标签");
  assert.equal(evidence.accessibleNameCoverage, "complete");
});

test("two labels in mixed order both bind and join in document order", () => {
  const html = element("HTML");
  const byId = new Map();
  const first = element("SPAN", { id: "mix-b" }, { childNodes: [{ nodeType: 3, textContent: "B标签" }] });
  const button = element("BUTTON", { "aria-labelledby": "mix-a mix-b" });
  const second = element("SPAN", { id: "mix-a" }, { childNodes: [{ nodeType: 3, textContent: "A标签" }] });
  for (const node of [first, button, second]) { node.parentElement = html; byId.set(node.id, node); }
  html.children = [first, button, second]; html.childNodes = html.children; html.childElementCount = 3;
  const document = { documentElement: html, body: html, baseURI: "https://fixture.test/mixed", activeElement: null, getElementById: id => byId.get(id) ?? null };
  const window = { innerWidth: 800, innerHeight: 600, getComputedStyle: () => style };
  const registry = createStableNodeRefRegistry("f09-mixed");
  const snapshot = observeLiveDom({ document, window, registry, excludeRoot: null, snapshotRef: "f09-mixed", documentRef: "mixed" });
  const evidence = snapshot.evidence.get(stableNodeRefFor(registry, button));
  assert.equal(evidence.labelledByUnresolved, false);
  // The tokens are joined in the order the attribute lists them, not document order.
  assert.equal(evidence.accessibleName, "A标签 B标签");
});

test("a label longer than the supported name limit reports truncation, not a summary", () => {
  const html = element("HTML");
  const byId = new Map();
  const long = "很长的标签文字".repeat(300); // 1800 characters, over the 1024 limit
  const label = element("SPAN", { id: "long-label" }, { childNodes: [{ nodeType: 3, textContent: long }] });
  const button = element("BUTTON", { "aria-labelledby": "long-label" });
  for (const node of [label, button]) { node.parentElement = html; byId.set(node.id, node); }
  html.children = [label, button]; html.childNodes = html.children; html.childElementCount = 2;
  const document = { documentElement: html, body: html, baseURI: "https://fixture.test/long", activeElement: null, getElementById: id => byId.get(id) ?? null };
  const window = { innerWidth: 800, innerHeight: 600, getComputedStyle: () => style };
  const registry = createStableNodeRefRegistry("f09-long");
  const snapshot = observeLiveDom({ document, window, registry, excludeRoot: null, snapshotRef: "f09-long", documentRef: "long" });
  const evidence = snapshot.evidence.get(stableNodeRefFor(registry, button));
  assert.equal(evidence.accessibleNameCoverage, "truncated");
  assert.ok((evidence.accessibleName?.length ?? 0) <= 1024);
  // The display summary is still capped at 180 and never passed off as the name.
  assert.ok((evidence.textSummary?.length ?? 0) <= 180);
});