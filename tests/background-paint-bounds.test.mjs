import assert from "node:assert/strict";
import { test } from "node:test";
import { observeLiveDom, createStableNodeRefRegistry, stableNodeRefFor } from "nnanything/browser-classify";
import * as geometry from "../dist/adapters/browser/paint-surface.js";

const style = {
  display: "block", position: "absolute", visibility: "visible", opacity: "1", width: "16px",
  transform: "none", translate: "none", rotate: "none", scale: "none", perspective: "none",
  overflowX: "visible", overflowY: "visible", clip: "auto", clipPath: "none", contain: "none",
  zIndex: "auto", pointerEvents: "auto", cursor: "auto", isolation: "auto", mixBlendMode: "normal",
  backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: 'url("https://fixture.test/image.png")',
  backgroundSize: "100% auto", backgroundPositionX: "-666px", backgroundRepeat: "no-repeat",
  backgroundOrigin: "padding-box", backgroundClip: "border-box", backgroundAttachment: "scroll",
  maskImage: "none", webkitMaskImage: "none", filter: "none", backdropFilter: "none", webkitBackdropFilter: "none",
  boxShadow: "none", outlineStyle: "none", outlineWidth: "0px", outlineColor: "rgba(0, 0, 0, 0)",
  borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: "0px", borderLeftWidth: "0px",
  borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none",
  borderTopColor: "rgba(0, 0, 0, 0)", borderRightColor: "rgba(0, 0, 0, 0)",
  borderBottomColor: "rgba(0, 0, 0, 0)", borderLeftColor: "rgba(0, 0, 0, 0)",
  paddingTop: "0px", paddingRight: "0px", paddingBottom: "0px", paddingLeft: "0px",
  borderTopLeftRadius: "0px", borderTopRightRadius: "0px", borderBottomLeftRadius: "0px", borderBottomRightRadius: "0px",
};

function scene(overrides = {}, { text = false, pseudo = false, namespace = "http://www.w3.org/1999/xhtml", fragments = 1 } = {}) {
  const viewport = { x: 0, y: 0, width: 300, height: 300 };
  const rect = { x: 100, y: 100, width: Number.parseFloat(overrides.width ?? style.width), height: 16 };
  function element(tag, box, parent, elementNamespace = "http://www.w3.org/1999/xhtml") {
    return {
      nodeType: 1, tagName: tag, namespaceURI: elementNamespace, parentElement: parent,
      children: [], childNodes: [], childElementCount: 0, id: "", classList: [], isConnected: true,
      getAttribute: () => null, hasAttribute: () => false, querySelectorAll: () => [],
      getBoundingClientRect: () => ({ ...box }), getClientRects: () => [{ ...box }],
    };
  }
  const html = element("HTML", viewport, null);
  const target = element("SVG", rect, html, "http://www.w3.org/2000/svg");
  const overlay = element("SPAN", rect, html, namespace);
  overlay.getClientRects = () => Array.from({ length: fragments }, () => ({ ...rect }));
  if (text) overlay.childNodes = [{ nodeType: 3, textContent: "visible text" }];
  html.children = [target, overlay]; html.childNodes = [target, overlay]; html.childElementCount = 2;
  const registry = createStableNodeRefRegistry("background-bounds");
  const snapshot = observeLiveDom({
    document: { documentElement: html, baseURI: "https://fixture.test/", elementsFromPoint: (x, y) =>
      [overlay, target, html].filter(e => { const r = e.getBoundingClientRect(); return x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height; }) },
    window: { innerWidth: 300, innerHeight: 300, getComputedStyle: (e, p) => p
      ? { content: e === overlay && pseudo ? '"glyph"' : "none" }
      : { ...style, backgroundImage: "none", position: "static", ...(e === overlay ? { backgroundImage: style.backgroundImage, position: "absolute", ...overrides } : {}) } },
    registry, excludeRoot: null, snapshotRef: "background-bounds", documentRef: "fixture",
  });
  return {
    target: snapshot.observation.nodes.find(n => n.nodeRef === stableNodeRefFor(registry, target)),
    overlayProperties: snapshot.properties.get(stableNodeRefFor(registry, overlay)),
  };
}

test("off-box nonrepeating background image leaves the underlying SVG visible", () => {
  for (const width of ["16px", "18px"]) {
    const result = scene({ width });
    assert.equal(result.target.foreground, "visible");
    assert.ok(result.target.exposedRects.length > 0);
    assert.equal(result.overlayProperties.backgroundImagePresent, true);
  }
});

test("overlapping, repeating or unmeasured backgrounds are not declared unpainted", () => {
  for (const overrides of [
    { backgroundPositionX: "0px" }, { backgroundRepeat: "repeat-x" }, { width: undefined },
    { backgroundSize: undefined }, { borderTopWidth: undefined }, { paddingLeft: undefined },
    { backgroundAttachment: undefined }, { backgroundImage: 'url("a"), url("b")' },
    { width: "16.4px", backgroundPositionX: "-16px" },
  ]) assert.equal(scene(overrides).target.foreground, "unassessed", JSON.stringify(overrides));
  assert.equal(scene({}, { namespace: "http://www.w3.org/2000/svg" }).target.foreground, "unassessed");
  assert.equal(scene({}, { fragments: 2 }).target.foreground, "unassessed");
});

test("excluding an off-box background does not remove other paint", () => {
  assert.equal(scene({ backgroundColor: "rgb(20, 20, 20)" }).target.foreground, "occluded");
  assert.equal(scene({}, { text: true }).target.foreground, "unassessed");
  assert.equal(scene({}, { pseudo: true }).target.foreground, "unassessed");
  assert.equal(scene({ maskImage: 'url("mask")' }).target.foreground, "unassessed");
});

test("background no-paint proof uses exact CSS width and requires every fact", () => {
  const prove = geometry.backgroundImageOutsideBox;
  assert.equal(typeof prove, "function");
  assert.equal(prove(style, true), true);
  assert.equal(prove(style, false), false);
  assert.equal(prove({ ...style, width: "16.4px", backgroundPositionX: "-16px" }, true), false);
  for (const x of ["-16px", "16px"]) assert.equal(prove({ ...style, backgroundPositionX: x }, true), true);
  for (const key of ["width", "backgroundImage", "backgroundSize", "backgroundPositionX", "backgroundRepeat", "backgroundOrigin", "backgroundClip", "backgroundAttachment", "borderTopWidth", "paddingBottom"]) {
    assert.equal(prove({ ...style, [key]: undefined }, true), false, key);
  }
  assert.equal(prove({ ...style, paddingBottom: "50%" }, true), false);
});
