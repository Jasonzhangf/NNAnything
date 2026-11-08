// B-A1 real sample converter: harness observation records -> physical
// student-rows / supervision-rows (design: b-a1-sample-skeleton.md,
// b-a1-unified-slot-observation-map.md subject revision 3,
// b-a1-supervision-loss-contract.md subject revision 3).
//
// This module owns the row projection only. It performs no observation, no
// training, no fitting and no adoption. It never reads gold into a student row
// and never reads x[64] into a supervision row. A required measurement that is
// missing stops that group; it is never replaced by `false` or by 0.
//
// Input is the harness observation record, which already carries the coverage
// and currentness envelope. Output rows match BA1_STUDENT_ROW_SCHEMA /
// BA1_SUPERVISION_ROW_SCHEMA so the fixed training entry can read them.

import {
  BA1_STUDENT_ROW_SCHEMA,
  BA1_SUPERVISION_ROW_SCHEMA,
} from "./b-a1-training-entry.js";
import {
  BA1RouteEncoderError,
  encodeBA1RouteGroup,
  type BA1Access,
  type BA1DepthBand,
  type BA1Host,
  type BA1RouteCandidateInput,
  type BA1RouteGateContext,
  type BA1TabIndexKind,
  type BA1TextLenBand,
  type BA1Type,
} from "./b-a1-route-encoder.js";
import {
  BA1_CONTRACT_GATE_REASONS,
  BA1_AGGREGATOR_STATES,
  BA1_SEMANTIC_SUPERVISION_STATUSES,
  classifyBA1TrainingEligibility,
  type BA1AggregatorState,
  type BA1ContractGateReason,
  type BA1SampleFamily,
  type BA1SamplePartition,
  type BA1SemanticSupervisionStatus,
} from "./b-a1-sample-evaluator-skeleton.js";

export const BA1_HARNESS_OBSERVATION_SCHEMA = "nnanything.b-a1.harness-observation.v1" as const;
export const BA1_SAMPLE_CONVERTER_VERSION = "nnanything.b-a1-sample-converter.v1" as const;
export const BA1_SAMPLE_MANIFEST_SCHEMA = "nnanything.b-a1.sample-manifest.v1" as const;
export const BA1_CONTRACT_GATE_ROW_SCHEMA = "nnanything.b-a1.contract-gate-row.v1" as const;
export const BA1_AGGREGATOR_ROW_SCHEMA = "nnanything.b-a1.aggregator-test-row.v1" as const;
export const BA1_OBSERVATION_MISSING_ROW_SCHEMA = "nnanything.b-a1.observation-missing-row.v1" as const;

export type BA1SourceFamily = "family-a" | "family-b" | "new-independent";

const SOURCE_FAMILIES: readonly BA1SourceFamily[] = Object.freeze([
  "family-a",
  "family-b",
  "new-independent",
]);

/** Student rows carry exactly these keys; anything else is rejected. */
export const BA1_STUDENT_ROW_KEYS: readonly string[] = Object.freeze([
  "schema",
  "group_id",
  "sampleId",
  "sourceGroup",
  "partition",
  "family",
  "candidateRef",
  "x",
  "missingMode",
  "candidateKind",
  "optionSemantics",
]);

/** Supervision rows carry exactly these keys; x/input must never appear. */
export const BA1_SUPERVISION_ROW_KEYS: readonly string[] = Object.freeze([
  "schema",
  "group_id",
  "sampleId",
  "sourceGroup",
  "partition",
  "family",
  "supervisionStatus",
  "goldAllowedCandidateRefs",
  "trainingEligible",
  "evaluationClass",
  "labelAuthority",
  "oracleKind",
]);

export const BA1_CONTRACT_GATE_ROW_KEYS: readonly string[] = Object.freeze([
  "schema",
  "group_id",
  "sampleId",
  "sourceGroup",
  "sourceFamily",
  "partition",
  "family",
  "candidateCount",
  "expectedReason",
  "evaluationClass",
  "allowedScopeRef",
  "candidateScopeRefs",
  "coverageStatus",
  "coverageEnvelope",
  "currentControl",
]);

export const BA1_AGGREGATOR_ROW_KEYS: readonly string[] = Object.freeze([
  "schema",
  "group_id",
  "sampleId",
  "sourceGroup",
  "sourceFamily",
  "partition",
  "family",
  "injectedScores",
  "expectedState",
  "evaluationClass",
]);

export const BA1_OBSERVATION_MISSING_ROW_KEYS: readonly string[] = Object.freeze([
  "schema",
  "group_id",
  "sampleId",
  "sourceGroup",
  "sourceFamily",
  "partition",
  "family",
  "supervisionStatus",
  "evaluationClass",
  "unmeasuredFields",
]);

const FORBIDDEN_STUDENT_FIELD_PATTERN = /^(?:gold|allowed|teacher|label|oracle|unknownReason|expected|injected|supervisionStatus|evidence|result)/i;
const FORBIDDEN_SUPERVISION_FIELD_PATTERN = /^(?:x|input|candidateRef|features)$/i;

