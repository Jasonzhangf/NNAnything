import assert from "node:assert/strict";
import { test } from "node:test";
import { roundedOuterClearCorners } from "../dist/adapters/browser/paint-surface.js";
import * as paintSurface from "../dist/adapters/browser/paint-surface.js";

import {
  checkCandidates,
  createFocusSpec,
  createStableNodeRefRegistry,
  observeCandidates,
  observeLiveDom,
  stableNodeRefFor,
} from "nnanything/browser-classify";

const viewport = { x: 0, y: 0, width: 1200, height: 900 };

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
  zoom: "1",
  borderImageSource: "none",
  objectFit: "fill",
  objectPosition: "50% 50%",
};

test("normalized oversized radii expose strictly clear corner patches", () => {
  const box = { x: 28, y: 520, width: 24, height: 24 };
  const style = { ...baseStyle, borderTopLeftRadius: "1000px", borderTopRightRadius: "1000px",
    borderBottomLeftRadius: "1000px", borderBottomRightRadius: "1000px" };
  const corners = roundedOuterClearCorners(box, box, style, { x: 1, y: 1 });
  assert.deepEqual(corners[0], { x: 29.5, y: 521.5, width: 1.5, height: 1.5 });
  assert.equal(corners.length, 4);
  assert.equal(roundedOuterClearCorners(box, box, { ...style, borderTopLeftRadius: undefined }, { x: 1, y: 1 }), null);
  assert.equal(roundedOuterClearCorners(box, box, style, { x: 0, y: 1 }), null);
});

const containIntrinsic = {
  complete: true,
  naturalWidth: 480,
  naturalHeight: 853,
  sourcePresent: true,
};

test("contained replaced paint rect uses exact centered contain geometry", () => {
  const borderBox = { x: 313.5, y: 1382, width: 542, height: 304.875 };
  const style = { ...baseStyle, objectFit: "contain", objectPosition: "50% 50%" };
  const contentWidth = 480 * (304.875 / 853);
  const expected = {
    x: 313.5 + (542 - contentWidth) / 2,
    y: 1382,
    width: contentWidth,
    height: 304.875,
  };
  const actual = paintSurface.containedReplacedPaintRect(
    borderBox, borderBox, style, { x: 1, y: 1 }, containIntrinsic,
  );
  for (const key of ["x", "y", "width", "height"]) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-12, `${key}: ${JSON.stringify(actual)}`);
  }
});

test("contained replaced paint rect clips the intrinsic image rectangle to the visible box", () => {
  const borderBox = { x: 313.5, y: 1382, width: 542, height: 304.875 };
  const visibleBox = { x: 520, y: 1400, width: 100, height: 200 };
  const style = { ...baseStyle, objectFit: "contain", objectPosition: "50% 50%" };
  assert.deepEqual(paintSurface.containedReplacedPaintRect(
    borderBox, visibleBox, style, { x: 1, y: 1 }, containIntrinsic,
  ), { x: 520, y: 1400, width: 100, height: 200 });
});

test("contained replaced paint rect computes in CSS pixels before applying a non-unit scale", () => {
  const borderBox = { x: 100, y: 200, width: 600, height: 450 };
  const style = { ...baseStyle, objectFit: "contain", objectPosition: "50% 50%" };
  const intrinsic = { complete: true, naturalWidth: 100, naturalHeight: 200, sourcePresent: true };
  assert.deepEqual(paintSurface.containedReplacedPaintRect(
    borderBox, borderBox, style, { x: 2, y: 3 }, intrinsic,
  ), { x: 325, y: 200, width: 150, height: 450 });
});

test("contained replaced paint rect rejects unsupported fit, position and intrinsic facts", () => {
  const borderBox = { x: 313.5, y: 1382, width: 542, height: 304.875 };
  const style = { ...baseStyle, objectFit: "contain", objectPosition: "50% 50%" };
  const paint = (nextStyle, nextIntrinsic = containIntrinsic) => paintSurface.containedReplacedPaintRect(
    borderBox, borderBox, nextStyle, { x: 1, y: 1 }, nextIntrinsic,
  );
  for (const objectFit of ["fill", "cover", "none", "scale-down"]) {
    assert.equal(paint({ ...style, objectFit }), null, objectFit);
  }
  for (const objectPosition of ["0% 50%", "left top", undefined]) {
    assert.equal(paint({ ...style, objectPosition }), null, String(objectPosition));
  }
  for (const intrinsic of [
    { ...containIntrinsic, complete: false },
    { ...containIntrinsic, complete: null },
    { ...containIntrinsic, complete: undefined },
    { ...containIntrinsic, sourcePresent: false },
    { ...containIntrinsic, naturalWidth: null },
    { ...containIntrinsic, naturalWidth: undefined },
    { ...containIntrinsic, naturalWidth: 0 },
    { ...containIntrinsic, naturalWidth: -1 },
    { ...containIntrinsic, naturalWidth: Number.NaN },
    { ...containIntrinsic, naturalWidth: Number.POSITIVE_INFINITY },
    { ...containIntrinsic, naturalHeight: null },
    { ...containIntrinsic, naturalHeight: undefined },
    { ...containIntrinsic, naturalHeight: 0 },
    { ...containIntrinsic, naturalHeight: -1 },
    { ...containIntrinsic, naturalHeight: Number.NaN },
  ]) assert.equal(paint(style, intrinsic), null, JSON.stringify(intrinsic));
});

