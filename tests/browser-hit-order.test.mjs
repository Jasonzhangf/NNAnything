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

const viewport = { x: 0, y: 0, width: 1400, height: 1878 };
const baseStyle = {
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
  mixBlendMode: "normal",
  isolation: "auto",
  contain: "none",
  pointerEvents: "auto",
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  borderTopLeftRadius: "0px",
  borderTopRightRadius: "0px",
  borderBottomLeftRadius: "0px",
  borderBottomRightRadius: "0px",
};

function htmlElement(overrides = {}) {
  return {
    nodeType: 1,
    tagName: "HTML",
    parentElement: null,
    children: [],
    childNodes: [],
    childElementCount: 0,
    id: "",
    classList: [],
    getAttribute: () => null,
    hasAttribute: () => false,
    getBoundingClientRect: () => ({ ...viewport }),
    getClientRects: () => [{ ...viewport }],
    querySelectorAll: () => [],
    ...overrides,
  };
}

function observeTarget(refs, hitStacks, perElementStyle = {}) {
  const registry = createStableNodeRefRegistry("hit-order");
  // Each fixture declares the front-to-back order. Rectangles determine which
  // members are hit at the additional corner probes used by the public reader.
  const order = Object.values(hitStacks).reduce((best, stack) => stack.length > best.length ? stack : best, []);
  const snapshot = observeLiveDom({
    document: {
      documentElement: refs.html,
      body: refs.html,
      baseURI: "https://fixture.test/page",
      elementsFromPoint: (x, y) => hitStacks[`${x},${y}`] ?? order.filter(element => {
        const r = element.getBoundingClientRect();
        return x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
      }),
    },
    window: {
      innerWidth: viewport.width,
      innerHeight: viewport.height,
      getComputedStyle: (element, pseudo) => {
        if (pseudo) return { content: "none" };
        return { ...baseStyle, ...(perElementStyle[element.refKey] ?? {}) };
      },
    },
    registry,
    excludeRoot: null,
    snapshotRef: "hit-order",
    documentRef: "fixture",
  });
  const nodeFor = (element) => snapshot.observation.nodes.find(node => node.nodeRef === stableNodeRefFor(registry, element));
  const candidates = checkCandidates(observeCandidates({ observation: snapshot.observation }), createFocusSpec());
  return { snapshot, nodeFor, registry, candidates };
}

test("partially ordered bounded image retains the exposed top strip", () => {
  const html = htmlElement();
  const rect = { x: 1157, y: 12.5, width: 30, height: 30 };
  const imageRect = { x: 1153, y: 13.5, width: 34, height: 34 };
  const target = htmlElement({ refKey: "target", tagName: "DIV", parentElement: html,
    getBoundingClientRect: () => ({ ...rect }), getClientRects: () => [{ ...rect }] });
  const img = htmlElement({ refKey: "img", tagName: "IMG", parentElement: html,
    getBoundingClientRect: () => ({ ...imageRect }), getClientRects: () => [{ ...imageRect }] });
  html.children = [target, img]; html.childNodes = [target, img]; html.childElementCount = 2;
  const stacks = { "1172,28": [img, target, html], "1172,13": [target, html],
    "1158,14.5": [target, html], "1186,14.5": [target, html] };
  const style = { boxShadow: "none", outlineStyle: "none", outlineWidth: "0px", borderImageSource: "none" };
  const result = observeTarget({ html, target, img }, stacks, { img: style });
  assert.equal(result.nodeFor(target).foreground, "visible");
  assert.deepEqual(result.nodeFor(target).exposedRects, [{ x: 1157, y: 12.5, width: 30, height: 1 }]);
  const escaping = observeTarget({ html, target, img }, stacks, { img: { ...style, filter: "blur(2px)" } });
  assert.equal(escaping.nodeFor(target).foreground, "unassessed");
});

test("interior probes avoid a rounded-up scrollbar edge hit", () => {
  const html = htmlElement();
  const rect = { x: 0, y: 0, width: viewport.width, height: 62 };
  const target = htmlElement({ refKey: "target", tagName: "DIV", parentElement: html,
    getBoundingClientRect: () => ({ ...rect }), getClientRects: () => [{ ...rect }] });
  const cover = htmlElement({ refKey: "cover", tagName: "HEADER", parentElement: html,
    getBoundingClientRect: () => ({ ...rect }), getClientRects: () => [{ ...rect }] });
  html.children = [target, cover]; html.childNodes = [target, cover]; html.childElementCount = 2;
  const result = observeTarget({ html, target, cover }, {
    [`${viewport.width / 2},31`]: [cover, target, html],
    [`${viewport.width - 0.5},0.5`]: [],
    [`${viewport.width - 0.5},61.5`]: [],
  }, { cover: { backgroundColor: "rgb(255, 255, 255)", position: "relative", zIndex: "100" } });
  assert.equal(result.nodeFor(target).foreground, "occluded");
});

