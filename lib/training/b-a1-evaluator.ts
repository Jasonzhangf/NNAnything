// B-A1 independent relation evaluator.
//
// This evaluator consumes a binder result, independently produced teacher gold,
// scope/currentness facts and typed evidence records. It never calls the model
// forward path and never derives gold from a model score. The semantic,
// contract-gate and aggregator-test families stay on separate denominators.

import {
  BA1_AGGREGATOR_STATES,
  BA1_CONTRACT_GATE_REASONS,
  validateBA1EvaluatorGold,
  type BA1AggregatorState,
  type BA1ContractGateReason,
  type BA1EvaluatorGold,
} from "./b-a1-sample-evaluator-skeleton.js";

export const BA1_EVALUATION_ERRORS = Object.freeze([
  "wrong_kind",
  "wrong_state",
  "wrong_reason",
  "wrong_ref",
  "unexpected_ref",
  "missing_evidence",
  "out_of_scope",
  "missing_coverage",
  "missing_reason_evidence",
  "stale_identity",
  "forced_selection",
  "insufficient_downgraded_to_none",
  "reject_misclassified",
] as const);

export type BA1EvaluationError = (typeof BA1_EVALUATION_ERRORS)[number];

export const BA1_DENOMINATOR_FAMILIES = Object.freeze([
  "family-a",
  "family-b",
  "new-independent-implementation",
  "real-site-held-out",
  "seen-source-diagnostics",
] as const);

export type BA1DenominatorFamily = (typeof BA1_DENOMINATOR_FAMILIES)[number];

export const BA1_EVALUATION_SAMPLE_KINDS = Object.freeze([
  "model-semantic",
  "contract-gate",
  "aggregator-test",
] as const);

export type BA1EvaluationSampleKind = (typeof BA1_EVALUATION_SAMPLE_KINDS)[number];

export interface BA1Identity {
  readonly documentRef: string;
  readonly observationId: string;
  readonly revision: number;
}

export interface BA1EvaluationCandidate extends BA1Identity {
  readonly ref: string;
  readonly scopeRef: string;
  readonly access?: string | null;
}

export interface BA1EvaluationCoverage extends BA1Identity {
  readonly status: "complete" | "partial" | "unverified";
  readonly scopeRef: string;
  readonly evaluatedCount: number;
  readonly expectedCount: number;
  readonly evidenceRefs: readonly string[];
}

