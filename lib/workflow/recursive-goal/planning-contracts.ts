import type {PlanningDecisionBinding} from "./decision-contracts.js";
export const BOUNDED_GOAL_PLANNING_KIND = "bounded_goal_planning.v1" as const;
export const PLANNING_ACTION_BOUNDARY_KIND =
  "planning_action_boundary.v1" as const;
export const PLANNING_REPORT_KIND = "bounded_goal_planning_report.v1" as const;

export interface VersionedRef {
  readonly id: string;
  readonly version: string;
}

export type PlanningApplicabilityKind =
  | "applicable"
  | "inapplicable"
  | "unknown";

export interface PlanningApplicability {
  readonly kind: PlanningApplicabilityKind;
  readonly reason: string;
  readonly evidenceRefs: readonly string[];
}

export interface PlanningUnknown {
  readonly ref: string;
  readonly reason: string;
}

export interface PlanningEvidenceRequirement {
  readonly ref: string;
  readonly reason: string;
}

export interface ObligationRef {
  readonly rootRef: string;
  readonly frameRef: string;
  readonly conditionRef: string | null;
}

export interface TypedCondition<G, B, S, E> {
  readonly kind: "typed_condition.v1";
  readonly conditionRef: VersionedRef;
  readonly goal: G;
  readonly bindings: B;
  readonly stateProjection: S;
  readonly evidenceProjection: readonly E[];
}

export type TypedInvalidationCondition<G, B, S, E> =
  TypedCondition<G, B, S, E>;

export interface PlanCost {
  readonly amount: number;
  readonly unit: string;
}

export interface PredictedState<S, E> {
  readonly kind: "predicted";
  readonly projection: {
    readonly state: S;
    readonly evidence: readonly E[];
  };
  readonly assumptions: readonly string[];
  readonly unknown: readonly PlanningUnknown[];
  readonly source: {
    readonly modelRef: VersionedRef;
    readonly predictionCallRef: string;
  };
}

export type PlanCoverage = "covered" | "truncated" | "unknown";
export type SemanticProgress = "progressed" | "no_progress" | "unknown";

export type TerminalTransition =
  | {
      readonly kind: "terminal";
      readonly terminalKind: "root_satisfied" | "dead_end" | "horizon";
      readonly checkpointRef: null;
    }
  | {
      readonly kind: "terminal";
      readonly terminalKind: "checkpoint";
      readonly checkpointRef: string;
    };

export type TransitionContinuation =
  | {
      readonly kind: "continued";
      readonly nextSkillRefs: readonly VersionedRef[];
    }
  | TerminalTransition;

export interface ResultTransitionProjection {
  readonly terminalSatisfaction: number | null;
  readonly riskLevels: readonly {
    readonly scaleRef: VersionedRef;
    readonly level: string;
    readonly ordinal: number;
  }[];
  readonly cost: PlanCost | null;
}

export interface PlannedResult<G, B, S, E, F> {
  readonly transitionRef: string;
  readonly resultRef: string;
  readonly preferenceOrder: number | null;
  readonly predictedState: PredictedState<S, E>;
  readonly predictedEffects: readonly F[];
  readonly applicability: PlanningApplicability;
  readonly coverage: PlanCoverage;
  readonly semanticProgress: SemanticProgress;
  readonly continuation: TransitionContinuation;
  readonly projection: ResultTransitionProjection;
  readonly priorExclusionRefs: readonly string[];
  readonly unknown: readonly PlanningUnknown[];
  readonly preconditions: readonly TypedCondition<G, B, S, E>[];
}

export interface PlanNode<G, B, S, E, F> {
  readonly id: string;
  readonly semanticDepth: number;
  readonly obligationRef: ObligationRef;
  readonly skillRef: VersionedRef;
  readonly preconditions: readonly TypedCondition<G, B, S, E>[];
  readonly predictedResults: readonly PlannedResult<G, B, S, E, F>[];
  readonly cost: PlanCost;
  readonly sourceModelRef: VersionedRef;
}

export type PlanEdgeTarget =
  | { readonly kind: "node"; readonly targetRef: string }
  | { readonly kind: "checkpoint"; readonly targetRef: string }
  | { readonly kind: "terminal"; readonly targetRef: string };

export interface PlanEdge<G, B, S, E> {
  readonly id: string;
  readonly source: {
    readonly nodeRef: string;
    readonly resultRef: string;
  };
  readonly target: PlanEdgeTarget;
  readonly conditions: readonly TypedCondition<G, B, S, E>[];
  readonly coverage: PlanCoverage;
}

export interface PathProjection {
  readonly terminalSatisfaction: number | null;
  readonly riskLevels: readonly {
    readonly scaleRef: VersionedRef;
    readonly level: string;
    readonly ordinal: number;
  }[];
  readonly maximumCost: number | null;
  readonly costUnit: string | null;
  readonly unknownRefs: readonly string[];
  readonly coverage: PlanCoverage;
}

export interface PathAttemptStep {
  readonly order: number;
  readonly nodeRef: string;
  readonly skillRef: VersionedRef;
}

export interface PathCandidate<G, B, S, E> {
  readonly pathId: string;
  readonly rankOrder: number | null;
  readonly entryNodeRef: string;
  readonly nodeRefs: readonly string[];
  readonly projection: PathProjection;
  readonly attemptOrder: readonly PathAttemptStep[];
  readonly invalidation: readonly TypedInvalidationCondition<G, B, S, E>[];
  readonly termination: TerminalTransition;
}

export interface CoverageFrontier {
  readonly frontierRef: string;
  readonly nodeRef: string;
  readonly resultRef: string;
  readonly coverage: PlanCoverage;
  readonly remainingHorizon: number;
  readonly reason: string | null;
  readonly unknownRefs: readonly string[];
}

export interface CheckpointSpec<G, B> {
  readonly id: string;
  readonly goal: G;
  readonly bindings: B;
  readonly satisfactionThreshold: number;
  readonly evaluatorId: string;
  readonly evidenceRequirementRefs: readonly string[];
  readonly obligations: readonly ObligationRef[];
  readonly rollingRule: "next_segment";
}

export interface PlanningEvaluationRef {
  readonly evaluatorId: string;
  readonly result: "satisfied" | "unsatisfied" | "unknown";
  readonly satisfaction: number | null;
  readonly stateRef: string;
  readonly evidenceRefs: readonly string[];
  readonly evaluatedAtTransition: number;
}

export interface PlanCursor {
  readonly pathRef: string;
  readonly nodeRef: string;
  readonly resultRef: string;
  readonly stepIndex: number;
}

export interface VerifiedCheckpoint {
  readonly specRef: string;
  readonly planRef: string;
  readonly evaluation: PlanningEvaluationRef;
  readonly cursor: PlanCursor;
  readonly verifiedAtTransition: number;
}

export type FailurePriorSource =
  | {
      readonly kind: "verified_failure";
      readonly dispatchId: string;
      readonly atomicResultRef: string;
      readonly errorRefs: readonly string[];
    }
  | {
      readonly kind: "proven_unsatisfied";
      readonly evaluation: PlanningEvaluationRef;
    };

export type FailurePriorConclusion =
  | {
      readonly kind: "exclude_transition";
      readonly transitionRefs: readonly string[];
    }
  | {
      readonly kind: "deprioritize_transition";
      readonly transitionRefs: readonly string[];
    };

export interface FailurePrior<G, B, S, E> {
  readonly id: string;
  readonly rootRef: string;
  readonly obligationRef: ObligationRef;
  readonly skillRef: VersionedRef;
  readonly source: FailurePriorSource;
  readonly scope: {
    readonly bindings: B;
    readonly stateProjection: S;
    readonly evidenceProjection: readonly E[];
  };
  readonly preconditions: readonly TypedCondition<G, B, S, E>[];
  readonly conclusion: FailurePriorConclusion;
  readonly invalidation: readonly TypedInvalidationCondition<G, B, S, E>[];
}

export interface GoalGraphPlan<G, B, S, E, F> {
  readonly planId: string;
  readonly rootRef: string;
  readonly startStateRef: string;
  readonly horizonN: number;
  readonly modelRefs: readonly VersionedRef[];
  readonly nodes: readonly PlanNode<G, B, S, E, F>[];
  readonly edges: readonly PlanEdge<G, B, S, E>[];
  readonly paths: readonly PathCandidate<G, B, S, E>[];
  readonly frontier: readonly CoverageFrontier[];
  readonly checkpoints: readonly CheckpointSpec<G, B>[];
}

export interface PlanningRecoveryControl {
  readonly phase:
    | "idle"
    | "evaluate_actual"
    | "check_alternatives"
    | "replan"
    | "checkpoint_recheck"
    | "rolled_back"
    | "blocked";
  readonly recoveryRefs: readonly string[];
  readonly reasonRefs: readonly string[];
  readonly checkpointRef: string | null;
}

export interface PlanningUsage {
  readonly predictionCallsUsed: number;
  readonly replansUsed: number;
  readonly rollbacksUsed: number;
}

export interface PlanControl<G, B, S, E, F> {
  readonly plan: GoalGraphPlan<G, B, S, E, F> | null;
  readonly currentPathRef: string | null;
  readonly alternatePathRefs: readonly string[];
  readonly cursor: PlanCursor | null;
  readonly verifiedCheckpoints: readonly VerifiedCheckpoint[];
  readonly recovery: PlanningRecoveryControl;
  readonly failurePriors: readonly FailurePrior<G, B, S, E>[];
  readonly invalidationRefs: readonly string[];
  readonly usage: PlanningUsage;
}

export interface BoundedPlanningLimits {
  readonly maxPlanNodes: number;
  readonly maxPredictionCalls: number;
  readonly maxReplans: number;
  readonly maxRollbacks: number;
}

