import assert from "node:assert/strict";
import { test } from "node:test";
import { compareAttributeChange, compareObservedAttributeChanges, createStableNodeRefRegistry } from "nnanything/browser-classify";

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

function comparisonContext(before = {}, after = {}) {
  return {
    before: {
      documentRef: "document-1",
      scopeRef: "scope-1",
      observationId: "observation-1",
      revision: 1,
      registryRef: "registry-1",
      ...before,
    },
    after: {
      documentRef: "document-1",
      scopeRef: "scope-1",
      observationId: "observation-2",
      revision: 2,
      registryRef: "registry-1",
      ...after,
    },
  };
}

function valueReads(before, after) {
  return {
    before: { status: "observed", value: before },
    after: { status: "observed", value: after },
  };
}

test("comparison_context_missing throws TypeError for a missing or malformed context", () => {
  const before = node("n1", { checked: true });
  const after = node("n1", { checked: true });
  // A null context is an explicit missing context, not a malformed one.
  assert.throws(
    () => compareAttributeChange(before, after, "checked", null),
    error => error instanceof TypeError && error.message.includes("comparison_context_missing"),
  );
  // Malformed sides must throw as well.
  assert.throws(
    () => compareAttributeChange(before, after, "checked", { before: comparisonContext().before, after: {} }),
    TypeError,
  );
  assert.throws(
    () => compareAttributeChange(before, after, "checked", undefined),
    error => error instanceof TypeError && error.message.includes("comparison_context_missing"),
  );
  assert.throws(
    () => compareAttributeChange(before, after, "checked", { before: comparisonContext().before }),
    TypeError,
  );
});

test("a value that changes is reported as changed with both sides kept", () => {
  const before = node("n1", { "aria-expanded": "false" });
  const after = node("n1", { "aria-expanded": "true" });
  const change = compareAttributeChange(before, after, "aria-expanded", comparisonContext());
  assert.equal(change.state, "changed");
  assert.equal(change.before, "false");
  assert.equal(change.after, "true");
});

test("the same value twice is unchanged, not unknown", () => {
  const before = node("n1", { checked: false });
  const after = node("n1", { checked: false });
  const change = compareAttributeChange(before, after, "checked", comparisonContext());
  assert.equal(change.state, "unchanged");
  assert.equal(change.unknownReason, null);
});

test("a missing posterior stays unknown instead of unchanged", () => {
  const before = node("n1", { checked: true });
  const change = compareAttributeChange(before, null, "checked", comparisonContext());
  assert.equal(change.state, "unknown");
  assert.equal(change.unknownReason, "observation_missing");
});

test("same ref in another document is unknown with document_mismatch", () => {
  const before = node("n1", { checked: true });
  const after = node("n1", { checked: false });
  const change = compareAttributeChange(
    before,
    after,
    "checked",
    comparisonContext({ documentRef: "document-a" }, { documentRef: "document-b" }),
  );
  assert.equal(change.state, "unknown");
  assert.equal(change.unknownReason, "document_mismatch");
});

test("same ref in another scope is unknown with scope_mismatch", () => {
  const before = node("n1", { checked: true });
  const after = node("n1", { checked: false });
  const change = compareAttributeChange(
    before,
    after,
    "checked",
    comparisonContext({ scopeRef: "scope-a" }, { scopeRef: "scope-b" }),
  );
  assert.equal(change.state, "unknown");
  assert.equal(change.unknownReason, "scope_mismatch");
});

test("a posterior that is not newer is unknown with observation_order_invalid", () => {
  const before = node("n1", { checked: true });
  const after = node("n1", { checked: false });
  const change = compareAttributeChange(
    before,
    after,
    "checked",
    comparisonContext({}, { revision: 1 }),
  );
  assert.equal(change.state, "unknown");
  assert.equal(change.unknownReason, "observation_order_invalid");
});

