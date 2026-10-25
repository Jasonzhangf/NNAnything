import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { requestedRangeObtained, readReceiptObserved, legalActions, legacyTeacherVerdict, assertReplacementCaseHasNoOriginalRootSuccess } = await import("../playground/l2-t2-cli/evidence.mjs");

function successReceipt(fields) {
  return {
    call: { operation: "file.read" },
    status: "succeeded",
    execution: { observation: { bytesRead: 0, eof: false, end_observed: false, ...fields } },
  };
}

test("C3 exact mode: zero-length and full-length are satisfied; short reads are not", () => {
  assert.equal(requestedRangeObtained(successReceipt({ bytesRead: 10 }), { mode: "exact", length: 10 }), "satisfied");
  assert.equal(requestedRangeObtained(successReceipt({ bytesRead: 0 }), { mode: "exact", length: 0 }), "satisfied");
  assert.equal(requestedRangeObtained(successReceipt({ bytesRead: 2, eof: true, end_observed: true }), { mode: "exact", length: 5 }), "unsatisfied");
  assert.equal(requestedRangeObtained(successReceipt({ bytesRead: 0, eof: true, end_observed: true }), { mode: "exact", length: 2 }), "unsatisfied");
});

test("C3 up_to mode: a short read qualifies only when the real receipt established EOF", () => {
  assert.equal(requestedRangeObtained(successReceipt({ bytesRead: 10, eof: true, end_observed: true }), { mode: "up_to", length: 15 }), "satisfied");
  assert.equal(requestedRangeObtained(successReceipt({ bytesRead: 2, eof: true, end_observed: true }), { mode: "up_to", length: 5 }), "satisfied");
  assert.equal(requestedRangeObtained(successReceipt({ bytesRead: 2, eof: false, end_observed: false }), { mode: "up_to", length: 5 }), "unsatisfied");
  assert.equal(requestedRangeObtained(successReceipt({ bytesRead: 0 }), { mode: "up_to", length: 0 }), "satisfied");
});

test("C3 exact zero bytes at offset 0 does not need an end fact", () => {
  const receipt = successReceipt({ bytesRead: 0, eof: false, end_observed: false });
  assert.equal(requestedRangeObtained(receipt, { mode: "exact", length: 0 }), "satisfied");
});

test("read failure is a recorded attempt, not never-tried", () => {
  assert.equal(readReceiptObserved({ call: { operation: "file.read" }, status: "failed" }), "satisfied");
  assert.equal(readReceiptObserved(null), "unsatisfied");
});

test("C1 the legacy unread premise admits no action; the staged premise admits read", () => {
  const state = { sourceCurrent: null, bindingUsable: "satisfied", grantedRead: true };
  assert.deepEqual(legalActions("legacy-unread-premise", state), []);
  assert.deepEqual(legalActions("staged", state), ["read"]);
  assert.throws(() => legalActions("unknown", state), { message: /unknown premise/ });
});

test("C3 the legacy E receipt branch has no size precheck; its up_to rule is byte/eof based", () => {
  // The source (playground/l2/cli.mjs, E head) never compares offset+length against size.
  // Scope is the E receipt branch only; the old R qualification is UNVERIFIED (see
  // LEGACY_TEACHER_SOURCE). A fabricated offset+length<=size precheck was withdrawn in r1 (P2-2).
  assert.equal(legacyTeacherVerdict("exact", { bytesRead: 2, length: 5, eof: true }), "unsatisfied");
  assert.equal(legacyTeacherVerdict("up_to", { bytesRead: 2, length: 5, eof: true }), "satisfied");
  assert.equal(legacyTeacherVerdict("up_to", { bytesRead: 2, length: 5, eof: false }), "unsatisfied");
  assert.equal(legacyTeacherVerdict("up_to", { bytesRead: 10, length: 15, eof: true }), "satisfied");
  assert.equal(legacyTeacherVerdict("up_to", { bytesRead: 10, length: 15, eof: false }), "unsatisfied");
});
test("P1 a replaced fixed-reference root never reports original-root success", () => {
  const rows = [
    { id: "reference-replaced", kind: "C2-reference-replacement" },
    {
      id: "reference-replaced", kind: "pathB-reference-fixed-root-boundary",
      newObjectRootObtained: true, originalRootRecovered: false, originalRootState: "unknown",
    },
    { id: "reference-replaced", kind: "read-attempt", rootObtained: false },
  ];
  assert.equal(assertReplacementCaseHasNoOriginalRootSuccess(rows, "reference-replaced"), true);
});

test("P1 the assertion rejects a new-object read recorded as original-root success", () => {
  const rows = [
    { id: "reference-replaced", kind: "pathB-reference-fixed-root-boundary", originalRootRecovered: false },
    { id: "reference-replaced", kind: "read-attempt", rootObtained: true },
  ];
  assert.throws(
    () => assertReplacementCaseHasNoOriginalRootSuccess(rows, "reference-replaced"),
    { message: /reports original-root success/ },
  );
});

test("P1 the assertion rejects a claim that the fixed reference recovered", () => {
  const rows = [
    { id: "reference-replaced", kind: "pathB-reference-fixed-root-boundary", originalRootRecovered: true },
    { id: "reference-replaced", kind: "read-attempt", rootObtained: false },
  ];
  assert.throws(
    () => assertReplacementCaseHasNoOriginalRootSuccess(rows, "reference-replaced"),
    { message: /claims the original root recovered/ },
  );
});
