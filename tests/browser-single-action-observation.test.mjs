import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_BASIC_KIND_PROFILE,
  createStableNodeRefRegistry,
} from "nnanything/browser-classify";
import {
  observeBrowserSingleAction,
  readSingleActionRequest,
  readSingleActionSnapshot,
} from "nnanything/browser-single-action";

const XHTML = "http://www.w3.org/1999/xhtml";
const viewport = { x: 0, y: 0, width: 800, height: 600 };
const zeroRect = { x: 0, y: 0, width: 0, height: 0 };
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
  maskImage: "none",
  webkitMaskImage: "none",
  backdropFilter: "none",
  webkitBackdropFilter: "none",
  filter: "none",
  mixBlendMode: "normal",
  isolation: "auto",
  contain: "none",
  willChange: "auto",
  contentVisibility: "visible",
  pointerEvents: "auto",
  cursor: "default",
  boxShadow: "none",
  textShadow: "none",
  outlineStyle: "none",
  outlineWidth: "0px",
  outlineColor: "rgba(0, 0, 0, 0)",
  borderImageSource: "none",
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  borderTopLeftRadius: "0px",
  borderTopRightRadius: "0px",
  borderBottomLeftRadius: "0px",
  borderBottomRightRadius: "0px",
};

function fakeElement({
  tagName,
  id = "",
  attributes = {},
  rect = { x: 0, y: 0, width: 100, height: 30 },
  text = null,
  hidden = false,
}) {
  const element = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    namespaceURI: XHTML,
    ownerDocument: null,
    parentElement: null,
    children: [],
    childNodes: [],
    childElementCount: 0,
    id,
    classList: [],
    clientLeft: 0,
    clientTop: 0,
    clientWidth: Math.round(rect.width),
    clientHeight: Math.round(rect.height),
    scrollLeft: 0,
    scrollTop: 0,
    isConnected: true,
    shadowRoot: null,
    styleOverrides: hidden ? { display: "none" } : {},
    getAttribute: name => Object.hasOwn(attributes, name) ? attributes[name] : null,
    hasAttribute: name => Object.hasOwn(attributes, name),
    getBoundingClientRect: () => hidden ? { ...zeroRect } : { ...rect },
    getClientRects: () => hidden ? [] : [{ ...rect }],
    matches: selector => {
      if (selector === ":read-write") return false;
      if (selector === ":disabled") {
        const nativeDisableable = new Set([
          "button",
          "fieldset",
          "input",
          "optgroup",
          "option",
          "select",
          "textarea",
        ]);
        if (!nativeDisableable.has(tagName)) return false;
        if (Object.hasOwn(attributes, "disabled")) return true;
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          if (ancestor.tagName.toLowerCase() !== "fieldset" || !ancestor.hasAttribute("disabled")) continue;
          const firstLegend = ancestor.children.find(child => child.tagName.toLowerCase() === "legend");
          let insideFirstLegend = false;
          for (let current = element; current; current = current.parentElement) {
            if (current === firstLegend) {
              insideFirstLegend = true;
              break;
            }
          }
          if (!insideFirstLegend) return true;
        }
        return false;
      }
      throw new Error(`unsupported selector ${selector}`);
    },
    querySelectorAll: () => [],
  };
  if (text !== null) {
    element.childNodes.push({ nodeType: 3, textContent: text, parentElement: element });
  }
  return element;
}

function attach(parent, children, document) {
  parent.children = children;
  parent.childNodes = [...children, ...parent.childNodes.filter(node => node.nodeType === 3)];
  parent.childElementCount = children.length;
  for (const child of children) {
    child.parentElement = parent;
    child.ownerDocument = document;
  }
}

