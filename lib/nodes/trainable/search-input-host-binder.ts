// B-A1 M1 phase 2: search-input-host binder numeric unit.
//
// learnable:  one scalar per candidate, roleMatch in [-1, 1], as a linear
//             function of the §3 feature table followed by tanh.
// deterministic: applicability, missing-measurement detection, coverage,
//             access gating, currentness, threshold/uniqueness aggregation.
//
// The fitter supports two objectives, selected explicitly by the caller:
//
//   "pairwise" (default): the target candidate's roleMatch must exceed every
//     other applicable candidate by a margin. Batches without a target
//     participate in no ranking loss and only prove `none`.
//   "absolute": every labelled candidate carries its own margin anchored on the
//     inference threshold, and only the usage-evidence wires are learnable. A
//     labelled negative whose measured usage evidence is all zero contributes
//     no gradient under any weight vector, so it is reported as excluded rather
//     than given a margin it cannot meet. Contract: m1-new-experiment-contract.md.

import type { TrainableSemanticUnit } from "../../core/trainable-unit.js";
import { expectRecord } from "../../core/schema.js";
import {
  SEARCH_INPUT_HOST_CONTRACT,
  SEARCH_INPUT_HOST_ROLE,
  SEARCH_INPUT_HOST_THRESHOLD,
  SEARCH_INPUT_HOST_WIRES,
  isMeasuredSearchInputHostCandidate,
  validateSearchInputHostCandidate,
  validateSearchInputHostInferInput,
  validateSearchInputHostProfile,
  type MeasuredSearchInputHostCandidate,
  type SearchInputHostCandidate,
  type SearchInputHostInferInput,
  type SearchInputHostProfile,
  type SearchInputHostRejection,
  type SearchInputHostResult,
  type SearchInputHostWire,
} from "../../adapters/browser/search-input-host-contract.js";

/** Weights are bounded so a single saturated row cannot dominate the ranking. */
const WEIGHT_BOUND = 8;

/**
 * Usage-evidence wires. These are the only wires the absolute objective learns;
 * every other wire stays exactly zero, so a candidate with no measured cue
 * scores identically zero and falls below θ instead of drifting to a default.
 */
const USAGE_EVIDENCE_WIRES = Object.freeze([
  "markerHit",
  "nonSearchMarker",
  "formRoleSearch",
] as const);

const USAGE_EVIDENCE_INDEX = Object.freeze(
  USAGE_EVIDENCE_WIRES.map(wire => SEARCH_INPUT_HOST_WIRES.indexOf(wire as SearchInputHostWire)),
);

/** Absolute objective margin, anchored on the inference threshold. */
const ABSOLUTE_MARGIN = 1;

/** Inference boundary: tanh(z) ≥ θ ⟺ z ≥ b. */
const ABSOLUTE_BOUNDARY = Math.atanh(SEARCH_INPUT_HOST_THRESHOLD);

/** Checkpoints are where the stop condition is evaluated, mirroring the contract budget. */
const ABSOLUTE_CHECKPOINT_INTERVAL = 50;

// ---------------------------------------------------------------------------
// Features (§3): one feature vector per measured candidate, all values 0 or 1.
//
// editable/disabled/readOnly/cssHidden/intersectsViewport are listed in §3 and
// therefore present in the wire, but the applicability guard already fixes them
// for every scored candidate. They act as constant offsets and cannot change a
// within-batch ranking; the deterministic guard, not the weight, decides them.
// ---------------------------------------------------------------------------

function oneHot(value: boolean): number {
  return value ? 1 : 0;
}

export function searchInputHostFeatures(candidate: MeasuredSearchInputHostCandidate): readonly number[] {
  const typeIndex = {
    text: 0, search: 1, tel: 2, email: 3, url: 4, number: 5, other: 6,
  }[candidate.type];
  const tabIndexIndex = {
    negative: 15, nonnegative: 16, absent: 17, invalid: 18,
  }[candidate.explicitTabIndexKind];
  const depthIndex = { shallow: 23, middle: 24, deep: 25 }[candidate.depthBand];
  const textLenIndex = { 0: 31, 1: 32, 2: 33 }[candidate.textLenBand];

  const features = new Array<number>(SEARCH_INPUT_HOST_WIRES.length).fill(0);
  features[typeIndex] = 1;
  features[7] = oneHot(candidate.contentEditable);
  features[8] = oneHot(candidate.host === "input");
  features[9] = oneHot(candidate.host === "textarea");
  features[10] = oneHot(candidate.editable);
  features[11] = oneHot(candidate.disabled);
  features[12] = oneHot(candidate.readOnly);
  features[13] = oneHot(candidate.cssHidden);
  features[14] = oneHot(candidate.intersectsViewport);
  features[tabIndexIndex] = 1;
  features[19] = oneHot(candidate.tabIndexFocus);
  features[20] = oneHot(candidate.inForm);
  features[21] = oneHot(candidate.formRoleSearch);
  features[22] = oneHot(candidate.nearbySubmit);
  features[depthIndex] = 1;
  features[26] = oneHot(candidate.hasLabel);
  features[27] = oneHot(candidate.hasPlaceholder);
  features[28] = oneHot(candidate.hasAria);
  features[29] = oneHot(candidate.markerHit);
  features[30] = oneHot(candidate.nonSearchMarker);
  features[textLenIndex] = 1;
  return Object.freeze(features);
}

