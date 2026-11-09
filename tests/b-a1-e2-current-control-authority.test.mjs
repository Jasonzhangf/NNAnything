import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createCurrentControlAuthority,
} from "../dist/adapters/browser/current-control-authority.js";

test("currentControl rejects before the first observation start", () => {
  const authority = createCurrentControlAuthority({ documentRef: "doc-a" });

  assert.throws(
    () => authority.currentControl(),
    /before the first observation/i,
  );
});

test("beginObservation returns the stable current token", () => {
  const authority = createCurrentControlAuthority({ documentRef: "doc-a" });
  const issued = authority.beginObservation();

  assert.deepEqual(issued, {
    documentRef: "doc-a",
    observationId: issued.observationId,
    revision: 1,
  });
  assert.deepEqual(authority.currentControl(), issued);
  assert.match(issued.observationId, /^observation-\d+$/);
});

test("a new observation start invalidates the prior token immediately", () => {
  const authority = createCurrentControlAuthority({ documentRef: "doc-a" });
  const first = authority.beginObservation();
  const second = authority.beginObservation();

  assert.notDeepEqual(second, first);
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.notEqual(second.observationId, first.observationId);
  assert.deepEqual(authority.currentControl(), second);
});

test("document replacement compares against the active provider token", () => {
  const previous = createCurrentControlAuthority({ documentRef: "doc-a" });
  const previousToken = previous.beginObservation();
  const replacement = createCurrentControlAuthority({ documentRef: "doc-b" });
  const replacementToken = replacement.beginObservation();

  assert.notDeepEqual(replacement.currentControl(), previousToken);
  assert.equal(replacementToken.documentRef, "doc-b");
});

test("issued and read controls are immutable defensive copies", () => {
  const input = { documentRef: "doc-a" };
  const authority = createCurrentControlAuthority(input);
  const issued = authority.beginObservation();
  const read = authority.currentControl();

  assert.notStrictEqual(read, issued);
  assert.equal(Object.isFrozen(issued), true);
  assert.equal(Object.isFrozen(read), true);
  assert.equal(Reflect.set(issued, "revision", 99), false);
  assert.equal(Reflect.set(read, "observationId", "poisoned"), false);
  assert.deepEqual(authority.currentControl(), {
    documentRef: "doc-a",
    observationId: issued.observationId,
    revision: 1,
  });

  input.documentRef = "doc-b";
  assert.deepEqual(authority.beginObservation(), {
    documentRef: "doc-a",
    observationId: "observation-2",
    revision: 2,
  });
});
