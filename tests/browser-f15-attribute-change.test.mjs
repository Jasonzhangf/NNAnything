import assert from "node:assert/strict";
import { test } from "node:test";
import { compareAttributeChange, compareObservedAttributeChanges } from "nnanything/browser-classify";

// F15 attribute change facts: compare the same object across two observations.
// A change statement never claims an action caused it, never claims a side
// effect, and never claims goal success.

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

test("a value that changes is reported as changed with both sides kept", () => {
  const before = node("n1", { "aria-expanded": "false" });
  const after = node("n1", { "aria-expanded": "true" });
  const change = compareAttributeChange(before, after, "aria-expanded");
  assert.equal(change.state, "changed");
  assert.equal(change.before, "false");
  assert.equal(change.after, "true");
});

test("the same value twice is unchanged, not unknown", () => {
  const before = node("n1", { checked: false });
  const after = node("n1", { checked: false });
  const change = compareAttributeChange(before, after, "checked");
  assert.equal(change.state, "unchanged");
  assert.equal(change.unknownReason, null);
});

test("a missing posterior stays unknown instead of unchanged", () => {
  const before = node("n1", { checked: true });
  const change = compareAttributeChange(before, null, "checked");
  assert.equal(change.state, "unknown");
  assert.equal(change.unknownReason, "observation_missing");
});

test("a different object is unknown even when the wording and value match", () => {
  const before = node("n1", { checked: true });
  const after = node("n2", { checked: true });
  const change = compareAttributeChange(before, after, "checked");
  assert.equal(change.state, "unknown");
  assert.equal(change.unknownReason, "object_mismatch");
});

test("an unobserved attribute on either side is unknown, not a value guess", () => {
  const before = node("n1", {});
  const after = node("n1", { open: true });
  const change = compareAttributeChange(before, after, "open");
  assert.equal(change.state, "unknown");
  assert.equal(change.unknownReason, "attribute_unobserved");
});

test("bulk compare reports only observed attributes and keeps each state", () => {
  const before = node("n1", { disabled: false, "aria-expanded": "false", checked: true });
  const after = node("n1", { disabled: true, "aria-expanded": "false", checked: true });
  const changes = compareObservedAttributeChanges(before, after);
  const byAttribute = new Map(changes.map(change => [change.attribute, change]));
  assert.equal(byAttribute.get("disabled").state, "changed");
  assert.equal(byAttribute.get("aria-expanded").state, "unchanged");
  assert.equal(byAttribute.get("checked").state, "unchanged");
  // Attributes neither side observed are not invented.
  assert.equal(byAttribute.has("selected"), false);
});