function dot(left: readonly number[], right: readonly number[]): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += left[index]! * right[index]!;
  return total;
}

function roleMatchOf(candidate: MeasuredSearchInputHostCandidate, profile: SearchInputHostProfile): number {
  return Math.tanh(dot(profile.weights, searchInputHostFeatures(candidate)));
}

/**
 * Input types that can carry typed input. This is an operational fact about what
 * the control does, so it is a deterministic guard, not a learned preference.
 */
const TEXT_ENTRY_TYPES: readonly string[] = Object.freeze([
  "text", "search", "tel", "email", "url", "number",
]);

/**
 * Layer 1, structural kind: could a control of this kind ever carry typed input?
 *
 * This is a fact about the element kind (text-entry input, textarea or
 * contenteditable), not about its state. A checkbox, radio, submit or file
 * control cannot carry the search-input role regardless of usage cues.
 *
 * Deliberately excludes every state fact: editable, disabled, readOnly,
 * cssHidden and intersectsViewport. Alice ruling 2026-10-24: "disabled/readOnly
 * 同样不能泛称角色消失，none 须限定当前可执行宿主合同并有覆盖，别扩成语义不存在."
 * A disabled search box is still a search host; it is just not executable now.
 * Only kind-level inability justifies a whole-scope `none`.
 */
function isStructurallyEligible(candidate: MeasuredSearchInputHostCandidate): boolean {
  if (candidate.host === "textarea" || candidate.host === "contenteditable") return true;
  return TEXT_ENTRY_TYPES.includes(candidate.type);
}

/**
 * Layer 2, perceivability: is the control displayed at all?
 *
 * Distinct from kind and from operability: a CSS-hidden input is still that kind
 * of control. Being hidden means it cannot be perceived now, not that it is
 * absent.
 */
function isPerceivable(candidate: MeasuredSearchInputHostCandidate): boolean {
  return candidate.cssHidden !== true;
}

/**
 * Layer 3, current action eligibility: can the control be acted on right now?
 *
 * Requires the input to be enabled, editable, not read-only, perceivable and
 * inside the viewport. Alice ruling 2026-10-24: "当前动作资格仍要求在视口和真实可
 * 操作", while "结构合格不证明已可感知，css可显示不证明在视口或未遮挡". Failure here
 * means unassessed for current operation, never absence of the role.
 */
function isApplicable(candidate: MeasuredSearchInputHostCandidate): boolean {
  return isStructurallyEligible(candidate)
    && candidate.editable === true
    && candidate.disabled !== true
    && candidate.readOnly !== true
    && isPerceivable(candidate)
    && candidate.intersectsViewport === true;
}

// ---------------------------------------------------------------------------
// Inference: deterministic guards then threshold/uniqueness aggregation.
// ---------------------------------------------------------------------------

function reject(
  rejection: SearchInputHostRejection,
  observedRevision: number | null,
  evidenceRefs: readonly string[] = [],
): SearchInputHostResult {
  return Object.freeze({
    state: "insufficient_observation",
    selectedRef: null,
    evidenceRefs: Object.freeze([...evidenceRefs]),
    observedRevision,
    rejection,
  });
}