test("subpixel overlap stays uncertain when interior corner hits are unavailable", () => {
  const html = htmlElement();
  const rect = { x: 100, y: 100, width: 0.4, height: 0.4 };
  const target = htmlElement({ refKey: "target", tagName: "DIV", parentElement: html,
    getBoundingClientRect: () => ({ ...rect }), getClientRects: () => [{ ...rect }] });
  const cover = htmlElement({ refKey: "cover", tagName: "HEADER", parentElement: html,
    getBoundingClientRect: () => ({ ...rect }), getClientRects: () => [{ ...rect }] });
  html.children = [target, cover]; html.childNodes = [target, cover]; html.childElementCount = 2;
  const center = rect.x + rect.width / 2, near = rect.x + rect.width / 4, far = rect.x + rect.width * 3 / 4;
  const result = observeTarget({ html, target, cover }, {
    [`${center},${center}`]: [cover, target, html],
    [`${near},${near}`]: [], [`${far},${near}`]: [],
    [`${near},${far}`]: [], [`${far},${far}`]: [],
  }, { cover: { backgroundColor: "rgb(255, 255, 255)", position: "relative", zIndex: "100" } });
  assert.equal(result.nodeFor(target).foreground, "unassessed");
});

function targetStatus(refs, result, element) {
  const node = result.nodeFor(element);
  const slot = result.candidates.slots.find(slot => slot.nodeRef === node.nodeRef);
  return { foreground: node.foreground, exposedRects: node.exposedRects, candidateStatus: slot?.status, reasons: slot?.reasons };
}

// Live evidence: a transparent native TEXTAREA hit first, then a white clone at
// opacity 0.00001 with aria-hidden sits behind it as the first "opaque" surface.
test("transparent target hit before white clone remains visible, not unassessed", () => {
  const html = htmlElement();
  const target = htmlElement({
    refKey: "target", tagName: "TEXTAREA", parentElement: html, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 286, y: 83, width: 814, height: 40 }),
    getClientRects: () => [{ x: 286, y: 83, width: 814, height: 40 }],
  });
  const wrapper = htmlElement({ refKey: "wrapper", tagName: "DIV", parentElement: html, children: [target], childNodes: [target], childElementCount: 1 });
  target.parentElement = wrapper;
  const clone = htmlElement({
    refKey: "clone", tagName: "TEXTAREA", parentElement: html, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 286, y: 83, width: 814, height: 40 }),
    getClientRects: () => [{ x: 286, y: 83, width: 814, height: 40 }],
  });
  const search = htmlElement({ refKey: "search", tagName: "DIV", parentElement: html, children: [wrapper, clone], childNodes: [wrapper, clone], childElementCount: 2 });
  html.children = [search];
  html.childNodes = [search];
  html.childElementCount = 1;
  const elementStyle = {
    target: { backgroundColor: "rgba(0, 0, 0, 0)" },
    clone: { backgroundColor: "rgb(255, 255, 255)", opacity: "1e-05", zIndex: "-1" },
  };
  const center = "693,103";
  const result = observeTarget(
    { html, target, wrapper, clone, search },
    { [center]: [target, wrapper, clone, search, html] },
    elementStyle,
  );
  const status = targetStatus({ html }, result, target);
  assert.equal(status.foreground, "visible", `foreground=${status.foreground}`);
  assert.ok(Array.isArray(status.exposedRects) && status.exposedRects.length > 0, JSON.stringify(status.exposedRects));
  assert.equal(status.candidateStatus, "ok", `candidate=${status.candidateStatus} reasons=${JSON.stringify(status.reasons)}`);
});