export interface BA1EvaluationEvidenceRecord extends BA1Identity {
  readonly evidenceRef: string;
  readonly type: string;
  readonly scopeRef: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type BA1BinderBoundOutput = {
  readonly kind: "bound";
  readonly state: BA1AggregatorState;
  readonly selectedRef?: string | null;
  readonly evidenceRefs: readonly string[];
  readonly observedRevision: number;
};

export type BA1BinderRejectOutput = {
  readonly kind: "reject";
  readonly reason: BA1ContractGateReason;
  readonly evidenceRefs: readonly string[];
  readonly observedRevision: number;
};

export type BA1BinderOutput = BA1BinderBoundOutput | BA1BinderRejectOutput;

export interface BA1EvaluationInput {
  readonly gold: BA1EvaluatorGold;
  readonly output: BA1BinderOutput;
  readonly allowedScopeRef: string;
  readonly candidates: readonly BA1EvaluationCandidate[];
  readonly coverage: BA1EvaluationCoverage;
  readonly currentControl: BA1Identity;
  readonly evidenceRecords: readonly BA1EvaluationEvidenceRecord[];
}

export interface BA1SampleEvaluation {
  readonly passed: boolean;
  readonly errors: readonly BA1EvaluationError[];
  readonly expectedKind: BA1EvaluatorGold["kind"];
  readonly actualKind: BA1BinderOutput["kind"];
  readonly expectedState: BA1AggregatorState | null;
  readonly actualState: BA1AggregatorState | null;
  readonly expectedReason: BA1ContractGateReason | null;
  readonly actualReason: BA1ContractGateReason | null;
}

export interface BA1EvaluationRow extends BA1EvaluationInput {
  readonly sampleId: string;
  readonly sampleKind: BA1EvaluationSampleKind;
  readonly family: BA1DenominatorFamily;
  readonly group: string;
}

export interface BA1StateCounts {
  selected: number;
  none: number;
  ambiguous: number;
  insufficient_observation: number;
  reject: number;
}

export interface BA1RejectReasonCounts {
  unsupported_requested_role: number;
  outside_scope: number;
  access_unknown: number;
  unverified_coverage: number;
  stale_candidate: number;
}

export interface BA1NamedDenominator {
  readonly sampleKind: BA1EvaluationSampleKind;
  readonly family: BA1DenominatorFamily;
  readonly group: string;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly expectedStates: BA1StateCounts;
  readonly predictedStates: BA1StateCounts;
  readonly expectedRejectReasons: BA1RejectReasonCounts;
  readonly predictedRejectReasons: BA1RejectReasonCounts;
  readonly errors: Readonly<Record<BA1EvaluationError, number>>;
}

export interface BA1EvaluationSummary {
  readonly denominators: readonly BA1NamedDenominator[];
  readonly errors: Readonly<Record<BA1EvaluationError, number>>;
}

type ParsedBinderOutput = {
  readonly output: BA1BinderOutput;
  readonly rejectCarriesSelectedRef: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer`);
  }
  return value;
}

function requireNonnegativeInteger(value: unknown, label: string): number {
  const result = requireInteger(value, label);
  if (result < 0) throw new TypeError(`${label} must be a nonnegative integer`);
  return result;
}

function requireStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return Object.freeze(value.map((entry, index) => requireNonEmptyString(entry, `${label}[${index}]`)));
}

function parseIdentity(value: unknown, label: string): BA1Identity {
  const record = requireRecord(value, label);
  return Object.freeze({
    documentRef: requireNonEmptyString(record.documentRef, `${label}.documentRef`),
    observationId: requireNonEmptyString(record.observationId, `${label}.observationId`),
    revision: requireInteger(record.revision, `${label}.revision`),
  });
}

function parseCandidate(value: unknown, label: string): BA1EvaluationCandidate {
  const record = requireRecord(value, label);
  const access = record.access;
  if (access !== undefined && access !== null && typeof access !== "string") {
    throw new TypeError(`${label}.access must be a string, null or undefined`);
  }
  return Object.freeze({
    ref: requireNonEmptyString(record.ref, `${label}.ref`),
    scopeRef: requireNonEmptyString(record.scopeRef, `${label}.scopeRef`),
    ...parseIdentity(record, label),
    ...(access === undefined ? {} : { access: access as string | null }),
  });
}

function parseCoverage(value: unknown): BA1EvaluationCoverage {
  const record = requireRecord(value, "coverage");
  const status = record.status;
  if (status !== "complete" && status !== "partial" && status !== "unverified") {
    throw new TypeError("coverage.status must be complete, partial or unverified");
  }
  return Object.freeze({
    status,
    scopeRef: requireNonEmptyString(record.scopeRef, "coverage.scopeRef"),
    ...parseIdentity(record, "coverage"),
    evaluatedCount: requireNonnegativeInteger(record.evaluatedCount, "coverage.evaluatedCount"),
    expectedCount: requireNonnegativeInteger(record.expectedCount, "coverage.expectedCount"),
    evidenceRefs: requireStringArray(record.evidenceRefs, "coverage.evidenceRefs"),
  });
}

function parseEvidenceRecord(value: unknown, label: string): BA1EvaluationEvidenceRecord {
  const record = requireRecord(value, label);
  return Object.freeze({
    evidenceRef: requireNonEmptyString(record.evidenceRef, `${label}.evidenceRef`),
    type: requireNonEmptyString(record.type, `${label}.type`),
    scopeRef: requireNonEmptyString(record.scopeRef, `${label}.scopeRef`),
    ...parseIdentity(record, label),
    payload: Object.freeze(requireRecord(record.payload, `${label}.payload`)),
  });
}

function parseBinderOutput(value: unknown): ParsedBinderOutput {
  const record = requireRecord(value, "binder output");
  const kind = record.kind;
  if (kind !== "bound" && kind !== "reject") {
    throw new TypeError("binder output.kind must be bound or reject");
  }
  const evidenceRefs = requireStringArray(record.evidenceRefs, "binder output.evidenceRefs");
  const observedRevision = requireInteger(record.observedRevision, "binder output.observedRevision");

  if (kind === "reject") {
    const allowed = new Set(["kind", "reason", "evidenceRefs", "observedRevision", "selectedRef"]);
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) throw new TypeError(`binder reject output has unexpected field ${key}`);
    }
    const reason = record.reason;
    if (!BA1_CONTRACT_GATE_REASONS.includes(reason as BA1ContractGateReason)) {
      throw new TypeError(`binder reject output.reason is unknown: ${String(reason)}`);
    }
    return {
      output: Object.freeze({
        kind,
        reason: reason as BA1ContractGateReason,
        evidenceRefs,
        observedRevision,
      }),
      rejectCarriesSelectedRef: Object.hasOwn(record, "selectedRef"),
    };
  }

  for (const key of Object.keys(record)) {
    if (!["kind", "state", "selectedRef", "evidenceRefs", "observedRevision"].includes(key)) {
      throw new TypeError(`binder bound output has unexpected field ${key}`);
    }
  }
  const state = record.state;
  if (!BA1_AGGREGATOR_STATES.includes(state as BA1AggregatorState)) {
    throw new TypeError(`binder bound output.state is unknown: ${String(state)}`);
  }
  const selectedRef = record.selectedRef;
  if (selectedRef !== undefined && selectedRef !== null
    && (typeof selectedRef !== "string" || selectedRef.length === 0)) {
    throw new TypeError("binder bound output.selectedRef must be a non-empty string, null or undefined");
  }
  return {
    output: Object.freeze({
      kind,
      state: state as BA1AggregatorState,
      ...(selectedRef === undefined ? {} : { selectedRef: selectedRef as string | null }),
      evidenceRefs,
      observedRevision,
    }),
    rejectCarriesSelectedRef: false,
  };
}

function emptyStateCounts(): BA1StateCounts {
  return {
    selected: 0,
    none: 0,
    ambiguous: 0,
    insufficient_observation: 0,
    reject: 0,
  };
}

function emptyRejectReasonCounts(): BA1RejectReasonCounts {
  return {
    unsupported_requested_role: 0,
    outside_scope: 0,
    access_unknown: 0,
    unverified_coverage: 0,
    stale_candidate: 0,
  };
}

function emptyErrorCounts(): Record<BA1EvaluationError, number> {
  return Object.fromEntries(BA1_EVALUATION_ERRORS.map(error => [error, 0])) as Record<BA1EvaluationError, number>;
}

function sameIdentity(left: BA1Identity, right: BA1Identity): boolean {
  return left.documentRef === right.documentRef
    && left.observationId === right.observationId
    && left.revision === right.revision;
}

function expectedStateOf(gold: BA1EvaluatorGold): BA1AggregatorState | null {
  return gold.kind === "bound" ? gold.state : null;
}

function expectedReasonOf(gold: BA1EvaluatorGold): BA1ContractGateReason | null {
  return gold.kind === "reject" ? gold.reason : null;
}

function actualStateOf(output: BA1BinderOutput): BA1AggregatorState | null {
  return output.kind === "bound" ? output.state : null;
}

function actualReasonOf(output: BA1BinderOutput): BA1ContractGateReason | null {
  return output.kind === "reject" ? output.reason : null;
}

function result(
  gold: BA1EvaluatorGold,
  output: BA1BinderOutput,
  errors: readonly BA1EvaluationError[],
): BA1SampleEvaluation {
  return Object.freeze({
    passed: errors.length === 0,
    errors: Object.freeze([...errors]),
    expectedKind: gold.kind,
    actualKind: output.kind,
    expectedState: expectedStateOf(gold),
    actualState: actualStateOf(output),
    expectedReason: expectedReasonOf(gold),
    actualReason: actualReasonOf(output),
  });
}

function evidenceIndex(records: readonly BA1EvaluationEvidenceRecord[]): ReadonlyMap<string, BA1EvaluationEvidenceRecord> {
  const index = new Map<string, BA1EvaluationEvidenceRecord>();
  for (const record of records) {
    if (index.has(record.evidenceRef)) throw new TypeError(`duplicate evidenceRef ${record.evidenceRef}`);
    index.set(record.evidenceRef, record);
  }
  return index;
}

function resolveEvidence(
  refs: readonly string[],
  records: ReadonlyMap<string, BA1EvaluationEvidenceRecord>,
): readonly BA1EvaluationEvidenceRecord[] | null {
  const resolved: BA1EvaluationEvidenceRecord[] = [];
  for (const ref of refs) {
    const record = records.get(ref);
    if (record === undefined) return null;
    resolved.push(record);
  }
  return Object.freeze(resolved);
}

function hasScopeMismatch(input: BA1EvaluationInput, includeEvidence = true): boolean {
  return input.coverage.scopeRef !== input.allowedScopeRef
    || input.candidates.some(candidate => candidate.scopeRef !== input.allowedScopeRef)
    || (includeEvidence && input.evidenceRecords.some(record => record.scopeRef !== input.allowedScopeRef));
}

function hasIdentityMismatch(input: BA1EvaluationInput, includeEvidence = true): boolean {
  return !sameIdentity(input.coverage, input.currentControl)
    || input.candidates.some(candidate => !sameIdentity(candidate, input.currentControl))
    || (includeEvidence && input.evidenceRecords.some(record => !sameIdentity(record, input.currentControl)));
}

function supportsAmbiguity(record: BA1EvaluationEvidenceRecord): boolean {
  return record.type === "ambiguity"
    || record.payload.supportsAmbiguity === true
    || record.payload.state === "ambiguous";
}

function supportsInsufficientObservation(record: BA1EvaluationEvidenceRecord): boolean {
  const reason = record.payload.insufficientReason;
  return record.type === "insufficient_observation"
    || reason === "missing_measurement"
    || reason === "no_scorable_candidate"
    || reason === "all_below_threshold";
}

function reasonHasOriginalFact(
  input: BA1EvaluationInput,
  evidence: readonly BA1EvaluationEvidenceRecord[],
): boolean {
  const { gold } = input;
  if (gold.kind !== "reject") return false;
  switch (gold.reason) {
    case "unsupported_requested_role":
      return evidence.some(record =>
        record.type === "unsupported_requested_role"
        || (typeof record.payload.requestedRole === "string"
          && record.payload.requestedRole !== "search-input-host"));
    case "outside_scope":
      return hasScopeMismatch(input, false);
    case "access_unknown":
      return input.candidates.some(candidate => candidate.access === "unknown")
        || evidence.some(record =>
          record.type === "access_unknown"
          || record.payload.access === "unknown"
          || record.payload.accessKnown === false);
    case "unverified_coverage":
      return input.coverage.status !== "complete"
        || input.coverage.evaluatedCount !== input.coverage.expectedCount
        || evidence.some(record =>
          record.type === "unverified_coverage"
          || record.payload.coverageComplete === false
          || record.payload.coverageStatus === "partial"
          || record.payload.coverageStatus === "unverified");
    case "stale_candidate":
      return !sameIdentity(input.coverage, input.currentControl)
        || input.candidates.some(candidate => !sameIdentity(candidate, input.currentControl))
        || evidence.some(record => !sameIdentity(record, input.currentControl));
    default: {
      const never: never = gold.reason;
      throw new TypeError(`unknown reject reason ${String(never)}`);
    }
  }
}

function evaluateBound(
  input: BA1EvaluationInput,
  parsed: ParsedBinderOutput,
  gold: Extract<BA1EvaluatorGold, { kind: "bound" }>,
): BA1SampleEvaluation {
  const output = parsed.output as BA1BinderBoundOutput;
  const errors: BA1EvaluationError[] = [];

  if (gold.state !== output.state) {
    errors.push("wrong_state");
    if (gold.state === "insufficient_observation" && output.state === "none") {
      errors.push("insufficient_downgraded_to_none");
    }
    if (gold.state === "ambiguous" && output.state === "selected" && typeof output.selectedRef === "string") {
      errors.push("forced_selection");
    }
  }

  if (output.state !== "selected" && output.selectedRef !== undefined && output.selectedRef !== null) {
    errors.push("unexpected_ref");
  }
  if (gold.state === "selected" && (typeof output.selectedRef !== "string" || output.selectedRef.length === 0)) {
    errors.push("wrong_ref");
  }

  if (hasScopeMismatch(input, false)) return result(gold, output, [...errors, "out_of_scope"]);
  if (hasIdentityMismatch(input, false)) return result(gold, output, [...errors, "stale_identity"]);

  const records = evidenceIndex(input.evidenceRecords);
  const resolved = resolveEvidence(output.evidenceRefs, records);
  if (resolved === null) return result(gold, output, [...errors, "missing_evidence"]);
  if (resolved.some(record => record.scopeRef !== input.allowedScopeRef)) {
    return result(gold, output, [...errors, "out_of_scope"]);
  }
  if (resolved.some(record => !sameIdentity(record, input.currentControl))) {
    return result(gold, output, [...errors, "stale_identity"]);
  }

  if (gold.state === "selected") {
    if (typeof output.selectedRef === "string"
      && output.selectedRef.length > 0
      && output.selectedRef !== gold.selectedRef) {
      errors.push("wrong_ref");
    }
    if (resolved.length === 0) errors.push("missing_evidence");
  } else if (gold.state === "none") {
    const coverageEvidence = resolveEvidence(input.coverage.evidenceRefs, records);
    if (input.coverage.status !== "complete"
      || input.coverage.evaluatedCount !== input.coverage.expectedCount
      || coverageEvidence === null
      || coverageEvidence.length === 0) {
      errors.push("missing_coverage");
    }
  } else if (gold.state === "ambiguous") {
    if (resolved.filter(supportsAmbiguity).length < 2) errors.push("missing_evidence");
  } else if (resolved.filter(supportsInsufficientObservation).length === 0) {
    errors.push("missing_evidence");
  }

  return result(gold, output, errors);
}

function evaluateReject(
  input: BA1EvaluationInput,
  parsed: ParsedBinderOutput,
  gold: Extract<BA1EvaluatorGold, { kind: "reject" }>,
): BA1SampleEvaluation {
  const output = parsed.output as BA1BinderRejectOutput;
  const errors: BA1EvaluationError[] = [];
  if (gold.reason !== output.reason) return result(gold, output, ["wrong_reason"]);
  if (parsed.rejectCarriesSelectedRef) errors.push("unexpected_ref");

  const records = evidenceIndex(input.evidenceRecords);
  const evidence = resolveEvidence(output.evidenceRefs, records);
  if (evidence === null || evidence.length === 0 || !reasonHasOriginalFact(input, evidence)) {
    errors.push("missing_reason_evidence");
  }
  return result(gold, output, errors);
}

export function evaluateBA1Sample(input: BA1EvaluationInput): BA1SampleEvaluation {
  validateBA1EvaluatorGold(input.gold);
  if (!Number.isInteger(input.output.observedRevision)) {
    throw new TypeError("binder output.observedRevision must be an integer");
  }
  const parsed = parseBinderOutput(input.output);
  const output = parsed.output;
  const gold = input.gold;

  if (gold.kind !== output.kind) {
    const errors: BA1EvaluationError[] = ["wrong_kind"];
    if (gold.kind === "reject") errors.push("reject_misclassified");
    return result(gold, output, errors);
  }

  parseCoverage(input.coverage);
  parseIdentity(input.currentControl, "currentControl");
  requireNonEmptyString(input.allowedScopeRef, "allowedScopeRef");
  if (!Array.isArray(input.candidates)) throw new TypeError("candidates must be an array");
  if (!Array.isArray(input.evidenceRecords)) throw new TypeError("evidenceRecords must be an array");
  input.candidates.forEach((candidate, index) => parseCandidate(candidate, `candidates[${index}]`));
  input.evidenceRecords.forEach((record, index) => parseEvidenceRecord(record, `evidenceRecords[${index}]`));

  return gold.kind === "bound"
    ? evaluateBound(input, parsed, gold)
    : evaluateReject(input, parsed, gold);
}

function incrementState(counts: BA1StateCounts, state: BA1AggregatorState | null): void {
  if (state === null) {
    counts.reject += 1;
    return;
  }
  counts[state] += 1;
}

function incrementReason(counts: BA1RejectReasonCounts, reason: BA1ContractGateReason | null): void {
  if (reason !== null) counts[reason] += 1;
}

export function summarizeBA1Evaluations(rows: readonly BA1EvaluationRow[]): BA1EvaluationSummary {
  const denominators = new Map<string, {
    sampleKind: BA1EvaluationSampleKind;
    family: BA1DenominatorFamily;
    group: string;
    total: number;
    passed: number;
    failed: number;
    expectedStates: BA1StateCounts;
    predictedStates: BA1StateCounts;
    expectedRejectReasons: BA1RejectReasonCounts;
    predictedRejectReasons: BA1RejectReasonCounts;
    errors: Record<BA1EvaluationError, number>;
  }>();
  const errors = emptyErrorCounts();

  for (const row of rows) {
    requireNonEmptyString(row.sampleId, "evaluation row.sampleId");
    requireNonEmptyString(row.group, "evaluation row.group");
    if (!BA1_EVALUATION_SAMPLE_KINDS.includes(row.sampleKind)) {
      throw new TypeError(`evaluation row.sampleKind is unknown: ${String(row.sampleKind)}`);
    }
    if (!BA1_DENOMINATOR_FAMILIES.includes(row.family)) {
      throw new TypeError(`evaluation row.family is unknown: ${String(row.family)}`);
    }
    const key = `${row.sampleKind}\u0000${row.family}\u0000${row.group}`;
    let denominator = denominators.get(key);
    if (denominator === undefined) {
      denominator = {
        sampleKind: row.sampleKind,
        family: row.family,
        group: row.group,
        total: 0,
        passed: 0,
        failed: 0,
        expectedStates: emptyStateCounts(),
        predictedStates: emptyStateCounts(),
        expectedRejectReasons: emptyRejectReasonCounts(),
        predictedRejectReasons: emptyRejectReasonCounts(),
        errors: emptyErrorCounts(),
      };
      denominators.set(key, denominator);
    }

    const evaluation = evaluateBA1Sample(row);
    denominator.total += 1;
    if (evaluation.passed) denominator.passed += 1;
    else denominator.failed += 1;
    incrementState(denominator.expectedStates, evaluation.expectedState);
    incrementState(denominator.predictedStates, evaluation.actualState);
    incrementReason(denominator.expectedRejectReasons, evaluation.expectedReason);
    incrementReason(denominator.predictedRejectReasons, evaluation.actualReason);
    for (const error of evaluation.errors) {
      denominator.errors[error] += 1;
      errors[error] += 1;
    }
  }

  return Object.freeze({
    denominators: Object.freeze(
      [...denominators.values()]
        .sort((left, right) =>
          left.family.localeCompare(right.family)
          || left.sampleKind.localeCompare(right.sampleKind)
          || left.group.localeCompare(right.group))
        .map(entry => Object.freeze({
          ...entry,
          expectedStates: Object.freeze({ ...entry.expectedStates }),
          predictedStates: Object.freeze({ ...entry.predictedStates }),
          expectedRejectReasons: Object.freeze({ ...entry.expectedRejectReasons }),
          predictedRejectReasons: Object.freeze({ ...entry.predictedRejectReasons }),
          errors: Object.freeze({ ...entry.errors }),
        })),
    ),
    errors: Object.freeze(errors),
  });
}