test("contained replaced paint rect requires known zero edges, positive scale and finite positive intersection", () => {
  const borderBox = { x: 313.5, y: 1382, width: 542, height: 304.875 };
  const style = { ...baseStyle, objectFit: "contain", objectPosition: "50% 50%" };
  const paint = (nextBorder = borderBox, nextVisible = nextBorder, nextStyle = style,
    nextScale = { x: 1, y: 1 }, nextIntrinsic = containIntrinsic) => paintSurface.containedReplacedPaintRect(
    nextBorder, nextVisible, nextStyle, nextScale, nextIntrinsic,
  );
  for (const edge of [
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  ]) {
    assert.equal(paint(borderBox, borderBox, { ...style, [edge]: "1px" }), null, `${edge} nonzero`);
    assert.equal(paint(borderBox, borderBox, { ...style, [edge]: undefined }), null, `${edge} unknown`);
  }
  for (const scale of [
    { x: 0, y: 1 }, { x: 1, y: 0 }, { x: -1, y: 1 },
    { x: 1, y: Number.POSITIVE_INFINITY }, { x: Number.NaN, y: 1 },
  ]) assert.equal(paint(borderBox, borderBox, style, scale), null, JSON.stringify(scale));
  for (const invalid of [
    { ...borderBox, x: Number.NaN },
    { ...borderBox, y: Number.POSITIVE_INFINITY },
    { ...borderBox, width: 0 },
    { ...borderBox, height: -1 },
  ]) assert.equal(paint(invalid), null, JSON.stringify(invalid));
  for (const visible of [
    { ...borderBox, x: Number.NaN },
    { ...borderBox, height: Number.POSITIVE_INFINITY },
    { x: 0, y: 0, width: 10, height: 10 },
  ]) assert.equal(paint(borderBox, visible), null, JSON.stringify(visible));
  assert.notEqual(paint(borderBox, borderBox, { ...style, opacity: "0" }), null,
    "geometry must not infer image opacity");
});

function element({
  refKey, tagName = "DIV", rect, parent = null, children = [], text = null, native = {},
}) {
  const childNodes = [...(text === null ? [] : [{ nodeType: 3, textContent: text }]), ...children];
  return {
    nodeType: 1,
    tagName,
    namespaceURI: "http://www.w3.org/1999/xhtml",
    parentElement: parent,
    children,
    childNodes,
    childElementCount: children.length,
    id: "",
    classList: [],
    getAttribute: () => null,
    hasAttribute: () => false,
    getBoundingClientRect: () => ({ ...rect }),
    getClientRects: () => [{ ...rect }],
    querySelectorAll: () => [],
    refKey,
    ...native,
  };
}

function observeScene({ html, paintOrder, styleByRef, pseudoByRef = {} }) {
  const registry = createStableNodeRefRegistry("paint-surface");
  const document = {
    documentElement: html,
    body: html,
    baseURI: "https://fixture.test/page",
    elementsFromPoint: (x, y) => paintOrder.filter((candidate) => {
      const box = candidate.getBoundingClientRect();
      return x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height;
    }),
  };
  const window = {
    innerWidth: viewport.width,
    innerHeight: viewport.height,
    getComputedStyle: (candidate, pseudo) => {
      if (pseudo) return { content: pseudoByRef[candidate.refKey] ?? "none" };
      return { ...baseStyle, ...(styleByRef[candidate.refKey] ?? {}) };
    },
  };
  const snapshot = observeLiveDom({
    document,
    window,
    registry,
    excludeRoot: null,
    snapshotRef: "paint-surface",
    documentRef: "fixture",
  });
  const candidates = checkCandidates(
    observeCandidates({ observation: snapshot.observation }),
    createFocusSpec(),
  );
  const nodeFor = (candidate) => snapshot.observation.nodes
    .find((node) => node.nodeRef === stableNodeRefFor(registry, candidate));
  const slotFor = (candidate) => {
    const node = nodeFor(candidate);
    return candidates.slots.find((slot) => slot.nodeRef === node.nodeRef);
  };
  return { snapshot, candidates, nodeFor, slotFor };
}

