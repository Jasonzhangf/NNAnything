import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import {
  createStableNodeRefRegistry,
  observeLiveDom,
  stableNodeRefFor,
  checkCandidates,
  observeCandidates,
  createFocusSpec,
  createBrowserOverlayNodeDefinitions,
  compileWorkflow,
  runWorkflow,
  createWorkflowInputEvent,
  BROWSER_OVERLAY_REQUEST_EVENT_TYPE,
  DEFAULT_BASIC_KIND_CONFIG,
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
  zIndex: "3",
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
  ancestorPseudo = { content: "none" },
  targetStyle = roundedTargetStyle,
  imageStyle = {},
  imageDims = { width: 640, height: 360 },
  reverseNativeOrder = false,
  imageResourceFor,
  documentRef = "fixture-doc-1",
  registry = createStableNodeRefRegistry("rounded-video-coverage"),
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
    },
  });
  const poster = element({ key: "poster", rect, parent: player, style: ancestorStyle });
  const picture = element({
    key: "picture",
    tagName: "PICTURE",
    rect,
    parent: poster,
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
      naturalWidth: imageDims.width,
      naturalHeight: imageDims.height,
      currentSrc: "https://fixture.test/poster.jpg",
    },
  });
  const video = element({
    key: "video",
    tagName: "VIDEO",
    rect,
    parent: player,
    style: targetStyle,
  });
  const subtitle = element({
    key: "subtitle",
    rect,
    parent: player,
    style: { position: "absolute", pointerEvents: "none" },
  });

  setChildren(html, [player]);
  setChildren(poster, [picture]);
  setChildren(picture, [image]);
  const playerChildren = [subtitle, video, poster];
  setChildren(player, playerChildren);

  const corner = { x: rect.x + 1.5, y: rect.y + 1.5 };
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const styles = new Map([
    [html, baseStyle],
    [player, { ...baseStyle, ...player.testStyle }],
    [poster, { ...baseStyle, ...poster.testStyle }],
    [picture, { ...baseStyle, ...picture.testStyle }],
    [image, { ...baseStyle, ...image.testStyle }],
    [video, { ...baseStyle, ...video.testStyle }],
    [subtitle, { ...baseStyle, ...subtitle.testStyle }],
  ]);
  const document = {
    documentElement: html,
    body: html,
    baseURI: "https://fixture.test/page",
    elementsFromPoint: (x, y) => {
      const atCorner = Math.abs(x - corner.x) < 1e-9 && Math.abs(y - corner.y) < 1e-9;
      if (atCorner) {
        // Outside 8px radius corners: image and video both not hit
        return [subtitle, player, html];
      }
      if (Math.abs(x - center.x) < 1e-9 && Math.abs(y - center.y) < 1e-9) {
        if (reverseNativeOrder) {
          return [video, image, subtitle, player, html];
        }
        return [image, subtitle, video, player, html];
      }
      return [];
    },
  };
  const diagnostics = [];
  const observationInput = {
    document,
    window: {
      innerWidth: viewport.width,
      innerHeight: viewport.height,
      getComputedStyle: (candidate, pseudo) => pseudo
        ? (pseudo === "::before" && [poster, picture].includes(candidate) ? ancestorPseudo : { content: "none" })
        : styles.get(candidate) ?? baseStyle,
    },
    registry,
    excludeRoot: null,
    snapshotRef: "rounded-video-coverage",
    documentRef,
    diagnostic: {
      selectedRefs: new Set([stableNodeRefFor(registry, video), stableNodeRefFor(registry, subtitle)]),
      callback: event => diagnostics.push(event),
    },
    imageResourceFor,
  };
  const snapshot = observeLiveDom(observationInput);
  const nodeFor = candidate => snapshot.observation.nodes
    .find(node => node.nodeRef === stableNodeRefFor(registry, candidate));
  const candidates = checkCandidates(observeCandidates({ observation: snapshot.observation }), createFocusSpec());
  return {
    snapshot,
    diagnostics,
    registry,
    observationInput,
    image,
    videoElement: video,
    nodeFor,
    video: nodeFor(video),
    subtitle: nodeFor(subtitle),
    videoCandidate: candidates.slots.find(slot => slot.nodeRef === stableNodeRefFor(registry, video)),
    subtitleCandidate: candidates.slots.find(slot => slot.nodeRef === stableNodeRefFor(registry, subtitle)),
  };
}