export type BA1SampleConverterErrorCode =
  | "FORBIDDEN_FIELD"
  | "MISSING_OBSERVATION"
  | "SHAPE_INVALID"
  | "ENCODER_REJECTED"
  | "JOIN_INVALID";

export class BA1SampleConverterError extends Error {
  readonly code: BA1SampleConverterErrorCode;

  constructor(code: BA1SampleConverterErrorCode, message: string) {
    super(message);
    this.name = "BA1SampleConverterError";
    this.code = code;
  }
}

export interface BA1HarnessObservationRecord {
  readonly schema: typeof BA1_HARNESS_OBSERVATION_SCHEMA;
  readonly caseId: string;
  readonly sourceFamily: BA1SourceFamily;
  readonly sampleFamily: BA1SampleFamily;
  readonly partition: BA1SamplePartition;
  readonly queryText: string;
  readonly requestedRole: string;
  readonly allowedScopeRef: string;
  readonly sourceGroup: string;
  readonly sampleId: string;
  readonly stepContextRef: string;
  readonly candidateGroupRef: string;
  readonly observation: {
    readonly documentRef: string;
    readonly observationId: string;
    readonly revision: number;
    readonly coverage: {
      readonly status: "complete" | "partial" | "unverified";
      readonly scopeRef: string;
      readonly documentRef: string;
      readonly observationId: string;
      readonly revision: number;
      readonly evaluatedCount: number;
      readonly expectedCount: number;
      readonly unassessedIframeCount: number;
      readonly unassessedObjectCount: number;
      readonly unassessedOpenShadowRootCount: number;
      readonly evidenceRefs: readonly string[];
    };
    readonly currentControl: {
      readonly documentRef: string;
      readonly observationId: string;
      readonly revision: number;
    };
    readonly candidateGroupEnumerationComplete: boolean;
    readonly evidenceRefs?: readonly string[];
  };
  readonly candidates: readonly BA1ObservedCandidateRecord[];
  readonly supervision: BA1ObservationSupervision;
}

export interface BA1ObservedCandidateRecord {
  readonly candidateRef: string;
  readonly scopeRef: string;
  readonly documentRef: string;
  readonly observationId: string;
  readonly revision: number;
  readonly unmeasured: readonly string[];
  readonly currentness?: {
    readonly scopeRef: string;
    readonly documentRef: string;
    readonly observationId: string;
    readonly revision: number;
  };
  readonly features: Partial<BA1RouteCandidateInput>;
}

export type BA1ObservationSupervision =
  | {
      readonly kind: "model-semantic";
      readonly supervisionStatus: BA1SemanticSupervisionStatus;
      readonly goldAllowedCandidateRefs: readonly string[];
      readonly labelAuthority: string;
      readonly oracleKind: string;
    }
  | { readonly kind: "contract-gate"; readonly reason: BA1ContractGateReason }
  | {
      readonly kind: "aggregator-test";
      readonly injectedScores: readonly number[];
      readonly expectedState: BA1AggregatorState;
    };

export interface BA1SampleManifest {
  readonly schema: typeof BA1_SAMPLE_MANIFEST_SCHEMA;
  readonly converterVersion: typeof BA1_SAMPLE_CONVERTER_VERSION;
  readonly generatedAt: string;
  readonly counts: {
    readonly totalGroups: number;
    readonly bySampleFamily: Readonly<Record<BA1SampleFamily, number>>;
    readonly byPartition: Readonly<Record<BA1SamplePartition, number>>;
    readonly bySourceFamily: Readonly<Record<BA1SourceFamily, number>>;
    readonly semanticBySourceFamily: Readonly<Record<BA1SourceFamily, number>>;
    readonly semanticByState: Readonly<Record<BA1SemanticSupervisionStatus, number>>;
    readonly contractGateByReason: Readonly<Record<BA1ContractGateReason, number>>;
    readonly aggregatorByState: Readonly<Record<BA1AggregatorState, number>>;
    readonly trainEligibleGroups: number;
    readonly observationMissingGroups: number;
  };
  readonly files: Readonly<Record<string, number>>;
}

export interface BA1ConvertedObservations {
  readonly trainStudentRows: readonly Record<string, unknown>[];
  readonly trainSupervisionRows: readonly Record<string, unknown>[];
  readonly devStudentRows: readonly Record<string, unknown>[];
  readonly devSupervisionRows: readonly Record<string, unknown>[];
  readonly verificationStudentRows: readonly Record<string, unknown>[];
  readonly verificationSupervisionRows: readonly Record<string, unknown>[];
  readonly contractGateRows: readonly Record<string, unknown>[];
  readonly aggregatorTestRows: readonly Record<string, unknown>[];
  readonly observationMissingRows: readonly Record<string, unknown>[];
  readonly manifest: BA1SampleManifest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BA1SampleConverterError("SHAPE_INVALID", `${label} must be a non-empty string`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BA1SampleConverterError("SHAPE_INVALID", `${label} must be a finite number`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new BA1SampleConverterError("SHAPE_INVALID", `${label} must be a boolean`);
  }
  return value;
}

function requireMember<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new BA1SampleConverterError("SHAPE_INVALID", `${label} must be one of ${allowed.join(", ")}; got ${String(value)}`);
  }
  return value as T;
}

