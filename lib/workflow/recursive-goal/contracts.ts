import {
  assertPlanningControlProgress,
  readBoundedPlanningOptions,
  readBoundedPlanningRequest,
  readPlanControl,
  readPlanningActionBoundary,
  readPlanningContractRefs,
  readPlanningReport,
  readPlanningSelectionView,
  sameVersionedRef,
  type BoundedPlanningCapability,
  type BoundedPlanningOptions,
  type BoundedPlanningRequest,
  type PlanControl,
  type PlanningActionBoundary,
  type PlanningContractRefs,
  type PlanningReport,
  type PlanningSelectionView,
} from "./planning-contracts.js";

export * from "./planning-contracts.js";

export const RECURSIVE_GOAL_REQUEST_SCHEMA = "nnanything.recursive-goal.request.v1" as const;
export const RECURSIVE_GOAL_CONTINUATION_SCHEMA =
  "nnanything.recursive-goal.continuation.v1" as const;
export const RECURSIVE_GOAL_PLANNING_CONTINUATION_SCHEMA =
  "nnanything.recursive-goal.continuation.v2" as const;

export type RecursiveGoalMode = "atomic" | "composite";
export type RecursiveGoalFact =
  | "not_evaluated"
  | "satisfied"
  | "unsatisfied"
  | "unknown"
  | "not_applicable";
export type RecursiveGoalEvaluationResult = "satisfied" | "unsatisfied" | "unknown";
export type RecursiveGoalExecution =
  | "not_started"
  | "dispatched"
  | "completed"
  | "failed"
  | "cancelled";
export type RecursiveGoalUnexecutedReason = "dependency_not_met" | "budget" | "cancel" | null;
export type EffectKnowledge = "none" | "known" | "unknown" | "mixed";
export type RecursiveGoalDispatchState = "not_dispatched" | "in_flight" | "returned";
export type RecursiveGoalExecutorInvoked = boolean | "unknown";
export type RecursiveGoalAtomicOutcome = "succeeded" | "failed" | "rejected" | "unknown";
export type RecursiveGoalControlOutcome =
  | "completed"
  | "error"
  | "stalled"
  | "exceeded"
  | "cancelled"
  | "yielded";
export type RecursiveGoalStopReason =
  | "root_evaluation"
  | "fatal_error"
  | "no_progress"
  | "budget"
  | "cancel"
  | "no_remaining_work"
  | "step_boundary";
export type RecursiveGoalErrorCode =
  | "invalid_request"
  | "invalid_binding"
  | "capability_missing"
  | "policy_deferred"
  | "precondition_unsatisfied"
  | "evidence_unavailable"
  | "evidence_conflict"
  | "policy_error"
  | "effect_denied"
  | "execution_failed"
  | "effect_outcome_unknown"
  | "derivation_cycle"
  | "no_progress"
  | "budget_exceeded"
  | "cancelled"
  | "adapter_contract_invalid"
  | "workflow_failure";
export type RecursiveGoalErrorStage =
  | "admission"
  | "binding"
  | "evaluation"
  | "selection"
  | "derivation"
  | "dispatch"
  | "execution"
  | "observation"
  | "effect"
  | "aggregation"
  | "cleanup"
  | "collection"
  | "finalization";

export interface RecursiveGoalLimits {
  readonly maxTransitions?: number;
  readonly maxDepth?: number;
  readonly maxDerivedGoals?: number;
}

export interface BoundedRetryPolicy {
  readonly kind: "bounded_strategy_retry.v1";
  readonly selectorId: string;
  readonly strategySkillIds: readonly string[];
  /** Includes the first attempt and every completed safe same-failure retry. */
  readonly sameFailureLimit: number;
  readonly maxAtomicAttempts?: number;
}

export interface RecursiveGoalInvocationControl {
  readonly maxAtomicDispatches: 1;
}

export interface RetryFailureCount {
  readonly failureKey: string;
  readonly count: number;
}

export interface StrategyRetryState {
  readonly skillId: string;
  readonly failures: readonly RetryFailureCount[];
  readonly exhausted: boolean;
  readonly latestAttemptRef: string | null;
}

export interface FrameStrategyRetryState {
  readonly frameId: string;
  readonly lockedSkillId: string | null;
  readonly strategies: readonly StrategyRetryState[];
  readonly lastAccountedDispatchId: string | null;
}

export interface RecursiveGoalRetryControl {
  readonly policy: BoundedRetryPolicy;
  readonly atomicAttemptsUsed: number;
  readonly frames: readonly FrameStrategyRetryState[];
}

export interface RetrySelectionView {
  readonly eligibleSkillIds: readonly string[];
  readonly lockedSkillId: string | null;
  readonly exhaustedSkillIds: readonly string[];
  readonly remainingAtomicAttempts: number | null;
}

export interface BudgetUsed {
  readonly transitionsUsed: number;
  readonly derivedGoalsUsed: number;
}

export interface RecursiveGoalRequestEnvelope {
  readonly schema: typeof RECURSIVE_GOAL_REQUEST_SCHEMA;
  readonly requestId: string;
  readonly rootGoal: unknown;
  readonly satisfactionThreshold: number;
  readonly rootBindings: unknown;
  readonly state: unknown;
  readonly rootEvaluatorId: string;
  readonly rootSelectorId: string;
  readonly limits?: RecursiveGoalLimits;
  readonly initialObservation?: RecursiveGoalInitialObservation<unknown>;
  readonly continuation?: unknown;
  readonly retryPolicy?: BoundedRetryPolicy;
  readonly invocation?: RecursiveGoalInvocationControl;
  readonly planning?: BoundedPlanningOptions;
}

export interface StateRecord<S> {
  readonly id: string;
  readonly value: S;
}

export interface EvidenceRecord<E> {
  readonly id: string;
  readonly stateRef: string;
  readonly payload: E;
  readonly validity: "valid" | "stale" | "conflicted";
}

export interface RecursiveGoalInitialObservation<E> {
  readonly stateId: string;
  readonly evidence: readonly EvidenceRecord<E>[];
}

export interface EvaluationReceipt {
  readonly evaluatorId: string;
  readonly result: RecursiveGoalEvaluationResult;
  readonly satisfaction: number | null;
  readonly necessaryConditionsMet: boolean;
  readonly evidenceRefs: readonly string[];
}

export interface ProgressReceipt {
  readonly improved: boolean;
  readonly reason: "obligation_reduced" | "facts_improved" | "none";
  readonly comparable: boolean;
}

export interface EnabledSkill {
  readonly id: string;
  readonly version: string;
  readonly mode: RecursiveGoalMode;
  readonly capability: string;
  readonly evaluatorId: string;
  readonly requiredEffects: readonly string[];
  readonly allowedEffects: readonly string[];
  readonly retry: "never" | "completed_no_effect";
  /**
   * `read_only` and `none` are the only classes a recovery request may dispatch
   * before an unknown or mixed effect is clarified.
   */
  readonly effectClass: "none" | "read_only" | "mutating";
}

export interface EnabledEvaluator {
  readonly id: string;
  readonly goalType: string;
  readonly thresholdContract: "0..100";
  readonly allowsPartialSatisfaction: boolean;
}

export interface SelectorBinding {
  readonly id: string;
  readonly skillIds: readonly string[];
}

export interface FactSnapshot<S, E> {
  readonly state: S;
  readonly evidence: readonly EvidenceRecord<E>[];
  readonly conditions: readonly ConditionFact[];
}

export interface RecursiveGoalComparators<G, B, S, E> {
  /** Pure structural comparison. Implementations must not observe or execute. */
  sameGoal(left: G, right: G): boolean;
  /** Pure structural comparison. Implementations must not observe or execute. */
  sameBindings(left: B, right: B): boolean;
  /** Pure comparison of current facts, evidence, and condition facts. */
  sameFacts(left: FactSnapshot<S, E>, right: FactSnapshot<S, E>): boolean;
}

export interface ConditionFact {
  readonly conditionId: string;
  readonly fact: RecursiveGoalFact;
  readonly satisfaction: number | null;
  readonly evaluatorId: string | null;
  readonly evidenceRefs: readonly string[];
  readonly childFrameId: string | null;
}

export interface IntermediateCondition<G, B> {
  readonly id: string;
  readonly goal: G;
  readonly bindings: B;
  readonly satisfactionThreshold: number;
  readonly evaluatorId: string;
  readonly selectorId: string;
  readonly mode: RecursiveGoalMode;
  readonly dependsOn: readonly string[];
  readonly lifetime: "stage" | "persistent";
  readonly activation: "required" | "not_applicable";
  readonly allowedEffects: readonly string[];
}

/**
 * Stable name for a condition emitted by one finite composite derivation batch.
 */
export type DerivedCondition<G, B> = IntermediateCondition<G, B>;

export interface DerivationReceipt<G, B, C> {
  readonly conditions: readonly DerivedCondition<G, B>[];
  readonly nextCursor: C;
  readonly expansion: "more" | "closed";
}

export interface RecursiveGoalFrameEvaluation {
  readonly receipt: EvaluationReceipt;
  readonly evaluatedAtTransition: number;
}

export interface RecursiveGoalProgressBaseline {
  readonly stateRef: string;
  readonly evaluation: EvaluationReceipt;
  readonly capturedAtTransition: number;
}

export interface RecursiveGoalPendingVerification {
  readonly dispatchId: string;
  readonly skillId: string;
  readonly verificationErrorIds: readonly string[];
}

export interface RecursiveGoalObligationSnapshot {
  readonly mode: RecursiveGoalMode;
  readonly selectedSkillId: string | null;
  readonly unresolvedConditionIds: readonly string[];
  readonly stateRef: string;
  readonly evidenceRefs: readonly string[];
  readonly conditions: readonly ConditionFact[];
}

export type Selection =
  | {
      readonly kind: "selected";
      readonly skillId: string;
    }
  | {
      readonly kind: "no_capability";
      readonly searchedSkillIds: readonly string[];
    }
  | {
      readonly kind: "defer";
      readonly reason: string;
    };

export interface AdapterCallbackContext {
  readonly requestId: string;
  readonly frameId: string;
  readonly signal: AbortSignal | null;
}

export interface SupportsInput<G, B> {
  readonly goal: G;
  readonly bindings: B;
  readonly skill: EnabledSkill;
}

export interface EvaluationInput<G, S, B, E> {
  readonly context: AdapterCallbackContext;
  readonly goal: G;
  readonly satisfactionThreshold: number;
  readonly bindings: B;
  readonly state: S;
  readonly evidence: readonly EvidenceRecord<E>[];
  readonly conditions: readonly ConditionFact[];
}

export interface SelectionInput<G, S, B, E> {
  readonly context: AdapterCallbackContext;
  readonly selectorId: string;
  readonly goal: G;
  readonly satisfactionThreshold: number;
  readonly bindings: B;
  readonly state: S;
  readonly evidence: readonly EvidenceRecord<E>[];
  readonly conditions: readonly ConditionFact[];
  readonly previousEvaluation: EvaluationReceipt | null;
  readonly candidates: readonly EnabledSkill[];
  readonly retry?: RetrySelectionView;
  readonly planning?: PlanningSelectionView;
}

export interface DerivationInput<G, S, B, E, C> {
  readonly context: AdapterCallbackContext;
  readonly skill: EnabledSkill;
  readonly cursor: C | null;
  readonly goal: G;
  readonly satisfactionThreshold: number;
  readonly bindings: B;
  readonly state: S;
  readonly evidence: readonly EvidenceRecord<E>[];
  readonly conditions: readonly ConditionFact[];
}

export interface AtomicInput<G, S, B, E> {
  readonly context: AdapterCallbackContext;
  readonly skill: EnabledSkill;
  readonly goal: G;
  readonly satisfactionThreshold: number;
  readonly bindings: B;
  readonly state: S;
  readonly evidence: readonly EvidenceRecord<E>[];
  readonly retry?: RetrySelectionView;
}

export interface DomainReceipt<R> {
  readonly tag: string;
  readonly value: R;
}

export interface CapturedWorkflowFailure {
  readonly category: string;
  readonly message: string;
  readonly nodeId?: string;
}

export interface AdapterDiagnostic {
  readonly diagnosticId: string;
  readonly code: RecursiveGoalErrorCode;
  readonly stage: RecursiveGoalErrorStage;
  readonly sourceCategory: string | null;
  readonly message: string;
  readonly nativeCode: string | null;
  readonly refs: readonly string[];
}

export interface AtomicEffectReceipt<F> {
  readonly knowledge: EffectKnowledge;
  readonly confirmedEffects: readonly F[];
  readonly receiptRef: string | null;
}

export interface AtomicReceipt<S, E, F, R> {
  readonly runId: string | null;
  readonly executorInvoked: RecursiveGoalExecutorInvoked;
  readonly outcome: RecursiveGoalAtomicOutcome;
  readonly sourceResult: DomainReceipt<R> | CapturedWorkflowFailure | null;
  readonly newState: StateRecord<S> | null;
  readonly evidence: readonly EvidenceRecord<E>[];
  readonly executionErrors: readonly AdapterDiagnostic[];
  readonly verificationErrors: readonly AdapterDiagnostic[];
  readonly effect: AtomicEffectReceipt<F>;
}

export interface ReceiptRef {
  readonly receiptId: string;
}

export interface CleanupInput<G, S, B, E, F, R> {
  readonly context: AdapterCallbackContext;
  readonly root: AcceptedRoot<G, B>;
  readonly states: readonly StateRecord<S>[];
  readonly evidence: readonly EvidenceRecord<E>[];
  readonly effects: readonly EffectRecord<F>[];
  readonly atomicResults: readonly AtomicExecutionResult<F, R>[];
}

export interface CollectionInput<G, S, B, E, F, R> {
  readonly context: AdapterCallbackContext;
  readonly root: AcceptedRoot<G, B>;
  readonly states: readonly StateRecord<S>[];
  readonly evidence: readonly EvidenceRecord<E>[];
  readonly effects: readonly EffectRecord<F>[];
  readonly atomicResults: readonly AtomicExecutionResult<F, R>[];
}

export interface ValidatedRequest<G, S, B, E, F, R, C> {
  readonly requestId: string;
  readonly rootGoal: G;
  readonly satisfactionThreshold: number;
  readonly rootBindings: B;
  readonly state: S;
  readonly rootEvaluatorId: string;
  readonly rootSelectorId: string;
  readonly limits?: RecursiveGoalLimits;
  readonly initialObservation?: RecursiveGoalInitialObservation<E>;
  readonly continuation: RecursiveGoalResumableContinuation<
    G,
    S,
    B,
    E,
    F,
    R,
    C
  > | null;
  readonly retryPolicy?: BoundedRetryPolicy;
  readonly planning?: BoundedPlanningRequest<G, B>;
}

export type RetryAssessment =
  | {
      readonly kind: "safe_same_failure";
      readonly failureKey: string;
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly kind: "stop";
      readonly reason:
        | "unsupported_retry"
        | "evidence_insufficient"
        | "effects_not_none"
        | "precondition_changed";
    };

export interface RetryAssessmentInput<G, S, B, E, F, R> {
  readonly goal: G;
  readonly bindings: B;
  readonly skill: EnabledSkill;
  readonly atomicResult: AtomicExecutionResult<F, R>;
  readonly evaluation: EvaluationReceipt;
  readonly state: S;
  readonly evidence: readonly EvidenceRecord<E>[];
}

export interface RecursiveGoalAdapter<G, S, B, E, F, R, C> {
  /** Validates domain Goal/State/bindings and any continuation payload. */
  validateRequest(
    request: RecursiveGoalRequestEnvelope,
  ): Promise<ValidatedRequest<G, S, B, E, F, R, C>>;
  /** Pure coverage check for one enabled skill. It must not select or execute. */
  supports(input: SupportsInput<G, B>): boolean;
  /** Pure evaluation of observed facts. It must not observe or execute. */
  evaluate(input: EvaluationInput<G, S, B, E>): Promise<EvaluationReceipt>;
  /** Selects one current skill. It must not derive children or execute them. */
  select(input: SelectionInput<G, S, B, E>): Promise<Selection>;
  /** Emits one finite condition batch. It must not execute child work. */
  derive(input: DerivationInput<G, S, B, E, C>): Promise<DerivationReceipt<G, B, C>>;
  /** Executes exactly one atomic current step. It must not recurse or aggregate. */
  executeAtomic(input: AtomicInput<G, S, B, E>): Promise<unknown>;
  /** Applies the application-owned domain receipt guard and tag. */
  validateAtomicReceipt(raw: unknown): AtomicReceipt<S, E, F, R>;
  /** Pure retry classification for a committed, evaluated atomic attempt. */
  assessRetry?(
    input: RetryAssessmentInput<G, S, B, E, F, R>,
  ): RetryAssessment | Promise<RetryAssessment>;
  /** Pure progress comparison over observed evaluations. */
  measureProgress(input: {
    readonly goal: G;
    readonly before: S;
    readonly after: S;
    readonly previousEvaluation: EvaluationReceipt;
    readonly currentEvaluation: EvaluationReceipt;
  }): ProgressReceipt;
  cleanup?(input: CleanupInput<G, S, B, E, F, R>): Promise<ReceiptRef>;
  collect?(input: CollectionInput<G, S, B, E, F, R>): Promise<ReceiptRef>;
}

export interface RecursiveGoalDependencies<G, S, B, E, F, R, C> {
  readonly adapter: RecursiveGoalAdapter<G, S, B, E, F, R, C>;
  readonly enabledSkills: readonly EnabledSkill[];
  readonly enabledEvaluators: readonly EnabledEvaluator[];
  readonly selectors: readonly SelectorBinding[];
  readonly comparators: RecursiveGoalComparators<G, B, S, E>;
  readonly grantedEffects: ReadonlySet<string>;
  readonly planning?: BoundedPlanningCapability<G, B, S, E, F, C>;
  readonly signal?: AbortSignal;
}

export interface AcceptedRoot<G, B> {
  readonly requestId: string;
  readonly rootFrameId: string;
  readonly rootGoal: G;
  readonly rootThreshold: number;
  readonly rootBindings: B;
}