function imageOverlayScene({ overlayTag = "DIV", overlayStyle = {}, imageStyle = {}, rect }) {
  const html = element({ refKey: "html", tagName: "HTML", rect: viewport });
  const container = element({ refKey: "container", rect, parent: html });
  const image = element({ refKey: "image", tagName: "IMG", rect, parent: container });
  const overlay = element({ refKey: "overlay", tagName: overlayTag.toUpperCase(), rect, parent: container });
  container.children = [image, overlay];
  container.childNodes = [image, overlay];
  container.childElementCount = 2;
  html.children = [container];
  html.childNodes = [container];
  html.childElementCount = 1;
  const scene = observeScene({
    html,
    paintOrder: [overlay, image, container, html],
    styleByRef: {
      html: {},
      container: {},
      image: imageStyle,
      overlay: overlayStyle,
    },
  });
  return { ...scene, html, container, image, overlay };
}

function containedMediaScene() {
  const rect = { x: 100, y: 100, width: 542, height: 304.875 };
  const trackRect = { x: 100, y: 100, width: 542, height: 249.875 };
  const html = element({ refKey: "html", tagName: "HTML", rect: viewport });
  const player = element({ refKey: "player", rect, parent: html });
  const video = element({ refKey: "video", tagName: "VIDEO", rect, parent: player });
  const image = element({
    refKey: "poster", tagName: "IMG", rect, parent: player,
    native: {
      complete: true,
      naturalWidth: 480,
      naturalHeight: 853,
      currentSrc: "https://fixture.test/poster.jpg",
      src: "https://fixture.test/poster.jpg",
    },
  });
  const textOuter = element({ refKey: "text-outer", rect: trackRect, parent: player });
  const textInner = element({ refKey: "text-inner", rect: trackRect, parent: textOuter });
  player.children = [video, image, textOuter];
  player.childNodes = [video, image, textOuter];
  player.childElementCount = 3;
  textOuter.children = [textInner];
  textOuter.childNodes = [textInner];
  textOuter.childElementCount = 1;
  html.children = [player];
  html.childNodes = [player];
  html.childElementCount = 1;
  const scene = observeScene({
    html,
    paintOrder: [image, textInner, textOuter, video, player, html],
    styleByRef: {
      html: {},
      player: { backgroundColor: "rgb(20, 20, 24)", position: "relative" },
      video: { position: "absolute" },
      poster: {
        objectFit: "contain",
        objectPosition: "50% 50%",
        position: "absolute",
      },
      "text-outer": { pointerEvents: "none", position: "absolute" },
      "text-inner": { pointerEvents: "none", position: "absolute" },
    },
  });
  return { ...scene, html, player, video, image, textOuter, textInner };
}

function assertRectClose(actual, expected, label) {
  for (const key of ["x", "y", "width", "height"]) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-9, `${label}.${key}: ${JSON.stringify(actual)}`);
  }
}

test("public observer bounds contained IMG paint and exposes video plus pointer-none text tracks", () => {
  const scene = containedMediaScene();
  const contentWidth = 480 * (304.875 / 853);
  const sideWidth = (542 - contentWidth) / 2;
  const imageRight = 100 + sideWidth + contentWidth;
  const video = scene.nodeFor(scene.video);
  const textOuter = scene.nodeFor(scene.textOuter);
  const textInner = scene.nodeFor(scene.textInner);
  assert.equal(video.foreground, "visible", `video foreground=${video.foreground}`);
  assert.equal(Array.isArray(video.exposedRects) ? video.exposedRects.length : null, 2,
    JSON.stringify(video.exposedRects));
  assertRectClose(video.exposedRects[0], { x: 100, y: 100, width: sideWidth, height: 304.875 }, "video.left");
  assertRectClose(video.exposedRects[1], {
    x: imageRight, y: 100, width: sideWidth, height: 304.875,
  }, "video.right");
  for (const [label, target] of [["outer", textOuter], ["inner", textInner]]) {
    assert.equal(target.foreground, "visible", `${label} foreground=${target.foreground}`);
    assert.equal(Array.isArray(target.exposedRects) ? target.exposedRects.length : null, 2,
      JSON.stringify(target.exposedRects));
    assertRectClose(target.exposedRects[0], {
      x: 100, y: 100, width: sideWidth, height: 249.875,
    }, `${label}.left`);
    assertRectClose(target.exposedRects[1], {
      x: imageRight, y: 100, width: sideWidth, height: 249.875,
    }, `${label}.right`);
  }
});

