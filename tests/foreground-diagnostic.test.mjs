import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createStableNodeRefRegistry,
  observeLiveDom,
  stableNodeRefFor,
} from "nnanything/browser-classify";

const viewport = { x: 0, y: 0, width: 600, height: 500 };
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
  boxShadow: "none",
  outlineStyle: "none",
  outlineWidth: "0px",
  outlineColor: "rgba(0, 0, 0, 0)",
  mixBlendMode: "normal",
  isolation: "auto",
  contain: "none",
  pointerEvents: "auto",
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
  cursor: "auto",
  content: "none",
};

function fixtureElement(key, tagName, rect, parent = null, text = null, overrides = {}) {
  return {
    nodeType: 1,
    tagName,
    key,
    parentElement: parent,
    children: [],
    childNodes: text === null ? [] : [{ nodeType: 3, textContent: text }],
    childElementCount: 0,
    id: "",
    classList: [],
    isConnected: true,
    getAttribute: () => null,
    hasAttribute: () => false,
    getBoundingClientRect: () => ({ ...rect }),
    getClientRects: () => [{ ...rect }],
    querySelectorAll: () => [],
    ...overrides,
  };
}

function contains(rect, x, y) {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function makeFixture() {
  const root = fixtureElement("root", "HTML", viewport);
  const uncertain = fixtureElement(
    "uncertain",
    "IMG",
    { x: 100, y: 100, width: 40, height: 100 },
    root,
  );
  const opaque = fixtureElement(
    "opaque",
    "DIV",
    { x: 100, y: 100, width: 200, height: 100 },
    root,
  );
  const blocked = fixtureElement(
    "blocked",
    "DIV",
    { x: 100, y: 100, width: 200, height: 100 },
    root,
    "blocked",
  );
  const probe = fixtureElement(
    "probe",
    "DIV",
    { x: 100, y: 300, width: 120, height: 40 },
    root,
    "readable",
  );
  const unselected = fixtureElement(
    "unselected",
    "DIV",
    { x: 350, y: 300, width: 120, height: 40 },
    root,
    "not selected",
  );
  const children = [uncertain, opaque, blocked, probe, unselected];
  root.children = children;
  root.childNodes = children;
  root.childElementCount = children.length;
  const styles = new Map([
    [root, baseStyle],
    [uncertain, { ...baseStyle, position: "relative", zIndex: "5" }],
    [opaque, {
      ...baseStyle,
      backgroundColor: "rgb(20, 20, 24)",
      position: "relative",
      zIndex: "4",
    }],
    [blocked, baseStyle],
    [probe, baseStyle],
    [unselected, baseStyle],
  ]);
  const document = {
    documentElement: root,
    body: root,
    baseURI: "https://fixture.test/page",
    elementsFromPoint: (x, y) => {
      const hits = [];
      if (contains(uncertain.getBoundingClientRect(), x, y)) hits.push(uncertain);
      if (contains(opaque.getBoundingClientRect(), x, y)) hits.push(opaque);
      if (contains(blocked.getBoundingClientRect(), x, y)) hits.push(blocked);
      if (contains(probe.getBoundingClientRect(), x, y)) hits.push(probe);
      if (contains(unselected.getBoundingClientRect(), x, y)) hits.push(unselected);
      hits.push(root);
      return hits;
    },
  };
  return {
    root,
    uncertain,
    opaque,
    blocked,
    probe,
    unselected,
    document,
    window: {
      innerWidth: viewport.width,
      innerHeight: viewport.height,
      getComputedStyle: (element, pseudo) => {
        if (pseudo) return { content: "none" };
        return styles.get(element) ?? baseStyle;
      },
    },
  };
}

function observe(fixture, registry, diagnostic) {
  return observeLiveDom({
    document: fixture.document,
    window: fixture.window,
    registry,
    excludeRoot: null,
    snapshotRef: "foreground-diagnostic",
    documentRef: "fixture",
    ...(diagnostic === undefined ? {} : { diagnostic }),
  });
}

test("diagnostic is opt-in and preserves normal observations", () => {
  const fixture = makeFixture();
  const registry = createStableNodeRefRegistry("diagnostic-parity");
  const baseline = observe(fixture, registry);
  const blockedRef = stableNodeRefFor(registry, fixture.blocked);
  const probeRef = stableNodeRefFor(registry, fixture.probe);
  const events = [];
  const withDiagnostic = observe(fixture, registry, {
    selectedRefs: new Set([blockedRef, probeRef]),
    callback: (event) => events.push(event),
  });
  const withoutCallback = observe(fixture, registry, {
    selectedRefs: new Set([blockedRef, probeRef]),
  });

  assert.deepEqual(withDiagnostic.observation, baseline.observation);
  assert.deepEqual(withDiagnostic.evidence, baseline.evidence);
  assert.deepEqual(withDiagnostic.properties, baseline.properties);
  assert.deepEqual(withoutCallback.observation, baseline.observation);
  assert.deepEqual(withoutCallback.evidence, baseline.evidence);
  assert.deepEqual(withoutCallback.properties, baseline.properties);
  assert.ok(events.length > 0);
});

test("diagnostic reports only selected targets and exposes first-decision facts", () => {
  const fixture = makeFixture();
  const registry = createStableNodeRefRegistry("diagnostic-events");
  const blockedRef = stableNodeRefFor(registry, fixture.blocked);
  const probeRef = stableNodeRefFor(registry, fixture.probe);
  const uncertainRef = stableNodeRefFor(registry, fixture.uncertain);
  const opaqueRef = stableNodeRefFor(registry, fixture.opaque);
  const unselectedRef = stableNodeRefFor(registry, fixture.unselected);
  const events = [];
  const result = observe(fixture, registry, {
    selectedRefs: new Set([blockedRef, probeRef]),
    callback: (event) => events.push(event),
  });

  assert.ok(events.every((event) => event.targetRef === blockedRef || event.targetRef === probeRef));
  assert.equal(events.some((event) => event.targetRef === unselectedRef), false);

  const initial = events.find((event) => event.phase === "initial" && event.targetRef === blockedRef);
  assert.ok(initial);
  assert.deepEqual(initial.clippedRect, { x: 100, y: 100, width: 200, height: 100 });
  assert.equal(initial.visibleRects.length, 1);
  assert.equal(initial.surface.kind, "uncertain");

  const uncertainBlocker = events.find((event) => event.phase === "blocker"
    && event.targetRef === blockedRef && event.blockerRef === uncertainRef);
  assert.ok(uncertainBlocker);
  assert.equal(uncertainBlocker.kind, "uncertain");
  assert.equal(uncertainBlocker.proven, false);
  assert.equal(uncertainBlocker.nativeBefore, true);
  assert.equal(uncertainBlocker.pointerBefore, true);
  assert.equal(uncertainBlocker.outcome, "uncertain_surface_subtracted");
  assert.equal(uncertainBlocker.remainingBefore, 1);
  assert.equal(uncertainBlocker.remainingAfter, 1);

  const opaqueBlocker = events.find((event) => event.phase === "blocker"
    && event.targetRef === blockedRef && event.blockerRef === opaqueRef);
  assert.ok(opaqueBlocker);
  assert.equal(opaqueBlocker.kind, "blocker");
  assert.equal(opaqueBlocker.proven, true);
  assert.equal(opaqueBlocker.nativeBefore, true);
  assert.equal(opaqueBlocker.pointerBefore, true);
  assert.equal(opaqueBlocker.outcome, "proven_surface_subtracted");
  assert.equal(opaqueBlocker.remainingBefore, 1);
  assert.equal(opaqueBlocker.remainingAfter, 0);
  assert.equal(opaqueBlocker.provenRemainingBefore, 1);
  assert.equal(opaqueBlocker.provenRemainingAfter, 0);

  const blockedFinal = events.find((event) => event.phase === "final" && event.targetRef === blockedRef);
  assert.deepEqual(blockedFinal, {
    phase: "final",
    targetRef: blockedRef,
    foreground: "occluded",
    exposedRects: [],
  });

  const pointProbe = events.find((event) => event.phase === "point_probe" && event.targetRef === probeRef);
  assert.ok(pointProbe);
  assert.deepEqual(pointProbe.point, { x: 160, y: 320 });
  assert.equal(pointProbe.chosenOwnerRef, probeRef);
  assert.equal(pointProbe.exposed, true);
  assert.ok(pointProbe.hitRefs.includes(probeRef));

  const probeFinal = events.find((event) => event.phase === "final" && event.targetRef === probeRef);
  assert.equal(probeFinal.foreground, "visible");
  assert.equal(probeFinal.exposedRects.length, 1);
  assert.equal(result.observation.nodes.find((node) => node.nodeRef === blockedRef).foreground, "occluded");
});

test("diagnostic callback errors propagate without conversion", () => {
  const fixture = makeFixture();
  const registry = createStableNodeRefRegistry("diagnostic-error");
  const blockedRef = stableNodeRefFor(registry, fixture.blocked);

  assert.throws(
    () => observe(fixture, registry, {
      selectedRefs: new Set([blockedRef]),
      callback: () => {
        throw new Error("diagnostic callback failure");
      },
    }),
    /diagnostic callback failure/,
  );
});