export type RootEvaluation =
  | {
      readonly state: "not_evaluated";
      readonly reason:
        | "not_reached"
        | "no_evaluator"
        | "binding_error"
        | "runner_fault";
      readonly blockedByErrorId: string | null;
    }
  | {
      readonly state: "evaluated";
      readonly result: RecursiveGoalEvaluationResult;
      readonly satisfaction: number | null;
      readonly evaluatorId: string;
      readonly evidenceRefs: readonly string[];
      readonly evaluatedAtTransition: number;
    };

export interface RecursiveGoalControl {
  readonly outcome: RecursiveGoalControlOutcome;
  readonly stopReason: RecursiveGoalStopReason;
  readonly frameId: string | null;
  /** Typed budget stop evidence attached only by the budget check points. */
  readonly budget?: RecursiveGoalBudgetReport;
}

export type RecursiveGoalBudgetDimension =
  | "maxTransitions"
  | "maxDepth"
  | "maxDerivedGoals"
  | "maxAtomicAttempts";

export interface RecursiveGoalBudgetReport {
  readonly dimension: RecursiveGoalBudgetDimension | readonly RecursiveGoalBudgetDimension[];
  readonly limit: number | readonly number[];
  readonly used: number | readonly number[];
  readonly attempted: number | readonly number[] | null;
}

export interface FrameResult<G, B, C> {
  readonly frameId: string;
  readonly rootRef: string;
  readonly parentFrameId: string | null;
  readonly fulfillsConditionId: string | null;
  readonly goal: G;
  readonly bindings: B;
  readonly mode: RecursiveGoalMode;
  readonly depth: number;
  readonly selectedSkillId: string | null;
  readonly cursor: C | null;
  readonly conditionResults: readonly ConditionFact[];
  readonly activeRequirements: readonly string[];
  readonly unresolvedRequirements: readonly string[];
  readonly fact: RecursiveGoalFact;
  readonly execution: RecursiveGoalExecution;
  readonly unexecutedReason: RecursiveGoalUnexecutedReason;
  readonly errorId: string | null;
  readonly evidenceRefs: readonly string[];
  readonly dispatchRefs: readonly string[];
  readonly atomicResultRefs: readonly string[];
  readonly noProgressCount: number;
}

export interface EffectRecord<F> {
  readonly dispatchId: string;
  readonly frameId: string;
  readonly skillId: string;
  readonly dispatchState: RecursiveGoalDispatchState;
  readonly knowledge: EffectKnowledge;
  readonly confirmedEffects: readonly F[];
  readonly receiptRef: string | null;
}

export interface AtomicExecutionResult<F, R> {
  readonly dispatchId: string;
  readonly frameId: string;
  readonly skillId: string;
  readonly runId: string | null;
  readonly executorInvoked: RecursiveGoalExecutorInvoked;
  readonly outcome: RecursiveGoalAtomicOutcome;
  readonly sourceResult: DomainReceipt<R> | CapturedWorkflowFailure | null;
  readonly executionErrorIds: readonly string[];
  readonly verificationErrorIds: readonly string[];
  readonly effect: EffectRecord<F>;
  readonly observedStateRef: string | null;
}

export interface ErrorOrigin {
  readonly frameId: string | null;
  readonly skillId: string | null;
  readonly conditionId: string | null;
  readonly evaluatorId: string | null;
  readonly nodeId: string | null;
}

export interface ErrorSource {
  readonly owner: "module" | "adapter" | "workflow";
  readonly category: string | null;
  readonly nativeCode: string | null;
  readonly refs: readonly string[];
}

export type ErrorCause =
  | {
      readonly kind: "captured_error";
      readonly name: string;
      readonly message: string;
      readonly nativeCode: string | null;
    }
  | {
      readonly kind: "error_ref";
      readonly errorId: string;
    };

export interface ErrorPropagation {
  readonly frameId: string;
  readonly parentFrameId: string | null;
  readonly satisfies: {
    readonly frameId: string;
    readonly conditionId: string;
  } | null;
}

export interface RecursiveGoalErrorDiagnostic {
  readonly errorId: string;
  readonly code: RecursiveGoalErrorCode;
  readonly stage: RecursiveGoalErrorStage;
  readonly origin: ErrorOrigin;
  readonly source: ErrorSource;
  readonly effectKnowledge: EffectKnowledge;
  readonly atomicResultRefs: readonly string[];
  readonly cause: ErrorCause | null;
  readonly propagation: readonly ErrorPropagation[];
  readonly diagnosticMessage: string;
}

export interface RelatedIssue {
  readonly errorId: string;
  readonly relation: "cleanup" | "collection" | "secondary";
  readonly affectsCompletion: boolean;
}

export interface RecursiveGoalFrameStackEntry<C> {
  readonly frameId: string;
  readonly parentFrameId: string | null;
  readonly fulfillsConditionId: string | null;
  readonly phase: "evaluate" | "select" | "derive" | "await_children" | "aggregate";
  readonly cursor: C | null;
}

export interface DependencyState<G, B> {
  readonly ownerFrameId: string;
  /** Original finite derivation definition; recovery must not re-derive it. */
  readonly condition: DerivedCondition<G, B>;
  readonly fact: RecursiveGoalFact;
  readonly execution: RecursiveGoalExecution;
  readonly childFrameId: string | null;
}

export interface RecursiveGoalFrameControl<G, B> {
  readonly frameId: string;
  readonly satisfactionThreshold: number;
  readonly evaluatorId: string;
  readonly selectorId: string;
  readonly effectScope: readonly string[];
  /** Persisted finite expansion position for recovery without replaying derive. */
  readonly expansion: "not_derived" | "more" | "closed";
  readonly evaluation: RecursiveGoalFrameEvaluation | null;
  readonly progressBaseline: RecursiveGoalProgressBaseline | null;
  /** Previous complete composite cycle state used by no-progress detection. */
  readonly compositeCycleBaseline: RecursiveGoalProgressBaseline | null;
  readonly pendingVerification: RecursiveGoalPendingVerification | null;
  /** Facts used to compare this frame with the current ancestor path. */
  readonly obligationSnapshot: RecursiveGoalObligationSnapshot | null;
}

export interface RemainingRequirement {
  readonly frameId: string;
  readonly conditionId: string;
}

export interface RecursiveGoalRunReport<G, S, B, E, F, R, C> {
  readonly root: AcceptedRoot<G, B>;
  readonly rootEvaluation: RootEvaluation;
  readonly control: RecursiveGoalControl;
  readonly states: readonly StateRecord<S>[];
  readonly evidence: readonly EvidenceRecord<E>[];
  readonly frames: readonly FrameResult<G, B, C>[];
  readonly effects: readonly EffectRecord<F>[];
  readonly atomicResults: readonly AtomicExecutionResult<F, R>[];
  readonly errors: readonly RecursiveGoalErrorDiagnostic[];
  readonly primaryErrorId: string | null;
  readonly relatedIssues: readonly RelatedIssue[];
  readonly budgetUsed: BudgetUsed;
  readonly continuation: RecursiveGoalResumableContinuation<
    G,
    S,
    B,
    E,
    F,
    R,
    C
  > | null;
  readonly planning?: PlanningReport;
  readonly cleanup: ReceiptRef | null;
  readonly collection: ReceiptRef | null;
}

export interface RecursiveGoalPartialRunReport<G, S, B, E, F, R, C> {
  readonly lastTrustedTransition: number;
  readonly rootEvaluation: RootEvaluation | null;
  readonly control: RecursiveGoalControl | null;
  readonly states: readonly StateRecord<S>[];
  readonly evidence: readonly EvidenceRecord<E>[];
  readonly frames: readonly FrameResult<G, B, C>[];
  readonly effects: readonly EffectRecord<F>[];
  readonly atomicResults: readonly AtomicExecutionResult<F, R>[];
  readonly errors: readonly RecursiveGoalErrorDiagnostic[];
  readonly primaryErrorId: string | null;
  readonly relatedIssues: readonly RelatedIssue[];
  readonly budgetUsed: BudgetUsed;
  readonly continuation: RecursiveGoalResumableContinuation<
    G,
    S,
    B,
    E,
    F,
    R,
    C
  > | null;
  readonly planning?: PlanningReport;
  readonly unavailableSections: readonly string[];
}

export interface RecursiveGoalKnownBoundary {
  readonly evidence: "none" | "partial" | "retained";
  readonly effects: "none" | "known" | "unknown" | "mixed";
}

export interface RecursiveGoalContinuation<G, S, B, E, F, R, C> {
  readonly schema: typeof RECURSIVE_GOAL_CONTINUATION_SCHEMA;
  readonly acceptedRoot: AcceptedRoot<G, B>;
  readonly lastTrustedTransition: number;
  readonly rootEvaluation: RootEvaluation;
  readonly control: RecursiveGoalControl;
  readonly frames: readonly FrameResult<G, B, C>[];
  readonly frameControls: readonly RecursiveGoalFrameControl<G, B>[];
  readonly stack: readonly RecursiveGoalFrameStackEntry<C>[];
  readonly dependencies: readonly DependencyState<G, B>[];
  readonly states: readonly StateRecord<S>[];
  readonly evidence: readonly EvidenceRecord<E>[];
  readonly ledger: readonly EffectRecord<F>[];
  readonly atomicResults: readonly AtomicExecutionResult<F, R>[];
  readonly errors: readonly RecursiveGoalErrorDiagnostic[];
  readonly primaryErrorId: string | null;
  readonly relatedIssues: readonly RelatedIssue[];
  readonly budgetUsed: BudgetUsed;
  readonly remainingRequirements: readonly RemainingRequirement[];
  readonly contractRefs: {
    readonly enabledSkillIds: readonly string[];
    readonly evaluatorIds: readonly string[];
    readonly selectorIds: readonly string[];
    readonly grantedEffects: readonly string[];
  };
  readonly retryControl?: RecursiveGoalRetryControl;
}

export interface RecursiveGoalPlanningContinuation<G, S, B, E, F, R, C>
  extends Omit<
    RecursiveGoalContinuation<G, S, B, E, F, R, C>,
    "schema"
  > {
  readonly schema: typeof RECURSIVE_GOAL_PLANNING_CONTINUATION_SCHEMA;
  readonly planControl: PlanControl<G, B, S, E, F>;
  readonly planningContract: PlanningContractRefs;
  readonly actionBoundary: PlanningActionBoundary | null;
}

export type RecursiveGoalResumableContinuation<G, S, B, E, F, R, C> =
  | RecursiveGoalContinuation<G, S, B, E, F, R, C>
  | RecursiveGoalPlanningContinuation<G, S, B, E, F, R, C>;

export type RecursiveGoalRunState<G, S, B, E, F, R, C> =
  RecursiveGoalResumableContinuation<G, S, B, E, F, R, C> extends infer T
    ? T extends unknown
      ? Omit<T, "schema">
      : never
    : never;

export interface RequestRejected {
  readonly kind: "request_rejected";
  readonly requestId: string | null;
  readonly acceptedRoot: null;
  readonly error: RecursiveGoalErrorDiagnostic;
}

export interface RecursiveGoalRunResult<G, S, B, E, F, R, C> {
  readonly kind: "run_result";
  readonly requestId: string;
  readonly acceptedRoot: AcceptedRoot<G, B>;
  readonly report: RecursiveGoalRunReport<G, S, B, E, F, R, C>;
}

export interface RecursiveGoalModuleFault<G, S, B, E, F, R, C> {
  readonly kind: "module_fault";
  readonly requestId: string | null;
  readonly acceptedRoot: AcceptedRoot<G, B> | null;
  readonly report: RecursiveGoalPartialRunReport<G, S, B, E, F, R, C> | null;
  readonly fault: RecursiveGoalErrorDiagnostic;
  readonly knownBoundary: RecursiveGoalKnownBoundary;
}

export type RecursiveGoalResponse<G, S, B, E, F, R, C> =
  | RequestRejected
  | RecursiveGoalRunResult<G, S, B, E, F, R, C>
  | RecursiveGoalModuleFault<G, S, B, E, F, R, C>;

export interface RecursiveGoalObligationIdentity<G, B, S, E> {
  readonly goal: G;
  readonly bindings: B;
  readonly mode: RecursiveGoalMode;
  readonly selectedSkillId: string | null;
  readonly unresolvedConditionIds: readonly string[];
  readonly facts: FactSnapshot<S, E>;
}

export function sameAcceptedRoot<G, B, S, E>(
  left: AcceptedRoot<G, B>,
  right: AcceptedRoot<G, B>,
  comparators: RecursiveGoalComparators<G, B, S, E>,
): boolean {
  return (
    left.requestId === right.requestId &&
    left.rootFrameId === right.rootFrameId &&
    left.rootThreshold === right.rootThreshold &&
    comparators.sameGoal(left.rootGoal, right.rootGoal) &&
    comparators.sameBindings(left.rootBindings, right.rootBindings)
  );
}

export function sameRecursiveGoalObligation<G, B, S, E>(
  left: RecursiveGoalObligationIdentity<G, B, S, E>,
  right: RecursiveGoalObligationIdentity<G, B, S, E>,
  comparators: RecursiveGoalComparators<G, B, S, E>,
): boolean {
  return (
    left.mode === right.mode &&
    left.selectedSkillId === right.selectedSkillId &&
    sameStringSet(left.unresolvedConditionIds, right.unresolvedConditionIds) &&
    comparators.sameGoal(left.goal, right.goal) &&
    comparators.sameBindings(left.bindings, right.bindings) &&
    comparators.sameFacts(left.facts, right.facts)
  );
}

export function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  if (rightSet.size !== right.length) return false;
  return left.every(value => rightSet.has(value));
}

