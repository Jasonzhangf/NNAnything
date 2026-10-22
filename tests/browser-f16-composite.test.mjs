import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_BASIC_KIND_PROFILE,
  createStableNodeRefRegistry,
  observeLiveDom,
  stableNodeRefFor,
} from "nnanything/browser-classify";
import {
  BROWSER_RECEIPT_HEADS,
  BROWSER_RECEIPT_SCHEMA,
  BROWSER_RECEIPT_WIRES,
} from "nnanything/browser-receipt";
import { observeBrowserSingleAction } from "nnanything/browser-single-action";

import {
  F16_SECTIONS,
  composeBrowserF16,
} from "../playground/browser/f16-composite.mjs";

// F16 composite consumer: base facts stay separated by identity, qualification,
// relation, event and attribute change. No member score aggregation and no
// second-layer training or purpose inference is allowed here.

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
  backgroundClip: "border-box",
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

function makeFixture() {
  const html = fakeElement({ tagName: "html", rect: viewport });
  const body = fakeElement({ tagName: "body", rect: viewport });
  const scope = fakeElement({ tagName: "main", rect: viewport });
  // The caption is traversed before the button so aria-labelledby can resolve
  // its node ref without matching by text.
  const caption = fakeElement({
    tagName: "span",
    id: "caption",
    rect: { x: 20, y: 60, width: 160, height: 20 },
    text: "Caption",
  });
  const button = fakeElement({
    tagName: "button",
    id: "toggle",
    attributes: {
      "aria-controls": "panel",
      "aria-labelledby": "caption",
      disabled: "",
    },
    rect: { x: 20, y: 20, width: 160, height: 30 },
    text: "Toggle",
  });
  const panel = fakeElement({
    tagName: "section",
    id: "panel",
    rect: { x: 20, y: 120, width: 160, height: 80 },
    text: "Panel",
  });
  const elements = [html, body, scope, caption, button, panel];
  const byId = new Map(elements.filter(element => element.id).map(element => [element.id, element]));
  const document = {
    nodeType: 9,
    documentElement: html,
    body,
    baseURI: "https://fixture.test/f16-composite",
    compatMode: "CSS1Compat",
    scrollingElement: html,
    activeElement: body,
    designMode: "off",
    getElementById: id => byId.get(id) ?? null,
    querySelectorAll: () => [],
    elementsFromPoint(x, y) {
      return elements.filter(element => {
        const box = element.getBoundingClientRect();
        return x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height;
      }).reverse();
    },
  };
  attach(html, [body], document);
  attach(body, [scope], document);
  attach(scope, [caption, button, panel], document);
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
  return { document, window, scope, caption, button, panel };
}

function observe(fixture) {
  const registry = createStableNodeRefRegistry("f16");
  const snapshot = observeBrowserSingleAction({
    document: fixture.document,
    window: fixture.window,
    registry,
    scope: fixture.scope,
    regions: [fixture.panel],
    documentRef: "document-f16",
    observationId: "observation-f16",
    revision: 1,
    l1Profile: DEFAULT_BASIC_KIND_PROFILE,
  });
  const live = observeLiveDom({
    document: fixture.document,
    window: fixture.window,
    registry,
    excludeRoot: null,
    snapshotRef: "f16-live",
    documentRef: "document-f16",
  });
  return {
    registry,
    snapshot,
    labels: [...live.evidence.values()],
    refOf: element => stableNodeRefFor(registry, element),
  };
}

function receiptProfile() {
  return {
    schema: BROWSER_RECEIPT_SCHEMA,
    heads: [...BROWSER_RECEIPT_HEADS],
    wires: [...BROWSER_RECEIPT_WIRES],
    weights: [
      [0, 20, -20],
      [0, 0, 10],
      [5, -10, 0],
    ],
    state: { calibration: "uncalibrated", application: "not_applied" },
  };
}

