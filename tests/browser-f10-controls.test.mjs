import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_BASIC_KIND_PROFILE,
  createStableNodeRefRegistry,
  stableNodeRefFor,
} from "nnanything/browser-classify";
import { observeBrowserSingleAction } from "nnanything/browser-single-action";

// F10 controls: aria-controls relations are observed independently from enabled.
// Missing, duplicate, unresolved, and out-of-scope targets stay distinguishable
// from an explicitly empty relation.

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

function makeFixture({ regions = [], outsideRegions = [], controls = [] } = {}) {
  const html = fakeElement({ tagName: "html", rect: viewport });
  const body = fakeElement({ tagName: "body", rect: viewport });
  const scope = fakeElement({ tagName: "main", rect: viewport });
  const regionElements = regions.map((spec, index) => fakeElement({
    tagName: "section",
    id: spec.id,
    rect: spec.rect ?? { x: 20 + index * 180, y: 120, width: 160, height: 80 },
    text: spec.text ?? spec.id,
    hidden: spec.hidden ?? false,
  }));
  const outsideElements = outsideRegions.map((spec, index) => fakeElement({
    tagName: "section",
    id: spec.id,
    rect: spec.rect ?? { x: 20 + index * 180, y: 240, width: 160, height: 80 },
    text: spec.text ?? spec.id,
    hidden: spec.hidden ?? false,
  }));
  const controlElements = controls.map((spec, index) => fakeElement({
    tagName: spec.tagName ?? "button",
    id: spec.id,
    attributes: spec.attributes ?? {},
    rect: spec.rect ?? { x: 20 + index * 180, y: 20, width: 160, height: 30 },
    text: spec.text ?? spec.id,
    hidden: spec.hidden ?? false,
  }));
  const elements = [html, body, scope, ...controlElements, ...regionElements, ...outsideElements];
  const document = {
    nodeType: 9,
    documentElement: html,
    body,
    baseURI: "https://fixture.test/f10-controls",
    compatMode: "CSS1Compat",
    scrollingElement: html,
    activeElement: body,
    designMode: "off",
    elementsFromPoint(x, y) {
      return elements.filter(element => {
        const box = element.getBoundingClientRect();
        return x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height;
      }).reverse();
    },
  };
  attach(html, [body], document);
  attach(body, [scope, ...outsideElements], document);
  attach(scope, [...controlElements, ...regionElements], document);
  for (const element of elements) element.ownerDocument = document;
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
  return {
    document,
    window,
    scope,
    regions: regionElements,
    outside: outsideElements,
    controls: controlElements,
  };
}

function observe(fixture) {
  const registry = createStableNodeRefRegistry("f10-controls");
  const snapshot = observeBrowserSingleAction({
    document: fixture.document,
    window: fixture.window,
    registry,
    scope: fixture.scope,
    regions: fixture.regions,
    documentRef: "document-f10",
    observationId: "observation-f10",
    revision: 1,
    l1Profile: DEFAULT_BASIC_KIND_PROFILE,
  });
  const byRef = new Map(snapshot.elements.map(item => [item.ref, item]));
  return {
    snapshot,
    ref: element => stableNodeRefFor(registry, element),
    element: element => byRef.get(stableNodeRefFor(registry, element)),
  };
}

test("F10 disabled control keeps an explicit controls relation", () => {
  const fixture = makeFixture({
    regions: [{ id: "panel" }],
    controls: [{
      id: "disabled-toggle",
      attributes: { "aria-controls": "panel", disabled: "" },
    }],
  });
  const observed = observe(fixture);
  const control = observed.element(fixture.controls[0]);
  const panelRef = observed.ref(fixture.regions[0]);

  assert.ok(control);
  assert.equal(control.enabled.status, "observed");
  assert.equal(control.enabled.value, false);
  assert.equal(control.controls.status, "observed");
  assert.deepEqual(control.controls.value, [panelRef]);
});

