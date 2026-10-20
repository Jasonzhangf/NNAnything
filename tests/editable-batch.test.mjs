import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyBasicKindBatch, observeCandidates, validateCandidateRequest } from "nnanything/browser";

function classifyMeasurement(value, attribute = "true") {
  const rect = { x: 10, y: 10, width: 100, height: 30 };
  const batch = observeCandidates(validateCandidateRequest({
    observation: {
      viewport: { x: 0, y: 0, width: 800, height: 600 },
      nodes: [{ nodeRef: "editor", tag: "div", role: null, parentRef: null,
        rect, fragments: [rect], clippedRect: rect, attributes: { contenteditable: attribute } }],
    },
    nodeRefs: ["editor", "editor"],
  }));
  return classifyBasicKindBatch({ ...batch, itemObservations: [{ nodeRef: "editor", contentEditable: value }] });
}

test("unknown effective editability is not replaced by a raw declaration in batch classification", () => {
  const result = classifyMeasurement(null);
  assert.equal(result.slots.length, 2);
  for (const [index, slot] of result.slots.entries()) {
    assert.equal(slot.index, index);
    assert.equal(slot.nodeRef, "editor");
    assert.equal(slot.candidateStatus, "ok");
    assert.equal(slot.evidence.wires.attr_editable, null);
    assert.ok(slot.familyScores.control.max >= 0.75);
  }
});

test("known effective editability takes precedence over a conflicting raw declaration", () => {
  assert.equal(classifyMeasurement(false).slots[0].evidence.wires.attr_editable, 0);
  assert.equal(classifyMeasurement(true, "false").slots[0].evidence.wires.attr_editable, 1);
});
