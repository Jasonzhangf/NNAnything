import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveOwnedScope, deriveDirectScope } from "nnanything/browser-classify";

// F11 owned/nested/citation minimal scope: DOM containment is not ownership.
// An outer container must not swallow nested interactive scope content, and a
// sibling button's text is never part of another button's scope.

function summary(nodeRef, tag, role = null) {
  return {
    nodeRef, tag, role, rect: { x: 0, y: 0, width: 10, height: 10 },
    positiveArea: true, directTextPresent: null, childElementCount: 0,
  };
}

function inputBase(overrides = {}) {
  return {
    schemaVersion: 1,
    nodeRef: "outer",
    containment: {
      maxRelationHops: 4, parentRef: null, parentStatus: "root",
      childRefs: [], positiveAreaChildRefs: [],
      ancestorEdges: [], descendantEdges: [], ancestorBoundary: "complete", descendantBoundary: "complete",
    },
    childComposition: { directChildrenStatus: "complete", children: [], childTagCounts: {}, positiveAreaChildTagCounts: {} },
    geometry: { rect: null, clippedRect: null, parentRect: null },
    measurementCoverage: { directChildren: "complete", unassessedInterior: [] },
    ...overrides,
  };
}

test("a container with only nested interactive children owns none of their content", () => {
  const input = inputBase({
    containment: {
      maxRelationHops: 4, parentRef: null, parentStatus: "root",
      childRefs: ["btn", "link"], positiveAreaChildRefs: ["btn", "link"],
      ancestorEdges: [], ancestorBoundary: "complete", descendantBoundary: "complete",
      descendantEdges: [
        { relation: "contained_by", relativeHops: 1, targetRef: "btn", target: summary("btn", "button") },
        { relation: "contained_by", relativeHops: 1, targetRef: "link", target: summary("link", "a") },
      ],
    },
  });
  const scope = deriveOwnedScope(input);
  assert.equal(scope.status, "complete");
  assert.deepEqual(scope.ownedRefs, []);
  assert.deepEqual(scope.nestedScopeRefs, ["btn", "link"]);
});

test("an outer container keeps plain text but does not swallow a nested button", () => {
  const input = inputBase({
    containment: {
      maxRelationHops: 4, parentRef: null, parentStatus: "root",
      childRefs: ["text", "btn"], positiveAreaChildRefs: ["text", "btn"],
      ancestorEdges: [], ancestorBoundary: "complete", descendantBoundary: "complete",
      descendantEdges: [
        { relation: "contained_by", relativeHops: 1, targetRef: "text", target: summary("text", "span") },
        { relation: "contained_by", relativeHops: 1, targetRef: "btn", target: summary("btn", "button") },
      ],
    },
  });
  const scope = deriveOwnedScope(input);
  assert.deepEqual(scope.ownedRefs, ["text"]);
  assert.deepEqual(scope.nestedScopeRefs, ["btn"]);
});

test("adjacent sibling text is not part of a control's own scope", () => {
  // The button has no observed descendants; its adjacent sibling text node is a
  // different node, so it never enters the button's scope.
  const input = inputBase({
    nodeRef: "button",
    childComposition: {
      directChildrenStatus: "complete",
      children: [summary("button", "button")],
      childTagCounts: { button: 1 }, positiveAreaChildTagCounts: { button: 1 },
    },
  });
  const scope = deriveDirectScope(input);
  assert.deepEqual(scope.ownedRefs, []);
  assert.deepEqual(scope.nestedScopeRefs, ["button"]);
});

test("incomplete descendant topology stays unknown instead of guessing ownership", () => {
  const input = inputBase({
    containment: {
      maxRelationHops: 4, parentRef: null, parentStatus: "root",
      childRefs: [], positiveAreaChildRefs: [],
      ancestorEdges: [], descendantEdges: [], ancestorBoundary: "complete", descendantBoundary: "hop_limit_reached",
    },
  });
  const scope = deriveOwnedScope(input);
  assert.equal(scope.status, "unknown");
  assert.equal(scope.unknownReason, "descendant_boundary_hop_limit_reached");
  assert.deepEqual(scope.ownedRefs, []);
  assert.deepEqual(scope.nestedScopeRefs, []);
});