export function inferSearchInputHostBinding(
  input: SearchInputHostInferInput,
  resources: { readonly profile: SearchInputHostProfile },
): SearchInputHostResult {
  const profile = validateSearchInputHostProfile(resources.profile);
  const request = validateSearchInputHostInferInput(input);
  const { goal, candidates, coverage, currentControl } = request;
  const observedRevision = currentControl.revision;

  // Unknown requested role is an explicit rejection, never a silent `none`.
  if (goal.requestedRole !== SEARCH_INPUT_HOST_ROLE) {
    return reject("unsupported_requested_role", observedRevision);
  }

  // The observed scope must be the scope the goal allowed.
  if (coverage.scopeRef !== goal.allowedScopeRef) {
    return reject("unverified_coverage", observedRevision);
  }

  // Coverage is proven only by the production unassessed counts; a caller
  // cannot prove coverage with a self-consistent declared count.
  if (coverage.unassessedIframeCount > 0
    || coverage.unassessedObjectCount > 0
    || coverage.unassessedOpenShadowRootCount > 0) {
    return reject("unassessed_scope_content", observedRevision);
  }

  // Self-consistency is necessary but not sufficient.
  if (coverage.observedCandidateCount !== candidates.length) {
    return reject("unverified_coverage", observedRevision);
  }

  const outsideScope = candidates.filter(candidate => candidate.scopeRef !== coverage.scopeRef);
  if (outsideScope.length > 0) {
    return reject("candidate_outside_scope", observedRevision, outsideScope.map(candidate => candidate.ref));
  }

  // Currentness: each candidate must carry this observation's identity triple.
  const stale = candidates.filter(candidate =>
    candidate.documentRef !== currentControl.documentRef
    || candidate.observationId !== currentControl.observationId
    || candidate.revision !== currentControl.revision);
  if (stale.length > 0) {
    return reject("stale_candidate", observedRevision, stale.map(candidate => candidate.ref));
  }

  // Missing measurement is never read as false and never collapses into none.
  const unmeasured = candidates.filter(candidate => !isMeasuredSearchInputHostCandidate(candidate));
  if (unmeasured.length > 0) {
    return reject("unmeasured_candidate_fields", observedRevision, unmeasured.map(candidate => candidate.ref));
  }

  const measured = candidates as readonly MeasuredSearchInputHostCandidate[];
  const structurallyEligible = measured.filter(isStructurallyEligible);
  if (structurallyEligible.length === 0) {
    // No control of an input-carrying kind exists in scope. That is the only
    // whole-scope absence claim this unit may make; it is about kinds, not about
    // states (a disabled or hidden host of an eligible kind still blocks it).
    return Object.freeze({
      state: "none",
      selectedRef: null,
      evidenceRefs: Object.freeze([]),
      observedRevision,
    });
  }

  const applied = structurallyEligible.filter(isApplicable);
  if (applied.length === 0) {
    // Structurally able hosts exist but none can be perceived and acted on now.
    // Such a host has not been assessed for the role, so it is NOT positive
    // evidence of absence (G1, Alice ruling 2026-10-24). The scope has unassessed
    // content, so the safe answer is insufficient.
    return reject(
      "unassessed_scope_content",
      observedRevision,
      structurallyEligible.map(candidate => candidate.ref),
    );
  }

  // `none` requires positive usage evidence that no applicable host carries the
  // role. A low score, a missing cue hit or an unknown purpose is not evidence of
  // absence: non-search inputs are allowed to exist inside an eligible scope, so
  // every applicable host must carry an explicit non-search usage fact and no
  // search cue for `none` to be justified.
  const confirmedNonSearch = applied.every(candidate =>
    candidate.nonSearchMarker === true
    && candidate.markerHit === false
    && candidate.formRoleSearch === false);
  if (confirmedNonSearch) {
    // Even when every applicable host looks non-search, a structurally able host
    // that is not perceivable or not in the viewport has not been assessed for
    // its usage, so a whole-scope `none` is not justified (G1 mixed-scope case,
    // Alice ruling 2026-10-24). Unassessed coverage is a gap, not absence.
    const unassessedEligible = structurallyEligible.filter(candidate => isApplicable(candidate) === false);
    if (unassessedEligible.length > 0) {
      return reject(
        "unassessed_scope_content",
        observedRevision,
        unassessedEligible.map(candidate => candidate.ref),
      );
    }
    return Object.freeze({
      state: "none",
      selectedRef: null,
      evidenceRefs: Object.freeze(applied.map(candidate => candidate.ref)),
      observedRevision,
    });
  }

  // Access gate: permission state is deterministic and never learned.
  const gated = applied.filter(candidate => candidate.access !== "available");
  if (gated.length > 0) {
    return reject("access_unknown", observedRevision, gated.map(candidate => candidate.ref));
  }

  const scored = applied.map(candidate => ({ candidate, roleMatch: roleMatchOf(candidate, profile) }));
  const max = Math.max(...scored.map(entry => entry.roleMatch));
  if (max < profile.threshold) {
    // Evidence below θ is insufficient_observation, not `none`.
    return Object.freeze({
      state: "insufficient_observation",
      selectedRef: null,
      evidenceRefs: Object.freeze(applied.map(candidate => candidate.ref)),
      observedRevision,
    });
  }

  const winners = scored.filter(entry => entry.roleMatch === max);
  if (winners.length === 1) {
    // Candidate validation already guarantees a non-empty ref, and winners are
    // drawn from this batch, so the selected ref is non-empty and local.
    const ref = winners[0]!.candidate.ref;
    return Object.freeze({
      state: "selected",
      selectedRef: ref,
      evidenceRefs: Object.freeze([ref]),
      observedRevision,
    });
  }

  return Object.freeze({
    state: "ambiguous",
    selectedRef: null,
    evidenceRefs: Object.freeze(winners.map(entry => entry.candidate.ref)),
    observedRevision,
  });
}