function borderUnionScene({ overlayStyle, bodyRect = { x: 0, y: 2, width: 1207, height: 58 } }) {
  const overlayRect = { x: 0, y: 0, width: 1207, height: 60 };
  const targetRect = { x: 0, y: 0, width: 1207, height: 60 };
  const html = element({ refKey: "html", tagName: "HTML", rect: viewport });
  const target = element({ refKey: "target", rect: targetRect, parent: html });
  const overlay = element({ refKey: "overlay", rect: overlayRect, parent: html });
  const body = element({ refKey: "body", rect: bodyRect, parent: overlay });
  overlay.children = [body];
  overlay.childNodes = [body];
  overlay.childElementCount = 1;
  html.children = [target, overlay];
  html.childNodes = [target, overlay];
  html.childElementCount = 2;
  const scene = observeScene({
    html,
    paintOrder: [body, overlay, target, html],
    styleByRef: {
      html: {},
      target: {},
      overlay: overlayStyle,
      body: { backgroundColor: "rgb(255, 255, 255)" },
    },
  });
  return { ...scene, html, target, overlay, body };
}

const opaqueTopBorder = {
  borderTopWidth: "2px",
  borderTopStyle: "solid",
  borderTopColor: "rgb(255, 255, 255)",
  position: "absolute",
};

function assertContains(rect, x, y) {
  return x > rect.x && x < rect.x + rect.width && y > rect.y && y < rect.y + rect.height;
}

test("unpainted rounded opacity wrapper over image does not occlude", () => {
  const scene = imageOverlayScene({
    rect: { x: 100, y: 100, width: 200, height: 200 },
    overlayStyle: {
      backgroundColor: "rgba(0, 0, 0, 0)",
      borderTopLeftRadius: "50%",
      borderTopRightRadius: "50%",
      borderBottomLeftRadius: "50%",
      borderBottomRightRadius: "50%",
      opacity: "0.9",
      position: "absolute",
    },
  });
  const image = scene.nodeFor(scene.image);
  const overlay = scene.nodeFor(scene.overlay);
  assert.equal(image.foreground, "visible", `image foreground=${image.foreground}`);
  assert.ok(Array.isArray(image.exposedRects) && image.exposedRects.length > 0, JSON.stringify(image.exposedRects));
  assert.equal(scene.slotFor(scene.image).status, "ok");
  assert.equal(overlay.foreground, "visible", `overlay foreground=${overlay.foreground}`);
  assert.equal(scene.slotFor(scene.overlay).status, "ok");
});

test("clipped rounded image exposes the underlying target only at certified corners", () => {
  const scene = imageOverlayScene({ rect: { x: 28, y: 520, width: 24, height: 24 }, overlayTag: "IMG",
    overlayStyle: { overflowX: "clip", overflowY: "clip", borderTopLeftRadius: "1000px",
      borderTopRightRadius: "1000px", borderBottomLeftRadius: "1000px", borderBottomRightRadius: "1000px" } });
  assert.equal(scene.nodeFor(scene.image).foreground, "visible");
  assert.deepEqual(scene.nodeFor(scene.image).exposedRects, [
    { x: 29.5, y: 521.5, width: 1.5, height: 1.5 },
    { x: 49, y: 521.5, width: 1.5, height: 1.5 },
    { x: 29.5, y: 541, width: 1.5, height: 1.5 },
    { x: 49, y: 541, width: 1.5, height: 1.5 },
  ]);
});

test("PICTURE contributes no decoded pixels of its own", () => {
  const scene = imageOverlayScene({ rect: { x: 100, y: 100, width: 24, height: 24 }, overlayTag: "PICTURE" });
  assert.equal(scene.nodeFor(scene.image).foreground, "visible");
});

test("rounded image clear corners require known bounded paint and zoom", () => {
  for (const unsupported of [{ zoom: undefined }, { filter: "blur(1px)" },
    { boxShadow: "black 0px 0px 2px" }, { borderImageSource: 'url("frame.png")' },
    { outlineStyle: "solid", outlineWidth: "2px", outlineColor: "black" },
    { overflowX: "visible" }, { borderTopLeftRadius: undefined }]) {
    const scene = imageOverlayScene({ rect: { x: 28, y: 520, width: 24, height: 24 }, overlayTag: "IMG",
      overlayStyle: { overflowX: "clip", overflowY: "clip", borderTopLeftRadius: "1000px",
        borderTopRightRadius: "1000px", borderBottomLeftRadius: "1000px", borderBottomRightRadius: "1000px", ...unsupported } });
    assert.equal(scene.nodeFor(scene.image).foreground, "unassessed", JSON.stringify(unsupported));
  }
  const painted = imageOverlayScene({ rect: { x: 100, y: 100, width: 24, height: 24 },
    overlayTag: "PICTURE", overlayStyle: { backgroundColor: "rgb(0, 0, 0)" } });
  assert.equal(painted.nodeFor(painted.image).foreground, "occluded");
});

