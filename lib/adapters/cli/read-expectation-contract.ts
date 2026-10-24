/**
 * CLI read expectation: contract, wire names and label vocabulary.
 *
 * Module prefix: `cli-read-feedback/read-expectation`.
 * Two units only: ReadFeedbackUnit (per-head multi-label) and
 * ReadReasoningUnit (single next requirement).
 *
 * Wire counts are derived from the arrays below; never write those numbers by
 * hand anywhere else.
 */

export const BASE_WIRES = [
  // execution facts (mask: execution_measured)
  "execution_succeeded",
  "err_stage_observe",
  "err_stage_validate",
  // input missing-measurement masks (features)
  "receipt_measured",
  "execution_measured",
  "size_measured",
  "bytes_measured",
  "bytes_read_measured",
  "request_measured",
  // request shape
  "req_head",
  "req_tail",
  "req_range",
  // requirement mode: needed to decide whether a short read is whole (up_to at
  // a confirmed end) or a real shortfall (exact)
  "mode_up_to",
  "mode_exact",
  // acquisition
  "got_bytes",
  "short_read",
  "end_at_read",
  "exact_length_met",
  // boundary
  "offset_zero",
  "offset_equals_size",
  "offset_past_size",
  // quantity
  "bytes_read_zero",
  "size_zero",
  // completeness
  "range_covers_size",
  "empty_request",
  // errors
  "err_enoent",
  "err_eacces",
  "err_other",
  // target
  "identity_changed",
  "target_type_denied",
] as const;

export type BaseWire = (typeof BASE_WIRES)[number];
export type BaseVector = Readonly<Record<BaseWire, 0 | 1>>;

export const BASE_LABELS = [
  "data_obtained",
  "end_observed",
  "incomplete_observation",
  "execution_error",
  "target_changed",
  "observation_unknown",
] as const;

export type BaseLabel = (typeof BASE_LABELS)[number];

export const REASONING_WIRES = [
  // base-unit inference output (model prediction, never gold)
  "fb_data_obtained",
  "fb_end_observed",
  "fb_incomplete",
  "fb_error",
  "fb_changed",
  "fb_unknown",
  // deterministic quantity state from measured facts
  "qty_met",
  "qty_short_end_confirmed",
  "qty_short_end_unconfirmed",
  "qty_known",
  // requirement mode
  "mode_up_to",
  "mode_exact",
  // target validity
  "target_current",
  "target_stale",
  "target_unreadable",
  // reissue / retry
  "binding_reissuable",
  "retry_eligible",
  "retry_budget_left",
  "retry_exhausted",
  // available skills
  "skill_read_available",
  "skill_inspect_available",
  "skill_observe_available",
  "skill_none",
] as const;

export type ReasoningWire = (typeof REASONING_WIRES)[number];
export type ReasoningVector = Readonly<Record<ReasoningWire, 0 | 1>>;

export const REASONING_LABELS = [
  "condition_met",
  "need_remaining_data",
  "need_current_target",
  "retry_current_read",
  "terminal_error",
  "need_observation",
] as const;

export type ReasoningLabel = (typeof REASONING_LABELS)[number];

/** Requirement modes fixed by the experiment contract. */
export type QuantityMode = "up_to" | "exact";

/** User-level read shape; the harness computes offsets, the model never does. */
export type ReadShape = "head" | "tail" | "range";

export type ReadRequest = Readonly<{
  shape: ReadShape;
  mode: QuantityMode;
  /** Requested quantity in bytes (user semantics). */
  quantity: number;
  /** Requested byte range; for head it is [0, quantity). */
  offset: number;
  length: number;
}>;

/** Closed interval ledger of already obtained byte ranges, half-open [start, end). */
export type CoverageInterval = readonly [number, number];

/** Error observation carried by a failed receipt. */
export type ReadFailure = Readonly<{
  stage: "validate" | "observe";
  code: string;
  message: string;
  executorInvoked: boolean;
}>;

/** Successful read observation, mirroring the sandbox receipt. */
export type ReadObservation = Readonly<{
  offset: number;
  length: number;
  size: number;
  bytes: string;
  bytesRead: number;
  /** Kept as-is from the reader; short-read flag, not an end-of-file truth. */
  eof: boolean;
  dev: number | string;
  ino: number | string;
}>;

/** One real read attempt: receipt may be absent when nothing was observed. */
export type ReadAttempt = Readonly<{
  request: ReadRequest;
  observation: ReadObservation | null;
  failure: ReadFailure | null;
  /** Accumulated coverage before this attempt. */
  priorCoverage: readonly CoverageInterval[];
}>;

/** Harness-owned deterministic inputs that are not model predictions. */
export type ReadContext = Readonly<{
  target: "current" | "stale" | "unreadable";
  bindingReissuable: boolean;
  retryEligible: boolean;
  retryBudgetLeft: number;
  retryExhausted: boolean;
  skills: readonly ("read" | "inspect" | "observe")[];
}>;

export type BaseSupervision = Readonly<{
  /** Per-head gold value. */
  label: Readonly<Record<BaseLabel, 0 | 1>>;
  /** Per-head supervision mask; 0 means the label is unknown and is skipped. */
  mask: Readonly<Record<BaseLabel, 0 | 1>>;
}>;

export type ReasoningSupervision = Readonly<{
  /** Oracle allowed set; model prediction must fall inside it. */
  allowed: readonly ReasoningLabel[];
  /** Auxiliary soft target, only used as an extra loss term. */
  soft: Readonly<Record<ReasoningLabel, number>>;
}>;
