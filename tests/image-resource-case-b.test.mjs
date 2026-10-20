import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// Run the public source consumer without writing dist. The project package
// entry points use dist; this test resolves the same lib modules directly.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith(".")
      && specifier.endsWith(".js")
      && context.parentURL?.includes("/lib/")
    ) {
      try {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      } catch {
        // Fall through to the original resolve for non-TypeScript targets.
      }
    }
    return nextResolve(specifier, context);
  },
});

const {
  createStableNodeRefRegistry,
  observeLiveDom,
  stableNodeRefFor,
} = await import("../lib/adapters/browser/live-dom.ts");
const { observeJpegImageResource } = await import(
  "../lib/adapters/browser/image-resource.ts"
);

const JPEG_BYTES = new Uint8Array(Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==",
  "base64",
));
const TRANSPARENT_PNG = new Uint8Array(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
));

const viewport = { x: 0, y: 0, width: 1200, height: 900 };
const xhtml = "http://www.w3.org/1999/xhtml";
const targetRect = { x: 342.5, y: 480, width: 168, height: 224 };
const rawImageRect = { ...targetRect, height: 365.015625 };

const baseStyle = {
  display: "block",
  visibility: "visible",
  position: "static",
  zIndex: "auto",
  opacity: "1",
  width: "168px",
  height: "224px",
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
  backgroundOrigin: "padding-box",
  backgroundSize: "auto",
  backgroundPosition: "0% 0%",
  backgroundRepeat: "repeat",
  backgroundAttachment: "scroll",
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

function element({
  tagName = "DIV",
  rect,
  parent = null,
  style = {},
  native = {},
}) {
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
    testStyle: style,
    ...native,
  };
}

function setChildren(parent, children) {
  parent.children = children;
  parent.childNodes = children;
  parent.childElementCount = children.length;
}

function makeWbHomeScene() {
  const registry = createStableNodeRefRegistry("wb-home-case-b");
  const html = element({ tagName: "HTML", rect: viewport });
  const shared = element({
    rect: targetRect,
    parent: html,
    style: {
      position: "relative",
      overflowX: "hidden",
      overflowY: "hidden",
      borderTopLeftRadius: "8px",
      borderTopRightRadius: "8px",
      borderBottomRightRadius: "8px",
      borderBottomLeftRadius: "8px",
    },
  });
  const target = element({
    rect: targetRect,
    parent: shared,
    style: {
      position: "absolute",
      pointerEvents: "none",
    },
  });
  const imageBranch = element({
    rect: targetRect,
    parent: shared,
    style: {
      position: "absolute",
      zIndex: "3",
      overflowX: "hidden",
      overflowY: "hidden",
      borderTopLeftRadius: "8px",
      borderTopRightRadius: "8px",
      borderBottomRightRadius: "8px",
      borderBottomLeftRadius: "8px",
    },
  });
  const image = element({
    tagName: "IMG",
    rect: rawImageRect,
    parent: imageBranch,
    style: {
      width: "168px",
      height: "365.015625px",
      overflowX: "clip",
      overflowY: "clip",
      overflowClipMargin: "content-box",
      objectFit: "cover",
      objectPosition: "50% 50%",
    },
    native: {
      complete: true,
      naturalWidth: 1,
      naturalHeight: 1,
      currentSrc: "https://fixture.test/wb-home-current.jpg",
    },
  });

  setChildren(shared, [target, imageBranch]);
  setChildren(imageBranch, [image]);
  setChildren(html, [shared]);

  const styles = new Map([
    [html, baseStyle],
    [shared, { ...baseStyle, ...shared.testStyle }],
    [target, { ...baseStyle, ...target.testStyle }],
    [imageBranch, { ...baseStyle, ...imageBranch.testStyle }],
    [image, { ...baseStyle, ...image.testStyle }],
  ]);
  const document = {
    documentElement: html,
    body: html,
    baseURI: "https://fixture.test/page",
    elementsFromPoint: (x, y) => {
      const inside = x >= targetRect.x
        && x < targetRect.x + targetRect.width
        && y >= targetRect.y
        && y < targetRect.y + targetRect.height;
      return inside ? [image, target, imageBranch, shared, html] : [];
    },
  };
  const capture = (imageResourceFor) => observeLiveDom({
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
    snapshotRef: "wb-home-case-b",
    documentRef: "fixture-doc-1",
    ...(imageResourceFor === undefined ? {} : { imageResourceFor }),
  });
  return {
    registry,
    image,
    target,
    capture,
  };
}

function bindingFor(scene) {
  return {
    documentRef: "fixture-doc-1",
    nodeRef: stableNodeRefFor(scene.registry, scene.image),
    loadGeneration: 2,
    currentSrc: scene.image.currentSrc,
    complete: true,
    naturalWidth: 1,
    naturalHeight: 1,
  };
}

async function observeResource(scene, {
  bytes = JPEG_BYTES,
  decoded = { complete: true, width: 1, height: 1 },
} = {}) {
  const binding = bindingFor(scene);
  return observeJpegImageResource({
    binding,
    readCurrentBinding: async () => ({ ...binding }),
    readBytes: async () => ({
      bytes,
      provenance: { kind: "browser-readable-response" },
    }),
    decodeJpeg: async () => decoded,
  });
}

function targetNode(snapshot, scene) {
  const nodeRef = stableNodeRefFor(scene.registry, scene.target);
  return snapshot.observation.nodes.find(node => node.nodeRef === nodeRef);
}

test("proven JPEG resource closes a clipped WB-home IMG cover pair", async () => {
  const scene = makeWbHomeScene();
  const observation = await observeResource(scene);
  assert.equal(observation.status, "proven");

  let reads = 0;
  let forwarded;
  const snapshot = scene.capture(image => {
    reads += 1;
    forwarded = image;
    return observation;
  });
  const target = targetNode(snapshot, scene);

  assert.equal(reads, 1);
  assert.equal(forwarded, scene.image);
  assert.equal(target.foreground, "occluded");
  assert.deepEqual(target.exposedRects, []);
  assert.equal(
    JSON.stringify([...snapshot.properties.values()]).includes("wb-home-current.jpg"),
    false,
  );
});

test("unavailable JPEG observations leave the clipped WB-home surface unchanged", async () => {
  const cases = [
    {
      name: "unsupported format",
      options: { bytes: TRANSPARENT_PNG },
      reason: "unsupported-format",
    },
    {
      name: "incomplete decode",
      options: { decoded: { complete: false, width: 1, height: 1 } },
      reason: "incomplete",
    },
    {
      name: "dimension mismatch",
      options: { decoded: { complete: true, width: 2, height: 2 } },
      reason: "dimension-mismatch",
    },
  ];

  for (const item of cases) {
    const scene = makeWbHomeScene();
    const observation = await observeResource(scene, item.options);
    assert.deepEqual(
      observation,
      { status: "unavailable", reason: item.reason },
      item.name,
    );

    let reads = 0;
    const snapshot = scene.capture(() => {
      reads += 1;
      return observation;
    });
    const target = targetNode(snapshot, scene);
    assert.equal(reads, 1, item.name);
    assert.equal(target.foreground, "unassessed", item.name);
    assert.equal(target.exposedRects, null, item.name);
  }
});

test("removing the producer keeps the prior honest WB-home surface", () => {
  const scene = makeWbHomeScene();
  const snapshot = scene.capture();
  const target = targetNode(snapshot, scene);

  assert.equal(target.foreground, "unassessed");
  assert.equal(target.exposedRects, null);
});