function makeFixture({
  duplicateRegionIds = false,
  brokenControls = false,
  conflictingExpanded = false,
  noPointQueries = false,
  regionAHidden = true,
} = {}) {
  const html = fakeElement({ tagName: "html", rect: viewport });
  const body = fakeElement({ tagName: "body", rect: viewport });
  const scope = fakeElement({ tagName: "main", rect: viewport });
  const regionA = fakeElement({
    tagName: "section",
    id: "region-a",
    rect: { x: 20, y: 70, width: 240, height: 80 },
    hidden: regionAHidden,
    text: "Target region",
  });
  const regionB = fakeElement({
    tagName: "section",
    id: duplicateRegionIds ? "region-a" : "region-b",
    rect: { x: 300, y: 70, width: 240, height: 80 },
    text: "Adjacent region",
  });
  const controlA = fakeElement({
    tagName: "button",
    id: "control-a",
    attributes: {
      "aria-controls": brokenControls ? "missing-region" : "region-a region-b",
      "aria-expanded": "false",
    },
    rect: { x: 20, y: 20, width: 100, height: 30 },
    text: "Open A",
  });
  const controlB = fakeElement({
    tagName: "button",
    id: "control-b",
    attributes: {
      "aria-controls": conflictingExpanded ? "region-a" : "region-b",
      "aria-expanded": conflictingExpanded ? "true" : "false",
    },
    rect: { x: 300, y: 20, width: 100, height: 30 },
    text: "Open B",
  });
  const caption = fakeElement({
    tagName: "span",
    rect: { x: 130, y: 20, width: 100, height: 30 },
    text: "Caption",
  });
  const elements = [html, body, scope, regionA, regionB, controlA, controlB, caption];
  const document = {
    nodeType: 9,
    documentElement: html,
    body,
    baseURI: "https://fixture.test/single-action",
    compatMode: "CSS1Compat",
    scrollingElement: html,
    activeElement: body,
    designMode: "off",
    ...(noPointQueries ? {} : {
      elementsFromPoint(x, y) {
        return elements.filter(element => {
          const box = element.getBoundingClientRect();
          return x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height;
        }).reverse();
      },
    }),
  };
  attach(html, [body], document);
  attach(body, [scope], document);
  attach(scope, [controlA, caption, controlB, regionA, regionB], document);
  html.ownerDocument = document;
  body.ownerDocument = document;
  scope.ownerDocument = document;
  const window = {
    innerWidth: viewport.width,
    innerHeight: viewport.height,
    devicePixelRatio: 1,
    visualViewport: { scale: 1, offsetLeft: 0, offsetTop: 0 },
    getComputedStyle(element, pseudo) {
      if (pseudo !== undefined) return { ...baseStyle, content: "none" };
      return { ...baseStyle, ...element.styleOverrides };
    },
  };
  return { document, window, scope, regionA, regionB, controlA, controlB, caption, elements };
}

function observe(fixture, options = {}) {
  return observeBrowserSingleAction({
    document: fixture.document,
    window: fixture.window,
    registry: options.registry ?? createStableNodeRefRegistry("single-action"),
    scope: fixture.scope,
    regions: [fixture.regionA],
    documentRef: "document-intent",
    observationId: "observation-intent",
    revision: 7,
    l1Profile: DEFAULT_BASIC_KIND_PROFILE,
    ...options.overrides,
  });
}

function elementByTag(snapshot, tag) {
  return snapshot.elements.find(element => element.tag === tag);
}

test("observation preserves the hidden goal region and uses real L1 output", () => {
  const fixture = makeFixture();
  const snapshot = observe(fixture);
  const region = snapshot.regions.find(item => item.ref === snapshot.elements.find(element => element.tag === "section")?.ref);
  const button = elementByTag(snapshot, "button");

  assert.equal(snapshot.scopeRef.length > 0, true);
  assert.equal(snapshot.elements.some(element => element.ref === snapshot.scopeRef), true);
  assert.equal(snapshot.elements.some(element => element.tag === "span"), true);
  assert.equal(region?.rendered.status, "observed");
  assert.equal(region?.rendered.status === "observed" ? region.rendered.value : null, false);
  assert.equal(region?.expanded.status, "observed");
  assert.equal(region?.expanded.status === "observed" ? region.expanded.value : null, false);
  assert.equal(button?.basicKind, "button");
  assert.equal(button?.judgmentStatus, "judged");
  assert.equal(button?.controls.status, "observed");
  assert.equal(button?.controls.status === "observed" ? button.controls.value.length : 0, 2);
  assert.equal(readSingleActionRequest({
    goal: { kind: "SetExpanded", regionRef: region.ref, desired: true },
    satisfactionThreshold: 100,
    state: snapshot,
  }).goal.regionRef, region.ref);
});

