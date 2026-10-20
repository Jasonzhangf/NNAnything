import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createStableNodeRefRegistry,
  observeLiveDom,
  stableNodeRefFor,
  checkCandidates,
  observeCandidates,
  createFocusSpec,
} from "nnanything/browser-classify";

const viewport = { x: 0, y: 0, width: 1200, height: 900 };
const xhtml = "http://www.w3.org/1999/xhtml";

const baseStyle = {
  display: "block",
  visibility: "visible",
  position: "static",
  zIndex: "auto",
  opacity: "1",
  width: "542px",
  height: "304.875px",
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
};

const roundedAncestorStyle = {
  ...baseStyle,
  display: "block",
  position: "absolute",
  overflowX: "hidden",
  overflowY: "hidden",
  borderTopLeftRadius: "8px",
  borderTopRightRadius: "8px",
  borderBottomRightRadius: "8px",
  borderBottomLeftRadius: "8px",
};

const roundedTargetStyle = {
  ...baseStyle,
  position: "absolute",
  overflowX: "clip",
  overflowY: "clip",
  overflowClipMargin: "content-box",
  borderTopLeftRadius: "8px",
  borderTopRightRadius: "8px",
  borderBottomRightRadius: "8px",
  borderBottomLeftRadius: "8px",
};

function element({ key, tagName = "DIV", rect, parent = null, style = {}, native = {} }) {
  return {
    nodeType: 1,
    tagName,
    namespaceURI: xhtml,
    parentElement: parent,
    children: [],
    childNodes: [],
    childElementCount: 0,
    clientWidth: rect.width,
    clientHeight: rect.height,
    clientLeft: 0,
    clientTop: 0,
    id: "",
    classList: [],
    getAttribute: () => null,
    hasAttribute: () => false,
    matches: () => false,
    getBoundingClientRect: () => ({ ...rect }),
    getClientRects: () => [{ ...rect }],
    querySelectorAll: () => [],
    key,
    testStyle: style,
    ...native,
  };
}

function setChildren(parent, children) {
  parent.children = children;
  parent.childNodes = children;
  parent.childElementCount = children.length;
}

function makeScene({
  ancestorStyle = roundedAncestorStyle,
  imageStyle = {},
  includeBlackBackdrop = false,
  includeInsideTarget = false,
  videoStackAtCorner = false,
} = {}) {
  const rect = { x: 100, y: 120, width: 542, height: 304.875 };
  const html = element({ key: "html", tagName: "HTML", rect: viewport });
  const player = element({
    key: "player",
    rect,
    parent: html,
    style: {
      position: "relative",
      display: "inline-block",
      borderTopLeftRadius: "8px",
      borderTopRightRadius: "8px",
      borderBottomRightRadius: "8px",
      borderBottomLeftRadius: "8px",
    },
  });
  const picture = element({
    key: "picture",
    tagName: "PICTURE",
    rect,
    parent: player,
    style: ancestorStyle,
  });
  const image = element({
    key: "image",
    tagName: "IMG",
    rect,
    parent: picture,
    style: {
      overflowX: "clip",
      overflowY: "clip",
      overflowClipMargin: "content-box",
      objectFit: "contain",
      objectPosition: "50% 50%",
      ...imageStyle,
    },
    native: {
      complete: true,
      naturalWidth: 640,
      naturalHeight: 360,
      currentSrc: "https://fixture.test/poster.jpg",
    },
  });
  const video = element({
    key: "video",
    tagName: "VIDEO",
    rect,
    parent: player,
    style: roundedTargetStyle,
  });
  const subtitle = element({
    key: "subtitle",
    rect,
    parent: player,
    style: { position: "absolute", pointerEvents: "none" },
  });
  const insideTarget = element({
    key: "inside-target",
    rect,
    parent: picture,
    style: { position: "absolute", pointerEvents: "none" },
  });
  const backdrop = element({
    key: "backdrop",
    rect,
    parent: player,
    style: { position: "absolute", backgroundColor: "rgb(0, 0, 0)" },
  });

  setChildren(html, [player]);
  setChildren(picture, includeInsideTarget ? [image, insideTarget] : [image]);
  const playerChildren = [subtitle, picture, video];
  if (includeInsideTarget) player.children.push(insideTarget);
  if (includeBlackBackdrop) playerChildren.push(backdrop);
  setChildren(player, playerChildren);
  setChildren(player, playerChildren);

  const corner = { x: rect.x + 1.5, y: rect.y + 1.5 };
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const styles = new Map([
    [html, baseStyle],
    [player, { ...baseStyle, ...player.testStyle }],
    [picture, { ...baseStyle, ...picture.testStyle }],
    [image, { ...baseStyle, ...image.testStyle }],
    [video, { ...baseStyle, ...video.testStyle }],
    [subtitle, { ...baseStyle, ...subtitle.testStyle }],
    [insideTarget, { ...baseStyle, ...insideTarget.testStyle }],
    [backdrop, { ...baseStyle, ...backdrop.testStyle }],
  ]);
  const document = {
    documentElement: html,
    body: html,
    baseURI: "https://fixture.test/page",
    elementsFromPoint: (x, y) => {
      const atCorner = Math.abs(x - corner.x) < 1e-9 && Math.abs(y - corner.y) < 1e-9;
      if (atCorner) {
        if (videoStackAtCorner) return [video, image, player, html];
        if (includeInsideTarget) return [image, insideTarget, subtitle, player, html];
        if (includeBlackBackdrop) return [backdrop, image, subtitle, video, player, html];
        return [image, subtitle, player, html];
      }
      if (x === center.x && y === center.y) return [image, subtitle, video, player, html];
      return [];
    },
  };
  const registry = createStableNodeRefRegistry("ancestor-rounded-clip");
  const diagnostics = [];
  const snapshot = observeLiveDom({
    document,
    window: {
      innerWidth: viewport.width,
      innerHeight: viewport.height,
      getComputedStyle: (candidate, pseudo) => pseudo
        ? { content: "none" }
        : styles.get(candidate) ?? baseStyle,
    },
    registry,
    excludeRoot: null,
    snapshotRef: "ancestor-rounded-clip",
    documentRef: "fixture",
    diagnostic: { selectedRefs: new Set([stableNodeRefFor(registry, subtitle)]), callback: event => diagnostics.push(event) },
  });
  const nodeFor = candidate => snapshot.observation.nodes
    .find(node => node.nodeRef === stableNodeRefFor(registry, candidate));
  const candidates = checkCandidates(observeCandidates({ observation: snapshot.observation }), createFocusSpec());
  return {
    snapshot,
    diagnostics,
    rect,
    corner,
    nodeFor,
    subtitle: nodeFor(subtitle),
    video: nodeFor(video),
    insideTarget: nodeFor(insideTarget),
    subtitleCandidate: candidates.slots.find(slot => slot.nodeRef === stableNodeRefFor(registry, subtitle)),
  };
}