function validProofFor(image, registry, documentRef = "fixture-doc-1", overrides = {}) {
  return {
    status: "proven",
    proof: {
      width: 640,
      height: 360,
      binding: {
        documentRef,
        nodeRef: stableNodeRefFor(registry, image),
        loadGeneration: 1,
        currentSrc: "https://fixture.test/poster.jpg",
        complete: true,
        naturalWidth: 640,
        naturalHeight: 360,
        ...overrides.binding,
      },
      provenance: { kind: "official-iab-download", receiptRef: "receipt-1" },
      ...overrides.proof,
    },
  };
}

test("rounded same-domain VIDEO with valid typed proof: unknown -> occluded with retained reason occluded", () => {
  const registry = createStableNodeRefRegistry("test-proof");
  const scene = makeScene({
    registry,
    imageResourceFor: img => validProofFor(img, registry),
  });

  assert.equal(scene.video.foreground, "occluded", JSON.stringify(scene.diagnostics));
  assert.deepEqual(scene.video.exposedRects, []);
  assert.equal(scene.videoCandidate.status, "filtered_out");
  assert.ok(scene.videoCandidate.reasons.includes("occluded"));
});

test("unsupported pair geometry does not request image resources", () => {
  for (const ancestorStyle of [
    { ...roundedAncestorStyle, borderTopLeftRadius: "12px" },
    { ...roundedAncestorStyle, rotate: "12deg" },
    { ...roundedAncestorStyle, zoom: "2" },
  ]) {
    let reads = 0;
    const scene = makeScene({ ancestorStyle, imageResourceFor: () => { reads++; return undefined; } });
    assert.notEqual(scene.video.foreground, "occluded");
    assert.equal(reads, 0);
  }
});

test("normal source-over gradient on clipped poster ancestors preserves opaque JPEG cover", () => {
  const registry = createStableNodeRefRegistry("gradient-cover");
  const gradient = { ...baseStyle, content: '\"\"', position: "absolute", opacity: "1",
    backgroundImage: "linear-gradient(rgba(0, 0, 0, 0), rgba(0, 0, 0, 0.4))" };
  const scene = makeScene({ registry, ancestorPseudo: gradient, imageResourceFor: image => validProofFor(image, registry) });
  assert.equal(scene.video.foreground, "occluded");
  for (const patch of [{ mixBlendMode: "multiply" }, { backdropFilter: "blur(2px)" }]) {
    const unsupported = makeScene({ registry, ancestorPseudo: { ...gradient, ...patch }, imageResourceFor: image => validProofFor(image, registry) });
    assert.notEqual(unsupported.video.foreground, "occluded");
  }
});

test("rounded image edge, legacy clip, mask or reduced ancestor opacity cannot certify full cover", () => {
  for (const options of [
    { imageStyle: { borderTopLeftRadius: "16px" } },
    { ancestorStyle: { ...roundedAncestorStyle, clip: "rect(0px, 100px, 100px, 0px)" } },
    { ancestorStyle: { ...roundedAncestorStyle, maskImage: "linear-gradient(black, transparent)" } },
    { ancestorStyle: { ...roundedAncestorStyle, opacity: "0.5" } },
  ]) {
    const registry = createStableNodeRefRegistry("coverage-holes");
    const scene = makeScene({ ...options, registry, imageResourceFor: image => validProofFor(image, registry) });
    assert.notEqual(scene.video.foreground, "occluded");
  }
});

