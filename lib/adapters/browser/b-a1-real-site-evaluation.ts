// B-A1 E2: projected real-site observation -> evaluator input.
//
// The browser bridge owns live DOM measurement. This Node-side evaluator accepts
// only the validated JSON-safe projection, encodes candidates without gold,
// forwards through the caller-prepared unified package, and aggregates scores.

import {
  SEARCH_INPUT_HOST_ROLE,
  isMeasuredSearchInputHostCandidate,
  type SearchInputHostCandidate,
  type SearchInputHostCoverage,
} from "./search-input-host-contract.js";
import {
  encodeBA1RouteCandidate,
  BA1_ENCODER_VERSION,
  type BA1RouteCandidateInput,
  type BA1RouteGateContext,
} from "../../training/b-a1-route-encoder.js";
import { forwardUnifiedScore, type UnifiedTensors } from "../../training/unified-forward.js";
import type { UnifiedModelPackage } from "../../training/unified-model-package.js";
import type {
  BA1BinderOutput,
  BA1EvaluationCandidate,
  BA1EvaluationCoverage,
  BA1EvaluationEvidenceRecord,
  BA1Identity,
} from "../../training/b-a1-evaluator.js";
import type {
  BA1AggregatorState,
  BA1ContractGateReason,
} from "../../training/b-a1-sample-evaluator-skeleton.js";
import type { BA1RealSiteProjectedObservation } from "./b-a1-real-site-browser-projection.js";

/**
 * The one fixed decision boundary in this milestone. It is the same frozen
 * constant the accepted route/evaluator contract uses; the adapter never
 * selects or retunes it.
 */
export const BA1_REAL_SITE_THRESHOLD = 0.5;

/**
 * Compatibility name for callers that already use the evaluator projection
 * shape. The value is the projected, non-DOM envelope only.
 */
export type BA1RealSiteObservation = BA1RealSiteProjectedObservation;

export interface BA1RealSiteEvaluationRequest {
  readonly observation: BA1RealSiteProjectedObservation;
  /** Prepared by the consumer after the admission gate. */
  readonly modelPackage: UnifiedModelPackage;
  /**
   * The authority-issued observation token. It is passed in explicitly so the
   * evaluator cannot derive current control from the observation envelope.
   */
  readonly currentControl: BA1Identity;
}

export interface BA1ScoredCandidate {
  readonly ref: string;
  readonly score: number;
}

/**
 * The gold-free half of `BA1EvaluationInput`. A caller adds its independently
 * produced gold when it calls `evaluateBA1Sample`.
 */
export interface BA1RealSiteEvaluationProjection {
  readonly output: BA1BinderOutput;
  readonly allowedScopeRef: string;
  readonly candidates: readonly BA1EvaluationCandidate[];
  readonly coverage: BA1EvaluationCoverage;
  readonly currentControl: BA1Identity;
  readonly evidenceRecords: readonly BA1EvaluationEvidenceRecord[];
  /**
   * Raw per-candidate model scores in candidate order. Kept as diagnosis only:
   * they are not gold, not inputs to the evaluator and not a second aggregate.
   */
  readonly scoredCandidates: readonly BA1ScoredCandidate[];
  readonly observedCandidateCount: number;
  readonly expectedCount: number;
  readonly evaluatedCount: number;
  /** Candidates with every measured field present. Diagnosis, not a denominator. */
  readonly measuredCandidateCount: number;
}

function evidenceRecord(
  evidenceRef: string,
  type: string,
  payload: Record<string, unknown>,
  scopeRef: string,
  control: BA1Identity,
): BA1EvaluationEvidenceRecord {
  return {
    evidenceRef,
    type,
    scopeRef,
    ...control,
    payload,
  };
}

function evaluationCoverage(
  status: BA1EvaluationCoverage["status"],
  scopeRef: string,
  control: BA1Identity,
  evaluatedCount: number,
  expectedCount: number,
  evidenceRefs: readonly string[],
): BA1EvaluationCoverage {
  return {
    status,
    scopeRef,
    ...control,
    evaluatedCount,
    expectedCount,
    evidenceRefs,
  };
}

