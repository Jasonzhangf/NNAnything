// B-A1 E2: real-site observation -> evaluator input projection.
//
// This adapter is the wiring the accepted E2 design asks for
// (b-a1-real-site-eval-e2-observation-source-design-carol-20261109,
// e2-observation-source-design.md). It reuses the production projection, the
// no-gold 64-slot route encoder, the saved unified model package loader, the
// shared forward function and the existing B-A1 evaluator input shape.
//
// Boundaries kept on purpose:
//   - no gold enters this module. `S_g` comes from the observation; `A_g` stays
//     with the training supervision and the caller injects gold separately when
//     it calls `evaluateBA1Sample`.
//   - no old binder/profile is called: `inferSearchInputHostBinding`,
//     `SearchInputHostProfile` and `validateSearchInputHostProfile` are not used
//     here, because the old binder re-scores with `roleMatchOf` and drops the
//     unified model scores.
//   - no model, threshold, evaluator or evidence semantics are declared here.
//     The adapter aggregates ref/score pairs with the accepted fixed rules and
//     stops.

import {
  projectSearchInputHostCandidates,
  type SearchInputHostProjectionInput,
} from "./search-input-host-projection.js";
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
import { loadUnifiedModelPackageFromFile } from "../../training/unified-model-package.js";
import { forwardUnifiedScore, type UnifiedTensors } from "../../training/unified-forward.js";
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

/**
 * The one fixed decision boundary in this milestone. It is the same frozen
 * constant the accepted route/evaluator contract uses; the adapter never
 * selects or retunes it.
 */
export const BA1_REAL_SITE_THRESHOLD = 0.5;

/**
 * The real-site observation envelope the E2 design defines. It carries the
 * production projection input plus the explicit saved package path. It carries
 * no gold and no supervision fields.
 */
export interface BA1RealSiteObservation {
  readonly documentRef: string;
  readonly observationId: string;
  readonly revision: number;
  readonly scopeRef: string;
  readonly scopeRoot: Element;
  readonly nodes: readonly { readonly nodeRef: string; readonly element: Element }[];
  readonly propertiesOf: (nodeRef: string) => Record<string, unknown> | null;
  readonly coverage: SearchInputHostCoverage;
  readonly access: SearchInputHostCandidate["access"];
  /**
   * The goal role the caller requested. Defaults to the only role this
   * milestone supports, so an unsupported role stays visible instead of being
   * silently rewritten to the supported one.
   */
  readonly requestedRole?: string;
}