/** Reject any key outside the declared whitelist for that row kind. */
function assertAllowedKeys(record: Readonly<Record<string, unknown>>, allowed: readonly string[], label: string): void {
  const offenders = Object.keys(record).filter(key => !allowed.includes(key));
  if (offenders.length > 0) {
    throw new BA1SampleConverterError("FORBIDDEN_FIELD", `${label} carries non-whitelisted field(s): ${offenders.join(", ")}`);
  }
}

function assertNoForbiddenStudentFields(candidate: Readonly<Record<string, unknown>>, label: string): void {
  const offenders = Object.keys(candidate).filter(key => FORBIDDEN_STUDENT_FIELD_PATTERN.test(key));
  if (offenders.length > 0) {
    throw new BA1SampleConverterError("FORBIDDEN_FIELD", `${label} carries forbidden teacher/gold field(s): ${offenders.join(", ")}`);
  }
}

function assertNoForbiddenSupervisionFields(row: Readonly<Record<string, unknown>>, label: string): void {
  const offenders = Object.keys(row).filter(key => FORBIDDEN_SUPERVISION_FIELD_PATTERN.test(key));
  if (offenders.length > 0) {
    throw new BA1SampleConverterError("FORBIDDEN_FIELD", `${label} carries forbidden measurement field(s): ${offenders.join(", ")}`);
  }
}

function groupIdOf(record: BA1HarnessObservationRecord): string {
  return [record.sourceGroup, record.sampleId, record.stepContextRef, record.candidateGroupRef].join("::");
}

function gateContextOf(record: BA1HarnessObservationRecord): BA1RouteGateContext {
  return {
    requestedRole: record.requestedRole,
    allowedScopeRef: record.allowedScopeRef,
    coverage: {
      status: record.observation.coverage.status,
      evaluatedCount: record.observation.coverage.evaluatedCount,
      expectedCount: record.observation.coverage.expectedCount,
      unassessedIframeCount: record.observation.coverage.unassessedIframeCount,
      unassessedObjectCount: record.observation.coverage.unassessedObjectCount,
      unassessedOpenShadowRootCount: record.observation.coverage.unassessedOpenShadowRootCount,
    },
    candidateGroupEnumerationComplete: record.observation.candidateGroupEnumerationComplete,
  };
}

/**
 * A candidate is scorable only when the harness measured every required
 * feature. A declared unmeasured field, or a null required feature, stops the
 * group. Nothing is filled with `false` or 0.
 */
function requiredUnmeasuredFields(candidate: BA1ObservedCandidateRecord): readonly string[] {
  const unmeasured = [...candidate.unmeasured];
  const features = candidate.features;
  for (const field of [
    "host",
    "type",
    "editable",
    "disabled",
    "readOnly",
    "cssHidden",
    "intersectsViewport",
    "explicitTabIndexKind",
    "tabIndexFocus",
    "inForm",
    "formRoleSearch",
    "nearbySubmit",
    "depthBand",
    "hasLabel",
    "hasPlaceholder",
    "hasAria",
    "markerHit",
    "nonSearchMarker",
    "textLenBand",
    "access",
  ] as const) {
    const value = features[field];
    if (value === null || value === undefined) unmeasured.push(field);
  }
  return [...new Set(unmeasured)];
}

function toEncoderCandidate(
  candidate: BA1ObservedCandidateRecord,
): BA1RouteCandidateInput {
  const features = candidate.features;
  return {
    candidateRef: candidate.candidateRef,
    candidateKind: "relation",
    optionSemantics: "select",
    scopeRef: candidate.scopeRef,
    host: features.host as BA1Host,
    type: features.type as BA1Type,
    contentEditable: (features.contentEditable ?? null) as boolean | null,
    editable: (features.editable ?? null) as boolean | null,
    disabled: (features.disabled ?? null) as boolean | null,
    readOnly: (features.readOnly ?? null) as boolean | null,
    cssHidden: (features.cssHidden ?? null) as boolean | null,
    intersectsViewport: (features.intersectsViewport ?? null) as boolean | null,
    explicitTabIndexKind: features.explicitTabIndexKind as BA1TabIndexKind,
    tabIndexFocus: (features.tabIndexFocus ?? null) as boolean | null,
    inForm: (features.inForm ?? null) as boolean | null,
    formRoleSearch: (features.formRoleSearch ?? null) as boolean | null,
    nearbySubmit: (features.nearbySubmit ?? null) as boolean | null,
    depthBand: features.depthBand as BA1DepthBand,
    hasLabel: (features.hasLabel ?? null) as boolean | null,
    hasPlaceholder: (features.hasPlaceholder ?? null) as boolean | null,
    hasAria: (features.hasAria ?? null) as boolean | null,
    markerHit: (features.markerHit ?? null) as boolean | null,
    nonSearchMarker: (features.nonSearchMarker ?? null) as boolean | null,
    textLenBand: features.textLenBand as BA1TextLenBand,
    access: features.access as BA1Access,
  };
}

