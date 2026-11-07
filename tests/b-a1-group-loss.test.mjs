import assert from "node:assert/strict";
import { test } from "node:test";
import { forwardUnifiedScore } from "../dist/training/unified-forward.js";
import { createXavierTensors } from "../dist/training/unified-forward.js";
import {
  BA1_LOSS_KIND,
  BA1_MARGIN,
  BA1_THETA,
  bA1EpochLoss,
  bA1GroupLoss,
  bA1GroupScoreGradient,
} from "../dist/training/b-a1-group-loss.js";

const phi = v => Math.log1p(Math.exp(v));

function group(groupRef, candidates, allowedCandidateRefs) {
  return { groupRef, candidates, allowedCandidateRefs };
}

function cand(candidateRef, score) {
  return { candidateRef, score };
}

test("the accepted B-A1 loss constants are frozen", () => {
  assert.equal(BA1_LOSS_KIND, "absolute_threshold_group");
  assert.equal(BA1_THETA, 0.5);
  assert.equal(BA1_MARGIN, 0.1);
});

test("hand example 1: single positive candidate below threshold has non-zero loss", () => {
  const result = bA1GroupLoss(group("g", [cand("p", 0.4)], ["p"]));
  assert.ok(Math.abs(result.loss - phi(0.2)) < 1e-9);
  assert.ok(Math.abs(result.loss - 0.798) < 1e-3);
});

test("hand example 2: two legal candidates cannot pass by relative mass alone", () => {
  const result = bA1GroupLoss(group("g", [cand("a", 10), cand("b", -10)], ["a", "b"]));
  const expected = (phi(0.6 - 10) + phi(0.6 - -10)) / 2;
  assert.ok(Math.abs(result.loss - expected) < 1e-9);
  assert.ok(Math.abs(result.loss - 5.3) < 1e-3);
});

test("hand example 3: a disallowed candidate above threshold is penalised", () => {
  const result = bA1GroupLoss(group("g", [cand("p", 0.2), cand("n", 0.8)], ["p"]));
  assert.ok(Math.abs(result.loss - phi(0.4)) < 1e-9);
  assert.ok(Math.abs(result.loss - 0.913) < 1e-3);
});

test("hand example 4: translating all scores changes the absolute-threshold loss", () => {
  const result = bA1GroupLoss(group("g", [cand("p", 0.4), cand("n", 1.0)], ["p"]));
  const expected = (phi(0.2) + phi(0.6)) / 2;
  assert.ok(Math.abs(result.loss - expected) < 1e-9);
  assert.ok(Math.abs(result.loss - 0.918) < 1e-3);
});

test("per-candidate average gradient for z=(0.2,0.8) is +/- 0.29934383", () => {
  const tensors = createXavierTensors(7);
  // Force a known scalar score per candidate by holding the tensors and reading
  // the model score, then assert the loss gradient w.r.t. the raw score.
  const grad = bA1GroupScoreGradient(group("g", [cand("p", 0.2), cand("n", 0.8)], ["p"]));
  const sig = 1 / (1 + Math.exp(-0.4));
  assert.ok(Math.abs(grad.get("p") - -sig / 2) < 1e-9);
  assert.ok(Math.abs(grad.get("n") - sig / 2) < 1e-9);
  assert.ok(Math.abs(Math.abs(grad.get("p")) - 0.29934383) < 1e-7);
  assert.ok(tensors.W1.length === 4096);
});

test("the group loss averages by candidate count, not by candidate mass", () => {
  const two = bA1GroupLoss(group("g", [cand("p", 0.2), cand("n", 0.8)], ["p"]));
  const three = bA1GroupLoss(group("g", [cand("p", 0.2), cand("n", 0.8), cand("m", 0.8)], ["p"]));
  const twoGrad = bA1GroupScoreGradient(group("g", [cand("p", 0.2), cand("n", 0.8)], ["p"]));
  const threeGrad = bA1GroupScoreGradient(group("g", [cand("p", 0.2), cand("n", 0.8), cand("m", 0.8)], ["p"]));
  assert.ok(Math.abs(threeGrad.get("p") - twoGrad.get("p") / 1.5) < 1e-9);
  assert.ok(Number.isFinite(two.loss) && Number.isFinite(three.loss));
});

test("analytic score gradient matches the central finite difference", () => {
  const cases = [
    group("g1", [cand("p", 0.4)], ["p"]),
    group("g2", [cand("a", 10), cand("b", -10)], ["a", "b"]),
    group("g3", [cand("p", 0.2), cand("n", 0.8)], ["p"]),
    group("g4", [cand("a", 0.1), cand("b", 0.6), cand("c", -0.3)], ["a", "c"]),
  ];
  const eps = 1e-6;
  for (const g of cases) {
    const analytic = bA1GroupScoreGradient(g);
    for (const original of g.candidates) {
      const base = g.candidates.map(c => ({ candidateRef: c.candidateRef, score: c.score }));
      const up = base.map(c => ({ ...c, score: c.candidateRef === original.candidateRef ? c.score + eps : c.score }));
      const down = base.map(c => ({ ...c, score: c.candidateRef === original.candidateRef ? c.score - eps : c.score }));
      const fd = (bA1GroupLoss(group(g.groupRef, up, g.allowedCandidateRefs)).loss
        - bA1GroupLoss(group(g.groupRef, down, g.allowedCandidateRefs)).loss) / (2 * eps);
      assert.ok(Math.abs(fd - analytic.get(original.candidateRef)) < 1e-7,
        `finite difference mismatch on ${g.groupRef}/${original.candidateRef}: fd=${fd} analytic=${analytic.get(original.candidateRef)}`);
    }
  }
});

test("epoch loss averages group losses over the eligible group count only once", () => {
  const g1 = group("g1", [cand("p", 0.2), cand("n", 0.8)], ["p"]);
  const g2 = group("g2", [cand("q", 0.4)], ["q"]);
  const epoch = bA1EpochLoss([g1, g2]);
  const expected = (bA1GroupLoss(g1).loss + bA1GroupLoss(g2).loss) / 2;
  assert.ok(Math.abs(epoch.loss - expected) < 1e-9);
  assert.equal(epoch.groupLosses.length, 2);
});

test("the model score drives the loss through forwardUnified", () => {
  const tensors = createXavierTensors(11);
  const x = Array.from({ length: 64 }, (_, i) => Math.sin(i) * 0.1);
  const score = forwardUnifiedScore(x, tensors);
  const result = bA1GroupLoss(group("g", [cand("only", score)], ["only"]));
  assert.ok(Math.abs(result.loss - phi(0.1 + 0.5 - score)) < 1e-9);
});