test("border-only round overlay exposes only its provably clear interior", () => {
  const scene = imageOverlayScene({
    rect: { x: 100, y: 100, width: 24, height: 24 },
    overlayTag: "I",
    overlayStyle: {
      backgroundColor: "rgba(0, 0, 0, 0)",
      borderTopWidth: "1px",
      borderRightWidth: "1px",
      borderBottomWidth: "1px",
      borderLeftWidth: "1px",
      borderTopStyle: "solid",
      borderRightStyle: "solid",
      borderBottomStyle: "solid",
      borderLeftStyle: "solid",
      borderTopColor: "rgba(0, 0, 0, 0.08)",
      borderRightColor: "rgba(0, 0, 0, 0.08)",
      borderBottomColor: "rgba(0, 0, 0, 0.08)",
      borderLeftColor: "rgba(0, 0, 0, 0.08)",
      borderTopLeftRadius: "50%",
      borderTopRightRadius: "50%",
      borderBottomLeftRadius: "50%",
      borderBottomRightRadius: "50%",
      position: "absolute",
    },
  });
  const image = scene.nodeFor(scene.image);
  assert.equal(image.foreground, "visible", `image foreground=${image.foreground}`);
  assert.ok(Array.isArray(image.exposedRects), JSON.stringify(image.exposedRects));
  assert.equal(image.exposedRects.length, 1, JSON.stringify(image.exposedRects));
  const [clear] = image.exposedRects;
  assert.ok(Math.abs(clear.x - 104.2218) < 0.01, JSON.stringify(clear));
  assert.ok(Math.abs(clear.y - 104.2218) < 0.01, JSON.stringify(clear));
  assert.ok(Math.abs(clear.width - 15.5564) < 0.01, JSON.stringify(clear));
  assert.ok(Math.abs(clear.height - 15.5564) < 0.01, JSON.stringify(clear));
  assert.equal(scene.slotFor(scene.image).status, "ok");
});

test("rounded-corner unsafe point stays outside the exposed region", () => {
  const scene = imageOverlayScene({
    rect: { x: 100, y: 100, width: 24, height: 24 },
    overlayTag: "I",
    overlayStyle: {
      backgroundColor: "rgba(0, 0, 0, 0)",
      borderTopWidth: "1px",
      borderRightWidth: "1px",
      borderBottomWidth: "1px",
      borderLeftWidth: "1px",
      borderTopStyle: "solid",
      borderRightStyle: "solid",
      borderBottomStyle: "solid",
      borderLeftStyle: "solid",
      borderTopColor: "rgba(0, 0, 0, 0.08)",
      borderRightColor: "rgba(0, 0, 0, 0.08)",
      borderBottomColor: "rgba(0, 0, 0, 0.08)",
      borderLeftColor: "rgba(0, 0, 0, 0.08)",
      borderTopLeftRadius: "50%",
      borderTopRightRadius: "50%",
      borderBottomLeftRadius: "50%",
      borderBottomRightRadius: "50%",
      position: "absolute",
    },
  });
  const image = scene.nodeFor(scene.image);
  assert.equal(image.foreground, "visible", `image foreground=${image.foreground}`);
  const exposed = image.exposedRects;
  assert.ok(Array.isArray(exposed) && exposed.length > 0, JSON.stringify(exposed));
  // (102,102) is inside the 1px border inset but outside the rounded clear
  // interior; a naive padding-box shortcut would wrongly expose this point.
  for (const rect of exposed) {
    assert.equal(assertContains(rect, 102, 102), false, JSON.stringify(rect));
  }
  assert.ok(exposed.some((rect) => assertContains(rect, 112, 112)), JSON.stringify(exposed));
});