function parseCoverage(raw: unknown, label: string): BA1HarnessObservationRecord["observation"]["coverage"] {
  if (!isRecord(raw)) throw new BA1SampleConverterError("SHAPE_INVALID", `${label} must be an object`);
  return {
    status: requireMember(raw.status, ["complete", "partial", "unverified"] as const, `${label}.status`),
    scopeRef: requireNonEmptyString(raw.scopeRef, `${label}.scopeRef`),
    documentRef: requireNonEmptyString(raw.documentRef, `${label}.documentRef`),
    observationId: requireNonEmptyString(raw.observationId, `${label}.observationId`),
    revision: requireFiniteNumber(raw.revision, `${label}.revision`),
    evaluatedCount: requireFiniteNumber(raw.evaluatedCount, `${label}.evaluatedCount`),
    expectedCount: requireFiniteNumber(raw.expectedCount, `${label}.expectedCount`),
    unassessedIframeCount: requireFiniteNumber(raw.unassessedIframeCount, `${label}.unassessedIframeCount`),
    unassessedObjectCount: requireFiniteNumber(raw.unassessedObjectCount, `${label}.unassessedObjectCount`),
    unassessedOpenShadowRootCount: requireFiniteNumber(
      raw.unassessedOpenShadowRootCount,
      `${label}.unassessedOpenShadowRootCount`,
    ),
    evidenceRefs: Array.isArray(raw.evidenceRefs)
      ? raw.evidenceRefs.map((ref, index) => requireNonEmptyString(ref, `${label}.evidenceRefs[${index}]`))
      : [],
  };
}

function parseCandidate(raw: unknown, index: number): BA1ObservedCandidateRecord {
  const label = `candidates[${index}]`;
  if (!isRecord(raw)) throw new BA1SampleConverterError("SHAPE_INVALID", `${label} must be an object`);
  if (!isRecord(raw.features)) {
    throw new BA1SampleConverterError("SHAPE_INVALID", `${label}.features must be an object`);
  }
  assertNoForbiddenStudentFields(raw.features, `${label}.features`);
  const unmeasured = Array.isArray(raw.unmeasured)
    ? raw.unmeasured.map((field, i) => requireNonEmptyString(field, `${label}.unmeasured[${i}]`))
    : [];
  return {
    candidateRef: requireNonEmptyString(raw.candidateRef, `${label}.candidateRef`),
    scopeRef: requireNonEmptyString(raw.scopeRef, `${label}.scopeRef`),
    documentRef: requireNonEmptyString(raw.documentRef, `${label}.documentRef`),
    observationId: requireNonEmptyString(raw.observationId, `${label}.observationId`),
    revision: requireFiniteNumber(raw.revision, `${label}.revision`),
    unmeasured,
    features: raw.features as Partial<BA1RouteCandidateInput>,
  };
}

function parseSupervision(raw: unknown, label: string): BA1ObservationSupervision {
  if (!isRecord(raw)) throw new BA1SampleConverterError("SHAPE_INVALID", `${label} must be an object`);
  if (raw.kind === "model-semantic") {
    return {
      kind: "model-semantic",
      supervisionStatus: requireMember(
        raw.supervisionStatus,
        BA1_SEMANTIC_SUPERVISION_STATUSES,
        `${label}.supervisionStatus`,
      ),
      goldAllowedCandidateRefs: Array.isArray(raw.goldAllowedCandidateRefs)
        ? raw.goldAllowedCandidateRefs.map((ref, index) => requireNonEmptyString(ref, `${label}.goldAllowedCandidateRefs[${index}]`))
        : [],
      labelAuthority: requireNonEmptyString(raw.labelAuthority, `${label}.labelAuthority`),
      oracleKind: requireNonEmptyString(raw.oracleKind, `${label}.oracleKind`),
    };
  }
  if (raw.kind === "contract-gate") {
    return {
      kind: "contract-gate",
      reason: requireMember(raw.reason, BA1_CONTRACT_GATE_REASONS, `${label}.reason`),
    };
  }
  if (raw.kind === "aggregator-test") {
    if (!Array.isArray(raw.injectedScores) || raw.injectedScores.length === 0) {
      throw new BA1SampleConverterError("SHAPE_INVALID", `${label}.injectedScores must be a non-empty array`);
    }
    return {
      kind: "aggregator-test",
      injectedScores: raw.injectedScores.map((score, index) => requireFiniteNumber(score, `${label}.injectedScores[${index}]`)),
      expectedState: requireMember(raw.expectedState, BA1_AGGREGATOR_STATES, `${label}.expectedState`),
    };
  }
  throw new BA1SampleConverterError("SHAPE_INVALID", `${label}.kind must be model-semantic, contract-gate, or aggregator-test`);
}