function evaluationCandidate(candidate: SearchInputHostCandidate): BA1EvaluationCandidate {
  return {
    ref: candidate.ref,
    scopeRef: candidate.scopeRef,
    documentRef: candidate.documentRef,
    observationId: candidate.observationId,
    revision: candidate.revision,
    access: candidate.access,
  };
}

function toRouteCandidate(measured: SearchInputHostCandidate): BA1RouteCandidateInput {
  return {
    candidateRef: measured.ref,
    candidateKind: "relation",
    optionSemantics: "select",
    scopeRef: measured.scopeRef,
    host: measured.host,
    type: measured.type,
    contentEditable: measured.contentEditable,
    editable: measured.editable,
    disabled: measured.disabled,
    readOnly: measured.readOnly,
    cssHidden: measured.cssHidden,
    intersectsViewport: measured.intersectsViewport,
    explicitTabIndexKind: measured.explicitTabIndexKind,
    tabIndexFocus: measured.tabIndexFocus,
    inForm: measured.inForm,
    formRoleSearch: measured.formRoleSearch,
    nearbySubmit: measured.nearbySubmit,
    depthBand: measured.depthBand,
    hasLabel: measured.hasLabel,
    hasPlaceholder: measured.hasPlaceholder,
    hasAria: measured.hasAria,
    markerHit: measured.markerHit,
    nonSearchMarker: measured.nonSearchMarker,
    textLenBand: measured.textLenBand,
    access: measured.access,
  };
}

/** The accepted fixed non-search shape, kept as the accepted script defines it. */
function matchesNonSearchShape(x: readonly number[]): boolean {
  return x[24] === 0 && x[40] === 0 && x[41] === 1 && x[25] === 0;
}

function gateContext(
  requestedRole: string,
  scopeRef: string,
  unassessed: SearchInputHostCoverage,
  evaluatedCount: number,
  expectedCount: number,
): BA1RouteGateContext {
  return {
    requestedRole,
    allowedScopeRef: scopeRef,
    coverage: {
      status: "complete",
      evaluatedCount,
      expectedCount,
      unassessedIframeCount: unassessed.unassessedIframeCount,
      unassessedObjectCount: unassessed.unassessedObjectCount,
      unassessedOpenShadowRootCount: unassessed.unassessedOpenShadowRootCount,
    },
    candidateGroupEnumerationComplete: true,
  };
}

function boundOutput(
  state: BA1AggregatorState,
  selectedRef: string | null,
  evidenceRefs: readonly string[],
  revision: number,
): BA1BinderOutput {
  return {
    kind: "bound",
    state,
    selectedRef,
    evidenceRefs,
    observedRevision: revision,
  };
}

function rejectOutput(
  reason: BA1ContractGateReason,
  evidenceRefs: readonly string[],
  revision: number,
): BA1BinderOutput {
  return { kind: "reject", reason, evidenceRefs, observedRevision: revision };
}

/**
 * Project one validated real-site observation into the gold-free evaluator
 * input. This function is synchronous after the consumer has loaded the package,
 * so the caller can check freshness immediately before encode/forward.
 */