test("elliptical radius normalization uses the two corners on each vertical edge", () => {
  const scene = imageOverlayScene({
    rect: { x: 100, y: 100, width: 100, height: 100 },
    overlayStyle: {
      borderTopWidth: "1px", borderRightWidth: "1px", borderBottomWidth: "1px", borderLeftWidth: "1px",
      borderTopStyle: "solid", borderRightStyle: "solid", borderBottomStyle: "solid", borderLeftStyle: "solid",
      borderTopColor: "rgb(0, 0, 0)", borderRightColor: "rgb(0, 0, 0)", borderBottomColor: "rgb(0, 0, 0)", borderLeftColor: "rgb(0, 0, 0)",
      borderTopLeftRadius: "10px 80px", borderBottomLeftRadius: "10px 80px",
      borderTopRightRadius: "10px 0px", borderBottomRightRadius: "10px 0px",
      position: "absolute",
    },
  });
  const image = scene.nodeFor(scene.image);
  assert.equal(image.foreground, "visible");
  const clear = image.exposedRects[0];
  const expectedY = 100 + 1 + (80 * (100 / 160) - 1) * (1 - 1 / Math.SQRT2);
  assert.ok(Math.abs(clear.y - expectedY) < 1e-8, JSON.stringify({ clear, expectedY }));
});

test("border-only asymmetric ring keeps the wide border strip out of the exposed region", () => {
  const scene = imageOverlayScene({
    rect: { x: 100, y: 100, width: 24, height: 24 },
    overlayTag: "I",
    overlayStyle: {
      backgroundColor: "rgba(0, 0, 0, 0)",
      borderLeftWidth: "8px",
      borderLeftStyle: "solid",
      borderLeftColor: "rgb(20, 20, 24)",
      position: "absolute",
    },
  });
  const image = scene.nodeFor(scene.image);
  assert.equal(image.foreground, "visible", `image foreground=${image.foreground}`);
  const exposed = image.exposedRects;
  assert.ok(Array.isArray(exposed) && exposed.length > 0, JSON.stringify(exposed));
  for (const rect of exposed) {
    assert.equal(assertContains(rect, 102, 112), false, JSON.stringify(rect));
  }
  assert.ok(exposed.some((rect) => assertContains(rect, 114, 112)), JSON.stringify(exposed));
});

test("border-only clear interior scales CSS border and radius into viewport coordinates", () => {
  const scene = imageOverlayScene({
    rect: { x: 100, y: 100, width: 12, height: 12 },
    overlayTag: "I",
    overlayStyle: {
      backgroundColor: "rgba(0, 0, 0, 0)",
      borderTopWidth: "1px",
      borderRightWidth: "1px",
      borderBottomWidth: "1px",
      borderLeftWidth: "1px",
      borderTopStyle: "solid",
      borderRightStyle: "solid",
      borderBottomStyle: "solid",
      borderLeftStyle: "solid",
      borderTopColor: "rgba(0, 0, 0, 0.08)",
      borderRightColor: "rgba(0, 0, 0, 0.08)",
      borderBottomColor: "rgba(0, 0, 0, 0.08)",
      borderLeftColor: "rgba(0, 0, 0, 0.08)",
      borderTopLeftRadius: "50%",
      borderTopRightRadius: "50%",
      borderBottomLeftRadius: "50%",
      borderBottomRightRadius: "50%",
      transform: "matrix(0.5, 0, 0, 0.5, 0, 0)",
      position: "absolute",
    },
  });
  const image = scene.nodeFor(scene.image);
  assert.equal(image.foreground, "visible", `image foreground=${image.foreground}`);
  const exposed = image.exposedRects;
  assert.ok(Array.isArray(exposed) && exposed.length === 1, JSON.stringify(exposed));
  const [clear] = exposed;
  assert.ok(Math.abs(clear.x - 102.1109) < 0.01, JSON.stringify(clear));
  assert.ok(Math.abs(clear.y - 102.1109) < 0.01, JSON.stringify(clear));
  assert.ok(Math.abs(clear.width - 7.7782) < 0.01, JSON.stringify(clear));
  assert.ok(Math.abs(clear.height - 7.7782) < 0.01, JSON.stringify(clear));
});

test("oversized radius is normalized before computing the clear interior", () => {
  const sceneWithRadius = (radius) => imageOverlayScene({
    rect: { x: 100, y: 100, width: 24, height: 24 },
    overlayTag: "I",
    overlayStyle: {
      backgroundColor: "rgba(0, 0, 0, 0)",
      borderTopWidth: "1px",
      borderRightWidth: "1px",
      borderBottomWidth: "1px",
      borderLeftWidth: "1px",
      borderTopStyle: "solid",
      borderRightStyle: "solid",
      borderBottomStyle: "solid",
      borderLeftStyle: "solid",
      borderTopColor: "rgba(0, 0, 0, 0.08)",
      borderRightColor: "rgba(0, 0, 0, 0.08)",
      borderBottomColor: "rgba(0, 0, 0, 0.08)",
      borderLeftColor: "rgba(0, 0, 0, 0.08)",
      borderTopLeftRadius: radius,
      borderTopRightRadius: radius,
      borderBottomLeftRadius: radius,
      borderBottomRightRadius: radius,
      position: "absolute",
    },
  });
  const oversized = sceneWithRadius("1000px");
  const half = sceneWithRadius("50%");
  const oversizedImage = oversized.nodeFor(oversized.image);
  const halfImage = half.nodeFor(half.image);
  assert.equal(oversizedImage.foreground, "visible");
  assert.deepEqual(oversizedImage.exposedRects, halfImage.exposedRects);
});