export function parseHarnessObservation(raw: unknown, index = 0): BA1HarnessObservationRecord {
  const label = `observations[${index}]`;
  if (!isRecord(raw)) throw new BA1SampleConverterError("SHAPE_INVALID", `${label} must be an object`);
  if (raw.schema !== BA1_HARNESS_OBSERVATION_SCHEMA) {
    throw new BA1SampleConverterError(
      "SHAPE_INVALID",
      `${label}.schema must be ${BA1_HARNESS_OBSERVATION_SCHEMA}`,
    );
  }
  if (!isRecord(raw.observation)) {
    throw new BA1SampleConverterError("SHAPE_INVALID", `${label}.observation must be an object`);
  }
  if (!isRecord(raw.observation.currentControl)) {
    throw new BA1SampleConverterError("SHAPE_INVALID", `${label}.observation.currentControl must be an object`);
  }
  if (!Array.isArray(raw.candidates)) {
    throw new BA1SampleConverterError("SHAPE_INVALID", `${label}.candidates must be an array`);
  }
  const sampleFamily = requireMember(
    raw.sampleFamily,
    ["model-semantic", "contract-gate", "aggregator-test"] as const,
    `${label}.sampleFamily`,
  );
  const supervision = parseSupervision(raw.supervision, `${label}.supervision`);
  const supervisionKind = supervision.kind === "model-semantic"
    ? "model-semantic"
    : supervision.kind;
  if (supervisionKind !== sampleFamily) {
    throw new BA1SampleConverterError(
      "SHAPE_INVALID",
      `${label}.supervision.kind=${supervision.kind} conflicts with sampleFamily=${sampleFamily}`,
    );
  }
  return {
    schema: BA1_HARNESS_OBSERVATION_SCHEMA,
    caseId: requireNonEmptyString(raw.caseId, `${label}.caseId`),
    sourceFamily: requireMember(raw.sourceFamily, SOURCE_FAMILIES, `${label}.sourceFamily`),
    sampleFamily,
    partition: requireMember(raw.partition, ["TRAIN", "DEV", "VERIFICATION"] as const, `${label}.partition`),
    queryText: requireNonEmptyString(raw.queryText, `${label}.queryText`),
    requestedRole: requireNonEmptyString(raw.requestedRole, `${label}.requestedRole`),
    allowedScopeRef: requireNonEmptyString(raw.allowedScopeRef, `${label}.allowedScopeRef`),
    sourceGroup: requireNonEmptyString(raw.sourceGroup, `${label}.sourceGroup`),
    sampleId: requireNonEmptyString(raw.sampleId, `${label}.sampleId`),
    stepContextRef: requireNonEmptyString(raw.stepContextRef, `${label}.stepContextRef`),
    candidateGroupRef: requireNonEmptyString(raw.candidateGroupRef, `${label}.candidateGroupRef`),
    observation: {
      documentRef: requireNonEmptyString(raw.observation.documentRef, `${label}.observation.documentRef`),
      observationId: requireNonEmptyString(raw.observation.observationId, `${label}.observation.observationId`),
      revision: requireFiniteNumber(raw.observation.revision, `${label}.observation.revision`),
      coverage: parseCoverage(raw.observation.coverage, `${label}.observation.coverage`),
      currentControl: {
        documentRef: requireNonEmptyString(
          raw.observation.currentControl.documentRef,
          `${label}.observation.currentControl.documentRef`,
        ),
        observationId: requireNonEmptyString(
          raw.observation.currentControl.observationId,
          `${label}.observation.currentControl.observationId`,
        ),
        revision: requireFiniteNumber(
          raw.observation.currentControl.revision,
          `${label}.observation.currentControl.revision`,
        ),
      },
      candidateGroupEnumerationComplete: requireBoolean(
        raw.observation.candidateGroupEnumerationComplete,
        `${label}.observation.candidateGroupEnumerationComplete`,
      ),
    },
    candidates: raw.candidates.map((candidate, candidateIndex) => parseCandidate(candidate, candidateIndex)),
    supervision,
  };
}

function assertRejectEvidence(record: BA1HarnessObservationRecord): readonly string[] {
  const missing: string[] = [];
  if (record.supervision.kind !== "contract-gate") return missing;
  const reason = record.supervision.reason;
  const observation = record.observation;
  const reasons = record.supervision.kind === "contract-gate" ? [record.supervision.reason] : [];
  if (reason === "unverified_coverage") {
    if (observation.coverage.status === "complete" && observation.coverage.evaluatedCount === observation.coverage.expectedCount) {
      missing.push("unverified_coverage");
    }
  }
  if (reason === "outside_scope") {
    const outside = record.candidates.some(c => c.scopeRef !== observation.coverage.scopeRef);
    if (!outside) missing.push("outside_scope");
  }
  if (reason === "unsupported_requested_role") {
    if (record.requestedRole === "search-input-host") missing.push("unsupported_requested_role");
  }
  if (reason === "access_unknown") {
    const unknown = record.candidates.some(c => c.features.access === "unknown");
    if (!unknown) missing.push("access_unknown");
  }
  if (reason === "stale_candidate") {
    const control = observation.currentControl;
    const candidateStale = record.candidates.some(c => {
      const identity = c.currentness ?? c;
      return identity.documentRef !== control.documentRef
        || identity.observationId !== control.observationId
        || identity.revision !== control.revision
        || c.scopeRef !== observation.coverage.scopeRef;
    });
    const envelopeStale = observation.coverage.documentRef !== control.documentRef
      || observation.coverage.observationId !== control.observationId
      || observation.coverage.revision !== control.revision;
    if (!candidateStale && !envelopeStale) missing.push("stale_candidate");
  }
  if (reasons.length === 0) missing.push("reason");
  return missing;
}