// ---------------------------------------------------------------------------
// Training: pairwise ranking within each batch.
// ---------------------------------------------------------------------------

export type SearchInputHostTrainingObjective = "pairwise" | "absolute";

/**
 * Supervision polarity for one measured candidate. Polarity is deliberately kept
 * off `SearchInputHostCandidate`: the candidate validator runs with `exactKeys`
 * for live inference too, and a gold label is not a property of an observed
 * control.
 */
export interface SearchInputHostTrainingLabel {
  readonly ref: string;
  readonly polarity: "positive" | "negative" | "unknown";
}

export interface SearchInputHostTrainingBatch {
  readonly id: string;
  readonly partition: "train" | "dev";
  readonly targetRef: string | null;
  readonly candidates: readonly SearchInputHostCandidate[];
  readonly labels?: readonly SearchInputHostTrainingLabel[] | undefined;
}

export interface SearchInputHostTrainingInput {
  readonly batches: readonly SearchInputHostTrainingBatch[];
}

export interface SearchInputHostTrainingResources {
  readonly epochs?: number;
  readonly learningRate?: number;
  readonly margin?: number;
  readonly objective?: SearchInputHostTrainingObjective;
}

export interface SearchInputHostChangedWeight {
  readonly wire: SearchInputHostWire;
  readonly before: number;
  readonly after: number;
}

export interface SearchInputHostExcludedTrainingRow {
  readonly ref: string;
  readonly reason: "zero-usage-evidence";
  readonly roleMatch: number;
}

export interface SearchInputHostTrainingFit {
  readonly objective: SearchInputHostTrainingObjective;
  readonly trainBatchCount: number;
  readonly devBatchCount: number;
  readonly rankedBatchCount: number;
  readonly skippedNoTargetCount: number;
  readonly pairCount: number;
  readonly fittedRowCount: number;
  readonly positiveRowCount: number;
  readonly negativeRowCount: number;
  readonly unknownRowCount: number;
  readonly excludedRows: readonly SearchInputHostExcludedTrainingRow[];
  readonly worstMarginViolation: number | null;
  readonly stopEpoch: number | null;
  /**
   * Wires whose unclamped step crossed the ±8 optimisation box. The bound is an
   * optimisation constraint, not a failure: a finite parameter may sit on it.
   * Recorded so a caller can see it; the stop metric decides acceptance.
   */
  readonly boundHitWires: readonly string[];
  readonly epochs: number;
  readonly learningRate: number;
  readonly margin: number;
  readonly lossBefore: number;
  readonly lossAfter: number;
  readonly changedWeightCount: number;
  readonly changedWeights: readonly SearchInputHostChangedWeight[];
}

export interface SearchInputHostTrainingResult {
  readonly profile: SearchInputHostProfile;
  readonly fit: SearchInputHostTrainingFit;
}

interface Pair {
  readonly target: readonly number[];
  readonly rival: readonly number[];
}

function readBudget(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative integer`);
  }
  return value;
}

function readPositiveNumber(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be positive and finite`);
  }
  return value;
}

/**
 * The objective must be named explicitly. An unknown or misspelled value throws
 * instead of falling back to pairwise, so a caller can never believe it asked
 * for absolute supervision and silently get a different objective.
 */
function readObjective(value: unknown): SearchInputHostTrainingObjective {
  if (value === undefined) return "pairwise";
  if (value === "pairwise" || value === "absolute") return value;
  throw new TypeError("objective must be pairwise or absolute");
}

function softplus(value: number): number {
  if (value > 0) return value + Math.log1p(Math.exp(-value));
  return Math.log1p(Math.exp(value));
}

function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