test("unsupported radius syntax remains unknown rather than approximated", () => {
  const scene = imageOverlayScene({
    rect: { x: 100, y: 100, width: 24, height: 24 },
    overlayTag: "I",
    overlayStyle: {
      backgroundColor: "rgba(0, 0, 0, 0)",
      borderTopWidth: "1px",
      borderRightWidth: "1px",
      borderBottomWidth: "1px",
      borderLeftWidth: "1px",
      borderTopStyle: "solid",
      borderRightStyle: "solid",
      borderBottomStyle: "solid",
      borderLeftStyle: "solid",
      borderTopColor: "rgba(0, 0, 0, 0.08)",
      borderRightColor: "rgba(0, 0, 0, 0.08)",
      borderBottomColor: "rgba(0, 0, 0, 0.08)",
      borderLeftColor: "rgba(0, 0, 0, 0.08)",
      borderTopLeftRadius: "calc(12px)",
      borderTopRightRadius: "calc(12px)",
      borderBottomLeftRadius: "calc(12px)",
      borderBottomRightRadius: "calc(12px)",
      position: "absolute",
    },
  });
  const image = scene.nodeFor(scene.image);
  assert.equal(image.foreground, "unassessed");
  assert.equal(image.exposedRects, null);
});

test("effective zero opacity rounded paint does not occlude and keeps the interactive candidate", () => {
  const scene = imageOverlayScene({
    rect: { x: 100, y: 100, width: 40, height: 40 },
    overlayTag: "BUTTON",
    imageStyle: { backgroundColor: "rgb(20, 20, 24)" },
    overlayStyle: {
      backgroundColor: "rgba(0, 0, 0, 0.15)",
      borderTopLeftRadius: "50%",
      borderTopRightRadius: "50%",
      borderBottomLeftRadius: "50%",
      borderBottomRightRadius: "50%",
      opacity: "0",
      position: "absolute",
    },
  });
  const image = scene.nodeFor(scene.image);
  assert.equal(image.foreground, "visible", `image foreground=${image.foreground}`);
  assert.equal(scene.slotFor(scene.overlay).status, "ok");
});

test("missing opacity remains treated as opaque paint", () => {
  const scene = imageOverlayScene({
    rect: { x: 100, y: 100, width: 40, height: 40 },
    overlayStyle: {
      backgroundColor: "rgb(20, 20, 24)",
      opacity: undefined,
      position: "absolute",
    },
  });
  assert.equal(scene.nodeFor(scene.image).foreground, "occluded");
});

test("visible shadow or outline paint stays accounted as uncertain", () => {
  for (const [label, overlayStyle] of [
    ["shadow", { backgroundColor: "rgba(0, 0, 0, 0)", boxShadow: "rgba(0, 0, 0, 0.4) 0px 0px 8px 4px" }],
    ["outline", { backgroundColor: "rgba(0, 0, 0, 0)", outlineStyle: "solid", outlineWidth: "2px", outlineColor: "rgba(0, 0, 0, 0.5)" }],
  ]) {
    const scene = imageOverlayScene({
      rect: { x: 100, y: 100, width: 80, height: 40 },
      overlayStyle,
    });
    const image = scene.nodeFor(scene.image);
    assert.equal(image.foreground, "unassessed", `${label} foreground=${image.foreground}`);
    assert.equal(image.exposedRects, null, label);
    assert.equal(scene.slotFor(scene.image).status, "unknown", label);
  }
});

test("opaque content-box body with coincident zero padding and borders blocks through its measured box", () => {
  const scene = imageOverlayScene({
    rect: { x: 100, y: 100, width: 1207, height: 62 },
    overlayTag: "HEADER",
    overlayStyle: {
      backgroundColor: "rgb(255, 255, 255)",
      backgroundClip: "content-box",
      boxShadow: "rgba(0, 0, 0, 0.2) 0px 2px 8px 0px",
      paddingTop: "0px",
      paddingRight: "0px",
      paddingBottom: "0px",
      paddingLeft: "0px",
    },
  });
  const image = scene.nodeFor(scene.image);
  assert.equal(image.foreground, "occluded", `image foreground=${image.foreground}`);
  assert.deepEqual(image.exposedRects, []);
});