function node(nodeRef, attributes) {
  return {
    nodeRef,
    parentRef: null,
    tag: "input",
    role: null,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    fragments: [{ x: 0, y: 0, width: 10, height: 10 }],
    clippedRect: { x: 0, y: 0, width: 10, height: 10 },
    attributes,
  };
}

function attributeSide(nodeValue, observationId, revision, options = {}) {
  const {
    inputValue,
    documentRef = "document-f16",
    scopeRef = "scope-f16",
    ...stateOverrides
  } = options;
  const side = {
    state: {
      documentRef,
      scopeRef,
      observationId,
      revision,
      ...stateOverrides,
    },
    snapshot: {
      observation: { nodes: [nodeValue] },
    },
  };
  if (Object.hasOwn(options, "inputValue")) {
    side.snapshot.evidence = new Map([[
      nodeValue.nodeRef,
      { nodeRef: nodeValue.nodeRef, inputValue },
    ]]);
  }
  return side;
}

function find(section, predicate) {
  const found = section.find(predicate);
  assert.ok(found, `missing entry for ${predicate}`);
  return found;
}

function eventEpisode(buttonRef, panelRef) {
  const error = { code: "executor_rejected", message: "executor rejected after dispatch" };
  return {
    prediction: null,
    invocation: {
      kind: "click",
      targetRef: buttonRef,
      point: { x: 100, y: 35 },
      documentRef: "document-f16",
      observationId: "observation-f16",
      revision: 1,
    },
    receipt: {
      dispatched: true,
      ok: false,
      effectKnowledge: "unknown",
      source: "fixture-executor",
      error,
    },
    dispatchState: "dispatched",
    effectKnowledge: "unknown",
    newState: null,
    satisfaction: null,
    achieved: false,
    error,
    collectionError: null,
    executionErrors: [error],
    observationFeedback: {
      obligation: {
        conditionRef: "goal.region.expanded",
        method: "browser.observe",
        subjectRef: panelRef,
        scopeRef: buttonRef,
        requiredFacts: ["expanded"],
        freshness: "after_action",
      },
      status: "failed",
      observationId: null,
      evidenceRefs: [],
      unmetFacts: ["expanded"],
      errors: [{ code: "post_observation_failed", message: "sensor unavailable" }],
    },
  };
}

test("F16.1 disabled button keeps identity, qualification and controls facts separate", () => {
  const fixture = makeFixture();
  const observed = observe(fixture);
  const buttonRef = observed.refOf(fixture.button);
  const panelRef = observed.refOf(fixture.panel);
  const composite = composeBrowserF16({ snapshot: observed.snapshot, labels: observed.labels });

  const identity = find(composite.identity, item =>
    item.nodeRef === buttonRef && item.source === "browser-single-action:basicKind");
  assert.equal(identity.fact.basicKind, "button");
  assert.equal(identity.fact.judgmentStatus, "judged");

  const enabled = find(composite.qualification, item =>
    item.nodeRef === buttonRef && item.source === "browser-single-action:enabled");
  assert.equal(enabled.fact.status, "observed");
  assert.equal(enabled.fact.value, false);

  const controls = find(composite.relation, item =>
    item.nodeRef === buttonRef && item.source === "browser-single-action:controls");
  assert.equal(controls.fact.status, "observed");
  assert.equal(controls.targetRef, panelRef);

  // Disabled and controls are independent entries; neither overwrites the other.
  assert.notEqual(enabled, controls);
  assert.equal(composite.qualification.includes(controls), false);
  assert.equal(composite.relation.includes(enabled), false);
});