// Live evidence: the real target container is the first hit; an unrelated IMG
// behind it becomes firstOpaque and must not demote the foreground.
test("target hit before unrelated image remains visible, not unassessed", () => {
  const html = htmlElement();
  const target = htmlElement({
    refKey: "target", tagName: "DIV", parentElement: html, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 1158, y: 1766, width: 40, height: 88 }),
    getClientRects: () => [{ x: 1158, y: 1766, width: 40, height: 88 }],
  });
  const link = htmlElement({ refKey: "link", tagName: "A", parentElement: html, children: [target], childNodes: [target], childElementCount: 1 });
  target.parentElement = link;
  const img = htmlElement({ refKey: "img", tagName: "IMG", parentElement: html, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 1158, y: 1766, width: 40, height: 88 }),
    getClientRects: () => [{ x: 1158, y: 1766, width: 40, height: 88 }],
  });
  const section = htmlElement({ refKey: "section", tagName: "SECTION", parentElement: html, children: [link, img], childNodes: [link, img], childElementCount: 2 });
  link.parentElement = section;
  img.parentElement = section;
  html.children = [section];
  html.childNodes = [section];
  html.childElementCount = 1;
  const elementStyle = {
    target: { backgroundColor: "rgba(0, 0, 0, 0)" },
    img: { backgroundColor: "rgb(255, 255, 255)", opacity: "1" },
  };
  const center = "1178,1810";
  const result = observeTarget(
    { html, target, link, img, section },
    { [center]: [target, link, img, section, html] },
    elementStyle,
  );
  const status = targetStatus({ html }, result, target);
  assert.equal(status.foreground, "visible", `foreground=${status.foreground}`);
  assert.ok(Array.isArray(status.exposedRects) && status.exposedRects.length > 0, JSON.stringify(status.exposedRects));
  assert.equal(status.candidateStatus, "ok", `candidate=${status.candidateStatus} reasons=${JSON.stringify(status.reasons)}`);
});

// A transparent descendant hit before the later opaque owner proves the target
// rect is exposed through its own subtree, not just an ancestor chain.
test("transparent descendant hit before opaque owner exposes parent target", () => {
  const html = htmlElement();
  const target = htmlElement({
    refKey: "target", tagName: "DIV", parentElement: html, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 200, height: 60 }),
    getClientRects: () => [{ x: 100, y: 100, width: 200, height: 60 }],
  });
  const descendant = htmlElement({ refKey: "descendant", tagName: "SPAN", parentElement: target, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 120, y: 120, width: 100, height: 20 }),
    getClientRects: () => [{ x: 120, y: 120, width: 100, height: 20 }],
  });
  target.children = [descendant];
  target.childNodes = [descendant];
  target.childElementCount = 1;
  const owner = htmlElement({ refKey: "owner", tagName: "DIV", parentElement: html, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 200, height: 60 }),
    getClientRects: () => [{ x: 100, y: 100, width: 200, height: 60 }],
  });
  const search = htmlElement({ refKey: "search", tagName: "DIV", parentElement: html, children: [target, owner], childNodes: [target, owner], childElementCount: 2 });
  html.children = [search];
  html.childNodes = [search];
  html.childElementCount = 1;
  const elementStyle = {
    target: { backgroundColor: "rgba(0, 0, 0, 0)" },
    descendant: { backgroundColor: "rgba(0, 0, 0, 0)" },
    owner: { backgroundColor: "rgb(20, 20, 24)", opacity: "1" },
  };
  const center = "200,130";
  const result = observeTarget(
    { html, target, descendant, owner, search },
    { [center]: [descendant, target, owner, search, html] },
    elementStyle,
  );
  const status = targetStatus({ html }, result, target);
  assert.equal(status.foreground, "visible", `foreground=${status.foreground}`);
  assert.ok(Array.isArray(status.exposedRects) && status.exposedRects.length > 0, JSON.stringify(status.exposedRects));
});

// A proven opaque overlay in front of the target keeps it occluded; the later
// target hit must not rescue a covered rect.
test("proven opaque overlay in front keeps target occluded", () => {
  const html = htmlElement();
  const target = htmlElement({
    refKey: "target", tagName: "DIV", parentElement: html, children: [], childNodes: [{ nodeType: 3, textContent: "hidden" }], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 200, height: 60 }),
    getClientRects: () => [{ x: 100, y: 100, width: 200, height: 60 }],
  });
  const overlay = htmlElement({ refKey: "overlay", tagName: "DIV", parentElement: html, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 200, height: 60 }),
    getClientRects: () => [{ x: 100, y: 100, width: 200, height: 60 }],
  });
  const search = htmlElement({ refKey: "search", tagName: "DIV", parentElement: html, children: [target, overlay], childNodes: [target, overlay], childElementCount: 2 });
  html.children = [search];
  html.childNodes = [search];
  html.childElementCount = 1;
  const elementStyle = {
    target: { backgroundColor: "rgba(0, 0, 0, 0)" },
    overlay: { backgroundColor: "rgb(20, 20, 24)", opacity: "1", zIndex: "5", position: "relative" },
  };
  const center = "200,130";
  const result = observeTarget(
    { html, target, overlay, search },
    { [center]: [overlay, target, search, html] },
    elementStyle,
  );
  const status = targetStatus({ html }, result, target);
  assert.equal(status.foreground, "occluded", `foreground=${status.foreground}`);
});