test("two sides with the same observation id are unknown with observation_not_distinct", () => {
  const before = node("n1", { checked: true });
  const after = node("n1", { checked: false });
  const change = compareAttributeChange(
    before,
    after,
    "checked",
    comparisonContext({ observationId: "same-observation" }, { observationId: "same-observation" }),
  );
  assert.equal(change.state, "unknown");
  assert.equal(change.unknownReason, "observation_not_distinct");
});

test("a different object is unknown with object_mismatch even when values match", () => {
  const before = node("n1", { checked: true });
  const after = node("n2", { checked: true });
  const change = compareAttributeChange(before, after, "checked", comparisonContext());
  assert.equal(change.state, "unknown");
  assert.equal(change.unknownReason, "object_mismatch");
});

test("an unobserved attribute on either side is unknown, not a value guess", () => {
  const before = node("n1", {});
  const after = node("n1", { open: true });
  const change = compareAttributeChange(before, after, "open", comparisonContext());
  assert.equal(change.state, "unknown");
  assert.equal(change.unknownReason, "attribute_unobserved");
});

test("requesting value without explicit value reads is unknown with value_read_not_supplied", () => {
  const before = node("n1", { value: "html-default-before" });
  const after = node("n1", { value: "html-default-after" });
  const change = compareAttributeChange(before, after, "value", comparisonContext());
  assert.equal(change.state, "unknown");
  assert.equal(change.unknownReason, "value_read_not_supplied");
});

test("explicit current values A to B are changed and A to A is unchanged", () => {
  const before = node("n1", { value: "html-default" });
  const after = node("n1", { value: "html-default" });
  const changed = compareAttributeChange(
    before,
    after,
    "value",
    comparisonContext(),
    valueReads("A", "B"),
  );
  assert.equal(changed.state, "changed");
  assert.equal(changed.before, "A");
  assert.equal(changed.after, "B");

  const unchanged = compareAttributeChange(
    before,
    after,
    "value",
    comparisonContext(),
    valueReads("A", "A"),
  );
  assert.equal(unchanged.state, "unchanged");
  assert.equal(unchanged.unknownReason, null);
});

test("an unavailable current value is unknown with value_unavailable", () => {
  const before = node("n1", {});
  const after = node("n1", {});
  const beforeUnavailable = compareAttributeChange(
    before,
    after,
    "value",
    comparisonContext(),
    {
      before: { status: "unavailable", value: null },
      after: { status: "observed", value: "B" },
    },
  );
  assert.equal(beforeUnavailable.state, "unknown");
  assert.equal(beforeUnavailable.unknownReason, "value_unavailable");

  const afterUnavailable = compareAttributeChange(
    before,
    after,
    "value",
    comparisonContext(),
    {
      before: { status: "observed", value: "A" },
      after: { status: "unavailable", value: null },
    },
  );
  assert.equal(afterUnavailable.state, "unknown");
  assert.equal(afterUnavailable.unknownReason, "value_unavailable");
});

test("value comparison of different objects is unknown with object_mismatch", () => {
  const before = node("n1", {});
  const after = node("n2", {});
  const change = compareAttributeChange(
    before,
    after,
    "value",
    comparisonContext(),
    valueReads("A", "B"),
  );
  assert.equal(change.state, "unknown");
  assert.equal(change.unknownReason, "object_mismatch");
});

test("bulk compare includes value only when explicit value reads are supplied", () => {
  const before = node("n1", { value: "html-default-before", disabled: false });
  const after = node("n1", { value: "html-default-after", disabled: true });

  const withoutReads = compareObservedAttributeChanges(before, after, comparisonContext());
  const withoutByAttribute = new Map(withoutReads.map(change => [change.attribute, change]));
  assert.equal(withoutByAttribute.has("value"), false);

  const withReads = compareObservedAttributeChanges(
    before,
    after,
    comparisonContext(),
    valueReads("A", "B"),
  );
  const withByAttribute = new Map(withReads.map(change => [change.attribute, change]));
  assert.equal(withByAttribute.get("value").state, "changed");
  assert.equal(withByAttribute.get("value").before, "A");
  assert.equal(withByAttribute.get("value").after, "B");
  assert.equal(withByAttribute.get("disabled").state, "changed");
});

