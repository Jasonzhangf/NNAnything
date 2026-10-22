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

function descendant(ref, tag, relativeHops, role = null) {
  return { relation: "contains", relativeHops, targetRef: ref, target: summary(ref, tag, role) };
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

test("nested button scope excludes all of its descendants from outer ownedRefs", () => {
  const input = inputBase({
    containment: {
      maxRelationHops: 4, parentRef: null, parentStatus: "root",
      childRefs: ["text", "btn"], positiveAreaChildRefs: ["text", "btn"],
      ancestorEdges: [], ancestorBoundary: "complete", descendantBoundary: "complete",
      descendantEdges: [
        descendant("text", "span", 1),
        descendant("btn", "button", 1),
        descendant("btn-label", "span", 2),
        descendant("btn-tail", null, 2),
      ],
    },
  });
  const scope = deriveOwnedScope(input);
  assert.equal(scope.status, "complete");
  assert.equal(scope.unknownReason, null);
  assert.deepEqual(scope.ownedRefs, ["text"]);
  assert.deepEqual(scope.nestedScopeRefs, ["btn"]);
  assert.deepEqual(scope.excludedNestedDescendantRefs, ["btn-label", "btn-tail"]);
});

test("text siblings outside a nested scope remain owned", () => {
  const input = inputBase({
    containment: {
      maxRelationHops: 4, parentRef: null, parentStatus: "root",
      childRefs: ["text-before", "btn", "text-after"], positiveAreaChildRefs: ["text-before", "btn", "text-after"],
      ancestorEdges: [], ancestorBoundary: "complete", descendantBoundary: "complete",
      descendantEdges: [
        descendant("text-before", "span", 1),
        descendant("btn", "button", 1),
        descendant("btn-inner", "span", 2),
        descendant("text-after", "span", 1),
      ],
    },
  });
  const scope = deriveOwnedScope(input);
  assert.equal(scope.status, "complete");
  assert.deepEqual(scope.ownedRefs, ["text-before", "text-after"]);
  assert.deepEqual(scope.nestedScopeRefs, ["btn"]);
  assert.deepEqual(scope.excludedNestedDescendantRefs, ["btn-inner"]);
});

test("a nested scope inside a nested scope is excluded without being counted twice", () => {
  const input = inputBase({
    containment: {
      maxRelationHops: 4, parentRef: null, parentStatus: "root",
      childRefs: ["btn"], positiveAreaChildRefs: ["btn"],
      ancestorEdges: [], ancestorBoundary: "complete", descendantBoundary: "complete",
      descendantEdges: [
        descendant("btn", "button", 1),
        descendant("nested-link", "a", 2),
        descendant("link-text", "span", 3),
        descendant("btn-text", null, 2),
      ],
    },
  });
  const scope = deriveOwnedScope(input);
  assert.equal(scope.status, "complete");
  assert.deepEqual(scope.ownedRefs, []);
  assert.deepEqual(scope.nestedScopeRefs, ["btn"]);
  assert.deepEqual(scope.excludedNestedDescendantRefs, ["nested-link", "link-text", "btn-text"]);
});

test("a button nested under wrapper divs excludes its whole subtree", () => {
  const input = inputBase({
    containment: {
      maxRelationHops: 4, parentRef: null, parentStatus: "root",
      childRefs: ["wrapper", "text-after"], positiveAreaChildRefs: ["wrapper", "text-after"],
      ancestorEdges: [], ancestorBoundary: "complete", descendantBoundary: "complete",
      descendantEdges: [
        descendant("wrapper", "div", 1),
        descendant("btn", "button", 2),
        descendant("btn-span", "span", 3),
        descendant("btn-text", null, 4),
        descendant("text-after", "span", 1),
      ],
    },
  });
  const scope = deriveOwnedScope(input);
  assert.equal(scope.status, "complete");
  assert.deepEqual(scope.ownedRefs, ["wrapper", "text-after"]);
  assert.deepEqual(scope.nestedScopeRefs, ["btn"]);
  assert.deepEqual(scope.excludedNestedDescendantRefs, ["btn-span", "btn-text"]);
});

test("a hop jump in descendant edges is unknown instead of guessing ownership", () => {
  const input = inputBase({
    containment: {
      maxRelationHops: 4, parentRef: null, parentStatus: "root",
      childRefs: ["wrapper"], positiveAreaChildRefs: ["wrapper"],
      ancestorEdges: [], ancestorBoundary: "complete", descendantBoundary: "complete",
      descendantEdges: [
        descendant("wrapper", "div", 1),
        descendant("skipped-level", "span", 3),
      ],
    },
  });
  const scope = deriveOwnedScope(input);
  assert.equal(scope.status, "unknown");
  assert.equal(scope.unknownReason, "descendant_edge_order_inconsistent");
  assert.deepEqual(scope.ownedRefs, []);
  assert.deepEqual(scope.nestedScopeRefs, []);
  assert.deepEqual(scope.excludedNestedDescendantRefs, []);
});

test("out-of-order descendant edges are unknown instead of guessing ownership", () => {
  const input = inputBase({
    containment: {
      maxRelationHops: 4, parentRef: null, parentStatus: "root",
      childRefs: ["wrapper"], positiveAreaChildRefs: ["wrapper"],
      ancestorEdges: [], ancestorBoundary: "complete", descendantBoundary: "complete",
      descendantEdges: [descendant("skipped-parent", "span", 2)],
    },
  });
  const scope = deriveOwnedScope(input);
  assert.equal(scope.status, "unknown");
  assert.equal(scope.unknownReason, "descendant_edge_order_inconsistent");
});

test("a duplicate descendant ref is unknown instead of guessing ownership", () => {
  const input = inputBase({
    containment: {
      maxRelationHops: 4, parentRef: null, parentStatus: "root",
      childRefs: ["btn"], positiveAreaChildRefs: ["btn"],
      ancestorEdges: [], ancestorBoundary: "complete", descendantBoundary: "complete",
      descendantEdges: [
        descendant("btn", "button", 1),
        descendant("btn-inner", "span", 2),
        descendant("btn-inner", "span", 2),
      ],
    },
  });
  const scope = deriveOwnedScope(input);
  assert.equal(scope.status, "unknown");
  assert.equal(scope.unknownReason, "descendant_edge_order_inconsistent");
  assert.deepEqual(scope.ownedRefs, []);
  assert.deepEqual(scope.nestedScopeRefs, []);
});

test("direct scope excludes descendants under a nested direct child", () => {
  const input = inputBase({
    containment: {
      maxRelationHops: 4, parentRef: null, parentStatus: "root",
      childRefs: ["text-before", "btn"], positiveAreaChildRefs: ["text-before", "btn"],
      ancestorEdges: [], ancestorBoundary: "complete", descendantBoundary: "complete",
      descendantEdges: [
        descendant("text-before", "span", 1),
        descendant("btn", "button", 1),
        descendant("btn-span", "span", 2),
        descendant("btn-text", null, 2),
        descendant("text-after", "span", 1),
      ],
    },
    childComposition: {
      directChildrenStatus: "complete",
      children: [summary("text-before", "span"), summary("btn", "button")],
      childTagCounts: { span: 1, button: 1 },
      positiveAreaChildTagCounts: { span: 1, button: 1 },
    },
  });
  const scope = deriveDirectScope(input);
  assert.equal(scope.status, "complete");
  assert.deepEqual(scope.ownedRefs, ["text-before"]);
  assert.deepEqual(scope.nestedScopeRefs, ["btn"]);
  assert.deepEqual(scope.excludedNestedDescendantRefs, ["btn-span", "btn-text"]);
});
