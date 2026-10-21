import assert from "node:assert/strict";
import { test } from "node:test";
import { createStableNodeRefRegistry, observeLiveDom, stableNodeRefFor } from "nnanything/browser-classify";

// F07 basic content reads: input value, placeholder, and media source references
// are observed as neutral evidence; empty is distinct from unobserved.

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

function baseElement(tagName, overrides = {}) {
  return {
    nodeType: 1, tagName, parentElement: null, children: [], childNodes: [], childElementCount: 0,
    id: "", classList: [], matches: () => false, querySelectorAll: () => [],
    getAttribute: () => null, hasAttribute: () => false,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 40, height: 20 }),
    getClientRects: () => [{ x: 0, y: 0, width: 40, height: 20 }],
    ...overrides,
  };
}

function contentDom() {
  const html = baseElement("HTML");
  const searchInput = baseElement("INPUT", {
    type: "text", value: "城市散步", parentElement: html,
    getAttribute: name => name === "placeholder" ? "搜索你感兴趣的内容" : null,
  });
  const emptyInput = baseElement("INPUT", {
    type: "text", value: "", parentElement: html,
    getAttribute: name => name === "placeholder" ? "请输入" : null,
  });
  const video = baseElement("VIDEO", {
    parentElement: html, currentSrc: "https://cdn.test/v.mp4",
    getAttribute: () => null,
  });
  const audio = baseElement("AUDIO", {
    parentElement: html, currentSrc: "",
    getAttribute: name => name === "src" ? "https://cdn.test/a.ogg" : null,
  });
  const plainDiv = baseElement("DIV", { parentElement: html });
  html.children = [searchInput, emptyInput, video, audio, plainDiv];
  html.childNodes = html.children;
  html.childElementCount = html.children.length;
  const document = { documentElement: html, body: html, baseURI: "https://fixture.test/page", activeElement: null };
  const window = { innerWidth: 800, innerHeight: 600, getComputedStyle: () => style };
  return { document, window, html, searchInput, emptyInput, video, audio, plainDiv };
}

test("content evidence separates value from placeholder and empty from unobserved", () => {
  const dom = contentDom();
  const registry = createStableNodeRefRegistry("f07-content");
  const snapshot = observeLiveDom({ document: dom.document, window: dom.window, registry, excludeRoot: null, snapshotRef: "f07-content", documentRef: "fixture" });
  const evidence = snapshot.evidence;
  const ref = element => stableNodeRefFor(registry, element);

  const search = evidence.get(ref(dom.searchInput));
  assert.equal(search.inputValue, "城市散步");
  assert.equal(search.placeholder, "搜索你感兴趣的内容");

  const empty = evidence.get(ref(dom.emptyInput));
  assert.equal(empty.inputValue, "");
  assert.equal(empty.placeholder, "请输入");

  const video = evidence.get(ref(dom.video));
  assert.equal(video.mediaType, "video");
  assert.equal(video.mediaSrc, "https://cdn.test/v.mp4");

  const audio = evidence.get(ref(dom.audio));
  assert.equal(audio.mediaType, "audio");
  assert.equal(audio.mediaSrc, "https://cdn.test/a.ogg");

  const plain = evidence.get(ref(dom.plainDiv));
  assert.equal(plain.inputValue, null);
  assert.equal(plain.placeholder, null);
  assert.equal(plain.mediaSrc, null);
  assert.equal(plain.mediaType, null);
});