test("public overlay workflow reads requested resource, reobserves, and presents only final frame", async () => {
  for (const outcome of ["proven", "unavailable", "stale"]) {
    const scene = makeScene();
    const graph = JSON.parse(readFileSync(new URL("../workflows/browser-visual-overlay.graph.json", import.meta.url), "utf8"));
    let observation;
    let reads = 0, presents = 0;
    const definitions = createBrowserOverlayNodeDefinitions({
      document: scene.observationInput.document, window: scene.observationInput.window,
      registry: scene.registry, excludeHost: null,
      imageResources: {
        peek: () => observation,
        read: async image => {
          reads++;
          assert.equal(image, scene.image);
          await Promise.resolve();
          observation = outcome === "unavailable"
            ? { status: "unavailable", reason: "read-failed" }
            : validProofFor(image, scene.registry);
          if (outcome === "stale") image.currentSrc = "https://fixture.test/changed.jpg";
          return observation;
        },
      },
      present: frame => { presents++; return frame.snapshot.snapshotRef; },
    });
    const compiled = compileWorkflow({ graph, bindings: {
      "筛选当前视口与关注候选": { config: { viewportOnly: true, scopeMode: "subtree" } },
      "判断DOM基础种类": { config: DEFAULT_BASIC_KIND_CONFIG },
    } }, { nodeDefinitions: definitions, grantedEffects: ["browser.dom.read", "browser.resource.read", "browser.overlay.present"] });
    const result = await runWorkflow(compiled, createWorkflowInputEvent({
      runId: `resource-${outcome}`, eventId: `resource-${outcome}:input`, port: "overlay_request",
      type: BROWSER_OVERLAY_REQUEST_EVENT_TYPE, correlation: {},
      payload: { snapshotRef: "resource-final", documentRef: "fixture-doc-1" },
    }));
    assert.equal(result.status, "completed");
    assert.equal(result.outputEvent.status, "ok");
    assert.equal(reads, 1);
    assert.equal(presents, 1);
    const frame = result.outputEvent.payload;
    const node = frame.snapshot.observation.nodes.find(node => node.nodeRef === scene.video.nodeRef);
    assert.equal(node.foreground, outcome === "proven" ? "occluded" : "unassessed");
    assert.ok(frame.snapshot.observation.nodes.some(node => node.nodeRef === stableNodeRefFor(scene.registry, scene.image)));
    assert.equal(frame.presentation.receipt, "resource-final");
  }
});

test("no proof or unavailable proof leaves VIDEO unassessed/unknown", () => {
  // No proof callback passed
  const noCallbackScene = makeScene();
  assert.equal(noCallbackScene.video.foreground, "unassessed");
  assert.equal(noCallbackScene.videoCandidate.status, "unknown");

  // Unavailable proof
  const unavailableScene = makeScene({
    imageResourceFor: () => ({ status: "unavailable", reason: "read-failed" }),
  });
  assert.equal(unavailableScene.video.foreground, "unassessed");
  assert.equal(unavailableScene.videoCandidate.status, "unknown");
});

