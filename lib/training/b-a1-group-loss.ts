// B-A1 route-specific group loss (design: b-a1-supervision-loss-contract.md,
// subject revision 3).
//
// The accepted B-A1 objective is an absolute-threshold soft-margin group loss.
// It is deliberately NOT the shared `group-loss.ts` `logZ_all - logZ_allowed`
// loss, and it does not reuse `validateEncodedGroup` (judge/action/control).
// A relation/select candidate may legitimately be the only allowed candidate,
// so the loss must still be non-zero when its absolute score is below theta.
//
// Two-level averaging (each applied exactly once):
//   - inside one group, average over the |S_g| scorable candidates;
//   - across the epoch, average the already-averaged group gradients over G.

import {
  addTensorsInto,
  applyFullBatchSgd,
  assertUnifiedTensors,
  backwardUnified,
  forwardUnified,
  zeroTensors,
  type MutableUnifiedTensors,
  type UnifiedTensors,
} from "./unified-forward.js";
import type { EncodedGroup } from "./group-loss.js";

export const BA1_LOSS_KIND = "absolute_threshold_group" as const;
export const BA1_THETA = 0.5;
export const BA1_MARGIN = 0.1;

export class BA1GroupLossError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BA1GroupLossError";
  }
}

export interface BA1ScoredCandidate {
  readonly candidateRef: string;
  readonly score: number;
}

export interface BA1ScoredGroup {
  readonly groupRef: string;
  readonly candidates: readonly BA1ScoredCandidate[];
  readonly allowedCandidateRefs: readonly string[];
}

export interface BA1GroupLossResult {
  readonly groupRef: string;
  readonly loss: number;
  readonly scores: readonly BA1ScoredCandidate[];
}

export interface BA1EpochLossResult {
  readonly loss: number;
  readonly groupLosses: readonly { readonly groupRef: string; readonly loss: number }[];
}

/** log(1 + exp(v)) computed without overflow. */
export function bA1Softplus(v: number): number {
  if (!Number.isFinite(v)) throw new BA1GroupLossError("softplus input must be finite");
  return v > 0 ? v + Math.log1p(Math.exp(-v)) : Math.log1p(Math.exp(v));
}

/** sigmoid(v) computed without overflow. */
export function bA1Sigmoid(v: number): number {
  if (!Number.isFinite(v)) throw new BA1GroupLossError("sigmoid input must be finite");
  return v >= 0 ? 1 / (1 + Math.exp(-v)) : Math.exp(v) / (1 + Math.exp(v));
}

function assertScoredGroup(group: BA1ScoredGroup): void {
  if (group.candidates.length === 0) {
    throw new BA1GroupLossError(`group ${group.groupRef} must contain at least one candidate`);
  }
  const refs = new Set<string>();
  for (const candidate of group.candidates) {
    if (refs.has(candidate.candidateRef)) {
      throw new BA1GroupLossError(`group ${group.groupRef} has duplicate candidate ${candidate.candidateRef}`);
    }
    if (!Number.isFinite(candidate.score)) {
      throw new BA1GroupLossError(`group ${group.groupRef} candidate ${candidate.candidateRef} score must be finite`);
    }
    refs.add(candidate.candidateRef);
  }
  if (group.allowedCandidateRefs.length === 0) {
    throw new BA1GroupLossError(`group ${group.groupRef} A_g must be non-empty`);
  }
  for (const ref of group.allowedCandidateRefs) {
    if (!refs.has(ref)) throw new BA1GroupLossError(`group ${group.groupRef} A_g ref ${ref} is outside S_g`);
  }
}

export function bA1GroupLoss(group: BA1ScoredGroup): BA1GroupLossResult {
  assertScoredGroup(group);
  const allowed = new Set(group.allowedCandidateRefs);
  const candidateCount = group.candidates.length;
  let sum = 0;
  for (const candidate of group.candidates) {
    sum += allowed.has(candidate.candidateRef)
      ? bA1Softplus(BA1_MARGIN + BA1_THETA - candidate.score)
      : bA1Softplus(BA1_MARGIN + candidate.score - BA1_THETA);
  }
  return { groupRef: group.groupRef, loss: sum / candidateCount, scores: group.candidates };
}

/**
 * Analytic gradient of the averaged group loss with respect to each raw score.
 *   dL/dz_i = -sigmoid(margin + theta - z_i)/|S_g|  for i in A_g
 *   dL/dz_i = +sigmoid(margin + z_i - theta)/|S_g|  for i not in A_g
 */
export function bA1GroupScoreGradient(group: BA1ScoredGroup): Map<string, number> {
  assertScoredGroup(group);
  const allowed = new Set(group.allowedCandidateRefs);
  const candidateCount = group.candidates.length;
  const gradient = new Map<string, number>();
  for (const candidate of group.candidates) {
    const value = allowed.has(candidate.candidateRef)
      ? -bA1Sigmoid(BA1_MARGIN + BA1_THETA - candidate.score) / candidateCount
      : bA1Sigmoid(BA1_MARGIN + candidate.score - BA1_THETA) / candidateCount;
    gradient.set(candidate.candidateRef, value);
  }
  return gradient;
}

