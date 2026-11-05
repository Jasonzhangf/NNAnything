import assert from "node:assert/strict";
import { test } from "node:test";
import {
  forwardUnified,
  forwardUnifiedScore,
  backwardUnified,
  createXavierTensors,
  cloneTensors,
  applyFullBatchSgd,
  assertUnifiedTensors,
} from "../dist/training/unified-forward.js";

function input(seed) {
  return Array.from({ length: 64 }, (_, i) => Math.sin(seed + i) * 0.5);
}

function lossAt(tensors, x) {
  return forwardUnifiedScore(x, tensors) ** 2;
}

test("forward returns one scalar per candidate with shared tensors", () => {
  const tensors = createXavierTensors(7);
  const a = forwardUnifiedScore(input(1), tensors);
  const b = forwardUnifiedScore(input(2), tensors);
  assert.equal(typeof a, "number");
  assert.equal(Number.isFinite(a), true);
  assert.equal(Number.isFinite(b), true);
  // Same vector deterministically gives the same score.
  assert.equal(forwardUnifiedScore(input(1), tensors), a);
});

test("candidate order does not change individual scores", () => {
  const tensors = createXavierTensors(11);
  const xs = [input(1), input(2), input(3)];
  const forward = xs.map(x => forwardUnifiedScore(x, tensors));
  const reversed = [...xs].reverse().map(x => forwardUnifiedScore(x, tensors)).reverse();
  assert.deepEqual(reversed, forward);
});

test("backward matches finite-difference gradient on sampled parameters", () => {
  const tensors = cloneTensors(createXavierTensors(5));
  const x = input(9);
  const trace = forwardUnified(x, tensors);
  const { grads } = backwardUnified(x, tensors, trace, 2 * trace.score);
  const eps = 1e-5;
  const samples = [
    ["W1", 0],
    ["b1", 3],
    ["W2", 100],
    ["b2", 7],
    ["W3", 5],
    ["b3", 0],
  ];
  for (const [key, idx] of samples) {
    const plus = cloneTensors(tensors);
    plus[key][idx] += eps;
    const minus = cloneTensors(tensors);
    minus[key][idx] -= eps;
    const numeric = (lossAt(plus, x) - lossAt(minus, x)) / (2 * eps);
    const analytic = grads[key][idx];
    assert.ok(Math.abs(numeric - analytic) < 1e-4, `${key}[${idx}] numeric=${numeric} analytic=${analytic}`);
  }
});

test("full-batch SGD applies one deterministic update", () => {
  const tensors = cloneTensors(createXavierTensors(3));
  const x = input(4);
  const trace = forwardUnified(x, tensors);
  const { grads } = backwardUnified(x, tensors, trace, 1);
  // Pick a parameter whose analytic gradient is provably nonzero; a dead
  // parameter (e.g. a ReLU-killed W1 row) legitimately yields zero gradient
  // and must not be used to assert an SGD update.
  const params = ["W1", "b1", "W2", "b2", "W3", "b3"];
  let key = params[0];
  let idx = 0;
  let found = false;
  for (const k of params) {
    const row = grads[k];
    const hit = row.findIndex((v) => Math.abs(v) > 0);
    if (hit >= 0) {
      key = k;
      idx = hit;
      found = true;
      break;
    }
  }
  assert.ok(found, "expected at least one nonzero gradient after backward");
  const before = tensors[key][idx];
  applyFullBatchSgd(tensors, grads, 0.01);
  assert.notEqual(tensors[key][idx], before, `${key}[${idx}] should change after SGD`);
  assertUnifiedTensors(tensors);
});