test("content-box shadow does not prove paint when padding separates its painted body", () => {
  const scene = imageOverlayScene({
    rect: { x: 100, y: 100, width: 80, height: 40 },
    overlayStyle: {
      backgroundColor: "rgb(255, 255, 255)",
      backgroundClip: "content-box",
      boxShadow: "rgba(0, 0, 0, 0.2) 0px 2px 8px 0px",
      paddingTop: "8px",
      paddingRight: "8px",
      paddingBottom: "8px",
      paddingLeft: "8px",
    },
  });
  const image = scene.nodeFor(scene.image);
  assert.equal(image.foreground, "unassessed", `image foreground=${image.foreground}`);
  assert.equal(image.exposedRects, null);
});

test("unsupported border color remains unknown rather than transparent", () => {
  const scene = imageOverlayScene({
    rect: { x: 100, y: 100, width: 40, height: 40 },
    overlayStyle: {
      backgroundColor: "rgba(0, 0, 0, 0)",
      borderTopWidth: "1px",
      borderTopStyle: "solid",
      borderTopColor: "not-a-css-color",
      borderRightWidth: "1px",
      borderRightStyle: "solid",
      borderRightColor: "not-a-css-color",
      borderBottomWidth: "1px",
      borderBottomStyle: "solid",
      borderBottomColor: "not-a-css-color",
      borderLeftWidth: "1px",
      borderLeftStyle: "solid",
      borderLeftColor: "not-a-css-color",
    },
  });
  const image = scene.nodeFor(scene.image);
  assert.equal(image.foreground, "unassessed", `image foreground=${image.foreground}`);
  assert.equal(image.exposedRects, null);
});

test("painted modal and opaque overlay semantics are preserved", () => {
  const translucent = imageOverlayScene({
    rect: { x: 100, y: 100, width: 80, height: 40 },
    overlayStyle: {
      backgroundColor: "rgba(0, 0, 0, 0.4)",
      borderTopLeftRadius: "8px",
      borderTopRightRadius: "8px",
      borderBottomLeftRadius: "8px",
      borderBottomRightRadius: "8px",
      position: "relative",
      zIndex: "4",
    },
  });
  assert.equal(translucent.nodeFor(translucent.image).foreground, "unassessed");

  const opaque = imageOverlayScene({
    rect: { x: 100, y: 100, width: 80, height: 40 },
    overlayStyle: { backgroundColor: "rgb(20, 20, 24)", position: "relative", zIndex: "4" },
  });
  assert.equal(opaque.nodeFor(opaque.image).foreground, "occluded");
});

test("opaque solid top border plus opaque body fully occludes the background spacer", () => {
  const scene = borderUnionScene({ overlayStyle: opaqueTopBorder });
  const target = scene.nodeFor(scene.target);
  assert.equal(target.foreground, "occluded", `target foreground=${target.foreground}`);
  assert.deepEqual(target.exposedRects, []);
});

test("translucent solid top border remains uncertain instead of proving occlusion", () => {
  const scene = borderUnionScene({
    overlayStyle: { ...opaqueTopBorder, borderTopColor: "rgba(0, 0, 0, 0.5)" },
  });
  const target = scene.nodeFor(scene.target);
  assert.notEqual(target.foreground, "occluded", `target foreground=${target.foreground}`);
});

test("non-solid top border remains uncertain instead of proving occlusion", () => {
  const scene = borderUnionScene({
    overlayStyle: { ...opaqueTopBorder, borderTopStyle: "dashed" },
  });
  const target = scene.nodeFor(scene.target);
  assert.notEqual(target.foreground, "occluded", `target foreground=${target.foreground}`);
});

test("a real gap between proved border and body stays not occluded", () => {
  const scene = borderUnionScene({
    overlayStyle: { ...opaqueTopBorder, borderTopWidth: "1px" },
    bodyRect: { x: 0, y: 2, width: 1207, height: 58 },
  });
  const target = scene.nodeFor(scene.target);
  assert.notEqual(target.foreground, "occluded", `target foreground=${target.foreground}`);
});

test("rounded opaque solid top border remains uncertain instead of proving occlusion", () => {
  const scene = borderUnionScene({
    overlayStyle: {
      ...opaqueTopBorder,
      borderTopLeftRadius: "8px",
      borderTopRightRadius: "8px",
      borderBottomLeftRadius: "8px",
      borderBottomRightRadius: "8px",
    },
  });
  const target = scene.nodeFor(scene.target);
  assert.notEqual(target.foreground, "occluded", `target foreground=${target.foreground}`);
});