export function bA1EpochLoss(groups: readonly BA1ScoredGroup[]): BA1EpochLossResult {
  if (groups.length === 0) throw new BA1GroupLossError("epoch must contain at least one group");
  const groupLosses = groups.map(g => {
    const result = bA1GroupLoss(g);
    return { groupRef: result.groupRef, loss: result.loss };
  });
  const loss = groupLosses.reduce((sum, entry) => sum + entry.loss, 0) / groupLosses.length;
  return { loss, groupLosses };
}

function assertEncodedGroup(group: EncodedGroup): void {
  if (group.candidates.length === 0) throw new BA1GroupLossError(`group ${group.groupRef} must contain at least one candidate`);
  const refs = new Set<string>();
  for (const candidate of group.candidates) {
    if (candidate.input.length !== 64) {
      throw new BA1GroupLossError(`candidate ${candidate.candidateRef} input must have 64 entries`);
    }
    if (refs.has(candidate.candidateRef)) {
      throw new BA1GroupLossError(`group ${group.groupRef} has duplicate candidate ${candidate.candidateRef}`);
    }
    refs.add(candidate.candidateRef);
  }
  if (group.allowedCandidateRefs.length === 0) throw new BA1GroupLossError(`group ${group.groupRef} A_g must be non-empty`);
  for (const ref of group.allowedCandidateRefs) {
    if (!refs.has(ref)) throw new BA1GroupLossError(`group ${group.groupRef} A_g ref ${ref} is outside S_g`);
  }
}

function scoreGroup(group: EncodedGroup, tensors: UnifiedTensors): BA1ScoredGroup {
  return {
    groupRef: group.groupRef,
    candidates: group.candidates.map(candidate => ({
      candidateRef: candidate.candidateRef,
      score: forwardUnified(candidate.input, tensors).score,
    })),
    allowedCandidateRefs: group.allowedCandidateRefs,
  };
}

export interface BA1GroupParameterGradient {
  readonly loss: number;
  readonly gradient: UnifiedTensors;
  readonly scores: readonly BA1ScoredCandidate[];
}

export function bA1GroupParameterGradient(
  group: EncodedGroup,
  tensors: UnifiedTensors,
): BA1GroupParameterGradient {
  assertUnifiedTensors(tensors);
  assertEncodedGroup(group);
  const scored = scoreGroup(group, tensors);
  const lossResult = bA1GroupLoss(scored);
  const dz = bA1GroupScoreGradient(scored);
  const gradTotal = zeroTensors() as MutableUnifiedTensors;
  for (const candidate of group.candidates) {
    const dScore = dz.get(candidate.candidateRef);
    if (dScore === undefined) throw new BA1GroupLossError(`missing gradient for ${candidate.candidateRef}`);
    const trace = forwardUnified(candidate.input, tensors);
    const { grads } = backwardUnified(candidate.input, tensors, trace, dScore);
    addTensorsInto(gradTotal, grads, 1);
  }
  return { loss: lossResult.loss, gradient: gradTotal as UnifiedTensors, scores: scored.candidates };
}

export interface BA1FullBatchEpochResult {
  readonly loss: number;
  readonly groupLosses: readonly { readonly groupRef: string; readonly loss: number }[];
}

/**
 * One full-batch SGD epoch. Each group gradient already carries the 1/|S_g|
 * candidate average; the epoch aggregate divides the summed group gradients by
 * the eligible group count G exactly once.
 */
export function bA1FullBatchEpochStep(
  tensors: MutableUnifiedTensors,
  groups: readonly EncodedGroup[],
  learningRate: number,
): BA1FullBatchEpochResult {
  if (groups.length === 0) throw new BA1GroupLossError("epoch must contain at least one group");
  const gradTotal = zeroTensors() as MutableUnifiedTensors;
  const groupLosses: { groupRef: string; loss: number }[] = [];
  const scale = 1 / groups.length;
  let lossSum = 0;
  for (const group of groups) {
    const { loss, gradient } = bA1GroupParameterGradient(group, tensors);
    groupLosses.push({ groupRef: group.groupRef, loss });
    lossSum += loss;
    addTensorsInto(gradTotal, gradient, scale);
  }
  applyFullBatchSgd(tensors, gradTotal as UnifiedTensors, learningRate);
  return { loss: lossSum / groups.length, groupLosses };
}

export interface BA1ThresholdDiagnosis {
  readonly groupRef: string;
  readonly marginSatisfied: boolean;
  readonly decisionSatisfied: boolean;
  readonly scores: readonly BA1ScoredCandidate[];
}

export function bA1ThresholdDiagnosis(
  group: EncodedGroup,
  tensors: UnifiedTensors,
): BA1ThresholdDiagnosis {
  const scored = scoreGroup(group, tensors);
  const allowed = new Set(group.allowedCandidateRefs);
  let marginSatisfied = true;
  let decisionSatisfied = true;
  for (const candidate of scored.candidates) {
    if (allowed.has(candidate.candidateRef)) {
      if (candidate.score < BA1_THETA + BA1_MARGIN) marginSatisfied = false;
      if (candidate.score < BA1_THETA) decisionSatisfied = false;
    } else {
      if (candidate.score > BA1_THETA - BA1_MARGIN) marginSatisfied = false;
      if (candidate.score > BA1_THETA) decisionSatisfied = false;
    }
  }
  return { groupRef: group.groupRef, marginSatisfied, decisionSatisfied, scores: scored.candidates };
}
