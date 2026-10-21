import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSavedObservation } from "nnanything/browser";

// F05 self-state attributes: checked/readonly/open/selected must survive a
// saved-observation round trip (failure mode: dropped by the safe-attribute
// whitelist), stay unknown when not applicable, and never imply enabled.

function node(overrides = {}) {
  return {
    nodeRef: "n1",
    parentRef: null,
    tag: "input",
    role: null,
    rect: { x: 1, y: 1, width: 10, height: 10 },
    fragments: [{ x: 1, y: 1, width: 10, height: 10 }],
    clippedRect: { x: 1, y: 1, width: 10, height: 10 },
    attributes: {},
    ...overrides,
  };
}

function observation(attributes, overrides = {}) {
  return {
    viewport: { x: 0, y: 0, width: 800, height: 600 },
    nodes: [node({ attributes, ...overrides })],
    coverage: {},
  };
}

test("checked, readonly, open and selected survive a saved-observation round trip", () => {
  const attributes = { checked: true, readonly: true, open: true, selected: true, "aria-checked": "true", "aria-readonly": "true" };
  const loaded = loadSavedObservation(observation(attributes)).nodes[0].attributes;
  assert.equal(loaded.checked, true);
  assert.equal(loaded.readonly, true);
  assert.equal(loaded.open, true);
  assert.equal(loaded.selected, true);
  assert.equal(loaded["aria-checked"], "true");
  assert.equal(loaded["aria-readonly"], "true");
});

test("absent attributes stay absent instead of being filled with false", () => {
  const loaded = loadSavedObservation(observation({})).nodes[0].attributes;
  assert.equal(Object.hasOwn(loaded, "checked"), false);
  assert.equal(Object.hasOwn(loaded, "readonly"), false);
  assert.equal(Object.hasOwn(loaded, "open"), false);
  assert.equal(Object.hasOwn(loaded, "selected"), false);
});

test("disabled and editable are separate facts; disabled does not imply enabled and readonly does not imply editable", () => {
  const loaded = loadSavedObservation(observation({ disabled: true, readonly: true })).nodes[0].attributes;
  assert.equal(loaded.disabled, true);
  assert.equal(loaded.readonly, true);
  // No enabled/editable inference is attached at the observation layer.
  assert.equal(Object.hasOwn(loaded, "enabled"), false);
  assert.equal(Object.hasOwn(loaded, "editable"), false);
});