function buildStudentRows(record: BA1HarnessObservationRecord, groupId: string): readonly Record<string, unknown>[] {
  const unmeasured = record.candidates.flatMap(candidate =>
    requiredUnmeasuredFields(candidate).map(field => `${candidate.candidateRef}:${field}`));
  if (unmeasured.length > 0) {
    throw new BA1SampleConverterError(
      "MISSING_OBSERVATION",
      `group ${groupId} requires unmeasured feature(s) ${unmeasured.join(", ")}; refusing to fill false/0`,
    );
  }
  const encoded = encodeBA1RouteGroup({
    groupRef: groupId,
    context: gateContextOf(record),
    candidates: record.candidates.map(toEncoderCandidate),
    allowedCandidateRefs: record.supervision.kind === "model-semantic"
      ? record.supervision.goldAllowedCandidateRefs
      : [],
  });
  return encoded.candidates.map(candidate => {
    const row: Record<string, unknown> = {
      schema: BA1_STUDENT_ROW_SCHEMA,
      group_id: groupId,
      sampleId: record.sampleId,
      sourceGroup: record.sourceGroup,
      partition: record.partition,
      family: "model-semantic",
      candidateRef: candidate.candidateRef,
      x: candidate.input,
      missingMode: [],
      candidateKind: "relation",
      optionSemantics: "select",
    };
    assertAllowedKeys(row, BA1_STUDENT_ROW_KEYS, `student row ${groupId}/${candidate.candidateRef}`);
    return row;
  });
}

function buildSupervisionRow(record: BA1HarnessObservationRecord, groupId: string): Record<string, unknown> {
  if (record.supervision.kind !== "model-semantic") {
    throw new BA1SampleConverterError("SHAPE_INVALID", `group ${groupId} is not model-semantic`);
  }
  const eligibility = classifyBA1TrainingEligibility(record.supervision.supervisionStatus);
  const row: Record<string, unknown> = {
    schema: BA1_SUPERVISION_ROW_SCHEMA,
    group_id: groupId,
    sampleId: record.sampleId,
    sourceGroup: record.sourceGroup,
    partition: record.partition,
    family: "model-semantic",
    supervisionStatus: record.supervision.supervisionStatus,
    goldAllowedCandidateRefs: record.supervision.goldAllowedCandidateRefs,
    trainingEligible: eligibility.trainingEligible,
    evaluationClass: eligibility.evaluationClass,
    labelAuthority: record.supervision.labelAuthority,
    oracleKind: record.supervision.oracleKind,
  };
  assertNoForbiddenSupervisionFields(row, `supervision row ${groupId}`);
  assertAllowedKeys(row, BA1_SUPERVISION_ROW_KEYS, `supervision row ${groupId}`);
  return row;
}

function buildContractGateRow(record: BA1HarnessObservationRecord, groupId: string): Record<string, unknown> {
  const missingEvidence = assertRejectEvidence(record);
  if (missingEvidence.length > 0) {
    throw new BA1SampleConverterError(
      "MISSING_OBSERVATION",
      `contract-gate group ${groupId} reason=${record.supervision.kind === "contract-gate" ? record.supervision.reason : "?"} `
      + `lacks required original violation evidence: ${missingEvidence.join(", ")}`,
    );
  }
  const row: Record<string, unknown> = {
    schema: BA1_CONTRACT_GATE_ROW_SCHEMA,
    group_id: groupId,
    sampleId: record.sampleId,
    sourceGroup: record.sourceGroup,
    sourceFamily: record.sourceFamily,
    partition: record.partition,
    family: "contract-gate",
    candidateCount: record.candidates.length,
    expectedReason: record.supervision.kind === "contract-gate" ? record.supervision.reason : null,
    evaluationClass: "contract",
    coverageStatus: record.observation.coverage.status,
    allowedScopeRef: record.allowedScopeRef,
    candidateScopeRefs: record.candidates.map(c => c.scopeRef),
    coverageEnvelope: {
      scopeRef: record.observation.coverage.scopeRef,
      documentRef: record.observation.coverage.documentRef,
      observationId: record.observation.coverage.observationId,
      revision: record.observation.coverage.revision,
    },
    currentControl: {
      documentRef: record.observation.currentControl.documentRef,
      observationId: record.observation.currentControl.observationId,
      revision: record.observation.currentControl.revision,
    },
  };
  assertAllowedKeys(row, BA1_CONTRACT_GATE_ROW_KEYS, `contract-gate row ${groupId}`);
  return row;
}