export type PathPreferencePolicy =
  | {
      readonly kind: "score_first";
      readonly projectionScaleRef: VersionedRef;
    }
  | {
      readonly kind: "order_first";
      readonly projectionScaleRef: VersionedRef;
    }
  | {
      readonly kind: "conservative";
      readonly projectionScaleRef: VersionedRef;
    }
  | {
      readonly kind: "aggressive";
      readonly projectionScaleRef: VersionedRef;
    };

export interface BoundedPlanningOptions {
  readonly kind: typeof BOUNDED_GOAL_PLANNING_KIND;
  readonly capabilityRef: VersionedRef;
  readonly horizonN: number;
  readonly resultModelRefs: readonly VersionedRef[];
  readonly preference: PathPreferencePolicy;
  readonly checkpointSpecs: readonly unknown[];
  readonly limits: BoundedPlanningLimits;
}

export interface BoundedPlanningRequest<G, B> {
  readonly kind: typeof BOUNDED_GOAL_PLANNING_KIND;
  readonly capabilityRef: VersionedRef;
  readonly horizonN: number;
  readonly resultModelRefs: readonly VersionedRef[];
  readonly preference: PathPreferencePolicy;
  readonly checkpointSpecs: readonly CheckpointSpec<G, B>[];
  readonly limits: BoundedPlanningLimits;
}

export type PathRanking =
  | {
      readonly kind: "ranked";
      readonly pathRefs: readonly string[];
    }
  | {
      readonly kind: "defer";
      readonly missingKeys: readonly string[];
      readonly reason: string;
    };

export interface PriorAssessment {
  readonly priorRef: string;
  readonly applicability: PlanningApplicability;
}

export type PredictionResult =
  | {
      readonly kind: "ready";
      readonly transitionRef: string;
      readonly rootRef: string;
      readonly startStateRef: string;
      readonly planRef: string;
      readonly rankedPathRefs: readonly string[];
      readonly frontier: readonly CoverageFrontier[];
      readonly predictionCallsUsed: number;
    }
  | {
      readonly kind: "deferred";
      readonly rootRef: string;
      readonly startStateRef: string;
      readonly requirements: readonly PlanningEvidenceRequirement[];
      readonly frontier: readonly CoverageFrontier[];
      readonly predictionCallsUsed: number;
    }
  | {
      readonly kind: "not_ready";
      readonly rootRef: string;
      readonly startStateRef: string;
      readonly reason:
        | "missing_skill"
        | "missing_model"
        | "missing_evaluator"
        | "invalid_contract"
        | "horizon_exhausted";
      readonly frontier: readonly CoverageFrontier[];
      readonly predictionCallsUsed: number;
    }
  | {
      readonly kind: "stopped";
      readonly rootRef: string;
      readonly startStateRef: string;
      readonly reason:
        | "root_satisfied"
        | "unknown_or_mixed_effect"
        | "permission_denied"
        | "budget_exhausted"
        | "cancelled"
        | "unrecoverable_error";
      readonly refs: readonly string[];
      readonly predictionCallsUsed: number;
    };

export type PlanningDecision =
  | {
      readonly kind: "continue";
      readonly pathRef: string;
      readonly nodeRef: string;
    }
  | {
      readonly kind: "switch";
      readonly fromPathRef: string;
      readonly toPathRef: string;
      readonly entryNodeRef: string;
    }
  | {
      readonly kind: "replan";
      readonly frontierRefs: readonly string[];
      readonly triggerRefs: readonly string[];
    }
  | {
      readonly kind: "checkpoint_reached";
      readonly checkpointRef: string;
    }
  | {
      readonly kind: "rollback";
      readonly checkpointRef: string;
      readonly currentStateRef: string;
      readonly sourceErrorRefs: readonly string[];
    }
  | {
      readonly kind: "defer";
      readonly requirements: readonly PlanningEvidenceRequirement[];
    }
  | {
      readonly kind: "stop";
      readonly reason:
        | "unknown_or_mixed_effect"
        | "permission_denied"
        | "budget_exhausted"
        | "cancelled"
        | "unrecoverable_error";
      readonly refs: readonly string[];
    }
  | {
      readonly kind: "root_satisfied";
      readonly evaluationStateRef: string;
    };

export interface PlanningSelectionView {
  readonly planRef: string;
  readonly pathRef: string;
  readonly cursorRef: string;
  readonly expectedSkillRef: VersionedRef | null;
  readonly allowedEntrySkillRefs: readonly VersionedRef[];
}

export interface PlanningReport {
  /** Historical failures resolved by the actual root evaluation in this report. */
  readonly recoveredFailureRefs?: readonly string[];
  readonly kind: typeof PLANNING_REPORT_KIND;
  readonly prediction: PredictionResult;
  readonly decision: PlanningDecision | null;
  readonly priorAssessments: readonly PriorAssessment[];
}

export interface PlanningContractRefs {
  readonly decisionRef?: VersionedRef;
  readonly capabilityRef: VersionedRef;
  readonly resultModelRefs: readonly VersionedRef[];
  readonly preference: PathPreferencePolicy;
  readonly checkpointSpecRefs: readonly string[];
  readonly horizonN: number;
  readonly limits: BoundedPlanningLimits;
}

export interface PlanningActionBoundary {
  readonly kind: typeof PLANNING_ACTION_BOUNDARY_KIND;
  readonly dispatchId: string;
  readonly frameId: string;
  readonly atomicResultRef: string;
  readonly observedStateRef: string | null;
  readonly nextPhase:
    | "evaluate_actual"
    | "verify_checkpoint"
    | "recover"
    | "select";
}

export interface PlanningCallbackContext {
  readonly requestId: string;
  readonly planRef: string;
  readonly signal: AbortSignal | null;
}

export interface ResultModelInput<G, B, S, E> {
  readonly context: PlanningCallbackContext;
  readonly rootGoal: G;
  readonly bindings: B;
  readonly stateProjection: S;
  readonly evidenceProjection: readonly E[];
  readonly skillRef: VersionedRef;
  readonly obligationRef: ObligationRef;
  readonly remainingHorizon: number;
  readonly prior: readonly FailurePrior<G, B, S, E>[];
}

export type ResultModelOutput<G, B, S, E, F> =
  | {
      readonly kind: "ready";
      readonly transitions: readonly {
        readonly resultRef: string;
        readonly preferenceOrder: number | null;
        readonly predictedState: PredictedState<S, E>;
        readonly predictedEffects: readonly F[];
        readonly applicability: PlanningApplicability;
        readonly coverage: PlanCoverage;
        readonly semanticProgress: SemanticProgress;
        readonly continuation: TransitionContinuation;
        readonly projection: ResultTransitionProjection;
        readonly unknown: readonly PlanningUnknown[];
        readonly preconditions: readonly TypedCondition<G, B, S, E>[];
      }[];
    }
  | {
      readonly kind: "deferred";
      readonly requirements: readonly PlanningEvidenceRequirement[];
    }
  | {
      readonly kind: "not_ready";
      readonly reason:
        | "missing_skill"
        | "missing_model"
        | "missing_evaluator"
        | "invalid_contract"
        | "horizon_exhausted";
    }
  | {
      readonly kind: "stopped";
      readonly reason:
        | "root_satisfied"
        | "unknown_or_mixed_effect"
        | "permission_denied"
        | "budget_exhausted"
        | "cancelled"
        | "unrecoverable_error";
      readonly refs: readonly string[];
    };

export interface ResultModelBinding<G, B, S, E, F> {
  readonly ref: VersionedRef;
  readonly skillRefs: readonly VersionedRef[];
  /** Deterministic finite transition only. It must not observe or execute. */
  predict(input: ResultModelInput<G, B, S, E>): ResultModelOutput<G, B, S, E, F>;
}

export interface ActualMatchInput<G, B, S, E, F> {
  readonly rootGoal: G;
  readonly bindings: B;
  readonly obligationRef: ObligationRef;
  readonly skillRef: VersionedRef;
  readonly predicted: PlannedResult<G, B, S, E, F>;
  readonly actualState: S;
  readonly actualEvidence: readonly E[];
  readonly actualEffects: readonly F[];
  readonly actualOutcome: "succeeded" | "failed" | "rejected" | "unknown";
}

export interface PriorAssessmentInput<G, B, S, E> {
  readonly prior: FailurePrior<G, B, S, E>;
  readonly obligationRef: ObligationRef;
  readonly skillRef: VersionedRef;
  readonly actualState: S;
  readonly actualEvidence: readonly E[];
  readonly invalidation: readonly TypedInvalidationCondition<G, B, S, E>[];
}

export interface PlanningDomainGuards<G, B, S, E, F, C> {
  readonly goal: (value: unknown) => G;
  readonly bindings: (value: unknown) => B;
  readonly stateProjection: (value: unknown) => S;
  readonly evidenceProjection: (value: unknown) => E;
  readonly effectFact: (value: unknown) => F;
  readonly cursor: (value: unknown) => C;
}

export interface BoundedPlanningCapability<G, B, S, E, F, C> {
  readonly decision?: PlanningDecisionBinding;
  readonly contract: VersionedRef;
  readonly resultModels: readonly ResultModelBinding<G, B, S, E, F>[];
  readonly guards: PlanningDomainGuards<G, B, S, E, F, C>;
  /** Checks entry conditions and invalidation against current facts; never executes. */
  assessEntry?(input: PlanningEntryAssessmentInput<G, B, S, E, F>): PlanningApplicability;
  /** Pure validity check; no observation, execution, or hidden state. */
  matchesActual(input: ActualMatchInput<G, B, S, E, F>): PlanningApplicability;
  /** Pure scope/precondition check; no observation or mutation. */
  assessPrior(input: PriorAssessmentInput<G, B, S, E>): PlanningApplicability;
}

export interface PlanningEntryAssessmentInput<G, B, S, E, F> {
  readonly path: PathCandidate<G, B, S, E>;
  readonly node: PlanNode<G, B, S, E, F>;
  readonly edge: PlanEdge<G, B, S, E> | null;
  readonly actualState: S;
  readonly actualEvidence: readonly E[];
}

export function readPlanningEntryAssessment(value: unknown): PlanningApplicability {
  return readApplicability(value, "planning entry assessment");
}

