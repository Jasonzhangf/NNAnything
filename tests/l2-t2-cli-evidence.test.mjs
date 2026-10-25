import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { requestedRangeObtained, readReceiptObserved, legalActions, legacyRangePrecheck } = await import("../playground/l2-t2-cli/evidence.mjs");

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

test("C3 the legacy range precheck rejects a valid EOF-limited up_to request", () => {
  assert.equal(legacyRangePrecheck(0, 15, 10), false);
  assert.equal(legacyRangePrecheck(8, 5, 10), false);
  assert.equal(legacyRangePrecheck(0, 10, 10), true);
});