function buildAggregatorRow(record: BA1HarnessObservationRecord, groupId: string): Record<string, unknown> {
  const row: Record<string, unknown> = {
    schema: BA1_AGGREGATOR_ROW_SCHEMA,
    group_id: groupId,
    sampleId: record.sampleId,
    sourceGroup: record.sourceGroup,
    sourceFamily: record.sourceFamily,
    partition: record.partition,
    family: "aggregator-test",
    injectedScores: record.supervision.kind === "aggregator-test" ? record.supervision.injectedScores : [],
    expectedState: record.supervision.kind === "aggregator-test" ? record.supervision.expectedState : null,
    evaluationClass: "aggregator",
  };
  assertAllowedKeys(row, BA1_AGGREGATOR_ROW_KEYS, `aggregator-test row ${groupId}`);
  return row;
}

function buildObservationMissingRow(
  record: BA1HarnessObservationRecord,
  groupId: string,
  unmeasuredFields: readonly string[],
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    schema: BA1_OBSERVATION_MISSING_ROW_SCHEMA,
    group_id: groupId,
    sampleId: record.sampleId,
    sourceGroup: record.sourceGroup,
    sourceFamily: record.sourceFamily,
    partition: record.partition,
    family: "model-semantic",
    supervisionStatus: "observation_missing",
    evaluationClass: "insufficient",
    unmeasuredFields,
  };
  assertAllowedKeys(row, BA1_OBSERVATION_MISSING_ROW_KEYS, `observation-missing row ${groupId}`);
  return row;
}

function emptySourceCounts(): Record<BA1SourceFamily, number> {
  return { "family-a": 0, "family-b": 0, "new-independent": 0 };
}

function emptyPartitionCounts(): Record<BA1SamplePartition, number> {
  return { TRAIN: 0, DEV: 0, VERIFICATION: 0 };
}

function emptySampleFamilyCounts(): Record<BA1SampleFamily, number> {
  return { "model-semantic": 0, "contract-gate": 0, "aggregator-test": 0 };
}

function emptySemanticStateCounts(): Record<BA1SemanticSupervisionStatus, number> {
  return {
    labeled_selected: 0,
    labeled_ambiguous: 0,
    labeled_none: 0,
    observation_missing: 0,
    unresolved_supervision: 0,
  };
}

function emptyContractReasonCounts(): Record<BA1ContractGateReason, number> {
  return {
    unsupported_requested_role: 0,
    outside_scope: 0,
    access_unknown: 0,
    unverified_coverage: 0,
    stale_candidate: 0,
  };
}

function emptyAggregatorStateCounts(): Record<BA1AggregatorState, number> {
  return {
    selected: 0,
    none: 0,
    ambiguous: 0,
    insufficient_observation: 0,
  };
}

/**
 * Student and supervision rows must join one-to-one on group_id. This mirrors
 * the fixed training entry's own join check so a mismatched pair fails here,
 * before any file is written.
 */
function assertTrainingJoinPair(
  studentRows: readonly Record<string, unknown>[],
  supervisionRows: readonly Record<string, unknown>[],
): void {
  const studentGroups = new Set(studentRows.map(row => String(row.group_id)));
  const supervisionGroups = new Set<string>();
  for (const row of supervisionRows) {
    const groupId = String(row.group_id);
    if (supervisionGroups.has(groupId)) {
      throw new BA1SampleConverterError("JOIN_INVALID", `duplicate supervision row for group ${groupId}`);
    }
    supervisionGroups.add(groupId);
    if (!studentGroups.has(groupId)) {
      throw new BA1SampleConverterError("JOIN_INVALID", `orphan supervision row for group ${groupId}`);
    }
  }
  for (const groupId of studentGroups) {
    if (!supervisionGroups.has(groupId)) {
      throw new BA1SampleConverterError("JOIN_INVALID", `missing supervision row for group ${groupId}`);
    }
  }
}