export function assertBoundedPlanningCapabilityContract<G, B, S, E, F, C>(
  request: BoundedPlanningRequest<G, B>,
  capability: BoundedPlanningCapability<G, B, S, E, F, C>,
  label = "planning",
): void {
  if (!sameVersionedRef(request.capabilityRef, capability.contract)) {
    throw new TypeError(`${label}.capabilityRef disagrees with dependency capability`);
  }
  assertUnique(
    capability.resultModels,
    model => `${model.ref.id}\0${model.ref.version}`,
    `${label}.capability.resultModels`,
  );
  if (capability.resultModels.length !== request.resultModelRefs.length) {
    throw new TypeError(`${label}.resultModelRefs disagrees with capability models`);
  }
  for (const requestRef of request.resultModelRefs) {
    const binding = capability.resultModels.find(model =>
      sameVersionedRef(model.ref, requestRef),
    );
    if (binding === undefined || binding.skillRefs.length === 0) {
      throw new TypeError(`${label}.resultModelRefs has an unavailable model`);
    }
    assertUnique(
      binding.skillRefs,
      skill => `${skill.id}\0${skill.version}`,
      `${label}.resultModel.${binding.ref.id}.skillRefs`,
    );
  }
}

export function assertBoundedPlanningPresence<G, B, S, E, F, C>(
  request: BoundedPlanningOptions | undefined,
  capability: BoundedPlanningCapability<G, B, S, E, F, C> | undefined,
): void {
  if ((request === undefined) !== (capability === undefined)) {
    throw new TypeError(
      "request.planning and dependencies.planning must be present together",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${label} has unsupported field ${key}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`${label}.${key} is required`);
    }
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty string without NUL`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : nonEmptyString(value, label);
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative integer`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function nonnegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite nonnegative number`);
  }
  return value;
}

function satisfaction(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new TypeError(`${label} must be a finite number from 0 to 100`);
  }
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const result = value.map((entry, index) =>
    nonEmptyString(entry, `${label}[${index}]`),
  );
  if (new Set(result).size !== result.length) {
    throw new TypeError(`${label} contains duplicate values`);
  }
  return result;
}

function objectArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function assertUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    const id = key(value);
    if (seen.has(id)) throw new TypeError(`${label} contains duplicate ${id}`);
    seen.add(id);
  }
}

function readCoverage(value: unknown, label: string): PlanCoverage {
  if (value !== "covered" && value !== "truncated" && value !== "unknown") {
    throw new TypeError(`${label} must be covered, truncated, or unknown`);
  }
  return value;
}

function readSemanticProgress(
  value: unknown,
  label: string,
): SemanticProgress {
  if (
    value !== "progressed" &&
    value !== "no_progress" &&
    value !== "unknown"
  ) {
    throw new TypeError(`${label} must be progressed, no_progress, or unknown`);
  }
  return value;
}

function readTransitionContinuation(
  value: unknown,
  label: string,
): TransitionContinuation {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  if (value.kind === "continued") {
    assertExactKeys(value, ["kind", "nextSkillRefs"], [], label);
    const nextSkillRefs = objectArray(
      value.nextSkillRefs,
      `${label}.nextSkillRefs`,
    ).map((entry, index) =>
      readVersionedRef(entry, `${label}.nextSkillRefs[${index}]`),
    );
    assertUnique(
      nextSkillRefs,
      skill => `${skill.id}\0${skill.version}`,
      `${label}.nextSkillRefs`,
    );
    if (nextSkillRefs.length === 0) {
      throw new TypeError(`${label}.nextSkillRefs must not be empty`);
    }
    return { kind: "continued", nextSkillRefs };
  }
  if (value.kind !== "terminal") {
    throw new TypeError(`${label}.kind must be continued or terminal`);
  }
  if (value.terminalKind === "checkpoint") {
    assertExactKeys(
      value,
      ["kind", "terminalKind", "checkpointRef"],
      [],
      label,
    );
    return {
      kind: "terminal",
      terminalKind: "checkpoint",
      checkpointRef: nonEmptyString(
        value.checkpointRef,
        `${label}.checkpointRef`,
      ),
    };
  }
  if (
    value.terminalKind !== "root_satisfied" &&
    value.terminalKind !== "dead_end" && value.terminalKind !== "horizon"
  ) {
    throw new TypeError(`${label}.terminalKind is invalid`);
  }
  assertExactKeys(
    value,
    ["kind", "terminalKind", "checkpointRef"],
    [],
    label,
  );
  if (value.checkpointRef !== null) {
    throw new TypeError(`${label}.checkpointRef must be null`);
  }
  return {
    kind: "terminal",
    terminalKind: value.terminalKind,
    checkpointRef: null,
  };
}

function readResultTransitionProjection(
  value: unknown,
  label: string,
): ResultTransitionProjection {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    ["terminalSatisfaction", "riskLevels", "cost"],
    [],
    label,
  );
  const riskLevels = objectArray(value.riskLevels, `${label}.riskLevels`).map(
    (entry, index) => {
      const itemLabel = `${label}.riskLevels[${index}]`;
      if (!isRecord(entry)) throw new TypeError(`${itemLabel} must be an object`);
      assertExactKeys(entry, ["scaleRef", "level", "ordinal"], [], itemLabel);
      return {
        scaleRef: readVersionedRef(entry.scaleRef, `${itemLabel}.scaleRef`),
        level: nonEmptyString(entry.level, `${itemLabel}.level`),
        ordinal: nonnegativeInteger(entry.ordinal, `${itemLabel}.ordinal`),
      };
    },
  );
  assertUnique(
    riskLevels,
    risk => `${risk.scaleRef.id}\0${risk.scaleRef.version}`,
    `${label}.riskLevels`,
  );
  return {
    terminalSatisfaction:
      value.terminalSatisfaction === null
        ? null
        : satisfaction(
            value.terminalSatisfaction,
            `${label}.terminalSatisfaction`,
          ),
    riskLevels,
    cost:
      value.cost === null ? null : readPlanCost(value.cost, `${label}.cost`),
  };
}

function readApplicability(value: unknown, label: string): PlanningApplicability {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, ["kind", "reason", "evidenceRefs"], [], label);
  if (
    value.kind !== "applicable" &&
    value.kind !== "inapplicable" &&
    value.kind !== "unknown"
  ) {
    throw new TypeError(`${label}.kind is invalid`);
  }
  return {
    kind: value.kind,
    reason: nonEmptyString(value.reason, `${label}.reason`),
    evidenceRefs: stringArray(value.evidenceRefs, `${label}.evidenceRefs`),
  };
}

function readPlanningUnknown(value: unknown, label: string): PlanningUnknown {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, ["ref", "reason"], [], label);
  return {
    ref: nonEmptyString(value.ref, `${label}.ref`),
    reason: nonEmptyString(value.reason, `${label}.reason`),
  };
}

function readEvidenceRequirement(
  value: unknown,
  label: string,
): PlanningEvidenceRequirement {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, ["ref", "reason"], [], label);
  return {
    ref: nonEmptyString(value.ref, `${label}.ref`),
    reason: nonEmptyString(value.reason, `${label}.reason`),
  };
}

export function readVersionedRef(
  value: unknown,
  label = "versionedRef",
): VersionedRef {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, ["id", "version"], [], label);
  return {
    id: nonEmptyString(value.id, `${label}.id`),
    version: nonEmptyString(value.version, `${label}.version`),
  };
}

export function sameVersionedRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.version === right.version;
}

function readObligationRef(value: unknown, label: string): ObligationRef {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, ["rootRef", "frameRef", "conditionRef"], [], label);
  return {
    rootRef: nonEmptyString(value.rootRef, `${label}.rootRef`),
    frameRef: nonEmptyString(value.frameRef, `${label}.frameRef`),
    conditionRef: nullableString(value.conditionRef, `${label}.conditionRef`),
  };
}

export function readTypedCondition<G, B, S, E>(
  value: unknown,
  guards: PlanningDomainGuards<G, B, S, E, unknown, unknown>,
  label = "typedCondition",
): TypedCondition<G, B, S, E> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    [
      "kind",
      "conditionRef",
      "goal",
      "bindings",
      "stateProjection",
      "evidenceProjection",
    ],
    [],
    label,
  );
  if (value.kind !== "typed_condition.v1") {
    throw new TypeError(`${label}.kind must be typed_condition.v1`);
  }
  return {
    kind: "typed_condition.v1",
    conditionRef: readVersionedRef(value.conditionRef, `${label}.conditionRef`),
    goal: guards.goal(value.goal),
    bindings: guards.bindings(value.bindings),
    stateProjection: guards.stateProjection(value.stateProjection),
    evidenceProjection: objectArray(
      value.evidenceProjection,
      `${label}.evidenceProjection`,
    ).map(entry => guards.evidenceProjection(entry)),
  };
}

function readTypedConditions<G, B, S, E, F, C>(
  value: unknown,
  guards: PlanningDomainGuards<G, B, S, E, F, C>,
  label: string,
): readonly TypedCondition<G, B, S, E>[] {
  return objectArray(value, label).map((entry, index) =>
    readTypedCondition(entry, guards, `${label}[${index}]`),
  );
}

export function readPredictedState<S, E>(
  value: unknown,
  stateGuard: (value: unknown) => S,
  evidenceGuard: (value: unknown) => E,
  label = "predictedState",
): PredictedState<S, E> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    ["kind", "projection", "assumptions", "unknown", "source"],
    [],
    label,
  );
  if (value.kind !== "predicted") {
    throw new TypeError(`${label}.kind must be predicted`);
  }
  if (!isRecord(value.projection)) {
    throw new TypeError(`${label}.projection must be an object`);
  }
  assertExactKeys(value.projection, ["state", "evidence"], [], `${label}.projection`);
  if (!isRecord(value.source)) {
    throw new TypeError(`${label}.source must be an object`);
  }
  assertExactKeys(
    value.source,
    ["modelRef", "predictionCallRef"],
    [],
    `${label}.source`,
  );
  return {
    kind: "predicted",
    projection: {
      state: stateGuard(value.projection.state),
      evidence: objectArray(
        value.projection.evidence,
        `${label}.projection.evidence`,
      ).map(entry => evidenceGuard(entry)),
    },
    assumptions: stringArray(value.assumptions, `${label}.assumptions`),
    unknown: objectArray(value.unknown, `${label}.unknown`).map((entry, index) =>
      readPlanningUnknown(entry, `${label}.unknown[${index}]`),
    ),
    source: {
      modelRef: readVersionedRef(value.source.modelRef, `${label}.source.modelRef`),
      predictionCallRef: nonEmptyString(
        value.source.predictionCallRef,
        `${label}.source.predictionCallRef`,
      ),
    },
  };
}

function readPlanCost(value: unknown, label: string): PlanCost {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, ["amount", "unit"], [], label);
  return {
    amount: nonnegativeNumber(value.amount, `${label}.amount`),
    unit: nonEmptyString(value.unit, `${label}.unit`),
  };
}

function readPlannedResults<G, B, S, E, F>(
  value: unknown,
  guards: PlanningDomainGuards<G, B, S, E, F, unknown>,
  label: string,
): readonly PlannedResult<G, B, S, E, F>[] {
  const results = objectArray(value, label).map((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    if (!isRecord(entry)) throw new TypeError(`${itemLabel} must be an object`);
    assertExactKeys(
      entry,
      [
        "transitionRef",
        "resultRef",
        "preferenceOrder",
        "predictedState",
        "predictedEffects",
        "applicability",
        "coverage",
        "semanticProgress",
        "continuation",
        "projection",
        "priorExclusionRefs",
        "unknown",
        "preconditions",
      ],
      [],
      itemLabel,
    );
    return {
      transitionRef: nonEmptyString(
        entry.transitionRef,
        `${itemLabel}.transitionRef`,
      ),
      resultRef: nonEmptyString(entry.resultRef, `${itemLabel}.resultRef`),
      preferenceOrder:
        entry.preferenceOrder === null
          ? null
          : nonnegativeInteger(
              entry.preferenceOrder,
              `${itemLabel}.preferenceOrder`,
            ),
      predictedState: readPredictedState(
        entry.predictedState,
        guards.stateProjection,
        guards.evidenceProjection,
        `${itemLabel}.predictedState`,
      ),
      predictedEffects: objectArray(
        entry.predictedEffects,
        `${itemLabel}.predictedEffects`,
      ).map(effect => guards.effectFact(effect)),
      applicability: readApplicability(
        entry.applicability,
        `${itemLabel}.applicability`,
      ),
      coverage: readCoverage(entry.coverage, `${itemLabel}.coverage`),
      semanticProgress: readSemanticProgress(
        entry.semanticProgress,
        `${itemLabel}.semanticProgress`,
      ),
      continuation: readTransitionContinuation(
        entry.continuation,
        `${itemLabel}.continuation`,
      ),
      projection: readResultTransitionProjection(
        entry.projection,
        `${itemLabel}.projection`,
      ),
      priorExclusionRefs: stringArray(
        entry.priorExclusionRefs,
        `${itemLabel}.priorExclusionRefs`,
      ),
      unknown: objectArray(entry.unknown, `${itemLabel}.unknown`).map(
        (unknown, unknownIndex) =>
          readPlanningUnknown(unknown, `${itemLabel}.unknown[${unknownIndex}]`),
      ),
      preconditions: readTypedConditions(
        entry.preconditions,
        guards,
        `${itemLabel}.preconditions`,
      ),
    };
  });
  assertUnique(results, result => result.transitionRef, label);
  assertUnique(results, result => result.resultRef, label);
  return results;
}

export function readPlanNode<G, B, S, E, F>(
  value: unknown,
  guards: PlanningDomainGuards<G, B, S, E, F, unknown>,
  label = "planNode",
): PlanNode<G, B, S, E, F> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    [
      "id",
      "semanticDepth",
      "obligationRef",
      "skillRef",
      "preconditions",
      "predictedResults",
      "cost",
      "sourceModelRef",
    ],
    [],
    label,
  );
  const sourceModelRef = readVersionedRef(
    value.sourceModelRef,
    `${label}.sourceModelRef`,
  );
  const predictedResults = readPlannedResults(
    value.predictedResults,
    guards,
    `${label}.predictedResults`,
  );
  for (const [index, result] of predictedResults.entries()) {
    if (!sameVersionedRef(result.predictedState.source.modelRef, sourceModelRef)) {
      throw new TypeError(
        `${label}.predictedResults[${index}] source model disagrees with node`,
      );
    }
  }
  return {
    id: nonEmptyString(value.id, `${label}.id`),
    semanticDepth: nonnegativeInteger(
      value.semanticDepth,
      `${label}.semanticDepth`,
    ),
    obligationRef: readObligationRef(
      value.obligationRef,
      `${label}.obligationRef`,
    ),
    skillRef: readVersionedRef(value.skillRef, `${label}.skillRef`),
    preconditions: readTypedConditions(
      value.preconditions,
      guards,
      `${label}.preconditions`,
    ),
    predictedResults,
    cost: readPlanCost(value.cost, `${label}.cost`),
    sourceModelRef,
  };
}

function readPlanEdge<G, B, S, E, F, C>(
  value: unknown,
  guards: PlanningDomainGuards<G, B, S, E, F, C>,
  label: string,
): PlanEdge<G, B, S, E> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    ["id", "source", "target", "conditions", "coverage"],
    [],
    label,
  );
  if (!isRecord(value.source)) {
    throw new TypeError(`${label}.source must be an object`);
  }
  assertExactKeys(value.source, ["nodeRef", "resultRef"], [], `${label}.source`);
  if (!isRecord(value.target)) {
    throw new TypeError(`${label}.target must be an object`);
  }
  assertExactKeys(value.target, ["kind", "targetRef"], [], `${label}.target`);
  if (
    value.target.kind !== "node" &&
    value.target.kind !== "checkpoint" &&
    value.target.kind !== "terminal"
  ) {
    throw new TypeError(`${label}.target.kind is invalid`);
  }
  return {
    id: nonEmptyString(value.id, `${label}.id`),
    source: {
      nodeRef: nonEmptyString(value.source.nodeRef, `${label}.source.nodeRef`),
      resultRef: nonEmptyString(value.source.resultRef, `${label}.source.resultRef`),
    },
    target: {
      kind: value.target.kind,
      targetRef: nonEmptyString(value.target.targetRef, `${label}.target.targetRef`),
    },
    conditions: readTypedConditions(
      value.conditions,
      guards,
      `${label}.conditions`,
    ),
    coverage: readCoverage(value.coverage, `${label}.coverage`),
  };
}

function readPathProjection(value: unknown, label: string): PathProjection {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    [
      "terminalSatisfaction",
      "riskLevels",
      "maximumCost",
      "costUnit",
      "unknownRefs",
      "coverage",
    ],
    [],
    label,
  );
  const riskLevels = objectArray(value.riskLevels, `${label}.riskLevels`).map(
    (entry, index) => {
      const itemLabel = `${label}.riskLevels[${index}]`;
      if (!isRecord(entry)) throw new TypeError(`${itemLabel} must be an object`);
      assertExactKeys(
        entry,
        ["scaleRef", "level", "ordinal"],
        [],
        itemLabel,
      );
      return {
        scaleRef: readVersionedRef(entry.scaleRef, `${itemLabel}.scaleRef`),
        level: nonEmptyString(entry.level, `${itemLabel}.level`),
        ordinal: nonnegativeInteger(entry.ordinal, `${itemLabel}.ordinal`),
      };
    },
  );
  assertUnique(
    riskLevels,
    risk => `${risk.scaleRef.id}\0${risk.scaleRef.version}`,
    `${label}.riskLevels`,
  );
  return {
    terminalSatisfaction:
      value.terminalSatisfaction === null
        ? null
        : satisfaction(value.terminalSatisfaction, `${label}.terminalSatisfaction`),
    riskLevels,
    maximumCost:
      value.maximumCost === null
        ? null
        : nonnegativeNumber(value.maximumCost, `${label}.maximumCost`),
    costUnit: nullableString(value.costUnit, `${label}.costUnit`),
    unknownRefs: stringArray(value.unknownRefs, `${label}.unknownRefs`),
    coverage: readCoverage(value.coverage, `${label}.coverage`),
  };
}

function readPathCandidate<G, B, S, E, F, C>(
  value: unknown,
  guards: PlanningDomainGuards<G, B, S, E, F, C>,
  label: string,
): PathCandidate<G, B, S, E> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    [
      "pathId",
      "rankOrder",
      "entryNodeRef",
      "nodeRefs",
      "projection",
      "attemptOrder",
      "invalidation",
      "termination",
    ],
    [],
    label,
  );
  const attemptOrder = objectArray(
    value.attemptOrder,
    `${label}.attemptOrder`,
  ).map((entry, index) => {
    const itemLabel = `${label}.attemptOrder[${index}]`;
    if (!isRecord(entry)) throw new TypeError(`${itemLabel} must be an object`);
    assertExactKeys(entry, ["order", "nodeRef", "skillRef"], [], itemLabel);
    return {
      order: nonnegativeInteger(entry.order, `${itemLabel}.order`),
      nodeRef: nonEmptyString(entry.nodeRef, `${itemLabel}.nodeRef`),
      skillRef: readVersionedRef(entry.skillRef, `${itemLabel}.skillRef`),
    };
  });
  for (const [index, step] of attemptOrder.entries()) {
    if (step.order !== index) {
      throw new TypeError(`${label}.attemptOrder must use contiguous zero-based order`);
    }
  }
  const termination = readTransitionContinuation(
    value.termination,
    `${label}.termination`,
  );
  if (termination.kind !== "terminal") {
    throw new TypeError(`${label}.termination must be terminal`);
  }
  return {
    pathId: nonEmptyString(value.pathId, `${label}.pathId`),
    rankOrder:
      value.rankOrder === null
        ? null
        : nonnegativeInteger(value.rankOrder, `${label}.rankOrder`),
    entryNodeRef: nonEmptyString(value.entryNodeRef, `${label}.entryNodeRef`),
    nodeRefs: stringArray(value.nodeRefs, `${label}.nodeRefs`),
    projection: readPathProjection(value.projection, `${label}.projection`),
    attemptOrder,
    invalidation: readTypedConditions(
      value.invalidation,
      guards,
      `${label}.invalidation`,
    ),
    termination,
  };
}

function readCoverageFrontier(value: unknown, label: string): CoverageFrontier {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    [
      "frontierRef",
      "nodeRef",
      "resultRef",
      "coverage",
      "remainingHorizon",
      "reason",
      "unknownRefs",
    ],
    [],
    label,
  );
  return {
    frontierRef: nonEmptyString(value.frontierRef, `${label}.frontierRef`),
    nodeRef: nonEmptyString(value.nodeRef, `${label}.nodeRef`),
    resultRef: nonEmptyString(value.resultRef, `${label}.resultRef`),
    coverage: readCoverage(value.coverage, `${label}.coverage`),
    remainingHorizon: nonnegativeInteger(
      value.remainingHorizon,
      `${label}.remainingHorizon`,
    ),
    reason: nullableString(value.reason, `${label}.reason`),
    unknownRefs: stringArray(value.unknownRefs, `${label}.unknownRefs`),
  };
}

function readCheckpointSpec<G, B, S, E, F, C>(
  value: unknown,
  guards: PlanningDomainGuards<G, B, S, E, F, C>,
  label: string,
): CheckpointSpec<G, B> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    [
      "id",
      "goal",
      "bindings",
      "satisfactionThreshold",
      "evaluatorId",
      "evidenceRequirementRefs",
      "obligations",
      "rollingRule",
    ],
    [],
    label,
  );
  if (value.rollingRule !== "next_segment") {
    throw new TypeError(`${label}.rollingRule must be next_segment`);
  }
  const obligations = objectArray(value.obligations, `${label}.obligations`).map(
    (entry, index) => readObligationRef(entry, `${label}.obligations[${index}]`),
  );
  assertUnique(
    obligations,
    obligation =>
      `${obligation.rootRef}\0${obligation.frameRef}\0${obligation.conditionRef ?? ""}`,
    `${label}.obligations`,
  );
  return {
    id: nonEmptyString(value.id, `${label}.id`),
    goal: guards.goal(value.goal),
    bindings: guards.bindings(value.bindings),
    satisfactionThreshold: satisfaction(
      value.satisfactionThreshold,
      `${label}.satisfactionThreshold`,
    ),
    evaluatorId: nonEmptyString(value.evaluatorId, `${label}.evaluatorId`),
    evidenceRequirementRefs: stringArray(
      value.evidenceRequirementRefs,
      `${label}.evidenceRequirementRefs`,
    ),
    obligations,
    rollingRule: "next_segment",
  };
}

export function readGoalGraphPlan<G, B, S, E, F, C>(
  value: unknown,
  guards: PlanningDomainGuards<G, B, S, E, F, C>,
  label = "goalGraphPlan",
): GoalGraphPlan<G, B, S, E, F> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    [
      "planId",
      "rootRef",
      "startStateRef",
      "horizonN",
      "modelRefs",
      "nodes",
      "edges",
      "paths",
      "frontier",
      "checkpoints",
    ],
    [],
    label,
  );
  const modelRefs = objectArray(value.modelRefs, `${label}.modelRefs`).map(
    (entry, index) => readVersionedRef(entry, `${label}.modelRefs[${index}]`),
  );
  assertUnique(
    modelRefs,
    model => `${model.id}\0${model.version}`,
    `${label}.modelRefs`,
  );
  const nodes = objectArray(value.nodes, `${label}.nodes`).map((entry, index) =>
    readPlanNode(entry, guards, `${label}.nodes[${index}]`),
  );
  assertUnique(nodes, node => node.id, `${label}.nodes`);
  const nodeRefs = new Set(nodes.map(node => node.id));
  const resultRefs = new Set(
    nodes.flatMap(node =>
      node.predictedResults.map(result => `${node.id}\0${result.resultRef}`),
    ),
  );
  for (const [index, node] of nodes.entries()) {
    for (const [resultIndex, result] of node.predictedResults.entries()) {
      if (
        !modelRefs.some(model =>
          sameVersionedRef(model, result.predictedState.source.modelRef),
        )
      ) {
        throw new TypeError(
          `${label}.nodes[${index}].predictedResults[${resultIndex}] uses an undeclared model`,
        );
      }
    }
  }
  const edges = objectArray(value.edges, `${label}.edges`).map((entry, index) =>
    readPlanEdge(entry, guards, `${label}.edges[${index}]`),
  );
  assertUnique(edges, edge => edge.id, `${label}.edges`);
  const checkpoints = objectArray(
    value.checkpoints,
    `${label}.checkpoints`,
  ).map((entry, index) =>
    readCheckpointSpec(entry, guards, `${label}.checkpoints[${index}]`),
  );
  assertUnique(checkpoints, checkpoint => checkpoint.id, `${label}.checkpoints`);
  const checkpointRefs = new Set(checkpoints.map(checkpoint => checkpoint.id));
  for (const [index, edge] of edges.entries()) {
    if (
      !nodeRefs.has(edge.source.nodeRef) ||
      !resultRefs.has(`${edge.source.nodeRef}\0${edge.source.resultRef}`)
    ) {
      throw new TypeError(`${label}.edges[${index}] has an unknown source result`);
    }
    if (edge.target.kind === "node" && !nodeRefs.has(edge.target.targetRef)) {
      throw new TypeError(`${label}.edges[${index}] has an unknown target node`);
    }
    if (
      edge.target.kind === "checkpoint" &&
      !checkpointRefs.has(edge.target.targetRef)
    ) {
      throw new TypeError(`${label}.edges[${index}] has an unknown checkpoint`);
    }
  }
  const paths = objectArray(value.paths, `${label}.paths`).map((entry, index) =>
    readPathCandidate(entry, guards, `${label}.paths[${index}]`),
  );
  assertUnique(paths, path => path.pathId, `${label}.paths`);
  for (const [index, path] of paths.entries()) {
    if (!nodeRefs.has(path.entryNodeRef)) {
      throw new TypeError(`${label}.paths[${index}] has an unknown entry node`);
    }
    for (const nodeRef of path.nodeRefs) {
      if (!nodeRefs.has(nodeRef)) {
        throw new TypeError(`${label}.paths[${index}] has an unknown node ${nodeRef}`);
      }
    }
    for (const step of path.attemptOrder) {
      const node = nodes.find(candidate => candidate.id === step.nodeRef);
      if (
        node === undefined ||
        !sameVersionedRef(node.skillRef, step.skillRef) ||
        !path.nodeRefs.includes(step.nodeRef)
      ) {
        throw new TypeError(
          `${label}.paths[${index}] attempt order disagrees with its node`,
        );
      }
    }
  }
  const frontier = objectArray(value.frontier, `${label}.frontier`).map(
    (entry, index) => readCoverageFrontier(entry, `${label}.frontier[${index}]`),
  );
  assertUnique(frontier, entry => entry.frontierRef, `${label}.frontier`);
  for (const [index, entry] of frontier.entries()) {
    if (!resultRefs.has(`${entry.nodeRef}\0${entry.resultRef}`)) {
      throw new TypeError(`${label}.frontier[${index}] has an unknown source result`);
    }
  }
  return {
    planId: nonEmptyString(value.planId, `${label}.planId`),
    rootRef: nonEmptyString(value.rootRef, `${label}.rootRef`),
    startStateRef: nonEmptyString(value.startStateRef, `${label}.startStateRef`),
    horizonN: positiveInteger(value.horizonN, `${label}.horizonN`),
    modelRefs,
    nodes,
    edges,
    paths,
    frontier,
    checkpoints,
  };
}

function readPlanningEvaluationRef(
  value: unknown,
  label: string,
): PlanningEvaluationRef {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    [
      "evaluatorId",
      "result",
      "satisfaction",
      "stateRef",
      "evidenceRefs",
      "evaluatedAtTransition",
    ],
    [],
    label,
  );
  if (
    value.result !== "satisfied" &&
    value.result !== "unsatisfied" &&
    value.result !== "unknown"
  ) {
    throw new TypeError(`${label}.result is invalid`);
  }
  return {
    evaluatorId: nonEmptyString(value.evaluatorId, `${label}.evaluatorId`),
    result: value.result,
    satisfaction:
      value.satisfaction === null
        ? null
        : satisfaction(value.satisfaction, `${label}.satisfaction`),
    stateRef: nonEmptyString(value.stateRef, `${label}.stateRef`),
    evidenceRefs: stringArray(value.evidenceRefs, `${label}.evidenceRefs`),
    evaluatedAtTransition: nonnegativeInteger(
      value.evaluatedAtTransition,
      `${label}.evaluatedAtTransition`,
    ),
  };
}

function readPlanCursor(value: unknown, label: string): PlanCursor {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    ["pathRef", "nodeRef", "resultRef", "stepIndex"],
    [],
    label,
  );
  return {
    pathRef: nonEmptyString(value.pathRef, `${label}.pathRef`),
    nodeRef: nonEmptyString(value.nodeRef, `${label}.nodeRef`),
    resultRef: nonEmptyString(value.resultRef, `${label}.resultRef`),
    stepIndex: nonnegativeInteger(value.stepIndex, `${label}.stepIndex`),
  };
}

function readVerifiedCheckpoint(
  value: unknown,
  label: string,
): VerifiedCheckpoint {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    ["specRef", "planRef", "evaluation", "cursor", "verifiedAtTransition"],
    [],
    label,
  );
  const verifiedAtTransition = nonnegativeInteger(
    value.verifiedAtTransition,
    `${label}.verifiedAtTransition`,
  );
  const evaluation = readPlanningEvaluationRef(
    value.evaluation,
    `${label}.evaluation`,
  );
  if (evaluation.evaluatedAtTransition !== verifiedAtTransition) {
    throw new TypeError(`${label} verification transition disagrees with evaluation`);
  }
  if (
    evaluation.result !== "satisfied" ||
    evaluation.satisfaction === null
  ) {
    throw new TypeError(`${label} requires a satisfied numerical evaluation`);
  }
  return {
    specRef: nonEmptyString(value.specRef, `${label}.specRef`),
    planRef: nonEmptyString(value.planRef, `${label}.planRef`),
    evaluation,
    cursor: readPlanCursor(value.cursor, `${label}.cursor`),
    verifiedAtTransition,
  };
}

export function readFailurePrior<G, B, S, E, F, C>(
  value: unknown,
  guards: PlanningDomainGuards<G, B, S, E, F, C>,
  label = "failurePrior",
): FailurePrior<G, B, S, E> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    [
      "id",
      "rootRef",
      "obligationRef",
      "skillRef",
      "source",
      "scope",
      "preconditions",
      "conclusion",
      "invalidation",
    ],
    [],
    label,
  );
  if (!isRecord(value.source)) {
    throw new TypeError(`${label}.source must be an object`);
  }
  let source: FailurePriorSource;
  if (value.source.kind === "verified_failure") {
    assertExactKeys(
      value.source,
      ["kind", "dispatchId", "atomicResultRef", "errorRefs"],
      [],
      `${label}.source`,
    );
    source = {
      kind: "verified_failure",
      dispatchId: nonEmptyString(
        value.source.dispatchId,
        `${label}.source.dispatchId`,
      ),
      atomicResultRef: nonEmptyString(
        value.source.atomicResultRef,
        `${label}.source.atomicResultRef`,
      ),
      errorRefs: stringArray(value.source.errorRefs, `${label}.source.errorRefs`),
    };
  } else if (value.source.kind === "proven_unsatisfied") {
    assertExactKeys(
      value.source,
      ["kind", "evaluation"],
      [],
      `${label}.source`,
    );
    source = {
      kind: "proven_unsatisfied",
      evaluation: readPlanningEvaluationRef(
        value.source.evaluation,
        `${label}.source.evaluation`,
      ),
    };
    if (
      source.evaluation.result !== "unsatisfied" ||
      source.evaluation.satisfaction === null
    ) {
      throw new TypeError(
        `${label}.source proven_unsatisfied requires an unsatisfied numerical evaluation`,
      );
    }
  } else {
    throw new TypeError(`${label}.source.kind is invalid`);
  }
  if (!isRecord(value.scope)) {
    throw new TypeError(`${label}.scope must be an object`);
  }
  assertExactKeys(
    value.scope,
    ["bindings", "stateProjection", "evidenceProjection"],
    [],
    `${label}.scope`,
  );
  if (!isRecord(value.conclusion)) {
    throw new TypeError(`${label}.conclusion must be an object`);
  }
  assertExactKeys(
    value.conclusion,
    ["kind", "transitionRefs"],
    [],
    `${label}.conclusion`,
  );
  if (
    value.conclusion.kind !== "exclude_transition" &&
    value.conclusion.kind !== "deprioritize_transition"
  ) {
    throw new TypeError(`${label}.conclusion.kind is invalid`);
  }
  const transitionRefs = stringArray(
    value.conclusion.transitionRefs,
    `${label}.conclusion.transitionRefs`,
  );
  if (transitionRefs.length === 0) {
    throw new TypeError(`${label}.conclusion.transitionRefs must not be empty`);
  }
  return {
    id: nonEmptyString(value.id, `${label}.id`),
    rootRef: nonEmptyString(value.rootRef, `${label}.rootRef`),
    obligationRef: readObligationRef(
      value.obligationRef,
      `${label}.obligationRef`,
    ),
    skillRef: readVersionedRef(value.skillRef, `${label}.skillRef`),
    source,
    scope: {
      bindings: guards.bindings(value.scope.bindings),
      stateProjection: guards.stateProjection(value.scope.stateProjection),
      evidenceProjection: objectArray(
        value.scope.evidenceProjection,
        `${label}.scope.evidenceProjection`,
      ).map(entry => guards.evidenceProjection(entry)),
    },
    preconditions: readTypedConditions(
      value.preconditions,
      guards,
      `${label}.preconditions`,
    ),
    conclusion: {
      kind: value.conclusion.kind,
      transitionRefs,
    },
    invalidation: readTypedConditions(
      value.invalidation,
      guards,
      `${label}.invalidation`,
    ),
  };
}

function readRecoveryControl(
  value: unknown,
  label: string,
): PlanningRecoveryControl {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    ["phase", "recoveryRefs", "reasonRefs", "checkpointRef"],
    [],
    label,
  );
  const phases = new Set([
    "idle",
    "evaluate_actual",
    "check_alternatives",
    "replan",
    "checkpoint_recheck",
    "rolled_back",
    "blocked",
  ]);
  if (typeof value.phase !== "string" || !phases.has(value.phase)) {
    throw new TypeError(`${label}.phase is invalid`);
  }
  return {
    phase: value.phase as PlanningRecoveryControl["phase"],
    recoveryRefs: stringArray(value.recoveryRefs, `${label}.recoveryRefs`),
    reasonRefs: stringArray(value.reasonRefs, `${label}.reasonRefs`),
    checkpointRef: nullableString(value.checkpointRef, `${label}.checkpointRef`),
  };
}

function readPlanningUsage(value: unknown, label: string): PlanningUsage {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    ["predictionCallsUsed", "replansUsed", "rollbacksUsed"],
    [],
    label,
  );
  return {
    predictionCallsUsed: nonnegativeInteger(
      value.predictionCallsUsed,
      `${label}.predictionCallsUsed`,
    ),
    replansUsed: nonnegativeInteger(value.replansUsed, `${label}.replansUsed`),
    rollbacksUsed: nonnegativeInteger(
      value.rollbacksUsed,
      `${label}.rollbacksUsed`,
    ),
  };
}

export function readPlanControl<G, B, S, E, F, C>(
  value: unknown,
  guards: PlanningDomainGuards<G, B, S, E, F, C>,
  limits?: BoundedPlanningLimits,
  label = "planControl",
): PlanControl<G, B, S, E, F> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    [
      "plan",
      "currentPathRef",
      "alternatePathRefs",
      "cursor",
      "verifiedCheckpoints",
      "recovery",
      "failurePriors",
      "invalidationRefs",
      "usage",
    ],
    [],
    label,
  );
  const plan =
    value.plan === null
      ? null
      : readGoalGraphPlan(value.plan, guards, `${label}.plan`);
  const currentPathRef = nullableString(
    value.currentPathRef,
    `${label}.currentPathRef`,
  );
  const alternatePathRefs = stringArray(
    value.alternatePathRefs,
    `${label}.alternatePathRefs`,
  );
  const cursor =
    value.cursor === null
      ? null
      : readPlanCursor(value.cursor, `${label}.cursor`);
  const verifiedCheckpoints = objectArray(
    value.verifiedCheckpoints,
    `${label}.verifiedCheckpoints`,
  ).map((entry, index) =>
    readVerifiedCheckpoint(entry, `${label}.verifiedCheckpoints[${index}]`),
  );
  const recovery = readRecoveryControl(value.recovery, `${label}.recovery`);
  const failurePriors = objectArray(
    value.failurePriors,
    `${label}.failurePriors`,
  ).map((entry, index) =>
    readFailurePrior(entry, guards, `${label}.failurePriors[${index}]`),
  );
  const invalidationRefs = stringArray(
    value.invalidationRefs,
    `${label}.invalidationRefs`,
  );
  const usage = readPlanningUsage(value.usage, `${label}.usage`);
  if (plan === null) {
    if (
      currentPathRef !== null ||
      alternatePathRefs.length > 0 ||
      cursor !== null ||
      verifiedCheckpoints.length > 0
    ) {
      throw new TypeError(`${label} cannot retain path control without a plan`);
    }
  } else {
    const pathRefs = new Set(plan.paths.map(path => path.pathId));
    if (currentPathRef !== null && !pathRefs.has(currentPathRef)) {
      throw new TypeError(`${label}.currentPathRef is unknown`);
    }
    for (const pathRef of alternatePathRefs) {
      if (!pathRefs.has(pathRef) || pathRef === currentPathRef) {
        throw new TypeError(`${label}.alternatePathRefs has an invalid path`);
      }
    }
    if (cursor !== null) {
      const currentPath = plan.paths.find(path => path.pathId === cursor.pathRef);
      if (
        currentPath === undefined ||
        currentPath.pathId !== currentPathRef ||
        !currentPath.nodeRefs.includes(cursor.nodeRef)
      ) {
        throw new TypeError(`${label}.cursor disagrees with the current path`);
      }
      const node = plan.nodes.find(candidate => candidate.id === cursor.nodeRef);
      if (
        node === undefined ||
        !node.predictedResults.some(result => result.resultRef === cursor.resultRef)
      ) {
        throw new TypeError(`${label}.cursor has an unknown result`);
      }
    }
    const checkpointRefs = new Set(
      plan.checkpoints.map(checkpoint => checkpoint.id),
    );
    for (const checkpoint of verifiedCheckpoints) {
      const spec = plan.checkpoints.find(
        candidate => candidate.id === checkpoint.specRef,
      );
      const cursorPath = plan.paths.find(
        path => path.pathId === checkpoint.cursor.pathRef,
      );
      const cursorNode = plan.nodes.find(
        node => node.id === checkpoint.cursor.nodeRef,
      );
      if (
        spec === undefined ||
        !checkpointRefs.has(checkpoint.specRef) ||
        checkpoint.evaluation.evaluatorId !== spec.evaluatorId ||
        checkpoint.evaluation.satisfaction === null ||
        checkpoint.evaluation.satisfaction < spec.satisfactionThreshold ||
        (checkpoint.planRef === plan.planId && (cursorPath === undefined || cursorNode === undefined || !cursorPath.nodeRefs.includes(checkpoint.cursor.nodeRef) || !cursorNode.predictedResults.some(
          result => result.resultRef === checkpoint.cursor.resultRef,
        ))) ||
        !spec.evidenceRequirementRefs.every(evidenceRef =>
          checkpoint.evaluation.evidenceRefs.includes(evidenceRef),
        )
      ) {
        throw new TypeError(`${label}.verifiedCheckpoints has an invalid reference`);
      }
    }
    assertUnique(
      verifiedCheckpoints,
      checkpoint => checkpoint.specRef,
      `${label}.verifiedCheckpoints`,
    );
  }
  if (
    recovery.checkpointRef !== null &&
    (plan === null ||
      !plan.checkpoints.some(checkpoint => checkpoint.id === recovery.checkpointRef))
  ) {
    throw new TypeError(`${label}.recovery.checkpointRef is unknown`);
  }
  assertUnique(failurePriors, prior => prior.id, `${label}.failurePriors`);
  if (limits !== undefined) {
    if (plan !== null && plan.nodes.length > limits.maxPlanNodes) {
      throw new TypeError(`${label}.plan exceeds maxPlanNodes`);
    }
    if (usage.predictionCallsUsed > limits.maxPredictionCalls) {
      throw new TypeError(`${label}.usage exceeds maxPredictionCalls`);
    }
    if (usage.replansUsed > limits.maxReplans) {
      throw new TypeError(`${label}.usage exceeds maxReplans`);
    }
    if (usage.rollbacksUsed > limits.maxRollbacks) {
      throw new TypeError(`${label}.usage exceeds maxRollbacks`);
    }
  }
  return {
    plan,
    currentPathRef,
    alternatePathRefs,
    cursor,
    verifiedCheckpoints,
    recovery,
    failurePriors,
    invalidationRefs,
    usage,
  };
}

export function assertPlanningControlProgress(
  previous: PlanControl<unknown, unknown, unknown, unknown, unknown> | null,
  next: PlanControl<unknown, unknown, unknown, unknown, unknown>,
  label = "planControl",
): void {
  if (previous === null) return;
  if (next.usage.predictionCallsUsed < previous.usage.predictionCallsUsed) {
    throw new TypeError(`${label}.usage.predictionCallsUsed must not decrease`);
  }
  if (next.usage.replansUsed < previous.usage.replansUsed) {
    throw new TypeError(`${label}.usage.replansUsed must not decrease`);
  }
  if (next.usage.rollbacksUsed < previous.usage.rollbacksUsed) {
    throw new TypeError(`${label}.usage.rollbacksUsed must not decrease`);
  }
}

export function readPathPreferencePolicy(
  value: unknown,
  label = "preference",
): PathPreferencePolicy {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, ["kind", "projectionScaleRef"], [], label);
  if (
    value.kind !== "score_first" &&
    value.kind !== "order_first" &&
    value.kind !== "conservative" &&
    value.kind !== "aggressive"
  ) {
    throw new TypeError(`${label}.kind is invalid`);
  }
  return {
    kind: value.kind,
    projectionScaleRef: readVersionedRef(
      value.projectionScaleRef,
      `${label}.projectionScaleRef`,
    ),
  };
}

export function readBoundedPlanningLimits(
  value: unknown,
  label = "limits",
): BoundedPlanningLimits {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    [
      "maxPlanNodes",
      "maxPredictionCalls",
      "maxReplans",
      "maxRollbacks",
    ],
    [],
    label,
  );
  return {
    maxPlanNodes: positiveInteger(value.maxPlanNodes, `${label}.maxPlanNodes`),
    maxPredictionCalls: nonnegativeInteger(
      value.maxPredictionCalls,
      `${label}.maxPredictionCalls`,
    ),
    maxReplans: nonnegativeInteger(value.maxReplans, `${label}.maxReplans`),
    maxRollbacks: nonnegativeInteger(
      value.maxRollbacks,
      `${label}.maxRollbacks`,
    ),
  };
}

export function readBoundedPlanningOptions(
  value: unknown,
  label = "request.planning",
): BoundedPlanningOptions {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    [
      "kind",
      "capabilityRef",
      "horizonN",
      "resultModelRefs",
      "preference",
      "checkpointSpecs",
      "limits",
    ],
    [],
    label,
  );
  if (value.kind !== BOUNDED_GOAL_PLANNING_KIND) {
    throw new TypeError(`${label}.kind must be ${BOUNDED_GOAL_PLANNING_KIND}`);
  }
  const resultModelRefs = objectArray(
    value.resultModelRefs,
    `${label}.resultModelRefs`,
  ).map((entry, index) =>
    readVersionedRef(entry, `${label}.resultModelRefs[${index}]`),
  );
  assertUnique(
    resultModelRefs,
    model => `${model.id}\0${model.version}`,
    `${label}.resultModelRefs`,
  );
  return {
    kind: BOUNDED_GOAL_PLANNING_KIND,
    capabilityRef: readVersionedRef(
      value.capabilityRef,
      `${label}.capabilityRef`,
    ),
    horizonN: positiveInteger(value.horizonN, `${label}.horizonN`),
    resultModelRefs,
    preference: readPathPreferencePolicy(value.preference, `${label}.preference`),
    checkpointSpecs: objectArray(value.checkpointSpecs, `${label}.checkpointSpecs`),
    limits: readBoundedPlanningLimits(value.limits, `${label}.limits`),
  };
}

export function readBoundedPlanningRequest<G, B, S, E, F, C>(
  value: unknown,
  guards: PlanningDomainGuards<G, B, S, E, F, C>,
  label = "validated.planning",
): BoundedPlanningRequest<G, B> {
  const options = readBoundedPlanningOptions(value, label);
  const checkpointSpecs = options.checkpointSpecs.map((entry, index) =>
    readCheckpointSpec(entry, guards, `${label}.checkpointSpecs[${index}]`),
  );
  assertUnique(checkpointSpecs, checkpoint => checkpoint.id, `${label}.checkpointSpecs`);
  return {
    kind: options.kind,
    capabilityRef: options.capabilityRef,
    horizonN: options.horizonN,
    resultModelRefs: options.resultModelRefs,
    preference: options.preference,
    checkpointSpecs,
    limits: options.limits,
  };
}

export function readPredictionResult(
  value: unknown,
  label = "planning.prediction",
): PredictionResult {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  const frontier = (entry: unknown, field: string) =>
    objectArray(entry, `${label}.${field}`).map((item, index) =>
      readCoverageFrontier(item, `${label}.${field}[${index}]`),
    );
  switch (value.kind) {
    case "ready":
      assertExactKeys(
        value,
        [
          "transitionRef",
          "kind",
          "rootRef",
          "startStateRef",
          "planRef",
          "rankedPathRefs",
          "frontier",
          "predictionCallsUsed",
        ],
        [],
        label,
      );
      return {
        transitionRef: nonEmptyString(
          value.transitionRef,
          `${label}.transitionRef`,
        ),
        kind: "ready",
        rootRef: nonEmptyString(value.rootRef, `${label}.rootRef`),
        startStateRef: nonEmptyString(
          value.startStateRef,
          `${label}.startStateRef`,
        ),
        planRef: nonEmptyString(value.planRef, `${label}.planRef`),
        rankedPathRefs: stringArray(
          value.rankedPathRefs,
          `${label}.rankedPathRefs`,
        ),
        frontier: frontier(value.frontier, "frontier"),
        predictionCallsUsed: nonnegativeInteger(
          value.predictionCallsUsed,
          `${label}.predictionCallsUsed`,
        ),
      };
    case "deferred":
      assertExactKeys(
        value,
        [
          "kind",
          "rootRef",
          "startStateRef",
          "requirements",
          "frontier",
          "predictionCallsUsed",
        ],
        [],
        label,
      );
      return {
        kind: "deferred",
        rootRef: nonEmptyString(value.rootRef, `${label}.rootRef`),
        startStateRef: nonEmptyString(
          value.startStateRef,
          `${label}.startStateRef`,
        ),
        requirements: objectArray(
          value.requirements,
          `${label}.requirements`,
        ).map((entry, index) =>
          readEvidenceRequirement(entry, `${label}.requirements[${index}]`),
        ),
        frontier: frontier(value.frontier, "frontier"),
        predictionCallsUsed: nonnegativeInteger(
          value.predictionCallsUsed,
          `${label}.predictionCallsUsed`,
        ),
      };
    case "not_ready": {
      assertExactKeys(
        value,
        [
          "kind",
          "rootRef",
          "startStateRef",
          "reason",
          "frontier",
          "predictionCallsUsed",
        ],
        [],
        label,
      );
      const reasons = new Set([
        "missing_skill",
        "missing_model",
        "missing_evaluator",
        "invalid_contract",
        "horizon_exhausted",
      ]);
      if (typeof value.reason !== "string" || !reasons.has(value.reason)) {
        throw new TypeError(`${label}.reason is invalid`);
      }
      return {
        kind: "not_ready",
        rootRef: nonEmptyString(value.rootRef, `${label}.rootRef`),
        startStateRef: nonEmptyString(
          value.startStateRef,
          `${label}.startStateRef`,
        ),
        reason: value.reason as Extract<
          PredictionResult,
          { kind: "not_ready" }
        >["reason"],
        frontier: frontier(value.frontier, "frontier"),
        predictionCallsUsed: nonnegativeInteger(
          value.predictionCallsUsed,
          `${label}.predictionCallsUsed`,
        ),
      };
    }
    case "stopped": {
      assertExactKeys(
        value,
        [
          "kind",
          "rootRef",
          "startStateRef",
          "reason",
          "refs",
          "predictionCallsUsed",
        ],
        [],
        label,
      );
      const reasons = new Set([
        "root_satisfied",
        "unknown_or_mixed_effect",
        "permission_denied",
        "budget_exhausted",
        "cancelled",
        "unrecoverable_error",
      ]);
      if (typeof value.reason !== "string" || !reasons.has(value.reason)) {
        throw new TypeError(`${label}.reason is invalid`);
      }
      return {
        kind: "stopped",
        rootRef: nonEmptyString(value.rootRef, `${label}.rootRef`),
        startStateRef: nonEmptyString(
          value.startStateRef,
          `${label}.startStateRef`,
        ),
        reason: value.reason as Extract<
          PredictionResult,
          { kind: "stopped" }
        >["reason"],
        refs: stringArray(value.refs, `${label}.refs`),
        predictionCallsUsed: nonnegativeInteger(
          value.predictionCallsUsed,
          `${label}.predictionCallsUsed`,
        ),
      };
    }
    default:
      throw new TypeError(`${label}.kind is invalid`);
  }
}

export function readPlanningDecision(
  value: unknown,
  label = "planning.decision",
): PlanningDecision {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  switch (value.kind) {
    case "continue":
      assertExactKeys(value, ["kind", "pathRef", "nodeRef"], [], label);
      return {
        kind: "continue",
        pathRef: nonEmptyString(value.pathRef, `${label}.pathRef`),
        nodeRef: nonEmptyString(value.nodeRef, `${label}.nodeRef`),
      };
    case "switch":
      assertExactKeys(
        value,
        ["kind", "fromPathRef", "toPathRef", "entryNodeRef"],
        [],
        label,
      );
      return {
        kind: "switch",
        fromPathRef: nonEmptyString(value.fromPathRef, `${label}.fromPathRef`),
        toPathRef: nonEmptyString(value.toPathRef, `${label}.toPathRef`),
        entryNodeRef: nonEmptyString(value.entryNodeRef, `${label}.entryNodeRef`),
      };
    case "replan":
      assertExactKeys(
        value,
        ["kind", "frontierRefs", "triggerRefs"],
        [],
        label,
      );
      return {
        kind: "replan",
        frontierRefs: stringArray(value.frontierRefs, `${label}.frontierRefs`),
        triggerRefs: stringArray(value.triggerRefs, `${label}.triggerRefs`),
      };
    case "checkpoint_reached":
      assertExactKeys(value, ["kind", "checkpointRef"], [], label);
      return {
        kind: "checkpoint_reached",
        checkpointRef: nonEmptyString(
          value.checkpointRef,
          `${label}.checkpointRef`,
        ),
      };
    case "rollback":
      assertExactKeys(
        value,
        ["kind", "checkpointRef", "currentStateRef", "sourceErrorRefs"],
        [],
        label,
      );
      return {
        kind: "rollback",
        checkpointRef: nonEmptyString(
          value.checkpointRef,
          `${label}.checkpointRef`,
        ),
        currentStateRef: nonEmptyString(
          value.currentStateRef,
          `${label}.currentStateRef`,
        ),
        sourceErrorRefs: stringArray(
          value.sourceErrorRefs,
          `${label}.sourceErrorRefs`,
        ),
      };
    case "defer":
      assertExactKeys(value, ["kind", "requirements"], [], label);
      return {
        kind: "defer",
        requirements: objectArray(
          value.requirements,
          `${label}.requirements`,
        ).map((entry, index) =>
          readEvidenceRequirement(entry, `${label}.requirements[${index}]`),
        ),
      };
    case "stop": {
      assertExactKeys(value, ["kind", "reason", "refs"], [], label);
      const reasons = new Set([
        "unknown_or_mixed_effect",
        "permission_denied",
        "budget_exhausted",
        "cancelled",
        "unrecoverable_error",
      ]);
      if (typeof value.reason !== "string" || !reasons.has(value.reason)) {
        throw new TypeError(`${label}.reason is invalid`);
      }
      return {
        kind: "stop",
        reason: value.reason as Extract<PlanningDecision, { kind: "stop" }>["reason"],
        refs: stringArray(value.refs, `${label}.refs`),
      };
    }
    case "root_satisfied":
      assertExactKeys(value, ["kind", "evaluationStateRef"], [], label);
      return {
        kind: "root_satisfied",
        evaluationStateRef: nonEmptyString(
          value.evaluationStateRef,
          `${label}.evaluationStateRef`,
        ),
      };
    default:
      throw new TypeError(`${label}.kind is invalid`);
  }
}

export function readPlanningReport(
  value: unknown,
  label = "report.planning",
): PlanningReport {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    ["kind", "prediction", "decision", "priorAssessments"],
    ["recoveredFailureRefs"],
    label,
  );
  if (value.kind !== PLANNING_REPORT_KIND) {
    throw new TypeError(`${label}.kind must be ${PLANNING_REPORT_KIND}`);
  }
  const decision =
    value.decision === null
      ? null
      : readPlanningDecision(value.decision, `${label}.decision`);
  const priorAssessments = objectArray(
    value.priorAssessments,
    `${label}.priorAssessments`,
  ).map((entry, index) => {
    const itemLabel = `${label}.priorAssessments[${index}]`;
    if (!isRecord(entry)) throw new TypeError(`${itemLabel} must be an object`);
    assertExactKeys(entry, ["priorRef", "applicability"], [], itemLabel);
    return {
      priorRef: nonEmptyString(entry.priorRef, `${itemLabel}.priorRef`),
      applicability: readApplicability(
        entry.applicability,
        `${itemLabel}.applicability`,
      ),
    };
  });
  assertUnique(priorAssessments, assessment => assessment.priorRef, `${label}.priorAssessments`);
  return {
    ...(Object.hasOwn(value,"recoveredFailureRefs") ? {recoveredFailureRefs:stringArray(value.recoveredFailureRefs,`${label}.recoveredFailureRefs`)} : {}),
    kind: PLANNING_REPORT_KIND,
    prediction: readPredictionResult(
      value.prediction,
      `${label}.prediction`,
    ),
    decision,
    priorAssessments,
  };
}

export function readPlanningSelectionView(
  value: unknown,
  label = "selection.planning",
): PlanningSelectionView {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    [
      "planRef",
      "pathRef",
      "cursorRef",
      "expectedSkillRef",
      "allowedEntrySkillRefs",
    ],
    [],
    label,
  );
  const allowedEntrySkillRefs = objectArray(
    value.allowedEntrySkillRefs,
    `${label}.allowedEntrySkillRefs`,
  ).map((entry, index) =>
    readVersionedRef(entry, `${label}.allowedEntrySkillRefs[${index}]`),
  );
  assertUnique(
    allowedEntrySkillRefs,
    skill => `${skill.id}\0${skill.version}`,
    `${label}.allowedEntrySkillRefs`,
  );
  return {
    planRef: nonEmptyString(value.planRef, `${label}.planRef`),
    pathRef: nonEmptyString(value.pathRef, `${label}.pathRef`),
    cursorRef: nonEmptyString(value.cursorRef, `${label}.cursorRef`),
    expectedSkillRef:
      value.expectedSkillRef === null
        ? null
        : readVersionedRef(value.expectedSkillRef, `${label}.expectedSkillRef`),
    allowedEntrySkillRefs,
  };
}

export function readPlanningContractRefs(
  value: unknown,
  label = "planningContract",
): PlanningContractRefs {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    [
      "capabilityRef",
      "resultModelRefs",
      "preference",
      "checkpointSpecRefs",
      "horizonN",
      "limits",
    ],
    ["decisionRef"],
    label,
  );
  const resultModelRefs = objectArray(
    value.resultModelRefs,
    `${label}.resultModelRefs`,
  ).map((entry, index) =>
    readVersionedRef(entry, `${label}.resultModelRefs[${index}]`),
  );
  assertUnique(
    resultModelRefs,
    model => `${model.id}\0${model.version}`,
    `${label}.resultModelRefs`,
  );
  return {
    ...(Object.hasOwn(value,"decisionRef") ? {decisionRef:readVersionedRef(value.decisionRef,`${label}.decisionRef`)} : {}),
    capabilityRef: readVersionedRef(
      value.capabilityRef,
      `${label}.capabilityRef`,
    ),
    resultModelRefs,
    preference: readPathPreferencePolicy(value.preference, `${label}.preference`),
    checkpointSpecRefs: stringArray(
      value.checkpointSpecRefs,
      `${label}.checkpointSpecRefs`,
    ),
    horizonN: positiveInteger(value.horizonN, `${label}.horizonN`),
    limits: readBoundedPlanningLimits(value.limits, `${label}.limits`),
  };
}

export function readPlanningActionBoundary(
  value: unknown,
  label = "actionBoundary",
): PlanningActionBoundary {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    [
      "kind",
      "dispatchId",
      "frameId",
      "atomicResultRef",
      "observedStateRef",
      "nextPhase",
    ],
    [],
    label,
  );
  if (value.kind !== PLANNING_ACTION_BOUNDARY_KIND) {
    throw new TypeError(`${label}.kind must be ${PLANNING_ACTION_BOUNDARY_KIND}`);
  }
  const phases = new Set([
    "evaluate_actual",
    "verify_checkpoint",
    "recover",
    "select",
  ]);
  if (typeof value.nextPhase !== "string" || !phases.has(value.nextPhase)) {
    throw new TypeError(`${label}.nextPhase is invalid`);
  }
  return {
    kind: PLANNING_ACTION_BOUNDARY_KIND,
    dispatchId: nonEmptyString(value.dispatchId, `${label}.dispatchId`),
    frameId: nonEmptyString(value.frameId, `${label}.frameId`),
    atomicResultRef: nonEmptyString(
      value.atomicResultRef,
      `${label}.atomicResultRef`,
    ),
    observedStateRef: nullableString(
      value.observedStateRef,
      `${label}.observedStateRef`,
    ),
    nextPhase: value.nextPhase as PlanningActionBoundary["nextPhase"],
  };
}