test("F16.2 explicit failure and unknown effects are reported side by side", () => {
  const fixture = makeFixture();
  const observed = observe(fixture);
  const buttonRef = observed.refOf(fixture.button);
  const panelRef = observed.refOf(fixture.panel);
  const episode = eventEpisode(buttonRef, panelRef);
  const composite = composeBrowserF16({
    snapshot: observed.snapshot,
    receipt: {
      nodeRef: buttonRef,
      input: { receipt: episode.receipt },
      profile: receiptProfile(),
    },
    episode,
  });

  const predicted = find(composite.event, item =>
    item.source === "browser-receipt:predictBrowserReceipt");
  assert.equal(predicted.fact.head, "explicit_failure");
  assert.equal(predicted.fact.status, "predicted");

  const effects = find(composite.event, item =>
    item.source === "browser-single-action:effectKnowledge");
  assert.equal(effects.fact.effectKnowledge, "unknown");

  const feedback = find(composite.event, item =>
    item.source === "browser-single-action:observationFeedback");
  assert.equal(feedback.fact.status, "failed");

  // The failure receipt and the unknown effect remain separate facts.
  assert.notEqual(predicted, effects);
  assert.equal(predicted.fact.head, "explicit_failure");
  assert.equal(effects.fact.effectKnowledge, "unknown");
});

test("F16.3 receipt success and unchanged attributes coexist without inference", () => {
  const before = node("node-1", { "aria-expanded": "true", checked: true });
  const after = node("node-1", { "aria-expanded": "true", checked: true });
  const composite = composeBrowserF16({
    receipt: {
      nodeRef: "node-1",
      input: { receipt: { ok: true } },
      profile: receiptProfile(),
    },
    attributeChange: {
      before: attributeSide(before, "f16-attribute-before", 1),
      after: attributeSide(after, "f16-attribute-after", 2),
      attributes: ["aria-expanded"],
    },
  });

  const success = find(composite.event, item =>
    item.source === "browser-receipt:predictBrowserReceipt");
  assert.equal(success.fact.head, "explicit_success");

  const unchanged = find(composite.attributeChange, item => item.nodeRef === "node-1");
  assert.equal(unchanged.fact.attribute, "aria-expanded");
  assert.equal(unchanged.fact.state, "unchanged");

  // Neither fact is used to derive the other.
  assert.equal(JSON.stringify(success.fact).includes("unchanged"), false);
  assert.equal(JSON.stringify(unchanged.fact).includes("explicit_success"), false);
});

test("F16.4 label and controls relations keep distinct target refs", () => {
  const fixture = makeFixture();
  const observed = observe(fixture);
  const buttonRef = observed.refOf(fixture.button);
  const panelRef = observed.refOf(fixture.panel);
  const captionRef = observed.refOf(fixture.caption);
  const composite = composeBrowserF16({ snapshot: observed.snapshot, labels: observed.labels });

  const controls = find(composite.relation, item =>
    item.nodeRef === buttonRef && item.source === "browser-single-action:controls");
  const label = find(composite.relation, item =>
    item.nodeRef === buttonRef && item.source === "browser-classify:accessibleName");

  assert.equal(controls.targetRef, panelRef);
  assert.equal(label.targetRef, captionRef);
  assert.notEqual(controls.targetRef, label.targetRef);
  assert.equal(label.fact.labelledByRefs.includes(captionRef), true);
});

test("F16.5 output carries no aggregated satisfaction field", () => {
  const fixture = makeFixture();
  const observed = observe(fixture);
  const buttonRef = observed.refOf(fixture.button);
  const panelRef = observed.refOf(fixture.panel);
  const composite = composeBrowserF16({
    snapshot: observed.snapshot,
    labels: observed.labels,
    receipt: {
      nodeRef: buttonRef,
      input: { receipt: { ok: true } },
      profile: receiptProfile(),
    },
    episode: eventEpisode(buttonRef, panelRef),
    attributeChange: {
      before: attributeSide(node("node-1", { "aria-expanded": "true" }), "f16-before-five", 1),
      after: attributeSide(node("node-1", { "aria-expanded": "true" }), "f16-after-five", 2),
      attributes: ["aria-expanded"],
    },
  });

  assert.deepEqual(Object.keys(composite), [...F16_SECTIONS]);
  assert.equal(JSON.stringify(composite).includes("satisfaction"), false);
  for (const section of F16_SECTIONS) {
    for (const item of composite[section]) {
      assert.equal(Object.hasOwn(item, "satisfaction"), false);
      assert.equal(Object.hasOwn(item.fact ?? {}, "satisfaction"), false);
    }
  }
});