function sameEvaluationReceipt(
  left: EvaluationReceipt,
  right: EvaluationReceipt,
): boolean {
  return (
    left.evaluatorId === right.evaluatorId &&
    left.result === right.result &&
    left.satisfaction === right.satisfaction &&
    left.necessaryConditionsMet === right.necessaryConditionsMet &&
    sameStringSet(left.evidenceRefs, right.evidenceRefs)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} has unsupported field ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${label}.${key} is required`);
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

function satisfaction(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new TypeError(`${label} must be a finite number from 0 to 100`);
  }
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const result = value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new TypeError(`${label} contains duplicate ids`);
  return result;
}

function effectClass(value: unknown): EnabledSkill["effectClass"] {
  if (value !== "none" && value !== "read_only" && value !== "mutating") {
    throw new TypeError("effectClass must be none, read_only, or mutating");
  }
  return value;
}

export function readBoundedRetryPolicy(
  value: unknown,
  label = "retryPolicy",
): BoundedRetryPolicy {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    [
      "kind",
      "selectorId",
      "strategySkillIds",
      "sameFailureLimit",
    ],
    ["maxAtomicAttempts"],
    label,
  );
  if (value.kind !== "bounded_strategy_retry.v1") {
    throw new TypeError(`${label}.kind must be bounded_strategy_retry.v1`);
  }
  const strategySkillIds = stringArray(
    value.strategySkillIds,
    `${label}.strategySkillIds`,
  );
  if (strategySkillIds.length === 0) {
    throw new TypeError(`${label}.strategySkillIds must not be empty`);
  }
  return {
    kind: "bounded_strategy_retry.v1",
    selectorId: nonEmptyString(value.selectorId, `${label}.selectorId`),
    strategySkillIds,
    sameFailureLimit: positiveInteger(
      value.sameFailureLimit,
      `${label}.sameFailureLimit`,
    ),
    ...(value.maxAtomicAttempts === undefined
      ? {}
      : {
          maxAtomicAttempts: positiveInteger(
            value.maxAtomicAttempts,
            `${label}.maxAtomicAttempts`,
          ),
        }),
  };
}

function readRecursiveGoalInvocationControl(
  value: unknown,
): RecursiveGoalInvocationControl {
  if (!isRecord(value)) throw new TypeError("request.invocation must be an object");
  assertExactKeys(
    value,
    ["maxAtomicDispatches"],
    [],
    "request.invocation",
  );
  if (value.maxAtomicDispatches !== 1) {
    throw new TypeError("request.invocation.maxAtomicDispatches must be 1");
  }
  return { maxAtomicDispatches: 1 };
}

function readRetryFailureCount(
  value: unknown,
  limit: number,
  label: string,
): RetryFailureCount {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, ["failureKey", "count"], [], label);
  const count = positiveInteger(value.count, `${label}.count`);
  if (count > limit) {
    throw new TypeError(`${label}.count exceeds the policy sameFailureLimit`);
  }
  return {
    failureKey: nonEmptyString(value.failureKey, `${label}.failureKey`),
    count,
  };
}

function readStrategyRetryState(
  value: unknown,
  policy: BoundedRetryPolicy,
  label: string,
): StrategyRetryState {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    ["skillId", "failures", "exhausted", "latestAttemptRef"],
    [],
    label,
  );
  if (!Array.isArray(value.failures)) {
    throw new TypeError(`${label}.failures must be an array`);
  }
  const failures = value.failures.map((entry, index) =>
    readRetryFailureCount(entry, policy.sameFailureLimit, `${label}.failures[${index}]`),
  );
  if (new Set(failures.map(entry => entry.failureKey)).size !== failures.length) {
    throw new TypeError(`${label}.failures contains a duplicate failureKey`);
  }
  if (typeof value.exhausted !== "boolean") {
    throw new TypeError(`${label}.exhausted must be boolean`);
  }
  const latestAttemptRef = nullableString(
    value.latestAttemptRef,
    `${label}.latestAttemptRef`,
  );
  if ((failures.length === 0) !== (latestAttemptRef === null)) {
    throw new TypeError(`${label}.latestAttemptRef disagrees with failure history`);
  }
  const reachedLimit = failures.some(
    failure => failure.count >= policy.sameFailureLimit,
  );
  if (value.exhausted !== reachedLimit) {
    throw new TypeError(`${label}.exhausted disagrees with failure counts`);
  }
  return {
    skillId: nonEmptyString(value.skillId, `${label}.skillId`),
    failures,
    exhausted: value.exhausted,
    latestAttemptRef,
  };
}

function readFrameStrategyRetryState(
  value: unknown,
  policy: BoundedRetryPolicy,
  label: string,
): FrameStrategyRetryState {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    ["frameId", "lockedSkillId", "strategies", "lastAccountedDispatchId"],
    [],
    label,
  );
  if (!Array.isArray(value.strategies)) {
    throw new TypeError(`${label}.strategies must be an array`);
  }
  const strategies = value.strategies.map((entry, index) =>
    readStrategyRetryState(entry, policy, `${label}.strategies[${index}]`),
  );
  assertUniqueIds(strategies, entry => entry.skillId, `${label}.strategies`);
  if (!sameStringSet(strategies.map(entry => entry.skillId), policy.strategySkillIds)) {
    throw new TypeError(`${label}.strategies must equal the policy strategy set`);
  }
  const lockedSkillId = nullableString(
    value.lockedSkillId,
    `${label}.lockedSkillId`,
  );
  if (lockedSkillId !== null) {
    const locked = strategies.find(entry => entry.skillId === lockedSkillId);
    if (locked === undefined || locked.exhausted) {
      throw new TypeError(`${label}.lockedSkillId must name an unexhausted strategy`);
    }
  }
  const unexhaustedFailed = strategies.filter(
    entry => !entry.exhausted && entry.failures.length > 0,
  );
  if (
    lockedSkillId === null
      ? unexhaustedFailed.length > 0
      : unexhaustedFailed.length !== 1 ||
        unexhaustedFailed[0]?.skillId !== lockedSkillId
  ) {
    throw new TypeError(`${label}.lockedSkillId disagrees with failure history`);
  }
  return {
    frameId: nonEmptyString(value.frameId, `${label}.frameId`),
    lockedSkillId,
    strategies,
    lastAccountedDispatchId: nullableString(
      value.lastAccountedDispatchId,
      `${label}.lastAccountedDispatchId`,
    ),
  };
}

export function readRecursiveGoalRetryControl(
  value: unknown,
  label = "retryControl",
): RecursiveGoalRetryControl {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, ["policy", "atomicAttemptsUsed", "frames"], [], label);
  if (!Array.isArray(value.frames)) {
    throw new TypeError(`${label}.frames must be an array`);
  }
  const policy = readBoundedRetryPolicy(value.policy, `${label}.policy`);
  const atomicAttemptsUsed = nonnegativeInteger(
    value.atomicAttemptsUsed,
    `${label}.atomicAttemptsUsed`,
  );
  if (
    policy.maxAtomicAttempts !== undefined &&
    atomicAttemptsUsed > policy.maxAtomicAttempts
  ) {
    throw new TypeError(`${label}.atomicAttemptsUsed exceeds maxAtomicAttempts`);
  }
  const frames = value.frames.map((entry, index) =>
    readFrameStrategyRetryState(entry, policy, `${label}.frames[${index}]`),
  );
  assertUniqueIds(frames, entry => entry.frameId, `${label}.frames`);
  return { policy, atomicAttemptsUsed, frames };
}

export function readRecursiveGoalLimits(value: unknown): RecursiveGoalLimits {
  if (!isRecord(value)) throw new TypeError("limits must be an object");
  assertExactKeys(
    value,
    [],
    ["maxTransitions", "maxDepth", "maxDerivedGoals"],
    "limits",
  );
  const maxTransitions =
    value.maxTransitions === undefined
      ? undefined
      : nonnegativeInteger(value.maxTransitions, "limits.maxTransitions");
  const maxDepth =
    value.maxDepth === undefined
      ? undefined
      : nonnegativeInteger(value.maxDepth, "limits.maxDepth");
  const maxDerivedGoals =
    value.maxDerivedGoals === undefined
      ? undefined
      : nonnegativeInteger(value.maxDerivedGoals, "limits.maxDerivedGoals");
  if (
    maxTransitions === undefined &&
    maxDepth === undefined &&
    maxDerivedGoals === undefined
  ) {
    return {};
  }
  return {
    ...(maxTransitions === undefined ? {} : { maxTransitions }),
    ...(maxDepth === undefined ? {} : { maxDepth }),
    ...(maxDerivedGoals === undefined ? {} : { maxDerivedGoals }),
  };
}

const BUDGET_DIMENSIONS = new Set([
  "maxTransitions",
  "maxDepth",
  "maxDerivedGoals",
  "maxAtomicAttempts",
]);

export function readRecursiveGoalBudgetReport(
  value: unknown,
): RecursiveGoalBudgetReport {
  if (!isRecord(value)) {
    throw new TypeError("control.budget must be an object");
  }
  assertExactKeys(
    value,
    ["dimension", "limit", "used", "attempted"],
    [],
    "control.budget",
  );
  const dimensions =
    typeof value.dimension === "string"
      ? [value.dimension]
      : value.dimension;
  if (!Array.isArray(dimensions)) {
    throw new TypeError("control.budget.dimension must be a string or array");
  }
  if (
    dimensions.length === 0 ||
    dimensions.some(dimension => !BUDGET_DIMENSIONS.has(dimension))
  ) {
    throw new TypeError("control.budget.dimension is invalid");
  }
  const limits =
    typeof value.limit === "number"
      ? [value.limit]
      : value.limit;
  const used =
    typeof value.used === "number"
      ? [value.used]
      : value.used;
  const attempted =
    value.attempted === null
      ? null
      : typeof value.attempted === "number"
        ? [value.attempted]
        : value.attempted;
  if (
    !Array.isArray(limits) ||
    !Array.isArray(used) ||
    limits.length !== dimensions.length ||
    used.length !== dimensions.length ||
    (attempted !== null &&
      (!Array.isArray(attempted) || attempted.length !== dimensions.length))
  ) {
    throw new TypeError(
      "control.budget dimension, limit, used and attempted must align",
    );
  }
  for (const number of [...limits, ...used, ...(attempted ?? [])]) {
    if (
      !Number.isSafeInteger(number) ||
      number < 0 ||
      (number as number) === Infinity ||
      Number.isNaN(number)
    ) {
      throw new TypeError("control.budget numeric values must be safe integers");
    }
  }
  return {
    dimension:
      dimensions.length === 1 ? dimensions[0] : [...dimensions],
    limit: limits.length === 1 ? limits[0] : [...limits],
    used: used.length === 1 ? used[0] : [...used],
    attempted:
      attempted === null ? null : attempted.length === 1 ? attempted[0] : [...attempted],
  };
}

export function readRecursiveGoalRequestEnvelope(value: unknown): RecursiveGoalRequestEnvelope {
  if (!isRecord(value)) throw new TypeError("recursive goal request must be an object");
  assertExactKeys(
    value,
    [
      "schema",
      "requestId",
      "rootGoal",
      "satisfactionThreshold",
      "rootBindings",
      "state",
      "rootEvaluatorId",
      "rootSelectorId",
    ],
    [
      "limits",
      "initialObservation",
      "continuation",
      "retryPolicy",
      "invocation",
      "planning",
    ],
    "request",
  );
  if (value.schema !== RECURSIVE_GOAL_REQUEST_SCHEMA) {
    throw new TypeError(`request.schema must be ${RECURSIVE_GOAL_REQUEST_SCHEMA}`);
  }
  const initialObservation = Object.hasOwn(value, "initialObservation")
    ? readRecursiveGoalInitialObservation(
        value.initialObservation,
        payload => payload,
        "request.initialObservation",
      )
    : undefined;
  const continuation = Object.hasOwn(value, "continuation")
    ? value.continuation
    : undefined;
  const retryPolicy = Object.hasOwn(value, "retryPolicy")
    ? readBoundedRetryPolicy(value.retryPolicy, "request.retryPolicy")
    : undefined;
  const invocation = Object.hasOwn(value, "invocation")
    ? readRecursiveGoalInvocationControl(value.invocation)
    : undefined;
  const planning = Object.hasOwn(value, "planning")
    ? readBoundedPlanningOptions(value.planning)
    : undefined;
  assertRecursiveGoalInitialObservationContinuationBoundary(
    initialObservation,
    continuation,
  );
  return {
    schema: RECURSIVE_GOAL_REQUEST_SCHEMA,
    requestId: nonEmptyString(value.requestId, "request.requestId"),
    rootGoal: value.rootGoal,
    satisfactionThreshold: satisfaction(
      value.satisfactionThreshold,
      "request.satisfactionThreshold",
    ),
    rootBindings: value.rootBindings,
    state: value.state,
    rootEvaluatorId: nonEmptyString(value.rootEvaluatorId, "request.rootEvaluatorId"),
    rootSelectorId: nonEmptyString(value.rootSelectorId, "request.rootSelectorId"),
    ...(value.limits === undefined
      ? {}
      : { limits: readRecursiveGoalLimits(value.limits) }),
    ...(initialObservation === undefined ? {} : { initialObservation }),
    ...(continuation === undefined ? {} : { continuation }),
    ...(retryPolicy === undefined ? {} : { retryPolicy }),
    ...(invocation === undefined ? {} : { invocation }),
    ...(planning === undefined ? {} : { planning }),
  };
}

export function assertRecursiveGoalInitialObservationContinuationBoundary(
  initialObservation: RecursiveGoalInitialObservation<unknown> | null | undefined,
  continuation: unknown | null | undefined,
): void {
  if (initialObservation != null && continuation != null) {
    throw new TypeError(
      "request.initialObservation is only valid for a new run and cannot accompany continuation",
    );
  }
}

export function readRecursiveGoalInitialObservation<E>(
  value: unknown,
  evidencePayloadGuard: (value: unknown) => E,
  label = "initialObservation",
): RecursiveGoalInitialObservation<E> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, ["stateId", "evidence"], [], label);
  const stateId = nonEmptyString(value.stateId, `${label}.stateId`);
  if (!Array.isArray(value.evidence)) {
    throw new TypeError(`${label}.evidence must be an array`);
  }
  const evidence = value.evidence.map((entry, index) =>
    readEvidenceRecord(
      entry,
      evidencePayloadGuard,
      `${label}.evidence[${index}]`,
    ),
  );
  assertUniqueIds(evidence, entry => entry.id, `${label}.evidence`);
  for (const item of evidence) {
    if (item.stateRef !== stateId) {
      throw new TypeError(
        `${label} evidence ${item.id} stateRef must equal ${stateId}`,
      );
    }
  }
  return { stateId, evidence };
}

export function assertRecursiveGoalEvaluationEvidenceRefs<E>(
  receipt: EvaluationReceipt,
  evidence: readonly EvidenceRecord<E>[],
  label = "evaluation",
): void {
  const evidenceById = new Map<string, EvidenceRecord<E>>();
  for (const item of evidence) {
    if (evidenceById.has(item.id)) {
      throw new TypeError(`${label} evidence ids must be unique`);
    }
    evidenceById.set(item.id, item);
  }
  for (const evidenceRef of receipt.evidenceRefs) {
    const item = evidenceById.get(evidenceRef);
    if (item === undefined) {
      throw new TypeError(`${label} references unavailable evidence ${evidenceRef}`);
    }
    if (receipt.result === "satisfied" && item.validity !== "valid") {
      throw new TypeError(
        `${label} cannot be satisfied with ${item.validity} evidence ${evidenceRef}`,
      );
    }
  }
}

export function readBudgetUsed(value: unknown): BudgetUsed {
  if (!isRecord(value)) throw new TypeError("budgetUsed must be an object");
  assertExactKeys(value, ["transitionsUsed", "derivedGoalsUsed"], [], "budgetUsed");
  return {
    transitionsUsed: nonnegativeInteger(value.transitionsUsed, "budgetUsed.transitionsUsed"),
    derivedGoalsUsed: nonnegativeInteger(value.derivedGoalsUsed, "budgetUsed.derivedGoalsUsed"),
  };
}

export function readEnabledSkill(value: unknown): EnabledSkill {
  if (!isRecord(value)) throw new TypeError("enabled skill must be an object");
  assertExactKeys(
    value,
    [
      "id",
      "version",
      "mode",
      "capability",
      "evaluatorId",
      "requiredEffects",
      "allowedEffects",
      "retry",
      "effectClass",
    ],
    [],
    "enabledSkill",
  );
  if (value.mode !== "atomic" && value.mode !== "composite") {
    throw new TypeError("enabledSkill.mode must be atomic or composite");
  }
  if (value.retry !== "never" && value.retry !== "completed_no_effect") {
    throw new TypeError("enabledSkill.retry is invalid");
  }
  const requiredEffects = stringArray(value.requiredEffects, "enabledSkill.requiredEffects");
  const allowedEffects = stringArray(value.allowedEffects, "enabledSkill.allowedEffects");
  for (const effect of requiredEffects) {
    if (!allowedEffects.includes(effect)) {
      throw new TypeError(`enabledSkill required effect ${effect} is not allowed`);
    }
  }
  return {
    id: nonEmptyString(value.id, "enabledSkill.id"),
    version: nonEmptyString(value.version, "enabledSkill.version"),
    mode: value.mode,
    capability: nonEmptyString(value.capability, "enabledSkill.capability"),
    evaluatorId: nonEmptyString(value.evaluatorId, "enabledSkill.evaluatorId"),
    requiredEffects,
    allowedEffects,
    retry: value.retry,
    effectClass: effectClass(value.effectClass),
  };
}

export function readEnabledEvaluator(value: unknown): EnabledEvaluator {
  if (!isRecord(value)) throw new TypeError("enabled evaluator must be an object");
  assertExactKeys(
    value,
    ["id", "goalType", "thresholdContract", "allowsPartialSatisfaction"],
    [],
    "enabledEvaluator",
  );
  if (value.thresholdContract !== "0..100") {
    throw new TypeError("enabledEvaluator.thresholdContract must be 0..100");
  }
  if (typeof value.allowsPartialSatisfaction !== "boolean") {
    throw new TypeError("enabledEvaluator.allowsPartialSatisfaction must be boolean");
  }
  return {
    id: nonEmptyString(value.id, "enabledEvaluator.id"),
    goalType: nonEmptyString(value.goalType, "enabledEvaluator.goalType"),
    thresholdContract: "0..100",
    allowsPartialSatisfaction: value.allowsPartialSatisfaction,
  };
}

export function readSelectorBinding(value: unknown): SelectorBinding {
  if (!isRecord(value)) throw new TypeError("selector binding must be an object");
  assertExactKeys(value, ["id", "skillIds"], [], "selector");
  return {
    id: nonEmptyString(value.id, "selector.id"),
    skillIds: stringArray(value.skillIds, "selector.skillIds"),
  };
}

export function readEvaluationReceipt(
  value: unknown,
  threshold?: number,
): EvaluationReceipt {
  if (!isRecord(value)) throw new TypeError("evaluation receipt must be an object");
  assertExactKeys(
    value,
    [
      "evaluatorId",
      "result",
      "satisfaction",
      "necessaryConditionsMet",
      "evidenceRefs",
    ],
    [],
    "evaluation",
  );
  if (
    value.result !== "satisfied" &&
    value.result !== "unsatisfied" &&
    value.result !== "unknown"
  ) {
    throw new TypeError("evaluation.result is invalid");
  }
  if (typeof value.necessaryConditionsMet !== "boolean") {
    throw new TypeError("evaluation.necessaryConditionsMet must be boolean");
  }
  const receipt: EvaluationReceipt = {
    evaluatorId: nonEmptyString(value.evaluatorId, "evaluation.evaluatorId"),
    result: value.result,
    satisfaction:
      value.satisfaction === null
        ? null
        : satisfaction(value.satisfaction, "evaluation.satisfaction"),
    necessaryConditionsMet: value.necessaryConditionsMet,
    evidenceRefs: stringArray(value.evidenceRefs, "evaluation.evidenceRefs"),
  };
  if (receipt.result === "satisfied") {
    if (
      receipt.satisfaction === null ||
      !receipt.necessaryConditionsMet ||
      receipt.evidenceRefs.length === 0
    ) {
      throw new TypeError(
        "evaluation.satisfied requires numeric satisfaction, necessary conditions, and evidence",
      );
    }
    if (threshold !== undefined && receipt.satisfaction < threshold) {
      throw new TypeError("evaluation.satisfied is below the frame threshold");
    }
  }
  return receipt;
}

export function readSelection(
  value: unknown,
  candidateSkillIds: readonly string[],
): Selection {
  if (!isRecord(value)) throw new TypeError("selection must be an object");
  if (value.kind === "selected") {
    assertExactKeys(value, ["kind", "skillId"], [], "selection");
    const skillId = nonEmptyString(value.skillId, "selection.skillId");
    if (!candidateSkillIds.includes(skillId)) {
      throw new TypeError("selection.skillId is outside the selector candidate vocabulary");
    }
    return { kind: "selected", skillId };
  }
  if (value.kind === "no_capability") {
    assertExactKeys(value, ["kind", "searchedSkillIds"], [], "selection");
    const searched = stringArray(value.searchedSkillIds, "selection.searchedSkillIds");
    if (!sameStringSet(searched, candidateSkillIds)) {
      throw new TypeError("selection.searchedSkillIds must equal the candidate vocabulary");
    }
    return { kind: "no_capability", searchedSkillIds: searched };
  }
  if (value.kind === "defer") {
    assertExactKeys(value, ["kind", "reason"], [], "selection");
    return {
      kind: "defer",
      reason: nonEmptyString(value.reason, "selection.reason"),
    };
  }
  throw new TypeError("selection.kind is invalid");
}

function readErrorCode(value: unknown): RecursiveGoalErrorCode {
  switch (value) {
    case "invalid_request":
    case "invalid_binding":
    case "capability_missing":
    case "policy_deferred":
    case "precondition_unsatisfied":
    case "evidence_unavailable":
    case "evidence_conflict":
    case "policy_error":
    case "effect_denied":
    case "execution_failed":
    case "effect_outcome_unknown":
    case "derivation_cycle":
    case "no_progress":
    case "budget_exceeded":
    case "cancelled":
    case "adapter_contract_invalid":
    case "workflow_failure":
      return value;
    default:
      throw new TypeError("recursive goal error code is invalid");
  }
}

function readErrorStage(value: unknown): RecursiveGoalErrorStage {
  switch (value) {
    case "admission":
    case "binding":
    case "evaluation":
    case "selection":
    case "derivation":
    case "dispatch":
    case "execution":
    case "observation":
    case "effect":
    case "aggregation":
    case "cleanup":
    case "collection":
    case "finalization":
      return value;
    default:
      throw new TypeError("recursive goal error stage is invalid");
  }
}

export function readAdapterDiagnostic(value: unknown): AdapterDiagnostic {
  if (!isRecord(value)) throw new TypeError("adapter diagnostic must be an object");
  assertExactKeys(
    value,
    [
      "diagnosticId",
      "code",
      "stage",
      "sourceCategory",
      "message",
      "nativeCode",
      "refs",
    ],
    [],
    "adapterDiagnostic",
  );
  return {
    diagnosticId: nonEmptyString(value.diagnosticId, "adapterDiagnostic.diagnosticId"),
    code: readErrorCode(value.code),
    stage: readErrorStage(value.stage),
    sourceCategory: nullableString(
      value.sourceCategory,
      "adapterDiagnostic.sourceCategory",
    ),
    message: nonEmptyString(value.message, "adapterDiagnostic.message"),
    nativeCode: nullableString(value.nativeCode, "adapterDiagnostic.nativeCode"),
    refs: stringArray(value.refs, "adapterDiagnostic.refs"),
  };
}

export interface RecursiveGoalDomainGuards<G, S, B, E, F, R, C> {
  readonly goal: (value: unknown) => G;
  readonly state: (value: unknown) => S;
  readonly bindings: (value: unknown) => B;
  readonly evidencePayload: (value: unknown) => E;
  readonly effectFact: (value: unknown) => F;
  readonly sameEffectFact: (left: F, right: F) => boolean;
  readonly receiptPayload: (value: unknown) => R;
  readonly cursor: (value: unknown) => C;
}

export interface RecursiveGoalContinuationGuards<G, S, B, E, F, R, C>
  extends RecursiveGoalDomainGuards<G, S, B, E, F, R, C> {
  readonly sameGoal: (left: G, right: G) => boolean;
  readonly sameBindings: (left: B, right: B) => boolean;
  readonly sameCursor: (left: C, right: C) => boolean;
}

export function readStateRecord<S>(
  value: unknown,
  stateGuard: (value: unknown) => S,
  label = "state",
): StateRecord<S> {
  if (!isRecord(value)) throw new TypeError(`${label} record must be an object`);
  assertExactKeys(value, ["id", "value"], [], label);
  return {
    id: nonEmptyString(value.id, `${label}.id`),
    value: stateGuard(value.value),
  };
}

export function readEvidenceRecord<E>(
  value: unknown,
  evidenceGuard: (value: unknown) => E,
  label = "evidence",
): EvidenceRecord<E> {
  if (!isRecord(value)) throw new TypeError(`${label} record must be an object`);
  assertExactKeys(value, ["id", "stateRef", "payload", "validity"], [], label);
  if (
    value.validity !== "valid" &&
    value.validity !== "stale" &&
    value.validity !== "conflicted"
  ) {
    throw new TypeError(`${label}.validity is invalid`);
  }
  return {
    id: nonEmptyString(value.id, `${label}.id`),
    stateRef: nonEmptyString(value.stateRef, `${label}.stateRef`),
    payload: evidenceGuard(value.payload),
    validity: value.validity,
  };
}

function readDomainReceipt<R>(
  value: unknown,
  receiptGuard: (value: unknown) => R,
): DomainReceipt<R> {
  if (!isRecord(value)) throw new TypeError("domain receipt must be an object");
  assertExactKeys(value, ["tag", "value"], [], "domainReceipt");
  return {
    tag: nonEmptyString(value.tag, "domainReceipt.tag"),
    value: receiptGuard(value.value),
  };
}

function readCapturedWorkflowFailure(value: unknown): CapturedWorkflowFailure {
  if (!isRecord(value)) throw new TypeError("captured workflow failure must be an object");
  assertExactKeys(
    value,
    ["category", "message"],
    ["nodeId"],
    "capturedWorkflowFailure",
  );
  return {
    category: nonEmptyString(value.category, "capturedWorkflowFailure.category"),
    message: nonEmptyString(value.message, "capturedWorkflowFailure.message"),
    ...(Object.hasOwn(value, "nodeId")
      ? { nodeId: nonEmptyString(value.nodeId, "capturedWorkflowFailure.nodeId") }
      : {}),
  };
}

function readSourceResult<R>(
  value: unknown,
  receiptGuard: (value: unknown) => R,
): DomainReceipt<R> | CapturedWorkflowFailure | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new TypeError("sourceResult must be an object or null");
  if (Object.hasOwn(value, "tag")) return readDomainReceipt(value, receiptGuard);
  return readCapturedWorkflowFailure(value);
}

function readAtomicEffectReceipt<F>(
  value: unknown,
  effectGuard: (value: unknown) => F,
): AtomicEffectReceipt<F> {
  if (!isRecord(value)) throw new TypeError("atomic effect must be an object");
  assertExactKeys(
    value,
    ["knowledge", "confirmedEffects", "receiptRef"],
    [],
    "atomicEffect",
  );
  if (
    value.knowledge !== "none" &&
    value.knowledge !== "known" &&
    value.knowledge !== "unknown" &&
    value.knowledge !== "mixed"
  ) {
    throw new TypeError("atomicEffect.knowledge is invalid");
  }
  if (!Array.isArray(value.confirmedEffects)) {
    throw new TypeError("atomicEffect.confirmedEffects must be an array");
  }
  const confirmedEffects = value.confirmedEffects.map(effectGuard);
  if (value.knowledge === "none" && confirmedEffects.length !== 0) {
    throw new TypeError("atomicEffect.none cannot contain confirmed effects");
  }
  if (
    (value.knowledge === "known" || value.knowledge === "mixed") &&
    confirmedEffects.length === 0
  ) {
    throw new TypeError("atomicEffect known/mixed requires a confirmed effect");
  }
  return {
    knowledge: value.knowledge,
    confirmedEffects,
    receiptRef:
      value.receiptRef === null
        ? null
        : nonEmptyString(value.receiptRef, "atomicEffect.receiptRef"),
  };
}

export function readAtomicReceipt<S, E, F, R>(
  value: unknown,
  guards: Pick<
    RecursiveGoalDomainGuards<never, S, never, E, F, R, never>,
    "state" | "evidencePayload" | "effectFact" | "receiptPayload"
  >,
): AtomicReceipt<S, E, F, R> {
  if (!isRecord(value)) throw new TypeError("atomic receipt must be an object");
  assertExactKeys(
    value,
    [
      "runId",
      "executorInvoked",
      "outcome",
      "sourceResult",
      "newState",
      "evidence",
      "executionErrors",
      "verificationErrors",
      "effect",
    ],
    [],
    "atomicReceipt",
  );
  if (
    value.executorInvoked !== true &&
    value.executorInvoked !== false &&
    value.executorInvoked !== "unknown"
  ) {
    throw new TypeError("atomicReceipt.executorInvoked is invalid");
  }
  if (
    value.outcome !== "succeeded" &&
    value.outcome !== "failed" &&
    value.outcome !== "rejected" &&
    value.outcome !== "unknown"
  ) {
    throw new TypeError("atomicReceipt.outcome is invalid");
  }
  if (!Array.isArray(value.evidence)) {
    throw new TypeError("atomicReceipt.evidence must be an array");
  }
  if (!Array.isArray(value.executionErrors) || !Array.isArray(value.verificationErrors)) {
    throw new TypeError("atomic receipt error lists must be arrays");
  }
  const evidence = value.evidence.map(entry =>
    readEvidenceRecord(entry, guards.evidencePayload),
  );
  if (new Set(evidence.map(entry => entry.id)).size !== evidence.length) {
    throw new TypeError("atomicReceipt evidence ids must be unique");
  }
  const executionErrors = value.executionErrors.map(readAdapterDiagnostic);
  const verificationErrors = value.verificationErrors.map(readAdapterDiagnostic);
  const diagnosticIds = [...executionErrors, ...verificationErrors].map(
    error => error.diagnosticId,
  );
  if (new Set(diagnosticIds).size !== diagnosticIds.length) {
    throw new TypeError("atomicReceipt diagnostic ids must be unique");
  }
  const effect = readAtomicEffectReceipt(value.effect, guards.effectFact);
  if (value.executorInvoked === false && effect.knowledge !== "none") {
    throw new TypeError("a non-invoked atomic receipt cannot claim known effects");
  }
  return {
    runId:
      value.runId === null ? null : nonEmptyString(value.runId, "atomicReceipt.runId"),
    executorInvoked: value.executorInvoked,
    outcome: value.outcome,
    sourceResult: readSourceResult(value.sourceResult, guards.receiptPayload),
    newState:
      value.newState === null
        ? null
        : readStateRecord(value.newState, guards.state),
    evidence,
    executionErrors,
    verificationErrors,
    effect,
  };
}

function readDerivedCondition<G, B>(
  value: unknown,
  label: string,
  guards: Pick<
    RecursiveGoalDomainGuards<G, never, B, never, never, never, never>,
    "goal" | "bindings"
  >,
): DerivedCondition<G, B> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    [
      "id",
      "goal",
      "bindings",
      "satisfactionThreshold",
      "evaluatorId",
      "selectorId",
      "mode",
      "dependsOn",
      "lifetime",
      "activation",
      "allowedEffects",
    ],
    [],
    label,
  );
  if (value.mode !== "atomic" && value.mode !== "composite") {
    throw new TypeError(`${label}.mode is invalid`);
  }
  if (value.lifetime !== "stage" && value.lifetime !== "persistent") {
    throw new TypeError(`${label}.lifetime is invalid`);
  }
  if (value.activation !== "required" && value.activation !== "not_applicable") {
    throw new TypeError(`${label}.activation is invalid`);
  }
  return {
    id: nonEmptyString(value.id, `${label}.id`),
    goal: guards.goal(value.goal),
    bindings: guards.bindings(value.bindings),
    satisfactionThreshold: satisfaction(
      value.satisfactionThreshold,
      `${label}.satisfactionThreshold`,
    ),
    evaluatorId: nonEmptyString(value.evaluatorId, `${label}.evaluatorId`),
    selectorId: nonEmptyString(value.selectorId, `${label}.selectorId`),
    mode: value.mode,
    dependsOn: stringArray(value.dependsOn, `${label}.dependsOn`),
    lifetime: value.lifetime,
    activation: value.activation,
    allowedEffects: stringArray(value.allowedEffects, `${label}.allowedEffects`),
  };
}

export function readDerivationReceipt<G, B, C>(
  value: unknown,
  guards: Pick<
    RecursiveGoalDomainGuards<G, never, B, never, never, never, C>,
    "goal" | "bindings" | "cursor"
  >,
): DerivationReceipt<G, B, C> {
  if (!isRecord(value)) throw new TypeError("derivation receipt must be an object");
  assertExactKeys(value, ["conditions", "nextCursor", "expansion"], [], "derivation");
  if (value.expansion !== "more" && value.expansion !== "closed") {
    throw new TypeError("derivation.expansion must be more or closed");
  }
  if (!Array.isArray(value.conditions)) {
    throw new TypeError("derivation.conditions must be an array");
  }
  const conditions = value.conditions.map((entry, index) =>
    readDerivedCondition(entry, `derivation.conditions[${index}]`, guards),
  );
  const ids = conditions.map(condition => condition.id);
  if (new Set(ids).size !== ids.length) throw new TypeError("derivation condition ids must be unique");
  const idSet = new Set(ids);
  for (const condition of conditions) {
    if (condition.dependsOn.includes(condition.id)) {
      throw new TypeError(`derivation condition ${condition.id} depends on itself`);
    }
    for (const dependency of condition.dependsOn) {
      if (idSet.has(dependency) && dependency === condition.id) {
        throw new TypeError(`derivation condition ${condition.id} has a self dependency`);
      }
    }
  }
  const byId = new Map(conditions.map(condition => [condition.id, condition]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new TypeError("derivation condition batch contains a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dependency)) visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  return {
    conditions,
    nextCursor: guards.cursor(value.nextCursor),
    expansion: value.expansion,
  };
}

function readConditionFact(value: unknown): ConditionFact {
  if (!isRecord(value)) throw new TypeError("condition fact must be an object");
  assertExactKeys(
    value,
    [
      "conditionId",
      "fact",
      "satisfaction",
      "evaluatorId",
      "evidenceRefs",
      "childFrameId",
    ],
    [],
    "conditionFact",
  );
  if (
    value.fact !== "not_evaluated" &&
    value.fact !== "satisfied" &&
    value.fact !== "unsatisfied" &&
    value.fact !== "unknown" &&
    value.fact !== "not_applicable"
  ) {
    throw new TypeError("conditionFact.fact is invalid");
  }
  const conditionFact: ConditionFact = {
    conditionId: nonEmptyString(value.conditionId, "conditionFact.conditionId"),
    fact: value.fact,
    satisfaction:
      value.satisfaction === null
        ? null
        : satisfaction(value.satisfaction, "conditionFact.satisfaction"),
    evaluatorId: nullableString(value.evaluatorId, "conditionFact.evaluatorId"),
    evidenceRefs: stringArray(value.evidenceRefs, "conditionFact.evidenceRefs"),
    childFrameId: nullableString(value.childFrameId, "conditionFact.childFrameId"),
  };
  if (
    conditionFact.fact === "satisfied" &&
    (conditionFact.satisfaction === null ||
      conditionFact.evaluatorId === null ||
      conditionFact.evidenceRefs.length === 0)
  ) {
    throw new TypeError(
      "conditionFact.satisfied requires satisfaction, evaluator, and evidence",
    );
  }
  return conditionFact;
}

function readAcceptedRoot<G, B>(
  value: unknown,
  guards: Pick<RecursiveGoalDomainGuards<G, never, B, never, never, never, never>, "goal" | "bindings">,
): AcceptedRoot<G, B> {
  if (!isRecord(value)) throw new TypeError("acceptedRoot must be an object");
  assertExactKeys(
    value,
    ["requestId", "rootFrameId", "rootGoal", "rootThreshold", "rootBindings"],
    [],
    "acceptedRoot",
  );
  return {
    requestId: nonEmptyString(value.requestId, "acceptedRoot.requestId"),
    rootFrameId: nonEmptyString(value.rootFrameId, "acceptedRoot.rootFrameId"),
    rootGoal: guards.goal(value.rootGoal),
    rootThreshold: satisfaction(value.rootThreshold, "acceptedRoot.rootThreshold"),
    rootBindings: guards.bindings(value.rootBindings),
  };
}

function readRootEvaluation(value: unknown): RootEvaluation {
  if (!isRecord(value)) throw new TypeError("rootEvaluation must be an object");
  if (value.state === "not_evaluated") {
    assertExactKeys(
      value,
      ["state", "reason", "blockedByErrorId"],
      [],
      "rootEvaluation",
    );
    if (
      value.reason !== "not_reached" &&
      value.reason !== "no_evaluator" &&
      value.reason !== "binding_error" &&
      value.reason !== "runner_fault"
    ) {
      throw new TypeError("rootEvaluation.reason is invalid");
    }
    return {
      state: "not_evaluated",
      reason: value.reason,
      blockedByErrorId: nullableString(
        value.blockedByErrorId,
        "rootEvaluation.blockedByErrorId",
      ),
    };
  }
  if (value.state === "evaluated") {
    assertExactKeys(
      value,
      [
        "state",
        "result",
        "satisfaction",
        "evaluatorId",
        "evidenceRefs",
        "evaluatedAtTransition",
      ],
      [],
      "rootEvaluation",
    );
    if (
      value.result !== "satisfied" &&
      value.result !== "unsatisfied" &&
      value.result !== "unknown"
    ) {
      throw new TypeError("rootEvaluation.result is invalid");
    }
    const evaluated: RootEvaluation = {
      state: "evaluated",
      result: value.result,
      satisfaction:
        value.satisfaction === null
          ? null
          : satisfaction(value.satisfaction, "rootEvaluation.satisfaction"),
      evaluatorId: nonEmptyString(value.evaluatorId, "rootEvaluation.evaluatorId"),
      evidenceRefs: stringArray(value.evidenceRefs, "rootEvaluation.evidenceRefs"),
      evaluatedAtTransition: nonnegativeInteger(
        value.evaluatedAtTransition,
        "rootEvaluation.evaluatedAtTransition",
      ),
    };
    if (
      evaluated.result === "satisfied" &&
      (evaluated.satisfaction === null || evaluated.evidenceRefs.length === 0)
    ) {
      throw new TypeError(
        "rootEvaluation.satisfied requires numeric satisfaction and evidence",
      );
    }
    return evaluated;
  }
  throw new TypeError("rootEvaluation.state is invalid");
}

function readControl(value: unknown): RecursiveGoalControl {
  if (!isRecord(value)) throw new TypeError("control must be an object");
  assertExactKeys(
    value,
    ["outcome", "stopReason", "frameId"],
    ["budget"],
    "control",
  );
  if (
    value.outcome !== "completed" &&
    value.outcome !== "error" &&
    value.outcome !== "stalled" &&
    value.outcome !== "exceeded" &&
    value.outcome !== "cancelled" &&
    value.outcome !== "yielded"
  ) {
    throw new TypeError("control.outcome is invalid");
  }
  if (
    value.stopReason !== "root_evaluation" &&
    value.stopReason !== "fatal_error" &&
    value.stopReason !== "no_progress" &&
    value.stopReason !== "budget" &&
    value.stopReason !== "cancel" &&
    value.stopReason !== "no_remaining_work" &&
    value.stopReason !== "step_boundary"
  ) {
    throw new TypeError("control.stopReason is invalid");
  }
  if (
    (value.outcome === "yielded" && value.stopReason !== "step_boundary") ||
    (value.outcome !== "yielded" && value.stopReason === "step_boundary")
  ) {
    throw new TypeError("control yielded outcome must match step_boundary");
  }
  return {
    outcome: value.outcome,
    stopReason: value.stopReason,
    frameId: nullableString(value.frameId, "control.frameId"),
    ...(value.budget === undefined
      ? {}
      : { budget: readRecursiveGoalBudgetReport(value.budget) }),
  };
}

function readFrameResult<G, B, C>(
  value: unknown,
  guards: Pick<
    RecursiveGoalDomainGuards<G, never, B, never, never, never, C>,
    "goal" | "bindings" | "cursor"
  >,
): FrameResult<G, B, C> {
  if (!isRecord(value)) throw new TypeError("frame result must be an object");
  assertExactKeys(
    value,
    [
      "frameId",
      "rootRef",
      "parentFrameId",
      "fulfillsConditionId",
      "goal",
      "bindings",
      "mode",
      "depth",
      "selectedSkillId",
      "cursor",
      "conditionResults",
      "activeRequirements",
      "unresolvedRequirements",
      "fact",
      "execution",
      "unexecutedReason",
      "errorId",
      "evidenceRefs",
      "dispatchRefs",
      "atomicResultRefs",
      "noProgressCount",
    ],
    [],
    "frame",
  );
  if (value.mode !== "atomic" && value.mode !== "composite") {
    throw new TypeError("frame.mode is invalid");
  }
  if (
    value.fact !== "not_evaluated" &&
    value.fact !== "satisfied" &&
    value.fact !== "unsatisfied" &&
    value.fact !== "unknown" &&
    value.fact !== "not_applicable"
  ) {
    throw new TypeError("frame.fact is invalid");
  }
  if (
    value.execution !== "not_started" &&
    value.execution !== "dispatched" &&
    value.execution !== "completed" &&
    value.execution !== "failed" &&
    value.execution !== "cancelled"
  ) {
    throw new TypeError("frame.execution is invalid");
  }
  if (
    value.unexecutedReason !== null &&
    value.unexecutedReason !== "dependency_not_met" &&
    value.unexecutedReason !== "budget" &&
    value.unexecutedReason !== "cancel"
  ) {
    throw new TypeError("frame.unexecutedReason is invalid");
  }
  if (!Array.isArray(value.conditionResults)) {
    throw new TypeError("frame.conditionResults must be an array");
  }
  const conditionResults = value.conditionResults.map(readConditionFact);
  if (
    new Set(conditionResults.map(result => result.conditionId)).size !==
    conditionResults.length
  ) {
    throw new TypeError("frame condition ids must be unique");
  }
  const activeRequirements = stringArray(
    value.activeRequirements,
    "frame.activeRequirements",
  );
  const unresolvedRequirements = stringArray(
    value.unresolvedRequirements,
    "frame.unresolvedRequirements",
  );
  const conditionIds = new Set(conditionResults.map(result => result.conditionId));
  for (const conditionId of [...activeRequirements, ...unresolvedRequirements]) {
    if (!conditionIds.has(conditionId)) {
      throw new TypeError(`frame requirement ${conditionId} lacks a condition result`);
    }
  }
  return {
    frameId: nonEmptyString(value.frameId, "frame.frameId"),
    rootRef: nonEmptyString(value.rootRef, "frame.rootRef"),
    parentFrameId: nullableString(value.parentFrameId, "frame.parentFrameId"),
    fulfillsConditionId: nullableString(
      value.fulfillsConditionId,
      "frame.fulfillsConditionId",
    ),
    goal: guards.goal(value.goal),
    bindings: guards.bindings(value.bindings),
    mode: value.mode,
    depth: nonnegativeInteger(value.depth, "frame.depth"),
    selectedSkillId: nullableString(value.selectedSkillId, "frame.selectedSkillId"),
    cursor: value.cursor === null ? null : guards.cursor(value.cursor),
    conditionResults,
    activeRequirements,
    unresolvedRequirements,
    fact: value.fact,
    execution: value.execution,
    unexecutedReason: value.unexecutedReason,
    errorId: nullableString(value.errorId, "frame.errorId"),
    evidenceRefs: stringArray(value.evidenceRefs, "frame.evidenceRefs"),
    dispatchRefs: stringArray(value.dispatchRefs, "frame.dispatchRefs"),
    atomicResultRefs: stringArray(value.atomicResultRefs, "frame.atomicResultRefs"),
    noProgressCount: nonnegativeInteger(value.noProgressCount, "frame.noProgressCount"),
  };
}

function readEffectRecord<F>(
  value: unknown,
  effectGuard: (value: unknown) => F,
): EffectRecord<F> {
  if (!isRecord(value)) throw new TypeError("effect record must be an object");
  assertExactKeys(
    value,
    [
      "dispatchId",
      "frameId",
      "skillId",
      "dispatchState",
      "knowledge",
      "confirmedEffects",
      "receiptRef",
    ],
    [],
    "effectRecord",
  );
  if (
    value.dispatchState !== "not_dispatched" &&
    value.dispatchState !== "in_flight" &&
    value.dispatchState !== "returned"
  ) {
    throw new TypeError("effectRecord.dispatchState is invalid");
  }
  if (
    value.knowledge !== "none" &&
    value.knowledge !== "known" &&
    value.knowledge !== "unknown" &&
    value.knowledge !== "mixed"
  ) {
    throw new TypeError("effectRecord.knowledge is invalid");
  }
  if (!Array.isArray(value.confirmedEffects)) {
    throw new TypeError("effectRecord.confirmedEffects must be an array");
  }
  const confirmedEffects = value.confirmedEffects.map(effectGuard);
  if (value.knowledge === "none" && confirmedEffects.length !== 0) {
    throw new TypeError("effectRecord.none cannot contain confirmed effects");
  }
  if (
    (value.knowledge === "known" || value.knowledge === "mixed") &&
    confirmedEffects.length === 0
  ) {
    throw new TypeError("effectRecord known/mixed requires a confirmed effect");
  }
  return {
    dispatchId: nonEmptyString(value.dispatchId, "effectRecord.dispatchId"),
    frameId: nonEmptyString(value.frameId, "effectRecord.frameId"),
    skillId: nonEmptyString(value.skillId, "effectRecord.skillId"),
    dispatchState: value.dispatchState,
    knowledge: value.knowledge,
    confirmedEffects,
    receiptRef:
      value.receiptRef === null
        ? null
        : nonEmptyString(value.receiptRef, "effectRecord.receiptRef"),
  };
}

function readAtomicExecutionResult<F, R>(
  value: unknown,
  guards: Pick<
    RecursiveGoalDomainGuards<never, never, never, never, F, R, never>,
    "effectFact" | "receiptPayload"
  >,
): AtomicExecutionResult<F, R> {
  if (!isRecord(value)) throw new TypeError("atomic result must be an object");
  assertExactKeys(
    value,
    [
      "dispatchId",
      "frameId",
      "skillId",
      "runId",
      "executorInvoked",
      "outcome",
      "sourceResult",
      "executionErrorIds",
      "verificationErrorIds",
      "effect",
      "observedStateRef",
    ],
    [],
    "atomicResult",
  );
  if (
    value.executorInvoked !== true &&
    value.executorInvoked !== false &&
    value.executorInvoked !== "unknown"
  ) {
    throw new TypeError("atomicResult.executorInvoked is invalid");
  }
  if (
    value.outcome !== "succeeded" &&
    value.outcome !== "failed" &&
    value.outcome !== "rejected" &&
    value.outcome !== "unknown"
  ) {
    throw new TypeError("atomicResult.outcome is invalid");
  }
  const effect = readEffectRecord(value.effect, guards.effectFact);
  return {
    dispatchId: nonEmptyString(value.dispatchId, "atomicResult.dispatchId"),
    frameId: nonEmptyString(value.frameId, "atomicResult.frameId"),
    skillId: nonEmptyString(value.skillId, "atomicResult.skillId"),
    runId:
      value.runId === null ? null : nonEmptyString(value.runId, "atomicResult.runId"),
    executorInvoked: value.executorInvoked,
    outcome: value.outcome,
    sourceResult: readSourceResult(value.sourceResult, guards.receiptPayload),
    executionErrorIds: stringArray(
      value.executionErrorIds,
      "atomicResult.executionErrorIds",
    ),
    verificationErrorIds: stringArray(
      value.verificationErrorIds,
      "atomicResult.verificationErrorIds",
    ),
    effect,
    observedStateRef: nullableString(
      value.observedStateRef,
      "atomicResult.observedStateRef",
    ),
  };
}

function readStackEntry<C>(
  value: unknown,
  cursorGuard: (value: unknown) => C,
): RecursiveGoalFrameStackEntry<C> {
  if (!isRecord(value)) throw new TypeError("stack entry must be an object");
  assertExactKeys(
    value,
    ["frameId", "parentFrameId", "fulfillsConditionId", "phase", "cursor"],
    [],
    "stackEntry",
  );
  if (
    value.phase !== "evaluate" &&
    value.phase !== "select" &&
    value.phase !== "derive" &&
    value.phase !== "await_children" &&
    value.phase !== "aggregate"
  ) {
    throw new TypeError("stackEntry.phase is invalid");
  }
  return {
    frameId: nonEmptyString(value.frameId, "stackEntry.frameId"),
    parentFrameId: nullableString(value.parentFrameId, "stackEntry.parentFrameId"),
    fulfillsConditionId: nullableString(
      value.fulfillsConditionId,
      "stackEntry.fulfillsConditionId",
    ),
    phase: value.phase,
    cursor: value.cursor === null ? null : cursorGuard(value.cursor),
  };
}

function readFrameEvaluation(
  value: unknown,
  threshold: number,
): RecursiveGoalFrameEvaluation {
  if (!isRecord(value)) throw new TypeError("frameControl.evaluation must be an object");
  assertExactKeys(
    value,
    ["receipt", "evaluatedAtTransition"],
    [],
    "frameControl.evaluation",
  );
  return {
    receipt: readEvaluationReceipt(value.receipt, threshold),
    evaluatedAtTransition: nonnegativeInteger(
      value.evaluatedAtTransition,
      "frameControl.evaluation.evaluatedAtTransition",
    ),
  };
}

function readProgressBaseline(
  value: unknown,
  threshold: number,
): RecursiveGoalProgressBaseline {
  if (!isRecord(value)) {
    throw new TypeError("frameControl.progressBaseline must be an object");
  }
  assertExactKeys(
    value,
    ["stateRef", "evaluation", "capturedAtTransition"],
    [],
    "frameControl.progressBaseline",
  );
  return {
    stateRef: nonEmptyString(
      value.stateRef,
      "frameControl.progressBaseline.stateRef",
    ),
    evaluation: readEvaluationReceipt(
      value.evaluation,
      threshold,
    ),
    capturedAtTransition: nonnegativeInteger(
      value.capturedAtTransition,
      "frameControl.progressBaseline.capturedAtTransition",
    ),
  };
}

function readObligationSnapshot(value: unknown): RecursiveGoalObligationSnapshot {
  if (!isRecord(value)) {
    throw new TypeError("frameControl.obligationSnapshot must be an object");
  }
  assertExactKeys(
    value,
    [
      "mode",
      "selectedSkillId",
      "unresolvedConditionIds",
      "stateRef",
      "evidenceRefs",
      "conditions",
    ],
    [],
    "frameControl.obligationSnapshot",
  );
  if (value.mode !== "atomic" && value.mode !== "composite") {
    throw new TypeError("frameControl.obligationSnapshot.mode is invalid");
  }
  if (!Array.isArray(value.conditions)) {
    throw new TypeError("frameControl.obligationSnapshot.conditions must be an array");
  }
  const conditions = value.conditions.map(readConditionFact);
  if (new Set(conditions.map(condition => condition.conditionId)).size !== conditions.length) {
    throw new TypeError("frameControl.obligationSnapshot condition ids must be unique");
  }
  const unresolvedConditionIds = stringArray(
    value.unresolvedConditionIds,
    "frameControl.obligationSnapshot.unresolvedConditionIds",
  );
  const conditionIds = new Set(conditions.map(condition => condition.conditionId));
  const conditionsById = new Map(
    conditions.map(condition => [condition.conditionId, condition]),
  );
  for (const conditionId of unresolvedConditionIds) {
    if (!conditionIds.has(conditionId)) {
      throw new TypeError(
        `frameControl.obligationSnapshot unresolved condition ${conditionId} lacks a fact`,
      );
    }
    const fact = conditionsById.get(conditionId)?.fact;
    if (fact === "satisfied" || fact === "not_applicable") {
      throw new TypeError(
        `frameControl.obligationSnapshot unresolved condition ${conditionId} is resolved`,
      );
    }
  }
  return {
    mode: value.mode,
    selectedSkillId: nullableString(
      value.selectedSkillId,
      "frameControl.obligationSnapshot.selectedSkillId",
    ),
    unresolvedConditionIds,
    stateRef: nonEmptyString(
      value.stateRef,
      "frameControl.obligationSnapshot.stateRef",
    ),
    evidenceRefs: stringArray(
      value.evidenceRefs,
      "frameControl.obligationSnapshot.evidenceRefs",
    ),
    conditions,
  };
}

function readPendingVerification(
  value: unknown,
): RecursiveGoalPendingVerification {
  if (!isRecord(value)) {
    throw new TypeError("frameControl.pendingVerification must be an object");
  }
  assertExactKeys(
    value,
    ["dispatchId", "skillId", "verificationErrorIds"],
    [],
    "frameControl.pendingVerification",
  );
  const verificationErrorIds = stringArray(
    value.verificationErrorIds,
    "frameControl.pendingVerification.verificationErrorIds",
  );
  if (verificationErrorIds.length === 0) {
    throw new TypeError(
      "frameControl.pendingVerification.verificationErrorIds must not be empty",
    );
  }
  return {
    dispatchId: nonEmptyString(
      value.dispatchId,
      "frameControl.pendingVerification.dispatchId",
    ),
    skillId: nonEmptyString(
      value.skillId,
      "frameControl.pendingVerification.skillId",
    ),
    verificationErrorIds,
  };
}

function readFrameControl<G, B>(value: unknown): RecursiveGoalFrameControl<G, B> {
  if (!isRecord(value)) throw new TypeError("frame control must be an object");
  assertExactKeys(
    value,
    [
      "frameId",
      "satisfactionThreshold",
      "evaluatorId",
      "selectorId",
      "effectScope",
      "expansion",
      "evaluation",
      "progressBaseline",
      "compositeCycleBaseline",
      "pendingVerification",
      "obligationSnapshot",
    ],
    [],
    "frameControl",
  );
  if (
    value.expansion !== "not_derived" &&
    value.expansion !== "more" &&
    value.expansion !== "closed"
  ) {
    throw new TypeError("frameControl.expansion is invalid");
  }
  const satisfactionThreshold = satisfaction(
    value.satisfactionThreshold,
    "frameControl.satisfactionThreshold",
  );
  return {
    frameId: nonEmptyString(value.frameId, "frameControl.frameId"),
    satisfactionThreshold,
    evaluatorId: nonEmptyString(value.evaluatorId, "frameControl.evaluatorId"),
    selectorId: nonEmptyString(value.selectorId, "frameControl.selectorId"),
    effectScope: stringArray(value.effectScope, "frameControl.effectScope"),
    expansion: value.expansion,
    evaluation:
      value.evaluation === null
        ? null
        : readFrameEvaluation(value.evaluation, satisfactionThreshold),
    progressBaseline:
      value.progressBaseline === null
        ? null
        : readProgressBaseline(value.progressBaseline, satisfactionThreshold),
    compositeCycleBaseline:
      value.compositeCycleBaseline === null
        ? null
        : readProgressBaseline(
            value.compositeCycleBaseline,
            satisfactionThreshold,
          ),
    pendingVerification:
      value.pendingVerification === null
        ? null
        : readPendingVerification(value.pendingVerification),
    obligationSnapshot:
      value.obligationSnapshot === null
        ? null
        : readObligationSnapshot(value.obligationSnapshot),
  };
}

function readDependencyState<G, B>(
  value: unknown,
  guards: Pick<
    RecursiveGoalDomainGuards<G, never, B, never, never, never, never>,
    "goal" | "bindings"
  >,
): DependencyState<G, B> {
  if (!isRecord(value)) throw new TypeError("dependency state must be an object");
  assertExactKeys(
    value,
    ["ownerFrameId", "condition", "fact", "execution", "childFrameId"],
    [],
    "dependency",
  );
  if (
    value.fact !== "not_evaluated" &&
    value.fact !== "satisfied" &&
    value.fact !== "unsatisfied" &&
    value.fact !== "unknown" &&
    value.fact !== "not_applicable"
  ) {
    throw new TypeError("dependency.fact is invalid");
  }
  if (
    value.execution !== "not_started" &&
    value.execution !== "dispatched" &&
    value.execution !== "completed" &&
    value.execution !== "failed" &&
    value.execution !== "cancelled"
  ) {
    throw new TypeError("dependency.execution is invalid");
  }
  return {
    ownerFrameId: nonEmptyString(value.ownerFrameId, "dependency.ownerFrameId"),
    condition: readDerivedCondition(value.condition, "dependency.condition", guards),
    fact: value.fact,
    execution: value.execution,
    childFrameId: nullableString(value.childFrameId, "dependency.childFrameId"),
  };
}

function readErrorDiagnostic(value: unknown): RecursiveGoalErrorDiagnostic {
  if (!isRecord(value)) throw new TypeError("error diagnostic must be an object");
  assertExactKeys(
    value,
    [
      "errorId",
      "code",
      "stage",
      "origin",
      "source",
      "effectKnowledge",
      "atomicResultRefs",
      "cause",
      "propagation",
      "diagnosticMessage",
    ],
    [],
    "errorDiagnostic",
  );
  if (!isRecord(value.origin)) throw new TypeError("errorDiagnostic.origin must be an object");
  assertExactKeys(
    value.origin,
    ["frameId", "skillId", "conditionId", "evaluatorId", "nodeId"],
    [],
    "errorDiagnostic.origin",
  );
  if (!isRecord(value.source)) throw new TypeError("errorDiagnostic.source must be an object");
  assertExactKeys(
    value.source,
    ["owner", "category", "nativeCode", "refs"],
    [],
    "errorDiagnostic.source",
  );
  if (
    value.source.owner !== "module" &&
    value.source.owner !== "adapter" &&
    value.source.owner !== "workflow"
  ) {
    throw new TypeError("errorDiagnostic.source.owner is invalid");
  }
  if (
    value.effectKnowledge !== "none" &&
    value.effectKnowledge !== "known" &&
    value.effectKnowledge !== "unknown" &&
    value.effectKnowledge !== "mixed"
  ) {
    throw new TypeError("errorDiagnostic.effectKnowledge is invalid");
  }
  if (!Array.isArray(value.propagation)) {
    throw new TypeError("errorDiagnostic.propagation must be an array");
  }
  const propagation = value.propagation.map((entry, index) => {
    const label = `errorDiagnostic.propagation[${index}]`;
    if (!isRecord(entry)) throw new TypeError(`${label} must be an object`);
    assertExactKeys(entry, ["frameId", "parentFrameId", "satisfies"], [], label);
    let satisfies: ErrorPropagation["satisfies"] = null;
    if (entry.satisfies !== null) {
      if (!isRecord(entry.satisfies)) throw new TypeError(`${label}.satisfies is invalid`);
      assertExactKeys(entry.satisfies, ["frameId", "conditionId"], [], `${label}.satisfies`);
      satisfies = {
        frameId: nonEmptyString(entry.satisfies.frameId, `${label}.satisfies.frameId`),
        conditionId: nonEmptyString(
          entry.satisfies.conditionId,
          `${label}.satisfies.conditionId`,
        ),
      };
    }
    return {
      frameId: nonEmptyString(entry.frameId, `${label}.frameId`),
      parentFrameId: nullableString(entry.parentFrameId, `${label}.parentFrameId`),
      satisfies,
    };
  });
  let cause: ErrorCause | null = null;
  if (value.cause !== null) {
    if (!isRecord(value.cause)) throw new TypeError("errorDiagnostic.cause is invalid");
    if (value.cause.kind === "captured_error") {
      assertExactKeys(
        value.cause,
        ["kind", "name", "message", "nativeCode"],
        [],
        "errorDiagnostic.cause",
      );
      cause = {
        kind: "captured_error",
        name: nonEmptyString(value.cause.name, "errorDiagnostic.cause.name"),
        message: nonEmptyString(value.cause.message, "errorDiagnostic.cause.message"),
        nativeCode: nullableString(
          value.cause.nativeCode,
          "errorDiagnostic.cause.nativeCode",
        ),
      };
    } else if (value.cause.kind === "error_ref") {
      assertExactKeys(
        value.cause,
        ["kind", "errorId"],
        [],
        "errorDiagnostic.cause",
      );
      cause = {
        kind: "error_ref",
        errorId: nonEmptyString(value.cause.errorId, "errorDiagnostic.cause.errorId"),
      };
    } else {
      throw new TypeError("errorDiagnostic.cause.kind is invalid");
    }
  }
  return {
    errorId: nonEmptyString(value.errorId, "errorDiagnostic.errorId"),
    code: readErrorCode(value.code),
    stage: readErrorStage(value.stage),
    origin: {
      frameId: nullableString(value.origin.frameId, "errorDiagnostic.origin.frameId"),
      skillId: nullableString(value.origin.skillId, "errorDiagnostic.origin.skillId"),
      conditionId: nullableString(
        value.origin.conditionId,
        "errorDiagnostic.origin.conditionId",
      ),
      evaluatorId: nullableString(
        value.origin.evaluatorId,
        "errorDiagnostic.origin.evaluatorId",
      ),
      nodeId: nullableString(value.origin.nodeId, "errorDiagnostic.origin.nodeId"),
    },
    source: {
      owner: value.source.owner,
      category: nullableString(
        value.source.category,
        "errorDiagnostic.source.category",
      ),
      nativeCode: nullableString(
        value.source.nativeCode,
        "errorDiagnostic.source.nativeCode",
      ),
      refs: stringArray(value.source.refs, "errorDiagnostic.source.refs"),
    },
    effectKnowledge: value.effectKnowledge,
    atomicResultRefs: stringArray(
      value.atomicResultRefs,
      "errorDiagnostic.atomicResultRefs",
    ),
    cause,
    propagation,
    diagnosticMessage: nonEmptyString(
      value.diagnosticMessage,
      "errorDiagnostic.diagnosticMessage",
    ),
  };
}

function readRelatedIssue(value: unknown): RelatedIssue {
  if (!isRecord(value)) throw new TypeError("related issue must be an object");
  assertExactKeys(value, ["errorId", "relation", "affectsCompletion"], [], "relatedIssue");
  if (
    value.relation !== "cleanup" &&
    value.relation !== "collection" &&
    value.relation !== "secondary"
  ) {
    throw new TypeError("relatedIssue.relation is invalid");
  }
  if (typeof value.affectsCompletion !== "boolean") {
    throw new TypeError("relatedIssue.affectsCompletion must be boolean");
  }
  return {
    errorId: nonEmptyString(value.errorId, "relatedIssue.errorId"),
    relation: value.relation,
    affectsCompletion: value.affectsCompletion,
  };
}

function assertUniqueIds<T>(
  values: readonly T[],
  id: (value: T) => string,
  label: string,
): void {
  const ids = values.map(id);
  if (new Set(ids).size !== ids.length) throw new TypeError(`${label} ids must be unique`);
}

function readReceiptRef(value: unknown, label: string): ReceiptRef | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new TypeError(`${label} must be an object or null`);
  assertExactKeys(value, ["receiptId"], [], label);
  return { receiptId: nonEmptyString(value.receiptId, `${label}.receiptId`) };
}

function dependencyKey(ownerFrameId: string, conditionId: string): string {
  return JSON.stringify([ownerFrameId, conditionId]);
}

function assertStringSubset(
  values: readonly string[],
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const value of values) {
    if (!allowed.has(value)) throw new TypeError(`${label} contains unknown ${value}`);
  }
}

type RecursiveGoalContinuationBase<G, S, B, E, F, R, C> = Omit<
  RecursiveGoalContinuation<G, S, B, E, F, R, C>,
  "schema"
>;

function readRecursiveGoalContinuationBase<G, S, B, E, F, R, C>(
  value: unknown,
  guards: RecursiveGoalContinuationGuards<G, S, B, E, F, R, C>,
  schema:
    | typeof RECURSIVE_GOAL_CONTINUATION_SCHEMA
    | typeof RECURSIVE_GOAL_PLANNING_CONTINUATION_SCHEMA,
  planningMode: boolean,
  hasPlanningActionBoundary: boolean,
): RecursiveGoalContinuationBase<G, S, B, E, F, R, C> {
  if (!isRecord(value)) throw new TypeError("continuation must be an object");
  assertExactKeys(
    value,
    [
      "schema",
      "acceptedRoot",
      "lastTrustedTransition",
      "rootEvaluation",
      "control",
      "frames",
      "frameControls",
      "stack",
      "dependencies",
      "states",
      "evidence",
      "ledger",
      "atomicResults",
      "errors",
      "primaryErrorId",
      "relatedIssues",
      "budgetUsed",
      "remainingRequirements",
      "contractRefs",
    ],
    planningMode
      ? ["retryControl", "planControl", "planningContract", "actionBoundary"]
      : ["retryControl"],
    "continuation",
  );
  if (value.schema !== schema) {
    throw new TypeError(`continuation.schema must be ${schema}`);
  }
  if (
    !Array.isArray(value.frames) ||
    !Array.isArray(value.frameControls) ||
    !Array.isArray(value.stack) ||
    !Array.isArray(value.dependencies) ||
    !Array.isArray(value.states) ||
    !Array.isArray(value.evidence) ||
    !Array.isArray(value.ledger) ||
    !Array.isArray(value.atomicResults) ||
    !Array.isArray(value.errors) ||
    !Array.isArray(value.relatedIssues) ||
    !Array.isArray(value.remainingRequirements)
  ) {
    throw new TypeError("continuation state collections must be arrays");
  }
  const acceptedRoot = readAcceptedRoot(value.acceptedRoot, guards);
  const lastTrustedTransition = nonnegativeInteger(
    value.lastTrustedTransition,
    "continuation.lastTrustedTransition",
  );
  const budgetUsed = readBudgetUsed(value.budgetUsed);
  const rootEvaluation = readRootEvaluation(value.rootEvaluation);
  const runControl = readControl(value.control);
  const frames = value.frames.map(entry => readFrameResult(entry, guards));
  const frameControls = value.frameControls.map(entry =>
    readFrameControl<G, B>(entry),
  );
  const stack = value.stack.map(entry => readStackEntry(entry, guards.cursor));
  const dependencies = value.dependencies.map(entry =>
    readDependencyState(entry, guards),
  );
  const states = value.states.map(entry => readStateRecord(entry, guards.state));
  const evidence = value.evidence.map(entry =>
    readEvidenceRecord(entry, guards.evidencePayload),
  );
  const ledger = value.ledger.map(entry => readEffectRecord(entry, guards.effectFact));
  const atomicResults = value.atomicResults.map(entry =>
    readAtomicExecutionResult(entry, guards),
  );
  const retryControl = Object.hasOwn(value, "retryControl")
    ? readRecursiveGoalRetryControl(
        value.retryControl,
        "continuation.retryControl",
      )
    : undefined;
  const errors = value.errors.map(readErrorDiagnostic);
  const relatedIssues = value.relatedIssues.map(readRelatedIssue);
  assertUniqueIds(frames, entry => entry.frameId, "continuation frame");
  assertUniqueIds(frameControls, entry => entry.frameId, "continuation frame control");
  assertUniqueIds(states, entry => entry.id, "continuation state");
  assertUniqueIds(evidence, entry => entry.id, "continuation evidence");
  assertUniqueIds(ledger, entry => entry.dispatchId, "continuation ledger");
  assertUniqueIds(
    atomicResults,
    entry => entry.dispatchId,
    "continuation atomic result",
  );
  assertUniqueIds(errors, entry => entry.errorId, "continuation error");
  if (
    retryControl !== undefined &&
    retryControl.atomicAttemptsUsed !== ledger.length
  ) {
    throw new TypeError(
      "continuation.retryControl.atomicAttemptsUsed must equal committed atomic dispatches",
    );
  }
  if (!isRecord(value.contractRefs)) {
    throw new TypeError("continuation.contractRefs must be an object");
  }
  assertExactKeys(
    value.contractRefs,
    ["enabledSkillIds", "evaluatorIds", "selectorIds", "grantedEffects"],
    [],
    "continuation.contractRefs",
  );
  const contractRefs = {
    enabledSkillIds: stringArray(
      value.contractRefs.enabledSkillIds,
      "continuation.contractRefs.enabledSkillIds",
    ),
    evaluatorIds: stringArray(
      value.contractRefs.evaluatorIds,
      "continuation.contractRefs.evaluatorIds",
    ),
    selectorIds: stringArray(
      value.contractRefs.selectorIds,
      "continuation.contractRefs.selectorIds",
    ),
    grantedEffects: stringArray(
      value.contractRefs.grantedEffects,
      "continuation.contractRefs.grantedEffects",
    ),
  };
  const enabledSkillIds = new Set(contractRefs.enabledSkillIds);
  const evaluatorIds = new Set(contractRefs.evaluatorIds);
  const selectorIds = new Set(contractRefs.selectorIds);
  const grantedEffects = new Set(contractRefs.grantedEffects);

  const frameIds = new Set(frames.map(frame => frame.frameId));
  const frameById = new Map(frames.map(frame => [frame.frameId, frame]));
  const controlById = new Map(frameControls.map(control => [control.frameId, control]));
  const stackByFrameId = new Map(stack.map(entry => [entry.frameId, entry]));
  const rootFrame = frameById.get(acceptedRoot.rootFrameId);
  if (!rootFrame) throw new TypeError("continuation root frame is missing");
  if (
    frameControls.length !== frames.length ||
    frameControls.some(control => !frameIds.has(control.frameId))
  ) {
    throw new TypeError("continuation frame controls must match frames one-to-one");
  }
  const rootControl = controlById.get(rootFrame.frameId);
  if (!rootControl) throw new TypeError("continuation root frame control is missing");
  if (
    rootFrame.parentFrameId !== null ||
    rootFrame.fulfillsConditionId !== null ||
    rootFrame.depth !== 0
  ) {
    throw new TypeError("continuation root frame has non-root identity");
  }
  if (
    !guards.sameGoal(rootFrame.goal, acceptedRoot.rootGoal) ||
    !guards.sameBindings(rootFrame.bindings, acceptedRoot.rootBindings) ||
    rootControl.satisfactionThreshold !== acceptedRoot.rootThreshold
  ) {
    throw new TypeError("continuation root frame disagrees with accepted root");
  }
  if (!sameStringSet(rootControl.effectScope, contractRefs.grantedEffects)) {
    throw new TypeError("continuation root effectScope must equal grantedEffects");
  }

  for (const frame of frames) {
    const frameControl = controlById.get(frame.frameId);
    if (!frameControl) throw new TypeError(`continuation frame ${frame.frameId} lacks control`);
    if (frame.rootRef !== acceptedRoot.rootFrameId) {
      throw new TypeError("continuation frame rootRef differs from accepted root");
    }
    if (frame.parentFrameId !== null && !frameIds.has(frame.parentFrameId)) {
      throw new TypeError(`continuation frame ${frame.frameId} has an unknown parent`);
    }
    if (frame.parentFrameId === null && frame.frameId !== rootFrame.frameId) {
      throw new TypeError("only the root continuation frame can have no parent");
    }
    if (
      frame.frameId !== rootFrame.frameId &&
      (frame.parentFrameId === null || frame.fulfillsConditionId === null)
    ) {
      throw new TypeError("non-root continuation frame lacks parent obligation");
    }
    if (!evaluatorIds.has(frameControl.evaluatorId)) {
      throw new TypeError(`continuation frame ${frame.frameId} has unknown evaluator`);
    }
    if (!selectorIds.has(frameControl.selectorId)) {
      throw new TypeError(`continuation frame ${frame.frameId} has unknown selector`);
    }
    assertStringSubset(
      frameControl.effectScope,
      grantedEffects,
      `continuation frame ${frame.frameId} effectScope`,
    );
    if (
      frame.selectedSkillId !== null &&
      !enabledSkillIds.has(frame.selectedSkillId)
    ) {
      throw new TypeError(`continuation frame ${frame.frameId} has unknown skill`);
    }
    if (frame.mode === "atomic" && frameControl.expansion !== "not_derived") {
      throw new TypeError("atomic continuation frame cannot have derivation expansion");
    }
    if (
      frameControl.expansion !== "not_derived" &&
      frame.selectedSkillId === null
    ) {
      throw new TypeError("derived continuation frame lacks selected skill");
    }
    if (frame.selectedSkillId !== null && frameControl.evaluation === null) {
      throw new TypeError("selected continuation frame lacks evaluation");
    }
    if (
      frame.fact !== "not_evaluated" &&
      frame.fact !== "not_applicable" &&
      frameControl.evaluation === null
    ) {
      throw new TypeError("evaluated continuation frame lacks evaluation receipt");
    }
    if (
      frameControl.evaluation !== null &&
      frame.fact !== "not_evaluated" &&
      frame.fact !== "not_applicable" &&
      frameControl.evaluation.receipt.result !== frame.fact
    ) {
      throw new TypeError("continuation frame fact disagrees with evaluation receipt");
    }
    if (
      frame.selectedSkillId !== null &&
      frameControl.obligationSnapshot === null
    ) {
      throw new TypeError("selected continuation frame lacks obligation snapshot");
    }
    if (
      frameControl.progressBaseline !== null &&
      frame.selectedSkillId === null
    ) {
      const stackEntry = stackByFrameId.get(frame.frameId);
      const evaluation = frameControl.evaluation;
      const isPreSelectionBaseline =
        stackEntry?.phase === "select" &&
        frame.noProgressCount === 0 &&
        frame.dispatchRefs.length === 0 &&
        frame.atomicResultRefs.length === 0 &&
        evaluation !== null &&
        evaluation.evaluatedAtTransition ===
          frameControl.progressBaseline.capturedAtTransition &&
        sameEvaluationReceipt(
          evaluation.receipt,
          frameControl.progressBaseline.evaluation,
        );
      if (!isPreSelectionBaseline) {
        throw new TypeError(
          "continuation progress baseline lacks selected skill",
        );
      }
    }
    for (const result of frame.conditionResults) {
      if (result.childFrameId !== null && !frameIds.has(result.childFrameId)) {
        throw new TypeError(
          `continuation condition ${result.conditionId} has an unknown child frame`,
        );
      }
    }
  }

  const dependenciesById = new Map<string, DependencyState<G, B>>();
  const dependenciesByOwner = new Map<string, DependencyState<G, B>[]>();
  for (const dependency of dependencies) {
    const key = dependencyKey(dependency.ownerFrameId, dependency.condition.id);
    if (dependenciesById.has(key)) {
      throw new TypeError(
        `continuation dependency ${dependency.condition.id} is duplicated for its owner`,
      );
    }
    dependenciesById.set(key, dependency);
    const owned = dependenciesByOwner.get(dependency.ownerFrameId) ?? [];
    owned.push(dependency);
    dependenciesByOwner.set(dependency.ownerFrameId, owned);
  }

  for (const [ownerFrameId, ownedDependencies] of dependenciesByOwner) {
    const ownerFrame = frameById.get(ownerFrameId);
    const ownerControl = controlById.get(ownerFrameId);
    if (!ownerFrame || !ownerControl) {
      throw new TypeError(
        `continuation dependency owner ${ownerFrameId} has no frame control`,
      );
    }
    if (ownerFrame.mode !== "composite") {
      throw new TypeError("atomic continuation frame cannot own derived conditions");
    }
    if (ownerControl.expansion === "not_derived") {
      throw new TypeError(
        "continuation derived conditions require a recorded expansion state",
      );
    }
    const conditionResultIds = new Set(
      ownerFrame.conditionResults.map(result => result.conditionId),
    );
    const definitions = new Map(
      ownedDependencies.map(dependency => [
        dependency.condition.id,
        dependency.condition,
      ]),
    );
    for (const dependency of ownedDependencies) {
      const condition = dependency.condition;
      if (!conditionResultIds.has(condition.id)) {
        throw new TypeError(
          `continuation condition ${condition.id} lacks its frame fact`,
        );
      }
      if (
        !evaluatorIds.has(condition.evaluatorId) ||
        !selectorIds.has(condition.selectorId)
      ) {
        throw new TypeError(
          `continuation condition ${condition.id} references unknown contract`,
        );
      }
      assertStringSubset(
        condition.allowedEffects,
        grantedEffects,
        `continuation condition ${condition.id} allowedEffects`,
      );
      if (
        !condition.allowedEffects.every(effect =>
          ownerControl.effectScope.includes(effect),
        )
      ) {
        throw new TypeError(
          `continuation condition ${condition.id} widens its owner effectScope`,
        );
      }
      for (const dependencyId of condition.dependsOn) {
        if (!definitions.has(dependencyId)) {
          throw new TypeError(
            `continuation condition ${condition.id} has unknown dependency ${dependencyId}`,
          );
        }
      }
      if (
        condition.activation === "not_applicable" &&
        (dependency.fact !== "not_applicable" ||
          dependency.execution !== "not_started" ||
          dependency.childFrameId !== null)
      ) {
        throw new TypeError(
          `continuation condition ${condition.id} has inconsistent not_applicable state`,
        );
      }
      if (
        condition.activation === "required" &&
        dependency.fact === "not_applicable"
      ) {
        throw new TypeError(
          `continuation required condition ${condition.id} cannot be not_applicable`,
        );
      }
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visitCondition = (conditionId: string): void => {
      if (visiting.has(conditionId)) {
        throw new TypeError("continuation dependency definitions contain a cycle");
      }
      if (visited.has(conditionId)) return;
      visiting.add(conditionId);
      for (const dependencyId of definitions.get(conditionId)?.dependsOn ?? []) {
        visitCondition(dependencyId);
      }
      visiting.delete(conditionId);
      visited.add(conditionId);
    };
    for (const conditionId of definitions.keys()) visitCondition(conditionId);
  }

  for (const frame of frames) {
    const frameControl = controlById.get(frame.frameId)!;
    if (
      frame.parentFrameId !== null &&
      frame.fulfillsConditionId !== null
    ) {
      const fulfilling = dependenciesById.get(
        dependencyKey(frame.parentFrameId, frame.fulfillsConditionId),
      );
      if (!fulfilling || fulfilling.childFrameId !== frame.frameId) {
        throw new TypeError(
          `continuation frame ${frame.frameId} lacks its fulfilling dependency`,
        );
      }
    }
    for (const result of frame.conditionResults) {
      const dependency = dependenciesById.get(
        dependencyKey(frame.frameId, result.conditionId),
      );
      if (!dependency) {
        throw new TypeError(
          `continuation condition ${result.conditionId} lacks its definition`,
        );
      }
      if (
        (result.fact === "satisfied" ||
          result.fact === "unsatisfied" ||
          result.fact === "unknown") &&
        result.evaluatorId === null
      ) {
        throw new TypeError(
          `continuation condition ${result.conditionId} is evaluated without an evaluator`,
        );
      }
      if (
        dependency.fact !== result.fact ||
        dependency.childFrameId !== result.childFrameId ||
        (result.evaluatorId !== null &&
          result.evaluatorId !== dependency.condition.evaluatorId)
      ) {
        throw new TypeError(
          `continuation condition ${result.conditionId} disagrees with its dependency`,
        );
      }
    }
    for (const dependency of dependenciesByOwner.get(frame.frameId) ?? []) {
      if (dependency.childFrameId === null) continue;
      const child = frameById.get(dependency.childFrameId);
      if (!child) {
        throw new TypeError(
          `continuation condition ${dependency.condition.id} has unknown child`,
        );
      }
      if (
        child.parentFrameId !== frame.frameId ||
        child.fulfillsConditionId !== dependency.condition.id ||
        child.execution !== dependency.execution
      ) {
        throw new TypeError(
          `continuation condition ${dependency.condition.id} child identity disagrees`,
        );
      }
      const childControl = controlById.get(child.frameId)!;
      assertStringSubset(
        childControl.effectScope,
        new Set(dependency.condition.allowedEffects),
        `continuation condition ${dependency.condition.id} child effectScope`,
      );
      if (
        child.mode !== dependency.condition.mode ||
        childControl.satisfactionThreshold !==
          dependency.condition.satisfactionThreshold ||
        childControl.evaluatorId !== dependency.condition.evaluatorId ||
        childControl.selectorId !== dependency.condition.selectorId ||
        !guards.sameGoal(child.goal, dependency.condition.goal) ||
        !guards.sameBindings(child.bindings, dependency.condition.bindings) ||
        child.depth !== frame.depth + 1
      ) {
        throw new TypeError(
          `continuation condition ${dependency.condition.id} child control disagrees`,
        );
      }
    }
    if (frameControl.obligationSnapshot !== null) {
      if (
        frameControl.obligationSnapshot.mode !== frame.mode ||
        frameControl.obligationSnapshot.selectedSkillId !== frame.selectedSkillId
      ) {
        throw new TypeError(
          `continuation frame ${frame.frameId} obligation identity disagrees`,
        );
      }
      for (const conditionId of frameControl.obligationSnapshot.unresolvedConditionIds) {
        if (!dependenciesById.has(dependencyKey(frame.frameId, conditionId))) {
          throw new TypeError(
            `continuation frame ${frame.frameId} obligation has unknown condition`,
          );
        }
      }
      for (const condition of frameControl.obligationSnapshot.conditions) {
        if (!dependenciesById.has(dependencyKey(frame.frameId, condition.conditionId))) {
          throw new TypeError(
            `continuation frame ${frame.frameId} obligation has unknown condition fact`,
          );
        }
      }
    }
  }

  if (stack.length === 0) {
    throw new TypeError("continuation stack must retain an active frame path");
  }
  assertUniqueIds(stack, entry => entry.frameId, "continuation stack");
  if (stack[0]?.frameId !== rootFrame.frameId) {
    throw new TypeError("continuation stack must start at the root frame");
  }
  for (const entry of stack) {
    const frame = frameById.get(entry.frameId);
    if (!frame) throw new TypeError("continuation stack has unknown frame");
    if (
      frame.parentFrameId !== entry.parentFrameId ||
      frame.fulfillsConditionId !== entry.fulfillsConditionId
    ) {
      throw new TypeError("continuation stack entry disagrees with its frame");
    }
    if ((entry.cursor === null) !== (frame.cursor === null)) {
      throw new TypeError("continuation stack cursor presence disagrees with its frame");
    }
    if (
      entry.cursor !== null &&
      frame.cursor !== null &&
      !guards.sameCursor(entry.cursor, frame.cursor)
    ) {
      throw new TypeError("continuation stack cursor disagrees with its frame");
    }
  }
  for (let index = 1; index < stack.length; index += 1) {
    if (stack[index]?.parentFrameId !== stack[index - 1]?.frameId) {
      throw new TypeError("continuation stack is not one root-to-leaf ancestor path");
    }
  }
  const stateIds = new Set(states.map(state => state.id));
  const evidenceIds = new Set(evidence.map(item => item.id));
  for (const item of evidence) {
    if (!stateIds.has(item.stateRef)) {
      throw new TypeError(`continuation evidence ${item.id} has unknown stateRef`);
    }
  }
  for (const frame of frames) {
    const frameControl = controlById.get(frame.frameId)!;
    if (
      frameControl.evaluation !== null &&
      frameControl.evaluation.evaluatedAtTransition > lastTrustedTransition
    ) {
      throw new TypeError(
        `continuation frame ${frame.frameId} evaluation exceeds lastTrustedTransition`,
      );
    }
    if (
      frameControl.evaluation !== null &&
      frameControl.evaluation.receipt.evaluatorId !== frameControl.evaluatorId
    ) {
      throw new TypeError(
        `continuation frame ${frame.frameId} evaluation evaluator disagrees`,
      );
    }
    if (frameControl.evaluation !== null) {
      assertRecursiveGoalEvaluationEvidenceRefs(
        frameControl.evaluation.receipt,
        evidence,
        `continuation frame ${frame.frameId} evaluation`,
      );
    }
    if (frameControl.progressBaseline !== null) {
      if (
        frameControl.progressBaseline.capturedAtTransition > lastTrustedTransition
      ) {
        throw new TypeError(
          `continuation frame ${frame.frameId} progress exceeds lastTrustedTransition`,
        );
      }
      if (!stateIds.has(frameControl.progressBaseline.stateRef)) {
        throw new TypeError(
          `continuation frame ${frame.frameId} progress has unknown state`,
        );
      }
      if (
        frameControl.progressBaseline.evaluation.evaluatorId !==
        frameControl.evaluatorId
      ) {
        throw new TypeError(
          `continuation frame ${frame.frameId} previous evaluation evaluator disagrees`,
        );
      }
      for (const evidenceRef of frameControl.progressBaseline.evaluation.evidenceRefs) {
        if (!evidenceIds.has(evidenceRef)) {
          throw new TypeError(
            `continuation frame ${frame.frameId} progress has unknown evidence`,
          );
        }
      }
    }
    if (frameControl.compositeCycleBaseline !== null) {
      if (
        frameControl.compositeCycleBaseline.capturedAtTransition >
        lastTrustedTransition
      ) {
        throw new TypeError(
          `continuation frame ${frame.frameId} composite cycle exceeds lastTrustedTransition`,
        );
      }
      if (!stateIds.has(frameControl.compositeCycleBaseline.stateRef)) {
        throw new TypeError(
          `continuation frame ${frame.frameId} composite cycle has unknown state`,
        );
      }
      if (
        frameControl.compositeCycleBaseline.evaluation.evaluatorId !==
        frameControl.evaluatorId
      ) {
        throw new TypeError(
          `continuation frame ${frame.frameId} composite cycle evaluator disagrees`,
        );
      }
      for (const evidenceRef of frameControl.compositeCycleBaseline.evaluation.evidenceRefs) {
        if (!evidenceIds.has(evidenceRef)) {
          throw new TypeError(
            `continuation frame ${frame.frameId} composite cycle has unknown evidence`,
          );
        }
      }
    }
    if (frameControl.obligationSnapshot !== null) {
      if (!stateIds.has(frameControl.obligationSnapshot.stateRef)) {
        throw new TypeError(
          `continuation frame ${frame.frameId} obligation has unknown state`,
        );
      }
      for (const evidenceRef of frameControl.obligationSnapshot.evidenceRefs) {
        if (!evidenceIds.has(evidenceRef)) {
          throw new TypeError(
            `continuation frame ${frame.frameId} obligation has unknown evidence`,
          );
        }
      }
      for (const condition of frameControl.obligationSnapshot.conditions) {
        if (condition.childFrameId !== null && !frameIds.has(condition.childFrameId)) {
          throw new TypeError(
            `continuation frame ${frame.frameId} obligation has unknown child frame`,
          );
        }
        for (const evidenceRef of condition.evidenceRefs) {
          if (!evidenceIds.has(evidenceRef)) {
            throw new TypeError(
              `continuation frame ${frame.frameId} obligation condition has unknown evidence`,
            );
          }
        }
      }
    }
  }
  const errorIds = new Set(errors.map(error => error.errorId));
  const atomicById = new Map(
    atomicResults.map(result => [result.dispatchId, result]),
  );
  const atomicIds = new Set(atomicById.keys());
  const ledgerById = new Map(ledger.map(effect => [effect.dispatchId, effect]));
  if (retryControl !== undefined) {
    for (const frameRetry of retryControl.frames) {
      const frame = frameById.get(frameRetry.frameId);
      const frameControl = controlById.get(frameRetry.frameId);
      if (frame === undefined || frameControl === undefined) {
        throw new TypeError(
          `continuation retry frame ${frameRetry.frameId} is unknown`,
        );
      }
      if (frameControl.selectorId !== retryControl.policy.selectorId) {
        throw new TypeError(
          `continuation retry frame ${frameRetry.frameId} selector disagrees with policy`,
        );
      }
      const lastAccountedIndex =
        frameRetry.lastAccountedDispatchId === null
          ? -1
          : frame.atomicResultRefs.indexOf(
              frameRetry.lastAccountedDispatchId,
            );
      if (
        frameRetry.lastAccountedDispatchId !== null &&
        lastAccountedIndex < 0
      ) {
        throw new TypeError(
          `continuation retry frame ${frameRetry.frameId} lastAccountedDispatchId is not a strategy attempt`,
        );
      }
      const accountedBySkill = new Map<string, string[]>();
      for (const dispatchId of frame.atomicResultRefs.slice(
        0,
        lastAccountedIndex + 1,
      )) {
        const result = atomicById.get(dispatchId);
        if (
          result === undefined ||
          result.frameId !== frameRetry.frameId ||
          !frameRetry.strategies.some(
            strategy => strategy.skillId === result.skillId,
          ) ||
          result.outcome !== "succeeded" ||
          result.executionErrorIds.length > 0 ||
          result.verificationErrorIds.length > 0 ||
          result.effect.knowledge !== "none" ||
          result.observedStateRef === null
        ) {
          throw new TypeError(
            `continuation retry frame ${frameRetry.frameId} contains an unsafe accounted dispatch`,
          );
        }
        const refs = accountedBySkill.get(result.skillId) ?? [];
        refs.push(result.dispatchId);
        accountedBySkill.set(result.skillId, refs);
      }
      for (const strategy of frameRetry.strategies) {
        const accountedRefs =
          accountedBySkill.get(strategy.skillId) ?? [];
        const countedFailures = strategy.failures.reduce(
          (total, failure) => total + failure.count,
          0,
        );
        if (countedFailures !== accountedRefs.length) {
          throw new TypeError(
            `continuation retry strategy ${strategy.skillId} counting history disagrees with accounted dispatches`,
          );
        }
        const latestAccountedRef = accountedRefs.at(-1) ?? null;
        if (strategy.latestAttemptRef !== latestAccountedRef) {
          throw new TypeError(
            `continuation retry strategy ${strategy.skillId} latest attempt disagrees with accounted dispatches`,
          );
        }
      }
    }
  }
  if (runControl.outcome === "yielded") {
    if (planningMode) {
      if (runControl.frameId === null || !hasPlanningActionBoundary) {
        throw new TypeError(
          "planning yielded continuation requires a frame id and action boundary",
        );
      }
    } else {
      if (runControl.frameId === null || retryControl === undefined) {
        throw new TypeError(
          "yielded continuation requires retry control and a frame id",
        );
      }
      const yieldedFrame = retryControl.frames.find(
        frame => frame.frameId === runControl.frameId,
      );
      if (
        yieldedFrame === undefined ||
        yieldedFrame.lastAccountedDispatchId === null
      ) {
        throw new TypeError(
          "yielded continuation requires an accounted retry dispatch",
        );
      }
    }
  }
  for (const frame of frames) {
    const pending = controlById.get(frame.frameId)?.pendingVerification;
    if (pending === null || pending === undefined) continue;
    const entry = stackByFrameId.get(frame.frameId);
    const proof = atomicById.get(frame.atomicResultRefs.at(-1) ?? "");
    const returnedProof = proof !== undefined && proof.dispatchId !== pending.dispatchId &&
      proof.outcome === "succeeded" && proof.executionErrorIds.length === 0 &&
      proof.verificationErrorIds.length === 0 && proof.observedStateRef !== null &&
      proof.observedStateRef === states.at(-1)?.id && evidence.some(item =>
        item.stateRef === proof.observedStateRef && item.validity === "valid");
    if (entry === undefined || (entry.phase !== "select" &&
        !(entry.phase === "evaluate" && returnedProof))) {
      throw new TypeError(`continuation frame ${frame.frameId} pending verification has no safe recovery phase`);
    }
    const effect = ledgerById.get(pending.dispatchId);
    const result = atomicById.get(pending.dispatchId);
    if (
      effect === undefined ||
      result === undefined ||
      frame.execution !== "completed" ||
      effect.frameId !== frame.frameId ||
      effect.skillId !== pending.skillId ||
      result.frameId !== frame.frameId ||
      result.skillId !== pending.skillId
    ) {
      throw new TypeError(
        `continuation frame ${frame.frameId} pending verification disagrees with its committed dispatch`,
      );
    }
    for (const errorId of pending.verificationErrorIds) {
      if (
        !errorIds.has(errorId) ||
        !result.verificationErrorIds.includes(errorId)
      ) {
        throw new TypeError(
          `continuation frame ${frame.frameId} pending verification has unknown error ${errorId}`,
        );
      }
    }
  }
  for (const result of atomicResults) {
    const effect = ledgerById.get(result.dispatchId);
    if (!effect) {
      throw new TypeError(`continuation atomic result ${result.dispatchId} lacks ledger`);
    }
    if (
      effect.frameId !== result.frameId ||
      effect.skillId !== result.skillId ||
      effect.knowledge !== result.effect.knowledge ||
      effect.receiptRef !== result.effect.receiptRef ||
      effect.confirmedEffects.length !== result.effect.confirmedEffects.length ||
      effect.confirmedEffects.some(
        (fact, index) =>
          !guards.sameEffectFact(fact, result.effect.confirmedEffects[index]!),
      )
    ) {
      throw new TypeError(
        `continuation atomic result ${result.dispatchId} disagrees with ledger`,
      );
    }
    for (const errorId of [...result.executionErrorIds, ...result.verificationErrorIds]) {
      if (!errorIds.has(errorId)) {
        throw new TypeError(`continuation atomic result has unknown error ${errorId}`);
      }
    }
    if (result.observedStateRef !== null && !stateIds.has(result.observedStateRef)) {
      throw new TypeError("continuation atomic result has unknown observed state");
    }
  }
  for (const error of errors) {
    if (error.origin.frameId !== null && !frameIds.has(error.origin.frameId)) {
      throw new TypeError(`continuation error ${error.errorId} has unknown origin frame`);
    }
    for (const propagation of error.propagation) {
      if (!frameIds.has(propagation.frameId)) {
        throw new TypeError(
          `continuation error ${error.errorId} has unknown propagation frame`,
        );
      }
      if (
        propagation.parentFrameId !== null &&
        !frameIds.has(propagation.parentFrameId)
      ) {
        throw new TypeError(
          `continuation error ${error.errorId} has unknown propagation parent`,
        );
      }
      if (propagation.satisfies !== null && !frameIds.has(propagation.satisfies.frameId)) {
        throw new TypeError(
          `continuation error ${error.errorId} has unknown satisfied frame`,
        );
      }
    }
    for (const atomicId of error.atomicResultRefs) {
      if (!atomicIds.has(atomicId)) {
        throw new TypeError(`continuation error ${error.errorId} has unknown atomic result`);
      }
    }
    if (error.cause?.kind === "error_ref" && !errorIds.has(error.cause.errorId)) {
      throw new TypeError(`continuation error ${error.errorId} has unknown cause`);
    }
  }
  const errorVisiting = new Set<string>();
  const errorSettled = new Set<string>();
  const errorById = new Map(errors.map(error => [error.errorId, error]));
  const visitError = (errorId: string): void => {
    if (errorVisiting.has(errorId)) throw new TypeError("continuation error causes contain a cycle");
    if (errorSettled.has(errorId)) return;
    errorVisiting.add(errorId);
    const cause = errorById.get(errorId)?.cause;
    if (cause?.kind === "error_ref") visitError(cause.errorId);
    errorVisiting.delete(errorId);
    errorSettled.add(errorId);
  };
  for (const error of errors) visitError(error.errorId);
  for (const frame of frames) {
    for (const evidenceRef of frame.evidenceRefs) {
      if (!evidenceIds.has(evidenceRef)) {
        throw new TypeError(`continuation frame ${frame.frameId} has unknown evidence`);
      }
    }
    for (const result of frame.conditionResults) {
      for (const evidenceRef of result.evidenceRefs) {
        if (!evidenceIds.has(evidenceRef)) {
          throw new TypeError(
            `continuation condition ${result.conditionId} has unknown evidence`,
          );
        }
      }
    }
    if (frame.errorId !== null && !errorIds.has(frame.errorId)) {
      throw new TypeError(`continuation frame ${frame.frameId} has unknown error`);
    }
    for (const dispatchRef of frame.dispatchRefs) {
      if (!ledgerById.has(dispatchRef)) {
        throw new TypeError(`continuation frame ${frame.frameId} has unknown dispatch`);
      }
    }
    for (const atomicRef of frame.atomicResultRefs) {
      if (!atomicIds.has(atomicRef)) {
        throw new TypeError(`continuation frame ${frame.frameId} has unknown atomic result`);
      }
    }
  }
  for (const effect of ledger) {
    if (!frameIds.has(effect.frameId)) {
      throw new TypeError(`continuation effect ${effect.dispatchId} has unknown frame`);
    }
  }
  const seenRemaining = new Set<string>();
  const remainingRequirements = value.remainingRequirements.map((entry, index) => {
    const label = `continuation.remainingRequirements[${index}]`;
    if (!isRecord(entry)) throw new TypeError(`${label} must be an object`);
    assertExactKeys(entry, ["frameId", "conditionId"], [], label);
    const frameId = nonEmptyString(entry.frameId, `${label}.frameId`);
    const conditionId = nonEmptyString(entry.conditionId, `${label}.conditionId`);
    const dependency = dependenciesById.get(dependencyKey(frameId, conditionId));
    if (!dependency) {
      throw new TypeError(`${label} has unknown condition definition`);
    }
    if (
      dependency.fact === "satisfied" ||
      dependency.fact === "not_applicable" ||
      dependency.condition.activation === "not_applicable"
    ) {
      throw new TypeError(`${label} is not an active remaining requirement`);
    }
    const key = dependencyKey(frameId, conditionId);
    if (seenRemaining.has(key)) throw new TypeError("remaining requirements contain a duplicate");
    seenRemaining.add(key);
    return { frameId, conditionId };
  });
  const expectedRemainingKeys = new Set(
    frames.flatMap(frame =>
      frame.unresolvedRequirements.map(conditionId =>
        dependencyKey(frame.frameId, conditionId),
      ),
    ),
  );
  if (
    expectedRemainingKeys.size !== seenRemaining.size ||
    [...expectedRemainingKeys].some(key => !seenRemaining.has(key))
  ) {
    throw new TypeError(
      "continuation remainingRequirements must equal frame unresolvedRequirements",
    );
  }
  if (lastTrustedTransition > budgetUsed.transitionsUsed) {
    throw new TypeError("continuation lastTrustedTransition exceeds budgetUsed");
  }
  if (
    rootEvaluation.state === "evaluated" &&
    rootEvaluation.evaluatedAtTransition > lastTrustedTransition
  ) {
    throw new TypeError("continuation root evaluation exceeds lastTrustedTransition");
  }
  if (rootEvaluation.state === "not_evaluated" && rootControl.evaluation !== null) {
    throw new TypeError("continuation root control has an untrusted evaluation");
  }
  if (rootEvaluation.state === "evaluated") {
    const rootFrameEvaluation = rootControl.evaluation;
    if (
      rootFrameEvaluation === null ||
      rootFrameEvaluation.evaluatedAtTransition !==
        rootEvaluation.evaluatedAtTransition ||
      rootFrameEvaluation.receipt.result !== rootEvaluation.result ||
      rootFrameEvaluation.receipt.satisfaction !== rootEvaluation.satisfaction ||
      rootFrameEvaluation.receipt.evaluatorId !== rootEvaluation.evaluatorId ||
      !sameStringSet(
        rootFrameEvaluation.receipt.evidenceRefs,
        rootEvaluation.evidenceRefs,
      )
    ) {
      throw new TypeError("continuation root evaluation disagrees with frame control");
    }
  }
  if (
    rootEvaluation.state === "evaluated" &&
    rootEvaluation.evaluatorId !== rootControl.evaluatorId
  ) {
    throw new TypeError("continuation root evaluation evaluator disagrees");
  }
  if (
    rootEvaluation.state === "evaluated" &&
    rootEvaluation.result === "satisfied" &&
    rootEvaluation.satisfaction !== null &&
    rootEvaluation.satisfaction < acceptedRoot.rootThreshold
  ) {
    throw new TypeError("continuation root satisfaction is below the accepted threshold");
  }
  for (const evidenceRef of rootEvaluation.state === "evaluated" ? rootEvaluation.evidenceRefs : []) {
    if (!evidenceIds.has(evidenceRef)) {
      throw new TypeError("continuation root evaluation has unknown evidence");
    }
  }
  if (
    rootEvaluation.state === "not_evaluated" &&
    rootEvaluation.blockedByErrorId !== null &&
    !errorIds.has(rootEvaluation.blockedByErrorId)
  ) {
    throw new TypeError("continuation root evaluation has unknown blocking error");
  }
  const primaryErrorId = nullableString(
    value.primaryErrorId,
    "continuation.primaryErrorId",
  );
  if (primaryErrorId !== null && !errorIds.has(primaryErrorId)) {
    throw new TypeError("continuation primaryErrorId is unknown");
  }
  for (const issue of relatedIssues) {
    if (!errorIds.has(issue.errorId)) {
      throw new TypeError(`continuation related issue ${issue.errorId} is unknown`);
    }
  }
  if (runControl.outcome === "completed") {
    throw new TypeError("a completed run must not expose a resumable continuation");
  }
  if (runControl.frameId !== null && !frameIds.has(runControl.frameId)) {
    throw new TypeError("continuation control has unknown frame");
  }
  if (
    runControl.frameId !== null &&
    !stack.some(entry => entry.frameId === runControl.frameId)
  ) {
    throw new TypeError("continuation control frame is outside the active stack");
  }
  return {
    acceptedRoot,
    lastTrustedTransition,
    rootEvaluation,
    control: runControl,
    frames,
    frameControls,
    stack,
    dependencies,
    states,
    evidence,
    ledger,
    atomicResults,
    errors,
    primaryErrorId,
    relatedIssues,
    budgetUsed,
    remainingRequirements,
    contractRefs,
    ...(retryControl === undefined ? {} : { retryControl }),
  };
}

function sameVersionedRefs(
  left: readonly PlanningContractRefs["resultModelRefs"][number][],
  right: readonly PlanningContractRefs["resultModelRefs"][number][],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.id === right[index]?.id &&
        entry.version === right[index]?.version,
    )
  );
}

function assertPlanningEvaluationRefs<G, S, B, E, F, R, C>(
  value: {
    readonly stateRef: string;
    readonly evidenceRefs: readonly string[];
    readonly evaluatedAtTransition: number;
  },
  base: Pick<
    RecursiveGoalContinuationBase<G, S, B, E, F, R, C>,
    "states" | "evidence" | "lastTrustedTransition"
  >,
  label: string,
): void {
  if (!base.states.some(state => state.id === value.stateRef)) {
    throw new TypeError(`${label}.stateRef is unknown`);
  }
  const evidenceById = new Map(base.evidence.map(item => [item.id, item]));
  for (const evidenceRef of value.evidenceRefs) {
    const evidence = evidenceById.get(evidenceRef);
    if (evidence === undefined || evidence.stateRef !== value.stateRef) {
      throw new TypeError(`${label} has an invalid evidence reference`);
    }
  }
  if (value.evaluatedAtTransition > base.lastTrustedTransition) {
    throw new TypeError(`${label} exceeds lastTrustedTransition`);
  }
}

function assertPlanningContinuationReferences<G, S, B, E, F, R, C>(
  base: RecursiveGoalContinuationBase<G, S, B, E, F, R, C>,
  planControl: PlanControl<G, B, S, E, F>,
  planningContract: PlanningContractRefs,
  actionBoundary: PlanningActionBoundary | null,
): void {
  const stateIds = new Set(base.states.map(state => state.id));
  const frameIds = new Set(base.frames.map(frame => frame.frameId));
  const ledgerById = new Map(base.ledger.map(effect => [effect.dispatchId, effect]));
  const atomicById = new Map(
    base.atomicResults.map(result => [result.dispatchId, result]),
  );
  const errorIds = new Set(base.errors.map(error => error.errorId));
  const plan = planControl.plan;
  if (plan !== null) {
    if (plan.rootRef !== base.acceptedRoot.rootFrameId) {
      throw new TypeError("continuation.planControl.plan root disagrees with accepted root");
    }
    if (!stateIds.has(plan.startStateRef)) {
      throw new TypeError("continuation.planControl.plan has an unknown startStateRef");
    }
    if (plan.horizonN !== planningContract.horizonN) {
      throw new TypeError("continuation.planControl.plan horizon disagrees with planningContract");
    }
    if (!sameVersionedRefs(plan.modelRefs, planningContract.resultModelRefs)) {
      throw new TypeError("continuation.planControl.plan models disagree with planningContract");
    }
    const checkpointIds = plan.checkpoints.map(checkpoint => checkpoint.id);
    if (
      checkpointIds.length !== planningContract.checkpointSpecRefs.length ||
      checkpointIds.some(
        (checkpointRef, index) =>
          checkpointRef !== planningContract.checkpointSpecRefs[index],
      )
    ) {
      throw new TypeError("continuation.planControl.plan checkpoints disagree with planningContract");
    }
  } else if (
    planningContract.checkpointSpecRefs.length > 0 ||
    planControl.usage.predictionCallsUsed > 0
  ) {
    throw new TypeError(
      "continuation.planControl cannot preserve planning history without a current plan",
    );
  }

  for (const checkpoint of planControl.verifiedCheckpoints) {
    assertPlanningEvaluationRefs(
      checkpoint.evaluation,
      base,
      `continuation.planControl.verifiedCheckpoint ${checkpoint.specRef}`,
    );
    if (
      plan === null ||
      !planningContract.checkpointSpecRefs.includes(checkpoint.specRef) ||
      (checkpoint.planRef === plan.planId && !plan.paths.some(path => path.pathId === checkpoint.cursor.pathRef))
    ) {
      throw new TypeError(
        `continuation.planControl.verifiedCheckpoint ${checkpoint.specRef} has invalid plan refs`,
      );
    }
  }

  for (const prior of planControl.failurePriors) {
    if (prior.rootRef !== base.acceptedRoot.rootFrameId) {
      throw new TypeError(`continuation.failurePrior ${prior.id} root is unknown`);
    }
    if (prior.source.kind === "verified_failure") {
      const atomic = atomicById.get(prior.source.dispatchId);
      const ledger = ledgerById.get(prior.source.dispatchId);
      if (
        atomic === undefined ||
        ledger === undefined ||
        prior.source.atomicResultRef !== prior.source.dispatchId ||
        atomic.skillId !== prior.skillRef.id || atomic.frameId !== prior.obligationRef.frameRef ||
        (atomic.outcome !== "failed" && atomic.outcome !== "rejected") || ledger.knowledge !== "none"
      ) {
        throw new TypeError(
          `continuation.failurePrior ${prior.id} has invalid failure source`,
        );
      }
      for (const errorRef of prior.source.errorRefs) {
        if (
          !errorIds.has(errorRef) ||
          ![
            ...atomic.executionErrorIds,
            ...atomic.verificationErrorIds,
          ].includes(errorRef)
        ) {
          throw new TypeError(
            `continuation.failurePrior ${prior.id} has unknown error ${errorRef}`,
          );
        }
      }
      const proof = prior.source.attribution;
      if (!sameVersionedRef(proof.capabilityRef, planningContract.capabilityRef) ||
        proof.stateRef !== atomic.observedStateRef || !stateIds.has(proof.stateRef) ||
        prior.conclusion.transitionRefs.some(ref => !proof.generatedTransitionRefs.includes(ref))) {
        throw new TypeError(`continuation.failurePrior ${prior.id} attribution is outside its observed transition`);
      }
      for (const ref of proof.evidenceRefs) {
        if (!base.evidence.some(e => e.id === ref && e.stateRef === proof.stateRef && e.validity === "valid")) {
          throw new TypeError(`continuation.failurePrior ${prior.id} attribution evidence is invalid`);
        }
      }
      if (plan?.planId === proof.planRef) {
        const node = plan.nodes.find(item => item.id === proof.nodeRef);
        if (node === undefined || !sameVersionedRef(node.skillRef, prior.skillRef) ||
          node.obligationRef.frameRef !== prior.obligationRef.frameRef ||
          !sameStringSet(node.predictedResults.map(item => item.transitionRef), proof.generatedTransitionRefs)) {
          throw new TypeError(`continuation.failurePrior ${prior.id} attribution disagrees with its generated node`);
        }
      }
    } else {
      assertPlanningEvaluationRefs(
        prior.source.evaluation,
        base,
        `continuation.failurePrior ${prior.id}.source.evaluation`,
      );
    }
    for (const transitionRef of prior.conclusion.transitionRefs) {
      if (!transitionRef.startsWith(`${prior.skillRef.id}@${prior.skillRef.version}:${prior.obligationRef.frameRef}:`)) {
        throw new TypeError(`continuation.failurePrior ${prior.id} transition is outside its skill and obligation`);
      }
    }
  }

  if (actionBoundary !== null) {
    const atomic = atomicById.get(actionBoundary.dispatchId);
    const ledger = ledgerById.get(actionBoundary.dispatchId);
    if (
      atomic === undefined ||
      ledger === undefined ||
      actionBoundary.atomicResultRef !== actionBoundary.dispatchId ||
      atomic.frameId !== actionBoundary.frameId ||
      ledger.frameId !== actionBoundary.frameId ||
      !frameIds.has(actionBoundary.frameId) ||
      atomic.observedStateRef !== actionBoundary.observedStateRef
    ) {
      throw new TypeError("continuation.actionBoundary has invalid dispatch references");
    }
    if (
      actionBoundary.observedStateRef !== null &&
      !stateIds.has(actionBoundary.observedStateRef)
    ) {
      throw new TypeError("continuation.actionBoundary has unknown observed state");
    }
    if (
      base.control.frameId !== null &&
      base.control.frameId !== actionBoundary.frameId
    ) {
      throw new TypeError("continuation.actionBoundary frame disagrees with control");
    }
  }
}

export function readRecursiveGoalContinuation<G, S, B, E, F, R, C>(
  value: unknown,
  guards: RecursiveGoalContinuationGuards<G, S, B, E, F, R, C>,
): RecursiveGoalContinuation<G, S, B, E, F, R, C> {
  return {
    schema: RECURSIVE_GOAL_CONTINUATION_SCHEMA,
    ...readRecursiveGoalContinuationBase(
      value,
      guards,
      RECURSIVE_GOAL_CONTINUATION_SCHEMA,
      false,
      false,
    ),
  };
}

export function readRecursiveGoalPlanningContinuation<G, S, B, E, F, R, C>(
  value: unknown,
  guards: RecursiveGoalContinuationGuards<G, S, B, E, F, R, C>,
): RecursiveGoalPlanningContinuation<G, S, B, E, F, R, C> {
  if (!isRecord(value)) throw new TypeError("continuation must be an object");
  const hasPlanningActionBoundary =
    Object.hasOwn(value, "actionBoundary") && value.actionBoundary !== null;
  const base = readRecursiveGoalContinuationBase(
    value,
    guards,
    RECURSIVE_GOAL_PLANNING_CONTINUATION_SCHEMA,
    true,
    hasPlanningActionBoundary,
  );
  const planningContract = readPlanningContractRefs(
    value.planningContract,
    "continuation.planningContract",
  );
  const planningGuards = {
    goal: guards.goal,
    bindings: guards.bindings,
    stateProjection: guards.state,
    evidenceProjection: guards.evidencePayload,
    effectFact: guards.effectFact,
    cursor: guards.cursor,
  };
  const planControl = readPlanControl(
    value.planControl,
    planningGuards,
    planningContract.limits,
    "continuation.planControl",
  );
  const actionBoundary =
    value.actionBoundary === null
      ? null
      : readPlanningActionBoundary(
          value.actionBoundary,
          "continuation.actionBoundary",
        );
  assertPlanningContinuationReferences(
    base,
    planControl,
    planningContract,
    actionBoundary,
  );
  return {
    schema: RECURSIVE_GOAL_PLANNING_CONTINUATION_SCHEMA,
    ...base,
    planControl,
    planningContract,
    actionBoundary,
  };
}

export function readRecursiveGoalResumableContinuation<G, S, B, E, F, R, C>(
  value: unknown,
  guards: RecursiveGoalContinuationGuards<G, S, B, E, F, R, C>,
): RecursiveGoalResumableContinuation<G, S, B, E, F, R, C> {
  if (!isRecord(value)) throw new TypeError("continuation must be an object");
  if (value.schema === RECURSIVE_GOAL_CONTINUATION_SCHEMA) {
    return readRecursiveGoalContinuation(value, guards);
  }
  if (value.schema === RECURSIVE_GOAL_PLANNING_CONTINUATION_SCHEMA) {
    return readRecursiveGoalPlanningContinuation(value, guards);
  }
  throw new TypeError("continuation.schema is not a supported version");
}