test("object association needs the same observation source, not just the same ref string", () => {
  const before = node("shared", { checked: true });
  const after = node("shared", { checked: false });
  // Two registries can produce the same ref string for different elements, so
  // different sources must never be read as one object.
  const crossSource = comparisonContext({}, { registryRef: "registry-2" });
  const crossResult = compareAttributeChange(before, after, "checked", crossSource);
  assert.equal(crossResult.state, "unknown");
  assert.equal(crossResult.unknownReason, "object_source_mismatch");
  // The same source with an identical ref is one object.
  const sameSource = compareAttributeChange(before, after, "checked", comparisonContext());
  assert.equal(sameSource.state, "changed");
  // Omitting the source identity is a contract error, not an implicit match.
  assert.throws(
    () => compareAttributeChange(before, after, "checked", { before: { documentRef: "document-1", scopeRef: "scope-1", observationId: "observation-1", revision: 1 }, after: comparisonContext().after }),
    error => error instanceof TypeError && error.message.includes("registryRef"),
  );
});

test("an observed value read must carry the value it observed", () => {
  const before = node("n1", {});
  const after = node("n1", {});
  // A null value with status observed hides a missing read behind unchanged.
  assert.throws(
    () => compareAttributeChange(before, after, "value", comparisonContext(), {
      before: { status: "observed", value: null },
      after: { status: "observed", value: null },
    }),
    error => error instanceof TypeError && error.message.includes("when status is observed"),
  );
  // An unavailable read names no value on either side.
  const unavailable = compareAttributeChange(before, after, "value", comparisonContext(), {
    before: { status: "unavailable", value: null },
    after: { status: "observed", value: "B" },
  });
  assert.equal(unavailable.state, "unknown");
  assert.equal(unavailable.unknownReason, "value_unavailable");
  // An observed empty string is a real value and stays comparable.
  const empty = compareAttributeChange(before, after, "value", comparisonContext(), valueReads("", ""));
  assert.equal(empty.state, "unchanged");
});

test("registries never share a source identity, even with the same prefix", async () => {
  const first = createStableNodeRefRegistry("shared-prefix");
  const second = createStableNodeRefRegistry("shared-prefix");
  assert.equal(first.prefix, second.prefix);
  assert.notEqual(first.registryRef, second.registryRef);
  // A second copy of the implementation module must not reuse the same source
  // identity: two independent producers may observe the same document and
  // different objects. The copy loads live-dom itself, because re-importing the
  // package entry only re-evaluates the entry and reuses the same dependency.
  const entryUrl = new URL(import.meta.resolve("nnanything/browser-classify"));
  const copyUrl = new URL("adapters/browser/live-dom.js", entryUrl);
  const copy = await import(`${copyUrl.href}?copy=1`);
  assert.notEqual(copy.createStableNodeRefRegistry, createStableNodeRefRegistry);
  const fromCopy = copy.createStableNodeRefRegistry("shared-prefix");
  assert.notEqual(first.registryRef, fromCopy.registryRef);
  assert.notEqual(second.registryRef, fromCopy.registryRef);
  // The source identity, not the prefix, is what a comparison context carries.
  const before = node("n1", { checked: true });
  const after = node("n1", { checked: false });
  const context = {
    before: { documentRef: "document-1", scopeRef: "scope-1", observationId: "observation-1", revision: 1, registryRef: first.registryRef },
    after: { documentRef: "document-1", scopeRef: "scope-1", observationId: "observation-2", revision: 2, registryRef: second.registryRef },
  };
  const result = compareAttributeChange(before, after, "checked", context);
  assert.equal(result.state, "unknown");
  assert.equal(result.unknownReason, "object_source_mismatch");
});