function pairwiseLossAndGradient(
  weights: readonly number[],
  pairs: readonly Pair[],
  margin: number,
): { readonly loss: number; readonly gradient: Float64Array } {
  const gradient = new Float64Array(weights.length);
  let loss = 0;
  for (const pair of pairs) {
    const difference = dot(weights, pair.target) - dot(weights, pair.rival);
    const z = margin - difference;
    loss += softplus(z);
    const factor = -sigmoid(z);
    for (let index = 0; index < weights.length; index += 1) {
      gradient[index] = gradient[index]! + factor * (pair.target[index]! - pair.rival[index]!);
    }
  }
  const count = pairs.length;
  for (let index = 0; index < gradient.length; index += 1) gradient[index] = gradient[index]! / count;
  return { loss: loss / count, gradient };
}

function validateTrainingBatch(value: unknown, label: string): SearchInputHostTrainingBatch {
  const batch = expectRecord(value, label);
  const allowed = new Set(["id", "partition", "targetRef", "candidates", "labels"]);
  for (const key of Object.keys(batch)) {
    if (!allowed.has(key)) throw new TypeError(`${label} has unknown field ${key}`);
  }
  if (typeof batch.id !== "string" || batch.id.length === 0) throw new TypeError(`${label}.id must be a non-empty string`);
  if (batch.partition !== "train" && batch.partition !== "dev") {
    throw new TypeError(`${label}.partition must be train or dev`);
  }
  if (batch.targetRef !== null && (typeof batch.targetRef !== "string" || batch.targetRef.length === 0)) {
    throw new TypeError(`${label}.targetRef must be null or a non-empty string`);
  }
  if (!Array.isArray(batch.candidates)) throw new TypeError(`${label}.candidates must be an array`);
  const refs = new Set<string>();
  const candidates = batch.candidates.map((raw: unknown, index: number) => {
    const candidate = validateSearchInputHostCandidate(raw, `${label}.candidates[${index}]`);
    if (refs.has(candidate.ref)) throw new TypeError(`${label}.candidates contains ${candidate.ref} twice`);
    refs.add(candidate.ref);
    return candidate;
  });
  return Object.freeze({
    id: batch.id,
    partition: batch.partition,
    targetRef: batch.targetRef,
    candidates: Object.freeze(candidates),
    labels: batch.labels === undefined ? undefined : validateTrainingLabels(batch.labels, refs, `${label}.labels`),
  });
}

function validateTrainingLabels(
  value: unknown,
  candidateRefs: ReadonlySet<string>,
  label: string,
): readonly SearchInputHostTrainingLabel[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const seen = new Set<string>();
  return Object.freeze(value.map((raw: unknown, index: number) => {
    const entry = expectRecord(raw, `${label}[${index}]`);
    for (const key of Object.keys(entry)) {
      if (key !== "ref" && key !== "polarity") throw new TypeError(`${label}[${index}] has unknown field ${key}`);
    }
    if (typeof entry.ref !== "string" || entry.ref.length === 0) {
      throw new TypeError(`${label}[${index}].ref must be a non-empty string`);
    }
    if (!candidateRefs.has(entry.ref)) {
      throw new TypeError(`${label}[${index}].ref ${entry.ref} is absent from the batch candidates`);
    }
    if (seen.has(entry.ref)) throw new TypeError(`${label} contains ${entry.ref} twice`);
    seen.add(entry.ref);
    if (entry.polarity !== "positive" && entry.polarity !== "negative" && entry.polarity !== "unknown") {
      throw new TypeError(`${label}[${index}].polarity must be positive, negative or unknown`);
    }
    return Object.freeze({ ref: entry.ref, polarity: entry.polarity });
  }));
}

// ---------------------------------------------------------------------------
// Absolute objective (m1-new-experiment-contract.md).
//
// Every fitted row carries its own margin anchored on the inference boundary b,
// so a negative is pushed below b−m and a positive above b+m. Only the usage
// evidence wires are learnable, so a candidate with no measured cue scores
// exactly zero for every weight vector. Such a negative contributes zero
// gradient and can never satisfy a negative margin; it is therefore reported as
// an excluded row rather than silently given a margin it cannot meet.
// ---------------------------------------------------------------------------

interface AbsoluteRow {
  readonly ref: string;
  readonly polarity: 1 | -1;
  readonly evidence: readonly number[];
}

function usageEvidenceOf(candidate: MeasuredSearchInputHostCandidate): readonly number[] {
  const features = searchInputHostFeatures(candidate);
  return Object.freeze(USAGE_EVIDENCE_INDEX.map(index => features[index]!));
}

