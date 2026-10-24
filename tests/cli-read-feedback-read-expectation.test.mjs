import assert from "node:assert/strict";
import test from "node:test";
import {
  BASE_WIRES, BASE_LABELS, REASONING_WIRES, REASONING_LABELS,
  measureBase, superviseBase, measureQuantity, superviseReasoning, mergeCoverage, coversRange,
} from "nnanything/cli-read-feedback";

const ctx = (over = {}) => ({ target: "current", bindingReissuable: true, retryEligible: false,
  retryBudgetLeft: 0, retryExhausted: false, skills: ["read", "inspect", "observe"], ...over });
const req = (shape, mode, quantity, offset, length) => ({ shape, mode, quantity, offset, length });
const obs = (offset, length, size, bytesRead) => ({ offset, length, size, bytes: "", bytesRead, eof: bytesRead < length, dev: 1, ino: 1 });
const attempt = (request, observation, failure = null, priorCoverage = []) => ({ request, observation, failure, priorCoverage });

test("wire and label vocabularies are derived from arrays", () => {
  assert.equal(BASE_WIRES.length, 30);
  assert.equal(BASE_LABELS.length, 6);
  assert.equal(REASONING_WIRES.length, 23);
  assert.equal(REASONING_LABELS.length, 6);
});

test("coverage merges and covers half-open ranges", () => {
  assert.deepEqual(mergeCoverage([[4, 6], [0, 3]]), [[0, 3], [4, 6]]);
  assert.equal(coversRange([[0, 3], [4, 6]], 0, 6), false);
  assert.equal(coversRange([[0, 3], [3, 6]], 0, 6), true);
});

test("head 3 on a big file needs only [0,3), not the whole file", () => {
  const a = attempt(req("head", "exact", 3, 0, 3), obs(0, 3, 1000, 3));
  const q = measureQuantity(a, ctx());
  assert.equal(q.coverageComplete, 1);
  assert.equal(q.qtyMet, 1);
  assert.equal(superviseReasoning(a, ctx()).allowed[0], "condition_met");
});

test("up_to 8 on a 3-byte file is met at the confirmed end", () => {
  const a = attempt(req("head", "up_to", 8, 0, 8), obs(0, 8, 3, 3));
  const q = measureQuantity(a, ctx());
  assert.equal(q.qtyMet, 1);
  assert.equal(superviseReasoning(a, ctx()).allowed[0], "condition_met");
});

test("exact 8 on a 3-byte file is a confirmed shortfall, not up_to", () => {
  const a = attempt(req("head", "exact", 8, 0, 8), obs(0, 8, 3, 3));
  const q = measureQuantity(a, ctx());
  assert.equal(q.qtyMet, 0);
  assert.equal(q.shortEndConfirmed, 1);
  assert.deepEqual(superviseReasoning(a, ctx()).allowed, ["terminal_error"]);
});

test("a partial exact read with data remaining asks for the rest", () => {
  const a = attempt(req("head", "exact", 8, 0, 8), obs(0, 8, 20, 3));
  const q = measureQuantity(a, ctx());
  assert.equal(q.qtyMet, 0);
  assert.equal(q.shortEndUnconfirmed, 1);
  assert.deepEqual(superviseReasoning(a, ctx()).allowed, ["need_remaining_data"]);
});

test("zero-length request is a legal satisfied read", () => {
  const a = attempt(req("range", "exact", 0, 1, 0), obs(1, 0, 10, 0));
  const base = superviseBase(a);
  assert.equal(base.label.data_obtained, 1);
  assert.equal(superviseReasoning(a, ctx()).allowed[0], "condition_met");
});

test("no receipt is unknown, not zero-byte success", () => {
  const a = attempt(req("head", "exact", 4, 0, 4), null, null);
  const wires = measureBase(a);
  assert.equal(wires.receipt_measured, 0);
  assert.equal(wires.execution_measured, 0);
  assert.equal(superviseBase(a).label.observation_unknown, 1);
  assert.deepEqual(superviseReasoning(a, ctx()).allowed, ["need_observation"]);
});

test("ENOENT keeps its signal even though the executor never ran", () => {
  const a = attempt(req("head", "exact", 3, 0, 3), null,
    { stage: "observe", code: "ENOENT", message: "gone", executorInvoked: false });
  const wires = measureBase(a);
  assert.equal(wires.execution_measured, 1);
  assert.equal(wires.err_enoent, 1);
  assert.equal(superviseBase(a).label.execution_error, 1);
  assert.deepEqual(superviseReasoning(a, ctx()).allowed, ["terminal_error"]);
});

test("a stale reference asks for a current target", () => {
  const a = attempt(req("head", "exact", 3, 0, 3), null,
    { stage: "observe", code: "STALE_REFERENCE", message: "swapped", executorInvoked: true });
  const base = superviseBase(a);
  assert.equal(base.label.target_changed, 1);
  assert.deepEqual(superviseReasoning(a, ctx({ target: "stale" })).allowed, ["need_current_target"]);
});

test("a retryable transient error may be retried, an exhausted one terminates", () => {
  const a = attempt(req("head", "exact", 3, 0, 3), null,
    { stage: "observe", code: "EINTR", message: "interrupted", executorInvoked: true });
  assert.deepEqual(superviseReasoning(a, ctx({ retryEligible: true, retryBudgetLeft: 1 })).allowed, ["retry_current_read"]);
  assert.deepEqual(superviseReasoning(a, ctx({ retryEligible: false, retryExhausted: true })).allowed, ["terminal_error"]);
});

test("derived end facts stay unknown until every dependency is measured", () => {
  const a = attempt(req("head", "exact", 3, 0, 3), null,
    { stage: "validate", code: "READ_TYPE_DENIED", message: "not a file", executorInvoked: false });
  const wires = measureBase(a);
  assert.equal(wires.end_at_read, 0);
  assert.equal(wires.target_type_denied, 1);
  assert.equal(superviseBase(a).mask.end_observed, 0);
});