test("F10 enabled state does not prove a controls relation", () => {
  const fixture = makeFixture({
    regions: [{ id: "panel" }],
    controls: [{ id: "enabled-toggle" }],
  });
  const observed = observe(fixture);
  const control = observed.element(fixture.controls[0]);

  assert.ok(control);
  assert.equal(control.enabled.status, "observed");
  assert.equal(control.enabled.value, true);
  assert.equal(control.controls.status, "observed");
  assert.deepEqual(control.controls.value, []);
  assert.notEqual(control.controls.status, "unknown");
});

test("F10 declared controls relations are directed and swap with the declaration", () => {
  const fixture = makeFixture({
    regions: [{ id: "alpha" }, { id: "beta" }],
    controls: [
      { id: "toggle-alpha", attributes: { "aria-controls": "beta" } },
      { id: "toggle-beta", attributes: { "aria-controls": "alpha" } },
    ],
  });
  const observed = observe(fixture);
  const alphaControl = observed.element(fixture.controls[0]);
  const betaControl = observed.element(fixture.controls[1]);
  const alphaRef = observed.ref(fixture.regions[0]);
  const betaRef = observed.ref(fixture.regions[1]);

  assert.ok(alphaControl);
  assert.ok(betaControl);
  assert.equal(alphaControl.controls.status, "observed");
  assert.deepEqual(alphaControl.controls.value, [betaRef]);
  assert.equal(betaControl.controls.status, "observed");
  assert.deepEqual(betaControl.controls.value, [alphaRef]);
  assert.notDeepEqual(alphaControl.controls.value, betaControl.controls.value);
});

test("F10 controls target outside the observed scope stays unknown", () => {
  const fixture = makeFixture({
    regions: [{ id: "inside-panel" }],
    outsideRegions: [{ id: "outside-panel" }],
    controls: [{
      id: "outside-toggle",
      attributes: { "aria-controls": "outside-panel" },
    }],
  });
  const observed = observe(fixture);
  const control = observed.element(fixture.controls[0]);
  const outsideRef = observed.ref(fixture.outside[0]);

  assert.ok(control);
  assert.equal(control.controls.status, "unknown");
  assert.equal(control.controls.reason, "aria_controls_target_outside_scope");
  assert.equal(Object.hasOwn(control.controls, "value"), false);
  assert.equal(observed.snapshot.elements.some(item => item.ref === outsideRef), false);
});

test("F10 missing aria-controls is an observed empty relation, not unknown", () => {
  const fixture = makeFixture({
    controls: [{ id: "plain-toggle" }],
  });
  const observed = observe(fixture);
  const control = observed.element(fixture.controls[0]);

  assert.ok(control);
  assert.equal(control.controls.status, "observed");
  assert.deepEqual(control.controls.value, []);
  assert.notEqual(control.controls.status, "unknown");

  const evidence = observed.snapshot.evidence.find(entry =>
    entry.source === "dom.aria-controls" && entry.fact.ref === control.ref);
  assert.ok(evidence);
  assert.equal(evidence.fact.value, null);
  assert.deepEqual(evidence.fact.targets, []);
});

test("F10 duplicate tokens and unresolved ids stay unknown, not empty", () => {
  const fixture = makeFixture({
    regions: [{ id: "panel" }],
    controls: [
      { id: "duplicate-token", attributes: { "aria-controls": "panel panel" } },
      { id: "unresolved-token", attributes: { "aria-controls": "missing-panel" } },
    ],
  });
  const observed = observe(fixture);
  const duplicate = observed.element(fixture.controls[0]);
  const unresolved = observed.element(fixture.controls[1]);

  assert.ok(duplicate);
  assert.ok(unresolved);
  assert.equal(duplicate.controls.status, "unknown");
  assert.equal(duplicate.controls.reason, "duplicate_aria_controls_idref");
  assert.equal(Object.hasOwn(duplicate.controls, "value"), false);
  assert.equal(unresolved.controls.status, "unknown");
  assert.equal(unresolved.controls.reason, "broken_aria_controls_idref");
  assert.equal(Object.hasOwn(unresolved.controls, "value"), false);
});
