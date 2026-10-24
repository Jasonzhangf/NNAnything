/**
 * Deterministic measurement and oracle for the CLI read expectation units.
 *
 * Everything here is harness-side truth: it derives the input wires, the base
 * supervision (with per-head unknown mask) and the reasoning allowed set from
 * real receipts. No model output is consulted.
 */

import {
  BASE_LABELS,
  BASE_WIRES,
  REASONING_LABELS,
  REASONING_WIRES,
  type BaseLabel,
  type BaseSupervision,
  type BaseVector,
  type CoverageInterval,
  type ReadAttempt,
  type ReadContext,
  type ReasoningLabel,
  type ReasoningSupervision,
  type ReasoningVector,
} from "../adapters/cli/read-expectation-contract.js";

function zeros<K extends string>(keys: readonly K[]): Record<K, 0 | 1> {
  const out = {} as Record<K, 0 | 1>;
  for (const key of keys) out[key] = 0;
  return out;
}

/** Union coverage with overlap merging; the ledger must stay non-overlapping. */
export function mergeCoverage(intervals: readonly CoverageInterval[]): readonly CoverageInterval[] {
  const sorted = [...intervals].filter(([start, end]) => end > start).sort((left, right) => left[0] - right[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

/** True when the union of intervals covers [start, end). */
export function coversRange(intervals: readonly CoverageInterval[], start: number, end: number): boolean {
  if (end <= start) return true;
  const merged = mergeCoverage(intervals);
  let cursor = start;
  for (const [left, right] of merged) {
    if (left > cursor) return false;
    cursor = Math.max(cursor, right);
    if (cursor >= end) return true;
  }
  return cursor >= end;
}

/** The user-requested range for this attempt. `up_to` truncates at a confirmed end. */
export function requestedRange(
  attempt: ReadAttempt,
  endConfirmed: boolean,
  size: number,
): readonly [number, number] {
  const request = attempt.request;
  if (request.shape === "head") {
    const bound = request.mode === "up_to" && endConfirmed ? Math.min(request.quantity, size) : request.quantity;
    return [0, Math.max(0, bound)];
  }
  if (request.shape === "tail") {
    const start = Math.max(0, size - request.quantity);
    return [start, Math.max(start, size)];
  }
  const start = request.offset;
  const nominal = start + request.length;
  const bound = request.mode === "up_to" && endConfirmed ? Math.min(nominal, size) : nominal;
  return [start, Math.max(start, bound)];
}

/** Coverage this attempt adds when it succeeded. */
export function attemptCoverage(attempt: ReadAttempt): readonly CoverageInterval[] {
  const observation = attempt.observation;
  if (observation === null) return [];
  return [[observation.offset, observation.offset + observation.bytesRead]];
}

/** Input wire vector for ReadFeedbackUnit. Pure function of the receipt. */
export function measureBase(attempt: ReadAttempt): BaseVector {
  const wires = zeros(BASE_WIRES);
  const observation = attempt.observation;
  const failure = attempt.failure;
  const request = attempt.request;

  const receiptMeasured = observation !== null || failure !== null;
  wires.receipt_measured = receiptMeasured ? 1 : 0;
  // A failed receipt still carries an execution result, including preflight
  // failures where the read handle was never opened.
  wires.execution_measured = receiptMeasured ? 1 : 0;
  wires.request_measured = 1;

  wires.req_head = request.shape === "head" ? 1 : 0;
  wires.req_tail = request.shape === "tail" ? 1 : 0;
  wires.req_range = request.shape === "range" ? 1 : 0;
  wires.mode_up_to = request.mode === "up_to" ? 1 : 0;
  wires.mode_exact = request.mode === "exact" ? 1 : 0;
  wires.empty_request = request.length === 0 ? 1 : 0;
  wires.offset_zero = request.offset === 0 ? 1 : 0;

  if (observation !== null) {
    wires.execution_succeeded = 1;
    wires.size_measured = 1;
    wires.bytes_measured = 1;
    wires.bytes_read_measured = 1;

    wires.got_bytes = observation.bytesRead > 0 ? 1 : 0;
    wires.bytes_read_zero = observation.bytesRead === 0 ? 1 : 0;
    wires.size_zero = observation.size === 0 ? 1 : 0;
    wires.short_read = observation.bytesRead < request.length ? 1 : 0;
    wires.exact_length_met = observation.bytesRead === request.length ? 1 : 0;

    // Every dependency must be measured before a derived fact is known.
    const endKnown = wires.size_measured === 1 && wires.bytes_read_measured === 1 && wires.request_measured === 1;
    wires.end_at_read = endKnown && observation.offset + observation.bytesRead >= observation.size ? 1 : 0;

    wires.offset_equals_size = observation.offset === observation.size ? 1 : 0;
    wires.offset_past_size = observation.offset > observation.size ? 1 : 0;

    const sizeKnown = wires.size_measured === 1 && wires.request_measured === 1;
    wires.range_covers_size = sizeKnown && observation.offset + request.length >= observation.size ? 1 : 0;
  } else if (failure !== null) {
    wires.execution_succeeded = 0;
    wires.err_stage_observe = failure.stage === "observe" ? 1 : 0;
    wires.err_stage_validate = failure.stage === "validate" ? 1 : 0;
    wires.err_enoent = failure.code === "ENOENT" ? 1 : 0;
    wires.err_eacces = failure.code === "EACCES" ? 1 : 0;
    const known = failure.code === "ENOENT" || failure.code === "EACCES";
    wires.err_other = known ? 0 : 1;
    wires.identity_changed = failure.code === "STALE_REFERENCE" || failure.code === "READ_TARGET_CHANGED" ? 1 : 0;
    wires.target_type_denied = failure.code === "NOT_REGULAR_FILE" || failure.code === "READ_TYPE_DENIED" ? 1 : 0;
  }

  return Object.freeze(wires);
}

/**
 * Gold base feedback with per-head unknown mask.
 *
 * The six states are independent facts, not a single exclusive label. A head is
 * supervised only when the facts needed to decide it were actually observed.
 */
export function superviseBase(attempt: ReadAttempt): BaseSupervision {
  const wires = measureBase(attempt);
  const label = zeros(BASE_LABELS);
  const mask = zeros(BASE_LABELS);

  const receiptMeasured = wires.receipt_measured === 1;
  const succeeded = wires.execution_succeeded === 1;
  const gotBytes = succeeded && wires.bytes_measured === 1;

  // data_obtained: current receipt with a byte field (empty string still counts).
  mask.data_obtained = receiptMeasured ? 1 : 1;
  label.data_obtained = gotBytes ? 1 : 0;

  // end_observed: needs size + bytesRead + request, all measured.
  const endKnown =
    succeeded && wires.size_measured === 1 && wires.bytes_read_measured === 1 && wires.request_measured === 1;
  mask.end_observed = endKnown ? 1 : 0;
  label.end_observed = endKnown && wires.end_at_read === 1 ? 1 : 0;

  // incomplete_observation: execution completed but the needed observation is
  // not whole (no bytes field, or the requested range is not covered).
  const merged = mergeCoverage([...attempt.priorCoverage, ...attemptCoverage(attempt)]);
  const endConfirmed = endKnown && wires.end_at_read === 1;
  const size = attempt.observation === null ? 0 : attempt.observation.size;
  const [needStart, needEnd] = requestedRange(attempt, endConfirmed, size);
  const covered = coversRange(merged, needStart, needEnd);
  mask.incomplete_observation = succeeded ? 1 : 0;
  label.incomplete_observation = succeeded && (wires.bytes_measured !== 1 || !covered) ? 1 : 0;

  // execution_error: a real operation error, with stage/code kept in evidence.
  mask.execution_error = receiptMeasured ? 1 : 0;
  label.execution_error = receiptMeasured && !succeeded ? 1 : 0;

  // target_changed: identity/binding invalidated.
  mask.target_changed = receiptMeasured ? 1 : 0;
  label.target_changed = wires.identity_changed;

  // observation_unknown: no usable observation at all.
  mask.observation_unknown = 1;
  label.observation_unknown = receiptMeasured && (succeeded || wires.err_enoent === 1 || wires.err_eacces === 1 || wires.err_other === 1) ? 0 : 1;
  if (receiptMeasured && !succeeded && wires.err_enoent === 0 && wires.err_eacces === 0 && wires.err_other === 0) {
    // Failure without a measurable error code: still unknown, not a claimed error.
    label.observation_unknown = 1;
  }

  return Object.freeze({ label: Object.freeze(label), mask: Object.freeze(mask) });
}

/** Deterministic quantity state from measured facts (never from predictions). */
export function measureQuantity(
  attempt: ReadAttempt,
  context: ReadContext,
): Readonly<{
  qtyMet: 0 | 1;
  shortEndConfirmed: 0 | 1;
  shortEndUnconfirmed: 0 | 1;
  known: 0 | 1;
  coverageComplete: 0 | 1;
}> {
  void context;
  const wires = measureBase(attempt);
  const observation = attempt.observation;
  const succeeded = wires.execution_succeeded === 1 && wires.bytes_measured === 1 && wires.bytes_read_measured === 1;
  if (!succeeded || observation === null) {
    return Object.freeze({ qtyMet: 0, shortEndConfirmed: 0, shortEndUnconfirmed: 0, known: 0, coverageComplete: 0 });
  }
  // Coverage is KNOWN as soon as the three fields are measured. Being known to
  // be incomplete (a real shortfall) is not the same as being unmeasured.
  const coverageKnown = wires.size_measured === 1 && wires.bytes_read_measured === 1 && wires.request_measured === 1;
  const endConfirmed = coverageKnown && wires.end_at_read === 1;
  const merged = mergeCoverage([...attempt.priorCoverage, ...attemptCoverage(attempt)]);
  const [needStart, needEnd] = requestedRange(attempt, endConfirmed, observation.size);
  const coverageComplete = coversRange(merged, needStart, needEnd) ? 1 : 0;
  const quantity = attempt.request.quantity;
  const have = merged.reduce((total, [start, end]) => total + (end - start), 0);
  const exactEnough = have >= quantity;
  const met = attempt.request.mode === "exact"
    ? coverageComplete === 1 && exactEnough
    : coverageComplete === 1 && (exactEnough || endConfirmed);
  const known: 0 | 1 = coverageKnown ? 1 : 0;
  if (known === 0) {
    return Object.freeze({ qtyMet: 0, shortEndConfirmed: 0, shortEndUnconfirmed: 0, known: 0, coverageComplete });
  }
  return Object.freeze({
    qtyMet: met ? 1 : 0,
    shortEndConfirmed: met ? 0 : endConfirmed ? 1 : 0,
    shortEndUnconfirmed: met ? 0 : endConfirmed ? 0 : 1,
    known: 1,
    coverageComplete,
  });
}

/** Reasoning input vector: model predictions plus deterministic facts. */
export function measureReasoning(
  prediction: Readonly<Record<BaseLabel, 0 | 1>>,
  attempt: ReadAttempt,
  context: ReadContext,
): ReasoningVector {
  const wires = zeros(REASONING_WIRES);
  wires.fb_data_obtained = prediction.data_obtained;
  wires.fb_end_observed = prediction.end_observed;
  wires.fb_incomplete = prediction.incomplete_observation;
  wires.fb_error = prediction.execution_error;
  wires.fb_changed = prediction.target_changed;
  wires.fb_unknown = prediction.observation_unknown;

  const quantity = measureQuantity(attempt, context);
  wires.qty_met = quantity.qtyMet;
  wires.qty_short_end_confirmed = quantity.shortEndConfirmed;
  wires.qty_short_end_unconfirmed = quantity.shortEndUnconfirmed;
  wires.qty_known = quantity.known;

  wires.mode_up_to = attempt.request.mode === "up_to" ? 1 : 0;
  wires.mode_exact = attempt.request.mode === "exact" ? 1 : 0;

  wires.target_current = context.target === "current" ? 1 : 0;
  wires.target_stale = context.target === "stale" ? 1 : 0;
  wires.target_unreadable = context.target === "unreadable" ? 1 : 0;

  wires.binding_reissuable = context.bindingReissuable ? 1 : 0;
  wires.retry_eligible = context.retryEligible ? 1 : 0;
  wires.retry_budget_left = context.retryBudgetLeft > 0 ? 1 : 0;
  wires.retry_exhausted = context.retryExhausted ? 1 : 0;

  wires.skill_read_available = context.skills.includes("read") ? 1 : 0;
  wires.skill_inspect_available = context.skills.includes("inspect") ? 1 : 0;
  wires.skill_observe_available = context.skills.includes("observe") ? 1 : 0;
  wires.skill_none = context.skills.length === 0 ? 1 : 0;

  return Object.freeze(wires);
}

/**
 * Oracle for the next requirement.
 *
 * `allowed` is computed from real facts only. The model prediction is compared
 * against it; a wrong prediction is recorded as wrong and never rewritten.
 */
export function superviseReasoning(attempt: ReadAttempt, context: ReadContext): ReasoningSupervision {
  const truth = superviseBase(attempt);
  const quantity = measureQuantity(attempt, context);
  const allowed: ReasoningLabel[] = [];

  const targetCurrent = context.target === "current";
  const failed = truth.label.execution_error === 1;
  const unknown = truth.label.observation_unknown === 1;
  const changed = truth.label.target_changed === 1;
  const retryable = context.retryEligible && context.retryBudgetLeft > 0 && !context.retryExhausted;
  const canObserve = context.skills.includes("observe");

  if (quantity.qtyMet === 1 && targetCurrent && !failed && !unknown && !changed) {
    allowed.push("condition_met");
  }
  if (changed && context.bindingReissuable) {
    allowed.push("need_current_target");
  }
  if (failed && !changed) {
    if (retryable) allowed.push("retry_current_read");
    else allowed.push("terminal_error");
  }
  if (!failed && quantity.known === 1 && quantity.qtyMet === 0) {
    if (quantity.shortEndConfirmed === 1 && !context.retryExhausted) {
      // Confirmed end with an unmet exact requirement: report the shortfall.
      allowed.push("terminal_error");
    } else {
      allowed.push("need_remaining_data");
    }
  }
  if (unknown) {
    // Without an observe skill the result stays unknown rather than being
    // claimed as success or failure.
    allowed.push("need_observation");
    void canObserve;
  }
  if (context.target === "unreadable" && !allowed.includes("need_observation")) {
    allowed.push("terminal_error");
  }
  if (allowed.length === 0) {
    allowed.push(!failed && quantity.known === 1 && quantity.qtyMet === 0 ? "need_remaining_data" : "need_observation");
  }

  const unique = [...new Set(allowed)] as readonly ReasoningLabel[];
  const soft: Record<ReasoningLabel, number> = Object.fromEntries(
    REASONING_LABELS.map(label => [label, 0]),
  ) as Record<ReasoningLabel, number>;
  for (const label of unique) soft[label] = Math.fround(1 / unique.length);

  return Object.freeze({ allowed: Object.freeze(unique), soft: Object.freeze(soft) });
}