test("multiple tied controls stay present and conflicting expanded facts become unknown", () => {
  const fixture = makeFixture({ conflictingExpanded: true });
  const snapshot = observe(fixture);
  const regionRef = snapshot.elements.find(element => element.tag === "section")?.ref;
  const region = snapshot.regions.find(item => item.ref === regionRef);
  const controls = snapshot.elements
    .filter(element => element.controls.status === "observed"
      && element.controls.value.includes(regionRef));

  assert.equal(controls.length, 2);
  assert.equal(region?.expanded.status, "unknown");
  assert.match(region?.expanded.status === "unknown" ? region.expanded.reason : "", /conflict/);
});

test("controller expansion and region presentation conflicts become unknown", () => {
  const fixture = makeFixture({ regionAHidden: false });
  const snapshot = observe(fixture);
  const region = snapshot.regions[0];

  assert.equal(region.rendered.status, "observed");
  assert.equal(region.rendered.status === "observed" ? region.rendered.value : null, true);
  assert.equal(region.expanded.status, "unknown");
  assert.match(region.expanded.status === "unknown" ? region.expanded.reason : "", /conflict/);
});

test("duplicate ids and broken aria-controls stay unknown without dropping elements", () => {
  for (const fixture of [
    makeFixture({ duplicateRegionIds: true }),
    makeFixture({ brokenControls: true }),
  ]) {
    const snapshot = observe(fixture);
    const firstButton = snapshot.elements.find(element => element.tag === "button");
    const region = snapshot.regions[0];
    assert.equal(firstButton?.controls.status, "unknown");
    assert.equal(region?.expanded.status, "unknown");
    assert.equal(snapshot.elements.filter(element => element.tag === "button").length, 2);
    assert.equal(snapshot.elements.some(element => element.tag === "span"), true);
  }
});

test("missing point measurement remains unknown instead of false", () => {
  const fixture = makeFixture({ noPointQueries: true });
  const snapshot = observe(fixture);
  const button = elementByTag(snapshot, "button");

  assert.equal(button?.hit.status, "unknown");
  assert.equal(button?.point.status, "unknown");
  assert.equal(button?.enabled.status, "observed");
  assert.equal(button?.enabled.status === "observed" ? button.enabled.value : null, true);
});

test("a transparent input interceptor prevents a covered target hit", () => {
  const fixture = makeFixture();
  fixture.controlA.styleOverrides.backgroundColor = "rgb(255, 255, 255)";
  const overlay = fakeElement({
    tagName: "div",
    rect: fixture.controlA.getBoundingClientRect(),
  });
  overlay.styleOverrides = {
    position: "absolute",
    zIndex: "10",
    backgroundColor: "rgba(0, 0, 0, 0)",
    pointerEvents: "auto",
  };
  attach(fixture.scope, [...fixture.scope.children, overlay], fixture.document);
  fixture.elements.push(overlay);

  const button = elementByTag(observe(fixture), "button");

  assert.equal(button?.hit.status, "observed");
  assert.equal(button?.hit.status === "observed" ? button.hit.value : null, false);
  assert.equal(button?.point.status, "unknown");
});

test("a descendant at the input point keeps the target hit", () => {
  const fixture = makeFixture();
  fixture.controlA.styleOverrides.backgroundColor = "rgb(255, 255, 255)";
  const descendant = fakeElement({
    tagName: "span",
    rect: fixture.controlA.getBoundingClientRect(),
  });
  attach(fixture.controlA, [descendant], fixture.document);
  fixture.elements.push(descendant);

  const button = elementByTag(observe(fixture), "button");

  assert.equal(button?.hit.status, "observed");
  assert.equal(button?.hit.status === "observed" ? button.hit.value : null, true);
  assert.equal(button?.point.status, "observed");
});