// A partial opaque overlay only subtracts its covered area; the exposed sides
// stay visible and the new condition must not restore the blocked strip.
test("partial opaque overlay subtracts covered strip only", () => {
  const html = htmlElement();
  const target = htmlElement({
    refKey: "target", tagName: "DIV", parentElement: html, children: [], childNodes: [{ nodeType: 3, textContent: "split" }], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 200, height: 60 }),
    getClientRects: () => [{ x: 100, y: 100, width: 200, height: 60 }],
  });
  const overlay = htmlElement({ refKey: "overlay", tagName: "DIV", parentElement: html, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 180, y: 100, width: 40, height: 60 }),
    getClientRects: () => [{ x: 180, y: 100, width: 40, height: 60 }],
  });
  const search = htmlElement({ refKey: "search", tagName: "DIV", parentElement: html, children: [target, overlay], childNodes: [target, overlay], childElementCount: 2 });
  html.children = [search];
  html.childNodes = [search];
  html.childElementCount = 1;
  const elementStyle = {
    target: { backgroundColor: "rgba(0, 0, 0, 0)" },
    overlay: { backgroundColor: "rgb(20, 20, 24)", opacity: "1", zIndex: "5", position: "relative" },
  };
  const leftCenter = "150,130";
  const rightCenter = "250,130";
  const blockedCenter = "200,130";
  const result = observeTarget(
    { html, target, overlay, search },
    { [leftCenter]: [target, search, html], [rightCenter]: [target, search, html], [blockedCenter]: [overlay, target, search, html] },
    elementStyle,
  );
  const node = result.nodeFor(target);
  assert.equal(node.foreground, "visible", `foreground=${node.foreground}`);
  assert.ok(node.exposedRects.length === 2, JSON.stringify(node.exposedRects));
  for (const rect of node.exposedRects) {
    assert.ok(rect.x + rect.width <= 180 || rect.x >= 220, JSON.stringify(rect));
  }
});

// A non-interactive transparent read target hit before a background owner must
// stay visible; the fix does not require clickability or event listeners.
test("transparent non-interactive read target before background stays visible", () => {
  const html = htmlElement();
  const target = htmlElement({
    refKey: "target", tagName: "DIV", parentElement: html, children: [], childNodes: [{ nodeType: 3, textContent: "status text" }], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 160, height: 40 }),
    getClientRects: () => [{ x: 100, y: 100, width: 160, height: 40 }],
  });
  const owner = htmlElement({ refKey: "owner", tagName: "DIV", parentElement: html, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 160, height: 40 }),
    getClientRects: () => [{ x: 100, y: 100, width: 160, height: 40 }],
  });
  const search = htmlElement({ refKey: "search", tagName: "DIV", parentElement: html, children: [target, owner], childNodes: [target, owner], childElementCount: 2 });
  html.children = [search];
  html.childNodes = [search];
  html.childElementCount = 1;
  const elementStyle = {
    target: { backgroundColor: "rgba(0, 0, 0, 0)" },
    owner: { backgroundColor: "rgb(25, 25, 30)", opacity: "1" },
  };
  const center = "180,120";
  const result = observeTarget(
    { html, target, owner, search },
    { [center]: [target, owner, search, html] },
    elementStyle,
  );
  const status = targetStatus({ html }, result, target);
  assert.equal(status.foreground, "visible", `foreground=${status.foreground}`);
  assert.ok(Array.isArray(status.exposedRects) && status.exposedRects.length > 0, JSON.stringify(status.exposedRects));
});