export function convertObservations(
  rawObservations: unknown,
  options: { readonly generatedAt?: string } = {},
): BA1ConvertedObservations {
  if (!Array.isArray(rawObservations)) {
    throw new BA1SampleConverterError("SHAPE_INVALID", "observations must be an array");
  }
  const all: BA1HarnessObservationRecord[] = rawObservations.map((raw, index) => parseHarnessObservation(raw, index));

  const trainStudentRows: Record<string, unknown>[] = [];
  const trainSupervisionRows: Record<string, unknown>[] = [];
  const devStudentRows: Record<string, unknown>[] = [];
  const devSupervisionRows: Record<string, unknown>[] = [];
  const verificationStudentRows: Record<string, unknown>[] = [];
  const verificationSupervisionRows: Record<string, unknown>[] = [];
  const contractGateRows: Record<string, unknown>[] = [];
  const aggregatorTestRows: Record<string, unknown>[] = [];
  const observationMissingRows: Record<string, unknown>[] = [];

  const bySampleFamily = emptySampleFamilyCounts();
  const byPartition = emptyPartitionCounts();
  const bySourceFamily = emptySourceCounts();
  const semanticBySourceFamily = emptySourceCounts();
  const semanticByState = emptySemanticStateCounts();
  const contractGateByReason = emptyContractReasonCounts();
  const aggregatorByState = emptyAggregatorStateCounts();
  let trainEligibleGroups = 0;
  let observationMissingGroups = 0;

  for (const record of all) {
    const groupId = groupIdOf(record);
    bySampleFamily[record.sampleFamily] += 1;
    byPartition[record.partition] += 1;
    bySourceFamily[record.sourceFamily] += 1;

    if (record.sampleFamily === "contract-gate") {
      contractGateRows.push(buildContractGateRow(record, groupId));
      if (record.supervision.kind === "contract-gate") contractGateByReason[record.supervision.reason] += 1;
      continue;
    }
    if (record.sampleFamily === "aggregator-test") {
      aggregatorTestRows.push(buildAggregatorRow(record, groupId));
      if (record.supervision.kind === "aggregator-test") aggregatorByState[record.supervision.expectedState] += 1;
      continue;
    }
    if (record.supervision.kind !== "model-semantic") {
      throw new BA1SampleConverterError("SHAPE_INVALID", `group ${groupId} is model-semantic but supervision kind is ${record.supervision.kind}`);
    }

    semanticBySourceFamily[record.sourceFamily] += 1;
    semanticByState[record.supervision.supervisionStatus] += 1;

    const eligibility = classifyBA1TrainingEligibility(record.supervision.supervisionStatus);
    if (record.partition === "TRAIN" && !eligibility.trainingEligible) {
      throw new BA1SampleConverterError(
        "SHAPE_INVALID",
        `group ${groupId} is partition=TRAIN with status=${record.supervision.supervisionStatus}; `
        + "only labeled_selected and labeled_ambiguous may enter TRAIN",
      );
    }

    const unmeasured = record.candidates.flatMap(candidate =>
      requiredUnmeasuredFields(candidate).map(field => `${candidate.candidateRef}.${field}`));
    if (record.supervision.supervisionStatus === "observation_missing" || unmeasured.length > 0) {
      if (record.supervision.supervisionStatus !== "observation_missing") {
        throw new BA1SampleConverterError(
          "MISSING_OBSERVATION",
          `group ${groupId} has unmeasured feature(s) ${unmeasured.join(", ")} but supervisionStatus=`
          + `${record.supervision.supervisionStatus}; refusing to fill false/0`,
        );
      }
      observationMissingRows.push(buildObservationMissingRow(record, groupId, unmeasured));
      observationMissingGroups += 1;
      continue;
    }

    let studentRows: readonly Record<string, unknown>[];
    try {
      studentRows = buildStudentRows(record, groupId);
    } catch (caught) {
      if (caught instanceof BA1SampleConverterError) throw caught;
      const message = caught instanceof BA1RouteEncoderError || caught instanceof Error
        ? caught.message
        : String(caught);
      throw new BA1SampleConverterError("ENCODER_REJECTED", `group ${groupId} encoder rejected the candidate group: ${message}`);
    }
    const supervisionRow = buildSupervisionRow(record, groupId);

    if (record.partition === "TRAIN") {
      trainStudentRows.push(...studentRows);
      trainSupervisionRows.push(supervisionRow);
      trainEligibleGroups += 1;
    } else if (record.partition === "DEV") {
      devStudentRows.push(...studentRows);
      devSupervisionRows.push(supervisionRow);
    } else {
      verificationStudentRows.push(...studentRows);
      verificationSupervisionRows.push(supervisionRow);
    }
  }

  assertTrainingJoinPair(trainStudentRows, trainSupervisionRows);
  assertTrainingJoinPair(devStudentRows, devSupervisionRows);
  assertTrainingJoinPair(verificationStudentRows, verificationSupervisionRows);

  const files = {
    "train/student-rows.jsonl": trainStudentRows.length,
    "train/supervision-rows.jsonl": trainSupervisionRows.length,
    "dev/student-rows.jsonl": devStudentRows.length,
    "dev/supervision-rows.jsonl": devSupervisionRows.length,
    "verification/student-rows.jsonl": verificationStudentRows.length,
    "verification/supervision-rows.jsonl": verificationSupervisionRows.length,
    "contract-gate/rows.jsonl": contractGateRows.length,
    "aggregator-test/rows.jsonl": aggregatorTestRows.length,
    "observation-missing/rows.jsonl": observationMissingRows.length,
  };

  const manifest: BA1SampleManifest = {
    schema: BA1_SAMPLE_MANIFEST_SCHEMA,
    converterVersion: BA1_SAMPLE_CONVERTER_VERSION,
    generatedAt: options.generatedAt ?? new Date(0).toISOString(),
    counts: {
      totalGroups: all.length,
      bySampleFamily,
      byPartition,
      bySourceFamily,
      semanticBySourceFamily,
      semanticByState,
      contractGateByReason,
      aggregatorByState,
      trainEligibleGroups,
      observationMissingGroups,
    },
    files,
  };

  return {
    trainStudentRows,
    trainSupervisionRows,
    devStudentRows,
    devSupervisionRows,
    verificationStudentRows,
    verificationSupervisionRows,
    contractGateRows,
    aggregatorTestRows,
    observationMissingRows,
    manifest,
  };
}