function absoluteLossAndGradient(
  learnable: readonly number[],
  rows: readonly AbsoluteRow[],
  margin: number,
): { readonly loss: number; readonly gradient: Float64Array; readonly worstViolation: number } {
  const gradient = new Float64Array(learnable.length);
  const positives = rows.filter(row => row.polarity === 1);
  const negatives = rows.filter(row => row.polarity === -1);
  let positiveLoss = 0;
  let negativeLoss = 0;
  let worstViolation = Number.NEGATIVE_INFINITY;
  for (const row of positives) {
    const z = dot(learnable, row.evidence);
    const violation = margin + (ABSOLUTE_BOUNDARY - z);
    worstViolation = Math.max(worstViolation, violation);
    positiveLoss += softplus(violation);
    const factor = -sigmoid(violation) / positives.length;
    for (let index = 0; index < learnable.length; index += 1) {
      gradient[index] = gradient[index]! + factor * row.evidence[index]!;
    }
  }
  for (const row of negatives) {
    const z = dot(learnable, row.evidence);
    const violation = margin + (z - ABSOLUTE_BOUNDARY);
    worstViolation = Math.max(worstViolation, violation);
    negativeLoss += softplus(violation);
    const factor = sigmoid(violation) / negatives.length;
    for (let index = 0; index < learnable.length; index += 1) {
      gradient[index] = gradient[index]! + factor * row.evidence[index]!;
    }
  }
  const positiveMean = positives.length === 0 ? 0 : positiveLoss / positives.length;
  const negativeMean = negatives.length === 0 ? 0 : negativeLoss / negatives.length;
  return { loss: positiveMean + negativeMean, gradient, worstViolation };
}