// A transparent overlay in front of a transparent read target, with the real
// background owner behind the target, must not be treated as opaque occlusion.
test("transparent overlay before target with later background stays visible", () => {
  const html = htmlElement();
  const target = htmlElement({
    refKey: "target", tagName: "DIV", parentElement: html, children: [], childNodes: [{ nodeType: 3, textContent: "read" }], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 120, height: 40 }),
    getClientRects: () => [{ x: 100, y: 100, width: 120, height: 40 }],
  });
  const overlay = htmlElement({ refKey: "overlay", tagName: "DIV", parentElement: html, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 120, height: 40 }),
    getClientRects: () => [{ x: 100, y: 100, width: 120, height: 40 }],
  });
  const owner = htmlElement({ refKey: "owner", tagName: "DIV", parentElement: html, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 120, height: 40 }),
    getClientRects: () => [{ x: 100, y: 100, width: 120, height: 40 }],
  });
  const search = htmlElement({ refKey: "search", tagName: "DIV", parentElement: html, children: [target, overlay, owner], childNodes: [target, overlay, owner], childElementCount: 3 });
  html.children = [search];
  html.childNodes = [search];
  html.childElementCount = 1;
  const elementStyle = {
    target: { backgroundColor: "rgba(0, 0, 0, 0)" },
    overlay: { backgroundColor: "rgba(0, 0, 0, 0)" },
    owner: { backgroundColor: "rgb(25, 25, 30)", opacity: "1" },
  };
  const center = "160,120";
  const result = observeTarget(
    { html, target, overlay, owner, search },
    { [center]: [overlay, target, owner, search, html] },
    elementStyle,
  );
  const status = targetStatus({ html }, result, target);
  assert.equal(status.foreground, "visible", `foreground=${status.foreground}`);
});

// A pointer-none opaque overlay absent from the native hit stack but proven in
// front by paint order still excludes the fully covered target.
test("pointer-none opaque overlay proven in front occludes target", () => {
  const html = htmlElement();
  const target = htmlElement({
    refKey: "target", tagName: "DIV", parentElement: html, children: [], childNodes: [{ nodeType: 3, textContent: "covered" }], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 180, height: 50 }),
    getClientRects: () => [{ x: 100, y: 100, width: 180, height: 50 }],
  });
  const overlay = htmlElement({ refKey: "overlay", tagName: "DIV", parentElement: html, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 180, height: 50 }),
    getClientRects: () => [{ x: 100, y: 100, width: 180, height: 50 }],
  });
  const search = htmlElement({ refKey: "search", tagName: "DIV", parentElement: html, children: [target, overlay], childNodes: [target, overlay], childElementCount: 2 });
  html.children = [search];
  html.childNodes = [search];
  html.childElementCount = 1;
  const elementStyle = {
    target: { backgroundColor: "rgba(0, 0, 0, 0)" },
    overlay: { backgroundColor: "rgb(20, 20, 24)", opacity: "1", zIndex: "4", position: "relative", pointerEvents: "none" },
  };
  const center = "190,125";
  const result = observeTarget(
    { html, target, overlay, search },
    { [center]: [target, search, html] },
    elementStyle,
  );
  const status = targetStatus({ html }, result, target);
  assert.equal(status.foreground, "occluded", `foreground=${status.foreground}`);
});

// A pointer-none opaque overlay partially in front only subtracts its strip,
// keeping the unblocked sides visible.
test("pointer-none partial opaque overlay subtracts covered strip only", () => {
  const html = htmlElement();
  const target = htmlElement({
    refKey: "target", tagName: "DIV", parentElement: html, children: [], childNodes: [{ nodeType: 3, textContent: "split" }], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 200, height: 60 }),
    getClientRects: () => [{ x: 100, y: 100, width: 200, height: 60 }],
  });
  const overlay = htmlElement({ refKey: "overlay", tagName: "DIV", parentElement: html, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 170, y: 100, width: 60, height: 60 }),
    getClientRects: () => [{ x: 170, y: 100, width: 60, height: 60 }],
  });
  const search = htmlElement({ refKey: "search", tagName: "DIV", parentElement: html, children: [target, overlay], childNodes: [target, overlay], childElementCount: 2 });
  html.children = [search];
  html.childNodes = [search];
  html.childElementCount = 1;
  const elementStyle = {
    target: { backgroundColor: "rgba(0, 0, 0, 0)" },
    overlay: { backgroundColor: "rgb(20, 20, 24)", opacity: "1", zIndex: "4", position: "relative", pointerEvents: "none" },
  };
  const leftCenter = "150,130";
  const rightCenter = "250,130";
  const blockedCenter = "200,130";
  const result = observeTarget(
    { html, target, overlay, search },
    { [leftCenter]: [target, search, html], [rightCenter]: [target, search, html], [blockedCenter]: [target, search, html] },
    elementStyle,
  );
  const node = result.nodeFor(target);
  assert.equal(node.foreground, "visible", `foreground=${node.foreground}`);
  assert.ok(node.exposedRects.length === 2, JSON.stringify(node.exposedRects));
  for (const rect of node.exposedRects) {
    assert.ok(rect.x + rect.width <= 170 || rect.x >= 230, JSON.stringify(rect));
  }
});