test("disabled fieldset descendants use the native effective disabled state", () => {
  const fixture = makeFixture();
  const fieldset = fakeElement({
    tagName: "fieldset",
    attributes: { disabled: "" },
    rect: { x: 10, y: 10, width: 130, height: 50 },
  });
  attach(
    fixture.scope,
    fixture.scope.children.map(child => child === fixture.controlA ? fieldset : child),
    fixture.document,
  );
  attach(fieldset, [fixture.controlA], fixture.document);
  fixture.elements.push(fieldset);

  const button = elementByTag(observe(fixture), "button");

  assert.equal(button?.enabled.status, "observed");
  assert.equal(button?.enabled.status === "observed" ? button.enabled.value : null, false);
});

test("a control in the first disabled fieldset legend remains enabled", () => {
  const fixture = makeFixture();
  const fieldset = fakeElement({
    tagName: "fieldset",
    attributes: { disabled: "" },
    rect: { x: 10, y: 10, width: 130, height: 50 },
  });
  const legend = fakeElement({
    tagName: "legend",
    rect: { x: 10, y: 10, width: 130, height: 50 },
  });
  attach(
    fixture.scope,
    fixture.scope.children.map(child => child === fixture.controlA ? fieldset : child),
    fixture.document,
  );
  attach(fieldset, [legend], fixture.document);
  attach(legend, [fixture.controlA], fixture.document);
  fixture.elements.push(fieldset, legend);

  const button = elementByTag(observe(fixture), "button");

  assert.equal(button?.enabled.status, "observed");
  assert.equal(button?.enabled.status === "observed" ? button.enabled.value : null, true);
});

test("an unavailable native disabled query remains unknown", () => {
  const fixture = makeFixture();
  const matches = fixture.controlA.matches;
  fixture.controlA.matches = selector => {
    if (selector === ":disabled") throw new Error("disabled query unavailable");
    return matches(selector);
  };

  const button = elementByTag(observe(fixture), "button");

  assert.equal(button?.enabled.status, "unknown");
  assert.match(button?.enabled.status === "unknown" ? button.enabled.reason : "", /disabled/);
});

test("readers reject bad goals, stale evidence, missing references and duplicate refs", () => {
  const fixture = makeFixture();
  const snapshot = observe(fixture);
  const regionRef = snapshot.elements.find(element => element.tag === "section").ref;
  const valid = {
    goal: { kind: "SetExpanded", regionRef, desired: true },
    satisfactionThreshold: 100,
    state: snapshot,
  };
  readSingleActionRequest(valid);

  for (const goal of [
    { kind: "ObserveExpanded", regionRef, desired: true },
    { kind: "SetExpanded", regionRef, desired: false },
  ]) {
    assert.throws(
      () => readSingleActionRequest({ ...valid, goal }),
      /SetExpanded|desired/,
    );
  }
  assert.throws(
    () => readSingleActionRequest({ ...valid, satisfactionThreshold: 99 }),
    /satisfactionThreshold/,
  );

  const stale = structuredClone(snapshot);
  stale.evidence[0].observationId = "older-observation";
  assert.throws(() => readSingleActionSnapshot(stale), /observationId/);

  const missing = structuredClone(snapshot);
  missing.evidence = missing.evidence.slice(1);
  assert.throws(() => readSingleActionSnapshot(missing), /unavailable evidence/);

  const duplicate = structuredClone(snapshot);
  duplicate.elements.push({ ...duplicate.elements[1] });
  assert.throws(() => readSingleActionSnapshot(duplicate), /duplicate element ref/);

  const posteriorLeak = structuredClone(snapshot);
  posteriorLeak.elements[0].isExpansionButton = true;
  assert.throws(() => readSingleActionSnapshot(posteriorLeak), /unsupported field/);
});

test("readers reject a goal region that was not explicitly bound into the observation", () => {
  const fixture = makeFixture();
  const snapshot = observe(fixture);
  const missingRegionRef = `${snapshot.scopeRef}-missing-region`;

  assert.throws(
    () => readSingleActionRequest({
      goal: { kind: "SetExpanded", regionRef: missingRegionRef, desired: true },
      satisfactionThreshold: 100,
      state: snapshot,
    }),
    /bound region|regions/,
  );
});
