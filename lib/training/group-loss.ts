import {
  applyFullBatchSgd,
  backwardUnified,
  forwardUnified,
  assertUnifiedTensors,
  addTensorsInto,
  zeroTensors,
  type UnifiedTensors,
} from "./unified-forward.js";

export interface EncodedCandidate {
  readonly candidateRef: string;
  readonly input: readonly number[];
  readonly optionSemantics: string;
  readonly candidateKind: "relation" | "decomposition" | "condition" | "action" | "control";
}

export interface EncodedGroup {
  readonly groupRef: string;
  readonly candidates: readonly EncodedCandidate[];
  readonly allowedCandidateRefs: readonly string[];
}

export interface GroupLossResult {
  readonly groupRef: string;
  readonly loss: number;
  readonly logZAll: number;
  readonly logZAllowed: number;
}

function logSumExp(values: readonly number[]): number {
  if (values.length === 0) throw new TypeError("logSumExp requires at least one value");
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) throw new TypeError("scores must be finite");
    if (v > max) max = v;
  }
  let sum = 0;
  for (const v of values) sum += Math.exp(v - max);
  return max + Math.log(sum);
}

export function validateEncodedGroup(group: EncodedGroup): void {
  if (group.candidates.length === 0) throw new TypeError("group must contain at least one candidate");
  const seen = new Set<string>();
  for (const c of group.candidates) {
    if (seen.has(c.candidateRef)) throw new TypeError(`duplicate candidate ${c.candidateRef}`);
    seen.add(c.candidateRef);
    if (c.input.length !== 64) throw new TypeError(`candidate ${c.candidateRef} input must be 64 entries`);
  }
  if (group.allowedCandidateRefs.length === 0) throw new TypeError("A_g must be non-empty");
  for (const ref of group.allowedCandidateRefs) {
    if (!seen.has(ref)) throw new TypeError(`A_g contains ${ref} not present in S_g`);
  }
  const allowed = new Set(group.allowedCandidateRefs);
  const hasJudge = group.candidates.some(c => c.optionSemantics.startsWith("judge=") && allowed.has(c.candidateRef));
  const hasSkillOrControl = group.candidates.some(c =>
    allowed.has(c.candidateRef) && (c.candidateKind === "action" || c.candidateKind === "control")
  );
  if (!hasJudge && !hasSkillOrControl) {
    throw new TypeError("A_g must contain a typed judge or skill/control option");
  }
}

interface ScoredGroup extends GroupLossResult {
  readonly scores: readonly { readonly candidateRef: string; readonly score: number }[];
}

function scoreGroup(group: EncodedGroup, tensors: UnifiedTensors): ScoredGroup {
  validateEncodedGroup(group);
  const allowed = new Set(group.allowedCandidateRefs);
  const scores = canonicalCandidates(group.candidates).map(c => ({
    candidateRef: c.candidateRef,
    score: forwardUnified(c.input, tensors).score,
  }));
  const allScores = scores.map(s => s.score);
  const allowedScores = scores.filter(s => allowed.has(s.candidateRef)).map(s => s.score);
  const logZAll = logSumExp(allScores);
  const logZAllowed = logSumExp(allowedScores);
  return { groupRef: group.groupRef, loss: logZAll - logZAllowed, logZAll, logZAllowed, scores };
}

export function groupLoss(group: EncodedGroup, tensors: UnifiedTensors): GroupLossResult {
  const scored = scoreGroup(group, tensors);
  return { groupRef: scored.groupRef, loss: scored.loss, logZAll: scored.logZAll, logZAllowed: scored.logZAllowed };
}

export interface GroupParameterGradient {
  readonly loss: number;
  readonly gradient: UnifiedTensors;
}

export function groupParameterGradient(
  group: EncodedGroup,
  tensors: UnifiedTensors,
): GroupParameterGradient {
  assertUnifiedTensors(tensors);
  const scored = scoreGroup(group, tensors);
  const allowed = new Set(group.allowedCandidateRefs);
  const gradTotal = zeroTensors() as { W1: number[]; b1: number[]; W2: number[]; b2: number[]; W3: number[]; b3: number[] };
  for (const candidate of canonicalCandidates(group.candidates)) {
    const entry = scored.scores.find(s => s.candidateRef === candidate.candidateRef);
    if (!entry) throw new TypeError("candidate scoring mismatch");
    const gradScore = Math.exp(entry.score - scored.logZAll)
      - (allowed.has(candidate.candidateRef) ? Math.exp(entry.score - scored.logZAllowed) : 0);
    const trace = forwardUnified(candidate.input, tensors);
    const { grads } = backwardUnified(candidate.input, tensors, trace, gradScore);
    addTensorsInto(gradTotal, grads, 1);
  }
  return { loss: scored.loss, gradient: gradTotal as UnifiedTensors };
}

export function canonicalGroups(groups: readonly EncodedGroup[]): readonly EncodedGroup[] {
  return [...groups]
    .map(g => ({
      ...g,
      candidates: canonicalCandidates(g.candidates),
    }))
    .sort((a, b) => (a.groupRef < b.groupRef ? -1 : a.groupRef > b.groupRef ? 1 : 0));
}

function canonicalCandidates(candidates: readonly EncodedCandidate[]): readonly EncodedCandidate[] {
  return [...candidates].sort((a, b) =>
    a.candidateRef < b.candidateRef ? -1 : a.candidateRef > b.candidateRef ? 1 : 0
  );
}

export interface EpochResult {
  readonly loss: number;
  readonly groupLosses: readonly GroupLossResult[];
}

export function epochLoss(groups: readonly EncodedGroup[], tensors: UnifiedTensors): EpochResult {
  if (groups.length === 0) throw new TypeError("epoch must contain at least one group");
  const ordered = canonicalGroups(groups);
  const groupLosses = ordered.map(g => groupLoss(g, tensors));
  const loss = groupLosses.reduce((sum, g) => sum + g.loss, 0) / groupLosses.length;
  return { loss, groupLosses };
}

export function fullBatchEpochStep(
  tensors: Parameters<typeof applyFullBatchSgd>[0],
  groups: readonly EncodedGroup[],
  learningRate: number,
): EpochResult {
  if (groups.length === 0) throw new TypeError("epoch must contain at least one group");
  const ordered = canonicalGroups(groups);
  const groupLosses: GroupLossResult[] = [];
  const gradTotal = zeroTensors() as { W1: number[]; b1: number[]; W2: number[]; b2: number[]; W3: number[]; b3: number[] };
  for (const group of ordered) {
    const { loss, gradient } = groupParameterGradient(group, tensors);
    groupLosses.push({ groupRef: group.groupRef, loss, logZAll: 0, logZAllowed: 0 });
    addTensorsInto(gradTotal, gradient, 1 / ordered.length);
  }
  const loss = groupLosses.reduce((sum, g) => sum + g.loss, 0) / groupLosses.length;
  applyFullBatchSgd(tensors, gradTotal as UnifiedTensors, learningRate);
  return { loss, groupLosses };
}