test("proof verification rejects mismatched documentRef, nodeRef, source, and dimensions", () => {
  const dummyRegistry = createStableNodeRefRegistry("dummy");

  // Mismatched documentRef
  const wrongDocScene = makeScene({
    documentRef: "fixture-doc-1",
    imageResourceFor: img => validProofFor(img, dummyRegistry, "other-doc"),
  });
  assert.equal(wrongDocScene.video.foreground, "unassessed");

  // Mismatched nodeRef
  const wrongNodeScene = makeScene({
    imageResourceFor: img => validProofFor(img, dummyRegistry, "fixture-doc-1", {
      binding: { nodeRef: "wrong-node-ref" },
    }),
  });
  assert.equal(wrongNodeScene.video.foreground, "unassessed");

  // Mismatched currentSrc
  const wrongSrcScene = makeScene({
    imageResourceFor: img => validProofFor(img, dummyRegistry, "fixture-doc-1", {
      binding: { currentSrc: "https://fixture.test/other.jpg" },
    }),
  });
  assert.equal(wrongSrcScene.video.foreground, "unassessed");

  // Mismatched naturalWidth
  const wrongDimsScene = makeScene({
    imageResourceFor: img => validProofFor(img, dummyRegistry, "fixture-doc-1", {
      proof: { width: 800, height: 450 },
      binding: { naturalWidth: 800, naturalHeight: 450 },
    }),
  });
  assert.equal(wrongDimsScene.video.foreground, "unassessed");

  // Callback throwing an error (honest unavailable, no crash)
  const throwingScene = makeScene({
    imageResourceFor: () => { throw new Error("boundary read failed"); },
  });
  assert.equal(throwingScene.video.foreground, "unassessed");
});

test("radius or box mismatch between target and blocker ancestor cannot occlude", () => {
  // Radius mismatch: ancestor has 12px radii while video has 8px
  const radiusMismatchScene = makeScene({
    ancestorStyle: {
      ...roundedAncestorStyle,
      borderTopLeftRadius: "12px",
      borderTopRightRadius: "12px",
      borderBottomRightRadius: "12px",
      borderBottomLeftRadius: "12px",
    },
    imageResourceFor: (img) => validProofFor(img, createStableNodeRefRegistry("dummy")),
  });
  assert.equal(radiusMismatchScene.video.foreground, "unassessed");

  // Box mismatch: video style width is 500px while ancestor is 542px
  const boxMismatchScene = makeScene({
    targetStyle: {
      ...roundedTargetStyle,
      width: "500px",
    },
    imageResourceFor: (img) => validProofFor(img, createStableNodeRefRegistry("dummy")),
  });
  assert.equal(boxMismatchScene.video.foreground, "unassessed");
});

test("reverse native order keeps VIDEO not occluded", () => {
  const reverseScene = makeScene({
    reverseNativeOrder: true,
    imageResourceFor: (img) => validProofFor(img, createStableNodeRefRegistry("dummy")),
  });
  assert.notEqual(reverseScene.video.foreground, "occluded");
});

test("contain letterbox cannot be expanded; exact equal contain is positive", () => {
  // Letterbox: image aspect ratio 4:3 (640x480) inside 16:9 box (542x304.875) leaves bars
  const letterboxScene = makeScene({
    imageDims: { width: 640, height: 480 },
    imageResourceFor: (img) => validProofFor(img, createStableNodeRefRegistry("dummy"), "fixture-doc-1", {
      proof: { width: 640, height: 480 },
      binding: { naturalWidth: 640, naturalHeight: 480 },
    }),
  });
  assert.equal(letterboxScene.video.foreground, "unassessed");

  // Exact equal aspect: 640x360 matches 542x304.875 exactly (ratio 1.7777777...)
  const equalReg = createStableNodeRefRegistry("equal-scene");
  const exactScene = makeScene({
    registry: equalReg,
    imageDims: { width: 640, height: 360 },
    imageResourceFor: (img) => validProofFor(img, equalReg),
  });
  assert.equal(exactScene.video.foreground, "occluded");
});

test("existing G2 target own corner guard remains: rectangular subtitle stays visible", () => {
  const guardReg = createStableNodeRefRegistry("corner-guard");
  const sceneWithReg = makeScene({
    registry: guardReg,
    imageResourceFor: (img) => validProofFor(img, guardReg),
  });
  // VIDEO is occluded under valid proof
  assert.equal(sceneWithReg.video.foreground, "occluded");
  // Subtitle DIV (pointer-events: none, rectangular) still sees clear corners and stays visible
  assert.equal(sceneWithReg.subtitle.foreground, "visible");
  assert.equal(sceneWithReg.subtitleCandidate.status, "ok");
});