export interface BA1RealSiteEvaluationRequest {
  readonly observation: BA1RealSiteObservation;
  readonly packagePath: string;
  /**
   * The authoritative current-control fact from its existing owner. It is not
   * derived from the observed envelope, so a stale envelope cannot relabel
   * itself as current.
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

/**
 * Apply the E2 design §1.2a correction to the projection output, then map the
 * candidate onto the accepted 64-slot route input.
 *
 * The projection folds a missing `properties` object into `disabled=false` and
 * `editable` from it. That false is not a measurement. `disabled`/`editable`
 * are therefore only kept when `propertiesOf(ref)` really carries a boolean
 * `disabled` key; `readOnly` stays a direct DOM read and is never dropped.
 */
function correctCandidate(
  projected: SearchInputHostCandidate,
  properties: Record<string, unknown> | null,
): SearchInputHostCandidate {
  const disabledMeasured = properties !== null && typeof properties.disabled === "boolean";
  const disabled = disabledMeasured ? (properties.disabled as boolean) : null;
  const editable = disabledMeasured && projected.readOnly !== null
    ? !disabled && projected.readOnly !== true
    : null;
  return { ...projected, disabled, editable };
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

/**
 * Actual DOM membership, not a ref stamped by projection. The scope root is
 * admitted; any element whose ancestor chain leaves it is outside scope.
 */
function isWithinScope(element: Element, scopeRoot: Element): boolean {
  let cursor: Element | null = element;
  while (cursor !== null) {
    if (cursor === scopeRoot) return true;
    cursor = cursor.parentElement;
  }
  return false;
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
 * Project one real-site observation into the gold-free evaluator input.
 *
 * Order (accepted E2 design §1.5): observe and count, run the fixed gates, take
 * the scorable set, encode it without gold, forward through the saved package,
 * then aggregate. Any gate hit stops before encoding or forward. A missing
 * measurement is `insufficient_observation` with `missing_measurement`
 * evidence; the other gates are typed rejects.
 */
export async function projectBA1RealSiteEvaluationInput(
  request: BA1RealSiteEvaluationRequest,
): Promise<BA1RealSiteEvaluationProjection> {
  const { observation } = request;
  const control = request.currentControl;
  const requestedRole = observation.requestedRole ?? SEARCH_INPUT_HOST_ROLE;
  const scopeRef = observation.scopeRef;
  const coverageRef = `${observation.observationId}-coverage`;
  const projectionInput: SearchInputHostProjectionInput = {
    scopeRef,
    documentRef: observation.documentRef,
    observationId: observation.observationId,
    revision: observation.revision,
    scopeRoot: observation.scopeRoot,
    nodes: observation.nodes,
    propertiesOf: observation.propertiesOf,
    coverage: observation.coverage,
    access: observation.access,
  };
  const projected = projectSearchInputHostCandidates(projectionInput);
  const corrected = projected.map(candidate =>
    correctCandidate(candidate, observation.propertiesOf(candidate.ref)));
  const elementByRef = new Map(observation.nodes.map(node => [node.nodeRef, node.element]));
  const outsideScopeRefs = corrected
    .filter(candidate => {
      const element = elementByRef.get(candidate.ref);
      return element === undefined || !isWithinScope(element, observation.scopeRoot);
    })
    .map(candidate => candidate.ref);
  const candidates = corrected.map(evaluationCandidate);
  const observedCandidateCount = observation.coverage.observedCandidateCount;
  const measuredCandidateCount = corrected.filter(isMeasuredSearchInputHostCandidate).length;
  const coverageEvidence = evidenceRecord(
    coverageRef,
    "coverage",
    {
      coverageStatus: "observed",
      observedCandidateCount,
      projectedCandidateCount: projected.length,
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
      `${observation.observationId}-unsupported-requested-role`,
      "unsupported_requested_role",
      { requestedRole },
    );
  }

  // R2: the observed scope must be the allowed scope.
  if (observation.coverage.scopeRef !== scopeRef
    || outsideScopeRefs.length > 0) {
    return rejectWith(
      "outside_scope",
      `${observation.observationId}-outside-scope`,
      "outside_scope",
      {
        allowedScopeRef: scopeRef,
        observedScopeRef: observation.coverage.scopeRef,
        outsideRefs: outsideScopeRefs,
      },
    );
  }

  // R3: coverage is proven only by the unassessed counts plus the observed and
  // projected counts agreeing. A self-consistent declared count is not proof.
  const unassessed = observation.coverage.unassessedIframeCount > 0
    || observation.coverage.unassessedObjectCount > 0
    || observation.coverage.unassessedOpenShadowRootCount > 0;
  if (unassessed
    || observation.coverage.excluded.length > 0
    || observedCandidateCount !== projected.length) {
    return rejectWith(
      "unverified_coverage",
      `${observation.observationId}-unverified-coverage`,
      "unverified_coverage",
      {
        coverageComplete: false,
        coverageStatus: "unverified",
        observedCandidateCount,
        projectedCandidateCount: projected.length,
        excluded: [...observation.coverage.excluded],
      },
      "unverified",
    );
  }

  // R4: envelope currentness. A stale observation is rejected even when it
  // carries no candidates, so an empty stale envelope cannot pass as a fresh
  // insufficient observation.
  if (observation.documentRef !== control.documentRef
    || observation.observationId !== control.observationId
    || observation.revision !== control.revision) {
    return rejectWith(
      "stale_candidate",
      `${observation.observationId}-stale-candidate`,
      "stale_candidate",
      {
        observedRevision: observation.revision,
        currentRevision: control.revision,
        observationId: observation.observationId,
        currentObservationId: control.observationId,
        observedDocumentRef: observation.documentRef,
        currentDocumentRef: control.documentRef,
      },
    );
  }

  // R5: a missing measurement is not a measured false. The whole group stops and
  // keeps its expected obligation; no x is produced and no forward runs.
  if (measuredCandidateCount !== corrected.length) {
    const record = evidenceRecord(
      `${observation.observationId}-insufficient-missing-measurement`,
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
      `${observation.observationId}-access-unknown`,
      "access_unknown",
      { access: "unknown" },
    );
  }

  const scorable = corrected.filter(isMeasuredSearchInputHostCandidate);
  const evaluatedCount = scorable.length;

  if (evaluatedCount === 0) {
    const record = evidenceRecord(
      `${observation.observationId}-insufficient-no-scorable-candidate`,
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

  // Encode without gold. x59/x60 are backfilled from the scorable count, and no
  // gold ref or supervision field enters the vector.
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

  const loaded = await loadUnifiedModelPackageFromFile(request.packagePath);
  if (loaded.package.encoderVersion !== BA1_ENCODER_VERSION) {
    throw new TypeError(
      `saved package ${loaded.package.encoderVersion} is not the B-A1 route encoder ${BA1_ENCODER_VERSION}`,
    );
  }
  const tensors: UnifiedTensors = loaded.package.tensors;
  const scored: BA1ScoredCandidate[] = scorable.map((candidate, index) => ({
    ref: candidate.ref,
    score: forwardUnifiedScore(vectors[index]!, tensors),
  }));
  const max = Math.max(...scored.map(entry => entry.score));

  if (max < BA1_REAL_SITE_THRESHOLD) {
    const record = evidenceRecord(
      `${observation.observationId}-insufficient-all-below-threshold`,
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
      `${observation.observationId}-selected`,
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
    `${observation.observationId}-ambiguity-${index}`,
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