test("F16.6 original facts and member outputs stay traceable", () => {
  const fixture = makeFixture();
  const observed = observe(fixture);
  const buttonRef = observed.refOf(fixture.button);
  const panelRef = observed.refOf(fixture.panel);
  const composite = composeBrowserF16({
    snapshot: observed.snapshot,
    labels: observed.labels,
    receipt: {
      nodeRef: buttonRef,
      input: { receipt: { ok: false } },
      profile: receiptProfile(),
    },
    episode: eventEpisode(buttonRef, panelRef),
    attributeChange: {
      before: attributeSide(node("node-1", { "aria-expanded": "false" }), "f16-before-six", 1),
      after: attributeSide(node("node-1", { "aria-expanded": "true" }), "f16-after-six", 2),
    },
  });

  for (const section of F16_SECTIONS) {
    assert.ok(composite[section].length > 0, `section ${section} must not be empty`);
    for (const item of composite[section]) {
      assert.equal(Object.hasOwn(item, "nodeRef"), true);
      assert.equal(typeof item.source, "string");
      assert.ok(item.source.length > 0);
      assert.equal(Object.hasOwn(item, "fact"), true);
      assert.equal(Array.isArray(item.evidence), true);
    }
  }

  const enabled = find(composite.qualification, item =>
    item.nodeRef === buttonRef && item.source === "browser-single-action:enabled");
  assert.ok(enabled.evidence.length > 0);
  assert.ok(enabled.evidence.every(item =>
    typeof item.source === "string" && Object.hasOwn(item, "fact")));

  const receipt = find(composite.event, item =>
    item.source === "browser-receipt:predictBrowserReceipt");
  assert.deepEqual(receipt.evidence, [{ receipt: { ok: false } }]);
});

test("F16.7 input value comes from evidence inputValue, never the value attribute", () => {
  const before = attributeSide(
    node("node-value", { value: "html-default-before" }),
    "f16-value-before",
    1,
    { inputValue: "A" },
  );
  const after = attributeSide(
    node("node-value", { value: "html-default-after" }),
    "f16-value-after",
    2,
    { inputValue: "B" },
  );
  const composite = composeBrowserF16({
    attributeChange: {
      before,
      after,
      attributes: ["value"],
    },
  });

  const changed = find(composite.attributeChange, item => item.fact.attribute === "value");
  assert.equal(changed.fact.state, "changed");
  assert.equal(changed.fact.before, "A");
  assert.equal(changed.fact.after, "B");
  assert.equal(changed.evidence[0].before.inputValue, "A");
  assert.equal(changed.evidence[0].after.inputValue, "B");
});

test("F16.8 comparison context is built from fixture state and rejects another document", () => {
  const before = attributeSide(node("node-context", { checked: true }), "f16-context-before", 1);
  const after = attributeSide(
    node("node-context", { checked: false }),
    "f16-context-after",
    2,
    { documentRef: "document-other" },
  );
  const composite = composeBrowserF16({
    attributeChange: {
      before,
      after,
      attributes: ["checked"],
    },
  });

  const change = find(composite.attributeChange, item => item.nodeRef === "node-context");
  assert.equal(change.fact.state, "unknown");
  assert.equal(change.fact.unknownReason, "document_mismatch");
});

test("F16.9 bulk attribute comparison includes value only when evidence supplied it", () => {
  const before = attributeSide(
    node("node-bulk-value", { disabled: false }),
    "f16-bulk-value-before",
    1,
    { inputValue: "A" },
  );
  const after = attributeSide(
    node("node-bulk-value", { disabled: false }),
    "f16-bulk-value-after",
    2,
    { inputValue: "B" },
  );
  const composite = composeBrowserF16({ attributeChange: { before, after } });
  const byAttribute = new Map(composite.attributeChange.map(item => [item.fact.attribute, item.fact]));

  assert.equal(byAttribute.get("value").state, "changed");
  assert.equal(byAttribute.get("disabled").state, "unchanged");
});