function fitAbsoluteSupervision(
  batches: readonly SearchInputHostTrainingBatch[],
  epochs: number,
  learningRate: number,
  margin: number,
): SearchInputHostTrainingResult {
  const rows: AbsoluteRow[] = [];
  const excludedRows: SearchInputHostExcludedTrainingRow[] = [];
  let trainBatchCount = 0;
  let devBatchCount = 0;
  let unknownRowCount = 0;

  for (const batch of batches) {
    if (batch.partition === "dev") {
      devBatchCount += 1;
      continue;
    }
    trainBatchCount += 1;
    if (batch.labels === undefined) {
      throw new TypeError(`training batch ${batch.id} has no labels; the absolute objective needs a polarity per candidate`);
    }
    const labelled = new Set(batch.labels.map(label => label.ref));
    for (const candidate of batch.candidates) {
      if (!labelled.has(candidate.ref)) {
        throw new TypeError(`training batch ${batch.id} candidate ${candidate.ref} has no label`);
      }
    }
    const measured = new Map<string, MeasuredSearchInputHostCandidate>();
    for (const candidate of batch.candidates) {
      if (!isMeasuredSearchInputHostCandidate(candidate)) {
        throw new TypeError(`training batch ${batch.id} contains an unmeasured candidate; do not fit on missing measurements`);
      }
      measured.set(candidate.ref, candidate);
    }
    for (const label of batch.labels) {
      if (label.polarity === "unknown") {
        unknownRowCount += 1;
        continue;
      }
      const candidate = measured.get(label.ref)!;
      const evidence = usageEvidenceOf(candidate);
      const polarity = label.polarity === "positive" ? 1 : -1;
      if (polarity === -1 && evidence.every(value => value === 0)) {
        excludedRows.push(Object.freeze({ ref: label.ref, reason: "zero-usage-evidence", roleMatch: 0 }));
        continue;
      }
      rows.push({ ref: label.ref, polarity, evidence });
    }
  }

  if (trainBatchCount === 0) throw new TypeError("search input host training requires at least one train batch");
  const positiveRowCount = rows.filter(row => row.polarity === 1).length;
  const negativeRowCount = rows.length - positiveRowCount;
  if (positiveRowCount === 0) throw new TypeError("absolute supervision requires at least one fitted positive row");
  if (negativeRowCount === 0) throw new TypeError("absolute supervision requires at least one fitted negative row");

  const initialWeights = USAGE_EVIDENCE_INDEX.map(() => 0);
  const lossBefore = absoluteLossAndGradient(initialWeights, rows, margin).loss;

  let learnable = initialWeights.slice();
  let stopEpoch: number | null = null;
  let worstMarginViolation: number | null = null;
  const boundHitWires = new Set<number>();
  for (let epoch = 1; epoch <= epochs; epoch += 1) {
    const evaluated = absoluteLossAndGradient(learnable, rows, margin);
    learnable = learnable.map((weight, index) => {
      const next = weight - learningRate * evaluated.gradient[index]!;
      if (!Number.isFinite(next)) throw new Error("non-finite search input host parameter during fit");
      // The bound is an optimisation box, not a failure signal: a finite
      // parameter may legitimately sit at ±8. Touching it is recorded as an
      // observable statistic and the stop metric still decides success.
      const clamped = Math.max(-WEIGHT_BOUND, Math.min(WEIGHT_BOUND, next));
      if (Math.abs(next) > WEIGHT_BOUND) boundHitWires.add(index);
      return clamped;
    });
    if (epoch % ABSOLUTE_CHECKPOINT_INTERVAL === 0) {
      const checkpoint = absoluteLossAndGradient(learnable, rows, margin);
      if (checkpoint.worstViolation <= 0) {
        stopEpoch = epoch;
        worstMarginViolation = checkpoint.worstViolation;
        break;
      }
    }
  }
  // An unmet stop metric is reported, not thrown. The caller decides acceptance
  // from the reported number; a parameter resting on the optimisation bound is
  // likewise a number, not an error.
  const lossAfter = absoluteLossAndGradient(learnable, rows, margin).loss;
  const worstMarginViolationFinal = stopEpoch === null
    ? absoluteLossAndGradient(learnable, rows, margin).worstViolation
    : worstMarginViolation!;

  const weights = SEARCH_INPUT_HOST_WIRES.map(() => 0);
  for (let index = 0; index < USAGE_EVIDENCE_INDEX.length; index += 1) {
    weights[USAGE_EVIDENCE_INDEX[index]!] = learnable[index]!;
  }

  const changedWeights: SearchInputHostChangedWeight[] = [];
  for (let index = 0; index < weights.length; index += 1) {
    if (Math.abs(weights[index]!) > 1e-9) {
      changedWeights.push({ wire: SEARCH_INPUT_HOST_WIRES[index]!, before: 0, after: weights[index]! });
    }
  }

  const profile = validateSearchInputHostProfile({
    contract: SEARCH_INPUT_HOST_CONTRACT,
    role: SEARCH_INPUT_HOST_ROLE,
    wires: [...SEARCH_INPUT_HOST_WIRES],
    weights,
    threshold: SEARCH_INPUT_HOST_THRESHOLD,
    calibration: "uncalibrated",
    adoption: "not_applied",
  });

  return Object.freeze({
    profile,
    fit: Object.freeze({
      objective: "absolute" as const,
      trainBatchCount,
      devBatchCount,
      rankedBatchCount: 0,
      skippedNoTargetCount: 0,
      pairCount: 0,
      fittedRowCount: rows.length,
      positiveRowCount,
      negativeRowCount,
      unknownRowCount,
      excludedRows: Object.freeze(excludedRows.map(row => Object.freeze(row))),
      worstMarginViolation: worstMarginViolationFinal,
      stopEpoch,
      boundHitWires: Object.freeze([...boundHitWires].map(index => USAGE_EVIDENCE_WIRES[index]!)),
      epochs,
      learningRate,
      margin,
      lossBefore,
      lossAfter,
      changedWeightCount: changedWeights.length,
      changedWeights: Object.freeze(changedWeights.map(change => Object.freeze(change))),
    }),
  });
}

