// B-A1 M1 phase 2: search-input-host binder numeric unit.
//
// learnable:  one scalar per candidate, roleMatch in [-1, 1], as a linear
//             function of the §3 feature table followed by tanh.
// deterministic: applicability, missing-measurement detection, coverage,
//             access gating, currentness, threshold/uniqueness aggregation.
//
// The fitter uses pairwise ranking within a batch: the target candidate's
// roleMatch must exceed every other applicable candidate by a margin. Batches
// without a target participate in no ranking loss and only prove `none`.

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
 * Structural eligibility: can this control carry typed input at all?
 *
 * This is an operational fact about what the control is (text-entry input,
 * textarea or contenteditable), independent of where it sits on the page.
 * Type is an operational applicability fact: a checkbox, radio, submit or file
 * control cannot carry the search-input role regardless of its usage cues.
 *
 * Viewport intersection is deliberately NOT part of structural eligibility.
 * A control below the fold is unassessed for current operation, not evidence
 * that the role is absent (G1, Alice ruling 2026-10-24: "视口外不能证明角色
 * 不存在"). `none` may only be concluded with contract-sufficient coverage AND
 * supporting evidence; an unassessed host keeps the scope insufficient.
 */
function isStructurallyEligible(candidate: MeasuredSearchInputHostCandidate): boolean {
  if (candidate.editable !== true) return false;
  if (candidate.disabled === true) return false;
  if (candidate.readOnly === true) return false;
  if (candidate.cssHidden === true) return false;
  if (candidate.host === "textarea" || candidate.host === "contenteditable") return true;
  return TEXT_ENTRY_TYPES.includes(candidate.type);
}

/**
 * Current-operation applicability: the guard that decides whether a measured
 * host is a live candidate for the role right now.
 *
 * Distinct from structural eligibility: a structurally eligible host that is
 * outside the viewport is NOT applicable for the current action (Alice ruling
 * 2026-10-24: "当前动作资格仍要求在视口和真实可操作"), but its mere presence
 * means the scope is NOT proven to lack the role. Usage evidence stays
 * learnable; this guard only decides what can be acted on now.
 */
function isApplicable(candidate: MeasuredSearchInputHostCandidate): boolean {
  return isStructurallyEligible(candidate) && candidate.intersectsViewport === true;
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
  const applied = measured.filter(isApplicable);
  if (applied.length === 0) {
    // No in-viewport host can be acted on now. Whether the role is absent is a
    // different question: a structurally eligible host that simply sits outside
    // the viewport has not been assessed, so it is NOT positive evidence of
    // absence (G1, Alice ruling 2026-10-24). Only a scope with no structurally
    // eligible host at all justifies `none`.
    const structurallyEligible = measured.filter(isStructurallyEligible);
    if (structurallyEligible.length === 0) {
      // No control in scope can carry the role at all. That is positive
      // structural evidence that the role is absent, so `none` is justified.
      return Object.freeze({
        state: "none",
        selectedRef: null,
        evidenceRefs: Object.freeze([]),
        observedRevision,
      });
    }
    // Structurally eligible hosts exist but none is currently operable: the
    // scope has unassessed content, so the safe answer is insufficient.
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

export interface SearchInputHostTrainingBatch {
  readonly id: string;
  readonly partition: "train" | "dev";
  readonly targetRef: string | null;
  readonly candidates: readonly SearchInputHostCandidate[];
}

export interface SearchInputHostTrainingInput {
  readonly batches: readonly SearchInputHostTrainingBatch[];
}

export interface SearchInputHostTrainingResources {
  readonly epochs?: number;
  readonly learningRate?: number;
  readonly margin?: number;
}

export interface SearchInputHostChangedWeight {
  readonly wire: SearchInputHostWire;
  readonly before: number;
  readonly after: number;
}

export interface SearchInputHostTrainingResult {
  readonly profile: SearchInputHostProfile;
  readonly fit: {
    readonly trainBatchCount: number;
    readonly devBatchCount: number;
    readonly rankedBatchCount: number;
    readonly skippedNoTargetCount: number;
    readonly pairCount: number;
    readonly epochs: number;
    readonly learningRate: number;
    readonly margin: number;
    readonly lossBefore: number;
    readonly lossAfter: number;
    readonly changedWeightCount: number;
    readonly changedWeights: readonly SearchInputHostChangedWeight[];
  };
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
  });
}

export function trainSearchInputHostBinder(
  input: SearchInputHostTrainingInput,
  resources: SearchInputHostTrainingResources = {},
): SearchInputHostTrainingResult {
  const value = expectRecord(input, "search input host training input");
  if (!Array.isArray(value.batches)) throw new TypeError("search input host training input.batches must be an array");
  const batches = value.batches.map((raw, index) => validateTrainingBatch(raw, `search input host training input.batches[${index}]`));

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
      trainBatchCount,
      devBatchCount,
      rankedBatchCount,
      skippedNoTargetCount,
      pairCount: pairs.length,
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
