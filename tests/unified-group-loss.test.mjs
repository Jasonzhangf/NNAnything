import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyFullBatchSgd,
  cloneTensors,
  createXavierTensors,
} from "../dist/training/unified-forward.js";
import {
  groupLoss,
  groupParameterGradient,
  epochLoss,
  fullBatchEpochStep,
  validateEncodedGroup,
} from "../dist/training/group-loss.js";

function input(seed) {
  return Array.from({ length: 64 }, (_, i) => Math.sin(seed * 0.7 + i * 0.11) * 0.5);
}

function candidate(ref, optionSemantics, candidateKind, seed) {
  return {
    candidateRef: ref,
    input: input(seed),
    optionSemantics,
    candidateKind,
  };
}

function group() {
  return {
    groupRef: "group:1",
    candidates: [
      candidate("cand:true", "judge=true", "relation", 1),
      candidate("cand:false", "judge=false", "relation", 2),
      candidate("cand:unknown", "judge=unknown", "relation", 3),
      candidate("cand:advance", "advance", "action", 4),
    ],
    allowedCandidateRefs: ["cand:true"],
  };
}

function groupAt(tensors, g) {
  return groupLoss(g, tensors).loss;
}

function assertTensorsClose(a, b, tol = 1e-12) {
  for (const key of ["W1", "b1", "W2", "b2", "W3", "b3"]) {
    assert.equal(a[key].length, b[key].length);
    for (let i = 0; i < a[key].length; i += 1) {
      assert.ok(Math.abs(a[key][i] - b[key][i]) < tol, `${key}[${i}] ${a[key][i]} vs ${b[key][i]}`);
    }
  }
}

test("group analytic gradient matches finite difference on sampled parameters", () => {
  const tensors = cloneTensors(createXavierTensors(9));
  const g = group();
  const { gradient } = groupParameterGradient(g, tensors);
  const eps = 1e-5;
  const samples = [
    ["W1", 40],
    ["b1", 2],
    ["W2", 30],
    ["b2", 5],
    ["W3", 3],
    ["b3", 0],
  ];
  for (const [key, idx] of samples) {
    const plus = cloneTensors(tensors);
    plus[key][idx] += eps;
    const minus = cloneTensors(tensors);
    minus[key][idx] -= eps;
    const numeric = (groupAt(plus, g) - groupAt(minus, g)) / (2 * eps);
    const analytic = gradient[key][idx];
    assert.ok(
      Math.abs(numeric - analytic) < 1e-3,
      `${key}[${idx}] numeric=${numeric} analytic=${analytic}`,
    );
  }
});

test("group loss and gradient are invariant under candidate order", () => {
  const tensors = cloneTensors(createXavierTensors(13));
  const g = group();
  const permuted = {
    ...g,
    candidates: [g.candidates[3], g.candidates[1], g.candidates[0], g.candidates[2]],
  };
  const a = groupLoss(g, tensors);
  const b = groupLoss(permuted, tensors);
  assert.equal(a.loss, b.loss);
  assert.equal(a.logZAll, b.logZAll);
  assert.equal(a.logZAllowed, b.logZAllowed);
  const ga = groupParameterGradient(g, tensors);
  const gb = groupParameterGradient(permuted, tensors);
  assert.deepEqual(gb.gradient.W1, ga.gradient.W1);
  assert.deepEqual(gb.gradient.W2, ga.gradient.W2);
  assert.deepEqual(gb.gradient.W3, ga.gradient.W3);
  assert.deepEqual(gb.gradient.b1, ga.gradient.b1);
  assert.deepEqual(gb.gradient.b2, ga.gradient.b2);
  assert.deepEqual(gb.gradient.b3, ga.gradient.b3);
});

test("epoch loss and batch step are invariant under group order", () => {
  const orderedTensors = cloneTensors(createXavierTensors(17));
  const reversedTensors = cloneTensors(createXavierTensors(17));
  const g1 = group();
  const g2 = {
    groupRef: "group:2",
    candidates: [
      candidate("cand:true2", "judge=true", "relation", 5),
      candidate("cand:advance2", "advance", "action", 6),
    ],
    allowedCandidateRefs: ["cand:advance2"],
  };
  const ordered = fullBatchEpochStep(orderedTensors, [g1, g2], 0.01);
  const reversed = fullBatchEpochStep(reversedTensors, [g2, g1], 0.01);
  assert.equal(ordered.loss, reversed.loss);
  assert.deepEqual(ordered.groupLosses.map(g => g.loss), reversed.groupLosses.map(g => g.loss));
  assertTensorsClose(orderedTensors, reversedTensors);
});

test("fullBatchEpochStep applies exactly one averaged update, not per-group updates", () => {
  const g1 = group();
  const g2 = {
    groupRef: "group:2",
    candidates: [
      candidate("cand:true2", "judge=true", "relation", 5),
      candidate("cand:advance2", "advance", "action", 6),
    ],
    allowedCandidateRefs: ["cand:advance2"],
  };
  const updated = cloneTensors(createXavierTensors(21));
  const step = fullBatchEpochStep(updated, [g1, g2], 0.01);
  const manual = cloneTensors(createXavierTensors(21));
  const ga = groupParameterGradient(g1, manual).gradient;
  const gb = groupParameterGradient(g2, manual).gradient;
  const avg = cloneTensors(manual);
  for (const key of ["W1", "b1", "W2", "b2", "W3", "b3"]) {
    for (let i = 0; i < avg[key].length; i += 1) {
      avg[key][i] = ga[key][i] / 2 + gb[key][i] / 2;
    }
  }
  applyFullBatchSgd(manual, avg, 0.01);
  assertTensorsClose(updated, manual, 1e-10);
  assert.ok(Number.isFinite(step.loss));
});

test("empty A_g is rejected", () => {
  const g = { ...group(), allowedCandidateRefs: [] };
  assert.throws(() => validateEncodedGroup(g), /A_g must be non-empty/);
  const tensors = cloneTensors(createXavierTensors(31));
  assert.throws(() => groupLoss(g, tensors));
  assert.throws(() => groupParameterGradient(g, tensors));
});

test("A_g not subset of S_g is rejected", () => {
  const g = { ...group(), allowedCandidateRefs: ["cand:true", "cand:ghost"] };
  assert.throws(() => validateEncodedGroup(g), /A_g contains cand:ghost not present in S_g/);
  const tensors = cloneTensors(createXavierTensors(37));
  assert.throws(() => groupLoss(g, tensors));
  assert.throws(() => groupParameterGradient(g, tensors));
});