export function projectBA1RealSiteEvaluationInput(
  request: BA1RealSiteEvaluationRequest,
): BA1RealSiteEvaluationProjection {
  const { observation } = request;
  const control = request.currentControl;
  const requestedRole = observation.requestedRole;
  const scopeRef = observation.scopeRef;
  const coverageRef = `${observation.identity.observationId}-coverage`;
  const corrected = observation.candidates;
  const outsideScopeRefs = observation.outsideScopeRefs;
  const candidates = corrected.map(evaluationCandidate);
  const observedCandidateCount = observation.coverage.observedCandidateCount;
  const measuredCandidateCount = corrected.filter(isMeasuredSearchInputHostCandidate).length;
  const coverageEvidence = evidenceRecord(
    coverageRef,
    "coverage",
    {
      coverageStatus: "observed",
      observedCandidateCount,
      projectedCandidateCount: corrected.length,
      measuredCandidateCount,
    },
    scopeRef,
    control,
  );

  const evidenceRecords: BA1EvaluationEvidenceRecord[] = [coverageEvidence];
  const base = {
    allowedScopeRef: scopeRef,
    candidates,
    currentControl: control,
    evidenceRecords,
    scoredCandidates: [] as readonly BA1ScoredCandidate[],
    expectedCount: observedCandidateCount,
    observedCandidateCount,
    measuredCandidateCount,
  };

  const rejectWith = (
    reason: BA1ContractGateReason,
    evidenceRef: string,
    type: string,
    payload: Record<string, unknown>,
    status: BA1EvaluationCoverage["status"] = "partial",
  ): BA1RealSiteEvaluationProjection => {
    const record = evidenceRecord(evidenceRef, type, payload, scopeRef, control);
    return {
      ...base,
      output: rejectOutput(reason, [record.evidenceRef], control.revision),
      coverage: evaluationCoverage(status, scopeRef, control, 0, observedCandidateCount, [coverageRef]),
      evidenceRecords: [...evidenceRecords, record],
      evaluatedCount: 0,
    };
  };

  // R1: the requested role must be the one capability this path implements.
  if (requestedRole !== SEARCH_INPUT_HOST_ROLE) {
    return rejectWith(
      "unsupported_requested_role",
      `${observation.identity.observationId}-unsupported-requested-role`,
      "unsupported_requested_role",
      { requestedRole },
    );
  }

  // R2: the projection scope and every projected candidate must be in scope.
  if (observation.coverage.scopeRef !== scopeRef || outsideScopeRefs.length > 0) {
    return rejectWith(
      "outside_scope",
      `${observation.identity.observationId}-outside-scope`,
      "outside_scope",
      {
        allowedScopeRef: scopeRef,
        observedScopeRef: observation.coverage.scopeRef,
        outsideRefs: outsideScopeRefs,
      },
    );
  }

  // R3: coverage is proven only by unassessed counts plus observed/projected
  // count agreement. A self-consistent declared count is not proof.
  const unassessed = observation.coverage.unassessedIframeCount > 0
    || observation.coverage.unassessedObjectCount > 0
    || observation.coverage.unassessedOpenShadowRootCount > 0;
  if (unassessed
    || observation.coverage.excluded.length > 0
    || observedCandidateCount !== corrected.length) {
    return rejectWith(
      "unverified_coverage",
      `${observation.identity.observationId}-unverified-coverage`,
      "unverified_coverage",
      {
        coverageComplete: false,
        coverageStatus: "unverified",
        observedCandidateCount,
        projectedCandidateCount: corrected.length,
        excluded: [...observation.coverage.excluded],
      },
      "unverified",
    );
  }

  // R4: envelope currentness. The identity must match the independent token
  // passed by the consumer. This check never reads `currentControl` from the
  // observation itself.
  if (
    observation.identity.documentRef !== control.documentRef
    || observation.identity.observationId !== control.observationId
    || observation.identity.revision !== control.revision
  ) {
    return rejectWith(
      "stale_candidate",
      `${observation.identity.observationId}-stale-candidate`,
      "stale_candidate",
      {
        observedRevision: observation.identity.revision,
        currentRevision: control.revision,
        observationId: observation.identity.observationId,
        currentObservationId: control.observationId,
        observedDocumentRef: observation.identity.documentRef,
        currentDocumentRef: control.documentRef,
      },
    );
  }

  // R5: a missing measurement is not a measured false. The whole group stops and
  // keeps its expected obligation; no x is produced and no forward runs.
  if (measuredCandidateCount !== corrected.length) {
    const record = evidenceRecord(
      `${observation.identity.observationId}-insufficient-missing-measurement`,
      "insufficient_observation",
      {
        insufficientReason: "missing_measurement",
        measuredCandidateCount,
        expectedCount: observedCandidateCount,
      },
      scopeRef,
      control,
    );
    return {
      ...base,
      output: boundOutput("insufficient_observation", null, [record.evidenceRef], control.revision),
      coverage: evaluationCoverage("partial", scopeRef, control, 0, observedCandidateCount, [coverageRef]),
      evidenceRecords: [...evidenceRecords, record],
      evaluatedCount: 0,
    };
  }

  // R6: access is a caller fact. Unknown access cannot be scored.
  if (corrected.some(candidate => candidate.access !== "available")) {
    return rejectWith(
      "access_unknown",
      `${observation.identity.observationId}-access-unknown`,
      "access_unknown",
      { access: "unknown" },
    );
  }

  const scorable = corrected.filter(isMeasuredSearchInputHostCandidate);
  const evaluatedCount = scorable.length;

  if (evaluatedCount === 0) {
    const record = evidenceRecord(
      `${observation.identity.observationId}-insufficient-no-scorable-candidate`,
      "insufficient_observation",
      { insufficientReason: "no_scorable_candidate", expectedCount: observedCandidateCount },
      scopeRef,
      control,
    );
    return {
      ...base,
      output: boundOutput("insufficient_observation", null, [record.evidenceRef], control.revision),
      coverage: evaluationCoverage("partial", scopeRef, control, 0, observedCandidateCount, [coverageRef]),
      evidenceRecords: [...evidenceRecords, record],
      evaluatedCount: 0,
    };
  }

  const context = gateContext(requestedRole, scopeRef, observation.coverage, evaluatedCount, observedCandidateCount);
  const vectors = scorable.map(candidate => [...encodeBA1RouteCandidate(context, toRouteCandidate(candidate))]);
  for (const x of vectors) {
    x[59] = evaluatedCount > 1 ? 1 : 0;
    x[60] = evaluatedCount === 1 ? 1 : 0;
  }

  const completeCoverage = evaluationCoverage(
    "complete",
    scopeRef,
    control,
    evaluatedCount,
    observedCandidateCount,
    [coverageRef],
  );

  // The fixed non-search shape is a deterministic branch, not a neural result:
  // when every scorable candidate matches it, the answer is `none` and the
  // model is not consulted.
  if (vectors.every(matchesNonSearchShape)) {
    return {
      ...base,
      output: boundOutput("none", null, [coverageRef], control.revision),
      coverage: completeCoverage,
      evaluatedCount,
    };
  }

  if (request.modelPackage.encoderVersion !== BA1_ENCODER_VERSION) {
    throw new TypeError(
      `saved package ${request.modelPackage.encoderVersion} is not the B-A1 route encoder ${BA1_ENCODER_VERSION}`,
    );
  }
  const tensors: UnifiedTensors = request.modelPackage.tensors;
  const scored: BA1ScoredCandidate[] = scorable.map((candidate, index) => ({
    ref: candidate.ref,
    score: forwardUnifiedScore(vectors[index]!, tensors),
  }));
  const max = Math.max(...scored.map(entry => entry.score));

  if (max < BA1_REAL_SITE_THRESHOLD) {
    const record = evidenceRecord(
      `${observation.identity.observationId}-insufficient-all-below-threshold`,
      "insufficient_observation",
      { insufficientReason: "all_below_threshold", max, threshold: BA1_REAL_SITE_THRESHOLD },
      scopeRef,
      control,
    );
    return {
      ...base,
      output: boundOutput("insufficient_observation", null, [record.evidenceRef], control.revision),
      coverage: completeCoverage,
      evidenceRecords: [...evidenceRecords, record],
      scoredCandidates: scored,
      evaluatedCount,
    };
  }

  const winners = scored.filter(entry => entry.score === max);
  if (winners.length === 1) {
    const winner = winners[0]!;
    const record = evidenceRecord(
      `${observation.identity.observationId}-selected`,
      "search_host",
      { score: winner.score, threshold: BA1_REAL_SITE_THRESHOLD },
      scopeRef,
      control,
    );
    return {
      ...base,
      output: boundOutput("selected", winner.ref, [record.evidenceRef], control.revision),
      coverage: completeCoverage,
      evidenceRecords: [...evidenceRecords, record],
      scoredCandidates: scored,
      evaluatedCount,
    };
  }

  const ambiguityRecords = winners.map((winner, index) => evidenceRecord(
    `${observation.identity.observationId}-ambiguity-${index}`,
    "ambiguity",
    { supportsAmbiguity: true, score: winner.score, threshold: BA1_REAL_SITE_THRESHOLD },
    scopeRef,
    control,
  ));
  return {
    ...base,
    output: boundOutput(
      "ambiguous",
      null,
      ambiguityRecords.map(record => record.evidenceRef),
      control.revision,
    ),
    coverage: completeCoverage,
    evidenceRecords: [...evidenceRecords, ...ambiguityRecords],
    scoredCandidates: scored,
    evaluatedCount,
  };
}