export function trainSearchInputHostBinder(
  input: SearchInputHostTrainingInput,
  resources: SearchInputHostTrainingResources = {},
): SearchInputHostTrainingResult {
  const value = expectRecord(input, "search input host training input");
  if (!Array.isArray(value.batches)) throw new TypeError("search input host training input.batches must be an array");
  const batches = value.batches.map((raw, index) => validateTrainingBatch(raw, `search input host training input.batches[${index}]`));

  const objective = readObjective(resources.objective);
  const allowedResources = new Set(["epochs", "learningRate", "margin", "objective"]);
  for (const key of Object.keys(resources)) {
    if (!allowedResources.has(key)) throw new TypeError(`training resources has unknown field ${key}`);
  }
  if (objective === "absolute") {
    const absoluteEpochs = readBudget(resources.epochs, 400, "epochs");
    const absoluteLearningRate = readPositiveNumber(resources.learningRate, 0.5, "learningRate");
    const absoluteMargin = readPositiveNumber(resources.margin, ABSOLUTE_MARGIN, "margin");
    return fitAbsoluteSupervision(batches, absoluteEpochs, absoluteLearningRate, absoluteMargin);
  }

  const epochs = readBudget(resources.epochs, 40, "epochs");
  const learningRate = readPositiveNumber(resources.learningRate, 0.5, "learningRate");
  const margin = readPositiveNumber(resources.margin, 0.2, "margin");

  const initialWeights = SEARCH_INPUT_HOST_WIRES.map(() => 0);
  const pairs: Pair[] = [];
  let trainBatchCount = 0;
  let devBatchCount = 0;
  let rankedBatchCount = 0;
  let skippedNoTargetCount = 0;

  for (const batch of batches) {
    if (batch.partition === "dev") {
      devBatchCount += 1;
      continue;
    }
    trainBatchCount += 1;
    if (batch.targetRef === null) {
      skippedNoTargetCount += 1;
      continue;
    }
    const measured = batch.candidates.map(candidate => {
      if (!isMeasuredSearchInputHostCandidate(candidate)) {
        throw new TypeError(`training batch ${batch.id} contains an unmeasured candidate; do not fit on missing measurements`);
      }
      return candidate;
    });
    const target = measured.find(candidate => candidate.ref === batch.targetRef);
    if (!target) throw new TypeError(`training batch ${batch.id} targetRef ${batch.targetRef} is absent from the batch`);
    if (!isApplicable(target)) throw new TypeError(`training batch ${batch.id} targetRef ${batch.targetRef} is not an applicable host`);
    const rivals = measured.filter(candidate => candidate.ref !== batch.targetRef && isApplicable(candidate));
    if (rivals.length > 0) rankedBatchCount += 1;
    for (const rival of rivals) {
      pairs.push({
        target: searchInputHostFeatures(target),
        rival: searchInputHostFeatures(rival),
      });
    }
  }

  if (trainBatchCount === 0) throw new TypeError("search input host training requires at least one train batch");
  if (pairs.length === 0) throw new TypeError("search input host training requires at least one applicable target with a rival");

  const lossBefore = pairwiseLossAndGradient(initialWeights, pairs, margin).loss;

  let weights = initialWeights.slice();
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const evaluated = pairwiseLossAndGradient(weights, pairs, margin);
    const gradient = evaluated.gradient;
    weights = weights.map((weight, index) => {
      const next = weight - learningRate * gradient[index]!;
      if (!Number.isFinite(next)) throw new Error("non-finite search input host parameter during fit");
      return Math.max(-WEIGHT_BOUND, Math.min(WEIGHT_BOUND, next));
    });
  }

  const lossAfter = pairwiseLossAndGradient(weights, pairs, margin).loss;
  const changedWeights: SearchInputHostChangedWeight[] = [];
  for (let index = 0; index < weights.length; index += 1) {
    if (Math.abs(weights[index]! - initialWeights[index]!) > 1e-9) {
      changedWeights.push({
        wire: SEARCH_INPUT_HOST_WIRES[index]!,
        before: initialWeights[index]!,
        after: weights[index]!,
      });
    }
  }

  const profile = validateSearchInputHostProfile({
    contract: SEARCH_INPUT_HOST_CONTRACT,
    role: SEARCH_INPUT_HOST_ROLE,
    wires: [...SEARCH_INPUT_HOST_WIRES],
    weights,
    threshold: SEARCH_INPUT_HOST_THRESHOLD,
    calibration: "uncalibrated",
    adoption: "not_applied",
  });

  return Object.freeze({
    profile,
    fit: Object.freeze({
      objective: "pairwise" as const,
      trainBatchCount,
      devBatchCount,
      rankedBatchCount,
      skippedNoTargetCount,
      pairCount: pairs.length,
      fittedRowCount: 0,
      positiveRowCount: 0,
      negativeRowCount: 0,
      unknownRowCount: 0,
      excludedRows: Object.freeze([]),
      worstMarginViolation: null,
      stopEpoch: null,
      boundHitWires: Object.freeze([]),
      epochs,
      learningRate,
      margin,
      lossBefore,
      lossAfter,
      changedWeightCount: changedWeights.length,
      changedWeights: Object.freeze(changedWeights.map(change => Object.freeze(change))),
    }),
  });
}

// ---------------------------------------------------------------------------
// TrainableSemanticUnit lifecycle view.
// ---------------------------------------------------------------------------

export type SearchInputHostInferenceResources = { readonly profile: SearchInputHostProfile };

export const searchInputHostBinderUnit: TrainableSemanticUnit<
  SearchInputHostInferInput,
  SearchInputHostResult,
  SearchInputHostInferenceResources,
  SearchInputHostTrainingInput,
  SearchInputHostTrainingResult,
  SearchInputHostTrainingResources
> = {
  infer: (input, resources) => Promise.resolve(inferSearchInputHostBinding(input, resources)),
  train: (input, resources) => Promise.resolve(trainSearchInputHostBinder(input, resources)),
};