function contains(rect, point) {
  return point.x > rect.x && point.x < rect.x + rect.width
    && point.y > rect.y && point.y < rect.y + rect.height;
}

test("ancestor rounded clip preserves the descendant blocker's certified clear corner", () => {
  const scene = makeScene();
  assert.equal(scene.subtitle.foreground, "visible", JSON.stringify({ node: scene.subtitle, diagnostics: scene.diagnostics }));
  assert.ok(Array.isArray(scene.subtitle.exposedRects), JSON.stringify(scene.subtitle.exposedRects));
  assert.ok(scene.subtitle.exposedRects.some(rect => contains(rect, scene.corner)),
    JSON.stringify(scene.subtitle.exposedRects));
  assert.equal(scene.subtitleCandidate.status, "ok");
});

test("same clipped target and a rounded VIDEO target cannot borrow the blocker's clear corner", () => {
  assert.notEqual(makeScene({ includeInsideTarget: true }).insideTarget.foreground, "visible");
  assert.notEqual(makeScene({ videoStackAtCorner: true }).video.foreground, "visible");
});

test("opaque full-width backdrop stays an independent corner control", () => {
  const scene = makeScene({
    imageStyle: { objectFit: "fill" },
    includeBlackBackdrop: true,
  });
  assert.notEqual(scene.subtitle.foreground, "visible");
});

test("missing or unsupported rounded-clip facts keep the old uncertain result", () => {
  for (const [label, ancestorStyle, imageStyle] of [
    ["not positioned", { ...roundedAncestorStyle, position: "static" }, {}],
    ["expanded clip margin", {
      ...roundedAncestorStyle,
      overflowX: "clip",
      overflowY: "clip",
      overflowClipMargin: "4px",
    }, {}],
    ["unknown zoom", { ...roundedAncestorStyle, zoom: undefined }, {}],
    ["rotated ancestor", { ...roundedAncestorStyle, transform: "rotate(1deg)" }, {}],
    ["missing radius", { ...roundedAncestorStyle, borderTopLeftRadius: undefined }, {}],
    ["escaping blocker effect", roundedAncestorStyle, { filter: "blur(1px)" }],
  ]) {
    assert.equal(makeScene({ ancestorStyle, imageStyle }).subtitle.foreground, "unassessed", label);
  }
});
