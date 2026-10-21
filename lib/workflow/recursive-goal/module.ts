import { fileURLToPath } from "node:url";
import {resolvePlanningDecision} from "./decision-contracts.js";
import {readPlanningEntryAssessment, type GoalGraphPlan, type PathCandidate, type PlanNode, type PlanEdge} from "./planning-contracts.js";

import type {
  EmitOptions,
  NodeDefinition,
  WorkflowRunFailure,
} from "../../core/contracts.js";
import { createWorkflowInputEvent } from "../../core/events.js";
import {
  WorkflowContractError,
  WorkflowRunError,
} from "../../core/errors.js";
import { compileWorkflow } from "../compiler.js";
import { loadWorkflow } from "../loader.js";
import { runWorkflow } from "../runner.js";
import {
  RECURSIVE_GOAL_CONTINUATION_SCHEMA,
  assertBoundedPlanningCapabilityContract,
  assertBoundedPlanningPresence,
  assertRecursiveGoalInitialObservationContinuationBoundary,
  readAdapterDiagnostic,
  readAtomicReceipt,
  readBoundedRetryPolicy,
  readDerivationReceipt,
  readEnabledEvaluator,
  readEnabledSkill,
  readEvaluationReceipt,
  readGoalGraphPlan,
  readRecursiveGoalInitialObservation,
  readRecursiveGoalResumableContinuation,
  readRecursiveGoalRequestEnvelope,
  readSelectorBinding,
  readSelection,
  sameAcceptedRoot,
  sameRecursiveGoalObligation,
  sameStringSet,
  sameVersionedRef,
  type AdapterDiagnostic,
  type AcceptedRoot,
  type AtomicExecutionResult,
  type AtomicReceipt,
  type BoundedRetryPolicy,
  type BoundedPlanningCapability,
  type BoundedPlanningRequest,
  type BudgetUsed,
  type ConditionFact,
  type DependencyState,
  type DerivedCondition,
  type EffectKnowledge,
  type EffectRecord,
  type EnabledEvaluator,
  type EnabledSkill,
  type ErrorPropagation,
  type EvaluationReceipt,
  type EvidenceRecord,
  type FrameResult,
  type RecursiveGoalAdapter,
  type RecursiveGoalAtomicOutcome,
  type RecursiveGoalComparators,
  type RecursiveGoalContinuation,
  type RecursiveGoalControl,
  type RecursiveGoalControlOutcome,
  type RecursiveGoalDependencies,
  type RecursiveGoalErrorCode,
  type RecursiveGoalErrorDiagnostic,
  type RecursiveGoalErrorStage,
  type RecursiveGoalExecution,
  type RecursiveGoalFact,
  type RecursiveGoalFrameControl,
  type RecursiveGoalFrameEvaluation,
  type RecursiveGoalFrameStackEntry,
  type RecursiveGoalInitialObservation,
  type RecursiveGoalLimits,
  type RecursiveGoalMode,
  type RecursiveGoalModuleFault,
  type RecursiveGoalObligationSnapshot,
  type RecursiveGoalPartialRunReport,
  type RecursiveGoalPlanningContinuation,
  type RecursiveGoalPendingVerification,
  type RecursiveGoalProgressBaseline,
  type RecursiveGoalRequestEnvelope,
  type RecursiveGoalResumableContinuation,
  type RecursiveGoalResponse,
  type RecursiveGoalRetryControl,
  type RecursiveGoalRunReport,
  type RecursiveGoalRunResult,
  type RecursiveGoalStopReason,
  type RecursiveGoalUnexecutedReason,
  type RemainingRequirement,
  type RelatedIssue,
  type RetryAssessment,
  type RetrySelectionView,
  type RootEvaluation,
  type SelectorBinding,
  type StateRecord,
  type ValidatedRequest,
  type PlanControl,
  type PlanningActionBoundary,
  type PlanningContractRefs,
  type PlanningDecision,
  type PlanningReport,
  type PlanningSelectionView,
  type PredictionResult,
  type PriorAssessment,
} from "./contracts.js";
import {
  emptyPlanControl,
  expandGoalGraph,
  type ExpandGoalGraphOutput,
} from "./planning.js";
import {
  ModuleInvariantError,
  RecursiveGoalDiagnosticFactory,
} from "./errors.js";

const BIND_OPERATOR = "goal.recursive.bind";
const RUN_OPERATOR = "goal.recursive.run";
const REPORT_OPERATOR = "goal.recursive.report";
const OPERATOR_VERSION = "0.2.0";
const CONTEXT_EVENT_TYPE = "recursive-goal.context";
const OUTCOME_EVENT_TYPE = "recursive-goal.outcome";
const RESULT_EVENT_TYPE = "recursive-goal.result";

interface NormalizedDependencies<G, S, B, E, F, R, C> {
  readonly adapter: RecursiveGoalAdapter<G, S, B, E, F, R, C>;
  readonly enabledSkills: readonly EnabledSkill[];
  readonly skillsById: ReadonlyMap<string, EnabledSkill>;
  readonly enabledEvaluators: readonly EnabledEvaluator[];
  readonly evaluatorsById: ReadonlyMap<string, EnabledEvaluator>;
  readonly selectors: readonly SelectorBinding[];
  readonly selectorsById: ReadonlyMap<string, SelectorBinding>;
  readonly comparators: RecursiveGoalComparators<G, B, S, E>;
  readonly grantedEffects: ReadonlySet<string>;
  readonly planning: BoundedPlanningCapability<G, B, S, E, F, C> | null;
  readonly signal: AbortSignal | null;
}

interface Admission<G, S, B, E, F, R, C> {
  readonly envelope: RecursiveGoalRequestEnvelope;
  readonly validated: ValidatedRequest<G, S, B, E, F, R, C>;
  readonly continuation: RecursiveGoalResumableContinuation<
    G,
    S,
    B,
    E,
    F,
    R,
    C
  > | null;
  readonly acceptedRoot: AcceptedRoot<G, B>;
  readonly dependencies: NormalizedDependencies<G, S, B, E, F, R, C>;
}

interface InternalCondition<G, B> {
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
  fact: RecursiveGoalFact;
  satisfaction: number | null;
  observedEvaluatorId: string | null;
  evidenceRefs: readonly string[];
  childFrameId: string | null;
  execution: RecursiveGoalExecution;
  errorId: string | null;
}

interface InternalFrame<G, B, C> {
  readonly frameId: string;
  readonly rootRef: string;
  readonly parentFrameId: string | null;
  readonly fulfillsConditionId: string | null;
  readonly goal: G;
  readonly bindings: B;
  readonly satisfactionThreshold: number;
  readonly evaluatorId: string;
  readonly selectorId: string;
  readonly depth: number;
  readonly effectScope: ReadonlySet<string>;
  readonly expectedMode: RecursiveGoalMode | null;
  mode: RecursiveGoalMode;
  selectedSkillId: string | null;
  cursor: C | null;
  conditions: Map<string, InternalCondition<G, B>>;
  phase: RecursiveGoalFrameStackEntry<C>["phase"];
  derivationClosed: boolean;
  fact: RecursiveGoalFact;
  execution: RecursiveGoalExecution;
  unexecutedReason: RecursiveGoalUnexecutedReason;
  errorId: string | null;
  evidenceRefs: string[];
  dispatchRefs: string[];
  atomicResultRefs: string[];
  noProgressCount: number;
  lastEvaluation: EvaluationReceipt | null;
  lastEvaluationAtTransition: number | null;
  progressBaseline: RecursiveGoalProgressBaseline | null;
  pendingVerification: RecursiveGoalPendingVerification | null;
  obligationSnapshot: RecursiveGoalObligationSnapshot | null;
  pendingProgressCheck: boolean;
  safeRetrySkill: boolean;
  lastAttemptEffectKnowledge: EffectKnowledge | null;
  lastAtomicOutcome: RecursiveGoalAtomicOutcome | null;
}

interface AtomicOutcomeProjection<F, R> {
  readonly result: AtomicExecutionResult<F, R>;
  readonly executionErrorIds: readonly string[];
  readonly verificationErrorIds: readonly string[];
}

interface MutableStrategyRetryState {
  readonly skillId: string;
  readonly failures: { failureKey: string; count: number }[];
  exhausted: boolean;
  latestAttemptRef: string | null;
}

interface MutableFrameStrategyRetryState {
  readonly frameId: string;
  lockedSkillId: string | null;
  readonly strategies: MutableStrategyRetryState[];
  lastAccountedDispatchId: string | null;
}

interface MutableRecursiveGoalRetryControl {
  readonly policy: BoundedRetryPolicy;
  atomicAttemptsUsed: number;
  readonly frames: MutableFrameStrategyRetryState[];
}

interface StopDiagnosticSpec {
  readonly code: RecursiveGoalErrorCode;
  readonly stage: RecursiveGoalErrorStage;
  readonly message: string;
  readonly origin?: {
    readonly frameId?: string | null;
    readonly skillId?: string | null;
    readonly conditionId?: string | null;
    readonly evaluatorId?: string | null;
    readonly nodeId?: string | null;
  };
  readonly owner?: "module" | "adapter" | "workflow";
  readonly category?: string;
  readonly nativeCode?: string | null;
  readonly effectKnowledge?: EffectKnowledge;
  readonly atomicResultRefs?: readonly string[];
  readonly cause?: ReturnType<RecursiveGoalDiagnosticFactory["capturedCause"]> | null;
}

export async function runRecursiveGoal<G, S, B, E, F, R, C>(
  request: unknown,
  deps: RecursiveGoalDependencies<G, S, B, E, F, R, C>,
): Promise<RecursiveGoalResponse<G, S, B, E, F, R, C>> {
  const requestId = requestIdFromUnknown(request);
  const diagnostics = new RecursiveGoalDiagnosticFactory(requestId);
  let envelope: RecursiveGoalRequestEnvelope;
  try {
    envelope = freezeSnapshot(readRecursiveGoalRequestEnvelope(request));
  } catch (error) {
    return requestRejected(
      requestId,
      diagnostics.create({
        code: "invalid_request",
        stage: "admission",
        message: errorMessage(error),
        category: "request_envelope",
        cause: null,
      }),
    );
  }

  let normalized: NormalizedDependencies<G, S, B, E, F, R, C>;
  try {
    normalized = normalizeDependencies(deps);
    validateAdmissionVocabulary(envelope, normalized);
  } catch (error) {
    return requestRejected(
      envelope.requestId,
      diagnostics.create({
        code: "invalid_request",
        stage: "admission",
        message: errorMessage(error),
        category: "dependency_contract",
        cause: null,
      }),
    );
  }

  let validated: ValidatedRequest<G, S, B, E, F, R, C>;
  try {
    validated = freezeSnapshot(
      await normalized.adapter.validateRequest(snapshotData(envelope)),
    );
    validateValidatedRequest(envelope, validated, normalized.comparators);
    if (validated.planning !== undefined) {
      if (normalized.planning === null) {
        throw new TypeError(
          "validated.planning requires dependencies.planning",
        );
      }
      assertBoundedPlanningCapabilityContract(
        validated.planning,
        normalized.planning,
        "validated.planning",
      );
    }
  } catch (error) {
    return requestRejected(
      envelope.requestId,
      diagnostics.create({
        code: "invalid_binding",
        stage: "binding",
        owner: "adapter",
        category: "request_validation",
        message: errorMessage(error),
        cause: diagnostics.capturedCause(error),
      }),
    );
  }

  let continuation: RecursiveGoalResumableContinuation<
    G,
    S,
    B,
    E,
    F,
    R,
    C
  > | null = null;
  try {
    continuation = readValidatedContinuation(validated.continuation, normalized);
    validatePlanningContinuationAdmission(
      continuation,
      validated,
      normalized,
    );
  } catch (error) {
    return requestRejected(
      envelope.requestId,
      diagnostics.create({
        code: "invalid_binding",
        stage: "binding",
        owner: "adapter",
        category: "continuation",
        message: errorMessage(error),
        cause: diagnostics.capturedCause(error),
      }),
    );
  }

  let acceptedRoot: AcceptedRoot<G, B>;
  try {
    acceptedRoot = freezeSnapshot({
      requestId: validated.requestId,
      rootFrameId:
        continuation?.acceptedRoot.rootFrameId ?? `${validated.requestId}:root`,
      rootGoal: validated.rootGoal,
      rootThreshold: validated.satisfactionThreshold,
      rootBindings: validated.rootBindings,
    });
  } catch (error) {
    return requestRejected(
      envelope.requestId,
      diagnostics.create({
        code: "invalid_binding",
        stage: "binding",
        owner: "adapter",
        category: "accepted_root_snapshot",
        message: errorMessage(error),
        cause: diagnostics.capturedCause(error),
      }),
    );
  }

  try {
    if (continuation !== null) {
      if (
        !sameAcceptedRoot(
          acceptedRoot,
          continuation.acceptedRoot,
          normalized.comparators,
        )
      ) {
        throw new TypeError("continuation accepted root differs from the request");
      }
      validateContinuationContracts(
        continuation,
        normalized,
        validated.retryPolicy,
      );
      diagnostics.reserveIds(continuation.errors.map(error => error.errorId));
    }
  } catch (error) {
    return requestRejected(
      envelope.requestId,
      diagnostics.create({
        code: "invalid_binding",
        stage: "binding",
        owner: "adapter",
        category: "continuation_contract",
        message: errorMessage(error),
        cause: diagnostics.capturedCause(error),
      }),
    );
  }

  const admission: Admission<G, S, B, E, F, R, C> = {
    envelope,
    validated,
    continuation,
    acceptedRoot,
    dependencies: normalized,
  };
  const controller = new RecursiveGoalRuntime(admission, diagnostics);

  try {
    const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const configPath = fileURLToPath(
      new URL("../../../workflows/recursive-goal.workflow.json", import.meta.url),
    );
    const definition = await loadWorkflow({
      configPath,
      allowedRoot: projectRoot,
    });
    const compiled = compileWorkflow(definition, {
      nodeDefinitions: controller.nodeDefinitions(),
      grantedEffects: [],
    });
    const inputEvent = createWorkflowInputEvent({
      runId: validated.requestId,
      eventId: `${validated.requestId}:workflow-input`,
      port: "recursive_goal_request",
      type: "recursive-goal.request",
      correlation: { itemKey: validated.requestId },
      payload: envelope,
    });
    const workflowResult = await runWorkflow(compiled, inputEvent);
    if (workflowResult.status === "failed") {
      return controller.finalizeWorkflowFailure(
        workflowResult.error,
        workflowResult.events.map(event => event.eventId),
      );
    }
    if (!isRunResultPayload(workflowResult.outputEvent.payload)) {
      throw new ModuleInvariantError(
        "recursive goal report operator returned a non-result payload",
      );
    }
    return workflowResult.outputEvent.payload as RecursiveGoalRunResult<
      G,
      S,
      B,
      E,
      F,
      R,
      C
    >;
  } catch (error) {
    if (error instanceof ModuleInvariantError) {
      return controller.moduleFault(error);
    }
    return controller.finalizeWorkflowFailure(
      workflowFailureFrom(error),
      workflowFailureRefs(error),
    );
  }
}

class RecursiveGoalRuntime<G, S, B, E, F, R, C> {
  private readonly envelope: RecursiveGoalRequestEnvelope;
  private readonly validated: ValidatedRequest<G, S, B, E, F, R, C>;
  private readonly deps: NormalizedDependencies<G, S, B, E, F, R, C>;
  private readonly diagnostics: RecursiveGoalDiagnosticFactory;
  private readonly acceptedRoot: AcceptedRoot<G, B>;
  private readonly frames = new Map<string, InternalFrame<G, B, C>>();
  private readonly stack: InternalFrame<G, B, C>[] = [];
  private states: StateRecord<S>[];
  private evidence: EvidenceRecord<E>[];
  private ledger: EffectRecord<F>[];
  private atomicResults: AtomicExecutionResult<F, R>[];
  private errors: RecursiveGoalErrorDiagnostic[];
  private primaryErrorId: string | null;
  private relatedIssues: RelatedIssue[];
  private transitionsUsed: number;
  private derivedGoalsUsed: number;
  private rootEvaluation: RootEvaluation;
  private control: RecursiveGoalControl | null;
  private rootFrame: InternalFrame<G, B, C>;
  private finished = false;
  private cleanupReceipt: { readonly receiptId: string } | null = null;
  private collectionReceipt: { readonly receiptId: string } | null = null;
  private sideEffectsFinalized = false;
  private retryControl: MutableRecursiveGoalRetryControl | null = null;
  private readonly planningMode: boolean;
  private readonly planningRequest: BoundedPlanningRequest<G, B> | null;
  private readonly planningCapability: BoundedPlanningCapability<
    G,
    B,
    S,
    E,
    F,
    C
  > | null;
  private readonly planningContract: PlanningContractRefs | null;
  private planControl: PlanControl<G, B, S, E, F> | null;
  private planningActionBoundary: PlanningActionBoundary | null;
  private planningReport: PlanningReport | null;
  private readonly invocationLimit: 1 | null;
  private atomicDispatchesThisInvocation = 0;

  constructor(
    admission: Admission<G, S, B, E, F, R, C>,
    diagnostics: RecursiveGoalDiagnosticFactory,
  ) {
    this.envelope = admission.envelope;
    this.validated = admission.validated;
    this.deps = admission.dependencies;
    this.diagnostics = diagnostics;
    this.acceptedRoot = admission.acceptedRoot;
    this.invocationLimit = admission.envelope.invocation?.maxAtomicDispatches ?? null;
    this.planningRequest = admission.validated.planning ?? null;
    this.planningCapability = admission.dependencies.planning;
    this.planningMode = this.planningRequest !== null;
    this.planningContract =
      this.planningRequest === null
        ? null
        : {
            capabilityRef: this.planningRequest.capabilityRef,
            resultModelRefs: [...this.planningRequest.resultModelRefs],
            preference: this.planningRequest.preference,
            checkpointSpecRefs: this.planningRequest.checkpointSpecs.map(
              checkpoint => checkpoint.id,
            ),
            horizonN: this.planningRequest.horizonN,
            limits: this.planningRequest.limits,
            ...(this.planningCapability?.decision===undefined ? {} : {decisionRef:this.planningCapability.decision.ref}),
          };
    this.planControl =
      admission.continuation?.schema ===
      "nnanything.recursive-goal.continuation.v2"
        ? admission.continuation.planControl
        : this.planningMode ? emptyPlanControl<G, B, S, E, F>() : null;
    this.planningActionBoundary = null;
    this.planningReport = null;
    if(this.planControl?.plan !== null && this.planControl?.plan !== undefined && this.planControl.currentPathRef !== null) {
      const plan=this.planControl.plan;
      this.planningReport={kind:"bounded_goal_planning_report.v1",prediction:{kind:"ready",transitionRef:plan.planId,rootRef:plan.rootRef,startStateRef:plan.startStateRef,planRef:plan.planId,rankedPathRefs:[this.planControl.currentPathRef,...this.planControl.alternatePathRefs],frontier:plan.frontier,predictionCallsUsed:this.planControl.usage.predictionCallsUsed},decision:null,priorAssessments:[]};
    }

    if (admission.continuation === null) {
      this.rootEvaluation = {
        state: "not_evaluated",
        reason: "not_reached",
        blockedByErrorId: null,
      };
      this.control = null;
      const initialObservation = admission.validated.initialObservation;
      this.states = [
        {
          id:
            initialObservation?.stateId ??
            `${this.acceptedRoot.rootFrameId}:state:initial`,
          value: admission.validated.state,
        },
      ];
      this.evidence =
        initialObservation === undefined
          ? []
          : initialObservation.evidence.map(item => ({ ...item }));
      this.ledger = [];
      this.atomicResults = [];
      this.errors = [];
      this.primaryErrorId = null;
      this.relatedIssues = [];
      this.transitionsUsed = 0;
      this.derivedGoalsUsed = 0;
      this.rootFrame = this.createRootFrame();
      this.frames.set(this.rootFrame.frameId, this.rootFrame);
      this.stack.push(this.rootFrame);
      if (this.validated.retryPolicy !== undefined) {
        this.retryControl = {
          policy: cloneRetryPolicy(this.validated.retryPolicy),
          atomicAttemptsUsed: 0,
          frames: [],
        };
        this.ensureRetryFrame(this.rootFrame);
      }
      return;
    }

    const continuation = admission.continuation;
    if (continuation.schema === "nnanything.recursive-goal.continuation.v2") {
      this.planningActionBoundary = continuation.actionBoundary;
    }
    this.rootEvaluation = continuation.rootEvaluation;
    this.control = continuation.control;
    this.states =
      continuation.states.length > 0
        ? continuation.states.map(state => ({ ...state }))
        : [
            {
              id: `${this.acceptedRoot.rootFrameId}:state:initial`,
              value: admission.validated.state,
            },
          ];
    this.evidence = continuation.evidence.map(item => ({ ...item }));
    this.ledger = continuation.ledger.map(item => ({ ...item }));
    this.atomicResults = continuation.atomicResults.map(item => ({ ...item }));
    this.errors = continuation.errors.map(error => cloneDiagnostic(error));
    this.primaryErrorId = continuation.primaryErrorId;
    this.relatedIssues = continuation.relatedIssues.map(issue => ({ ...issue }));
    this.transitionsUsed = continuation.budgetUsed.transitionsUsed;
    this.derivedGoalsUsed = continuation.budgetUsed.derivedGoalsUsed;
    this.retryControl =
      continuation.retryControl === undefined
        ? null
        : cloneRetryControl(continuation.retryControl);
    this.restoreFrames(continuation);
    this.rootFrame = this.frames.get(this.acceptedRoot.rootFrameId)!;
    if (this.rootFrame === undefined) {
      throw new ModuleInvariantError("continuation root frame was not restored");
    }
    this.restoreStack(continuation);
    if(this.planningActionBoundary?.nextPhase === "evaluate_actual") {
      const boundary=this.planningActionBoundary;
      const frame=this.frames.get(boundary.frameId)!;
      const atomic=this.atomicResults.find(result=>result.dispatchId===boundary.dispatchId)!;
      const skill=this.deps.skillsById.get(atomic.skillId)!;
      frame.pendingProgressCheck=true;
      frame.safeRetrySkill=skill.retry === "completed_no_effect";
      frame.lastAtomicOutcome=atomic.outcome;
      frame.lastAttemptEffectKnowledge=atomic.effect.knowledge;
    }
  }

  nodeDefinitions(): readonly NodeDefinition[] {
    const bind: NodeDefinition<undefined, unknown> = {
      operator: BIND_OPERATOR,
      version: OPERATOR_VERSION,
      inputPorts: [
        {
          name: "recursive_goal_request",
          schemaId: "nnanything.recursive-goal.request.v1",
          eventType: "recursive-goal.request",
          validate: value => value,
        },
      ],
      outputPort: {
        name: "recursive_goal_context",
        schemaId: "nnanything.recursive-goal.context.v1",
        eventType: CONTEXT_EVENT_TYPE,
        validate: validateContextPayload,
      },
      execute: context =>
        context.emit({
          requestId: this.acceptedRoot.requestId,
          rootFrameId: this.acceptedRoot.rootFrameId,
        }),
    };

    const run: NodeDefinition<undefined, unknown> = {
      operator: RUN_OPERATOR,
      version: OPERATOR_VERSION,
      inputPorts: [
        {
          name: "recursive_goal_context",
          schemaId: "nnanything.recursive-goal.context.v1",
          eventType: CONTEXT_EVENT_TYPE,
          validate: validateContextPayload,
        },
      ],
      outputPort: {
        name: "recursive_goal_outcome",
        schemaId: "nnanything.recursive-goal.outcome.v1",
        eventType: OUTCOME_EVENT_TYPE,
        validate: validateOutcomePayload,
      },
      execute: async context => {
        await this.run();
        return context.emit({
          requestId: this.acceptedRoot.requestId,
          rootFrameId: this.acceptedRoot.rootFrameId,
        });
      },
    };

    const report: NodeDefinition<undefined, unknown> = {
      operator: REPORT_OPERATOR,
      version: OPERATOR_VERSION,
      inputPorts: [
        {
          name: "recursive_goal_outcome",
          schemaId: "nnanything.recursive-goal.outcome.v1",
          eventType: OUTCOME_EVENT_TYPE,
          validate: validateOutcomePayload,
        },
      ],
      outputPort: {
        name: "recursive_goal_result",
        schemaId: "nnanything.recursive-goal.result.v1",
        eventType: RESULT_EVENT_TYPE,
        validate: validateRunResultPayload,
      },
      execute: async context => {
        const result = await this.buildRunResult();
        return context.emit(result);
      },
    };

    return [bind, run, report];
  }

  finalizeWorkflowFailure(
    failure: Pick<WorkflowRunFailure, "category" | "message" | "nodeId">,
    refs: readonly string[] = [],
  ): RecursiveGoalRunResult<G, S, B, E, F, R, C> {
    const diagnostic = this.diagnostics.fromWorkflow(failure, refs);
    this.addDiagnostic(diagnostic);
    this.primaryErrorId = diagnostic.errorId;
    if (this.rootEvaluation.state === "not_evaluated") {
      this.rootEvaluation = {
        state: "not_evaluated",
        reason: "runner_fault",
        blockedByErrorId: diagnostic.errorId,
      };
    }
    this.rootFrame.errorId = diagnostic.errorId;
    this.propagateDiagnostic(this.rootFrame, diagnostic);
    this.control = {
      outcome: "error",
      stopReason: "fatal_error",
      frameId: this.rootFrame.frameId,
    };
    this.finished = true;
    return this.buildRunResultSync();
  }

  moduleFault(error: unknown): RecursiveGoalModuleFault<G, S, B, E, F, R, C> {
    const diagnostic = this.diagnostics.create({
      code: "workflow_failure",
      stage: "finalization",
      message: errorMessage(error),
      category: "module_invariant",
      owner: "module",
      cause: this.diagnostics.capturedCause(error),
      effectKnowledge: aggregateEffectKnowledge(this.ledger),
    });
    const report = this.partialReport(diagnostic);
    return {
      kind: "module_fault",
      requestId: this.acceptedRoot.requestId,
      acceptedRoot: this.acceptedRoot,
      report,
      fault: diagnostic,
      knownBoundary: {
        evidence:
          this.evidence.length === 0
            ? "none"
            : report === null
              ? "partial"
              : "retained",
        effects: boundaryEffects(this.ledger),
      },
    };
  }

  private createRootFrame(): InternalFrame<G, B, C> {
    return {
      frameId: this.acceptedRoot.rootFrameId,
      rootRef: this.acceptedRoot.rootFrameId,
      parentFrameId: null,
      fulfillsConditionId: null,
      goal: this.acceptedRoot.rootGoal,
      bindings: this.acceptedRoot.rootBindings,
      satisfactionThreshold: this.acceptedRoot.rootThreshold,
      evaluatorId: this.validated.rootEvaluatorId,
      selectorId: this.validated.rootSelectorId,
      depth: 0,
      effectScope: this.deps.grantedEffects,
      expectedMode: null,
      mode: "composite",
      selectedSkillId: null,
      cursor: null,
      conditions: new Map(),
      phase: "evaluate",
      derivationClosed: false,
      fact: "not_evaluated",
      execution: "not_started",
      unexecutedReason: null,
      errorId: null,
      evidenceRefs: [],
      dispatchRefs: [],
      atomicResultRefs: [],
      noProgressCount: 0,
      lastEvaluation: null,
      lastEvaluationAtTransition: null,
      progressBaseline: null,
      pendingVerification: null,
      obligationSnapshot: null,
      pendingProgressCheck: false,
      safeRetrySkill: false,
      lastAttemptEffectKnowledge: null,
      lastAtomicOutcome: null,
    };
  }

  private async run(): Promise<void> {
    while (!this.finished) {
      if (this.deps.signal?.aborted === true) {
        this.stopCancelled(this.currentFrame());
        return;
      }
      const frame = this.currentFrame();
      switch (frame.phase) {
        case "evaluate":
          await this.evaluateFrame(frame);
          break;
        case "select":
          await this.selectSkill(frame);
          break;
        case "derive":
          await this.deriveConditions(frame);
          break;
        case "await_children":
          await this.awaitChildren(frame);
          break;
        case "aggregate":
          await this.aggregateFrame(frame);
          break;
        default:
          throw new ModuleInvariantError(
            `unknown recursive goal frame phase ${String(frame.phase)}`,
          );
      }
    }
  }

  private async evaluateFrame(frame: InternalFrame<G, B, C>): Promise<void> {
    const verificationProof = this.pendingVerificationProof(frame);
    if (frame.pendingVerification !== null && verificationProof === null) {
      frame.phase = "select";
      return;
    }
    if (!this.beginTransition(frame, "evaluation")) return;
    const evaluatesCommittedAtomic = frame.pendingProgressCheck;
    let receipt: EvaluationReceipt;
    let raw: unknown;
    try {
      raw = await this.deps.adapter.evaluate({
        context: this.context(frame),
        goal: this.callbackGoal(frame.goal),
        satisfactionThreshold: frame.satisfactionThreshold,
        bindings: this.callbackBindings(frame.bindings),
        state: this.callbackState(),
        evidence: this.callbackEvidence(),
        conditions: this.callbackConditions(frame),
      });
      receipt = readEvaluationReceipt(raw, frame.satisfactionThreshold);
      if (receipt.evaluatorId !== frame.evaluatorId) {
        throw new TypeError(
          `evaluation used ${receipt.evaluatorId}; expected ${frame.evaluatorId}`,
        );
      }
      if (!this.deps.evaluatorsById.has(receipt.evaluatorId)) {
        throw new TypeError(`evaluation used disabled evaluator ${receipt.evaluatorId}`);
      }
      const evidenceFailure = this.evaluationEvidenceFailure(receipt);
      if (evidenceFailure !== null) {
        this.stopWithNewDiagnostic(
          frame,
          evidenceFailure,
          "error",
          "fatal_error",
        );
        return;
      }
      if (frame.pendingVerification !== null && receipt.result === "satisfied") {
        const proofState = verificationProof!.observedStateRef;
        const hasProof = receipt.evidenceRefs.some(id => this.evidence.some(item =>
          item.id === id && item.stateRef === proofState && item.validity === "valid"));
        if (!hasProof) {
          this.stopPendingVerificationWithNewDiagnostic(frame, {
            code: "evidence_unavailable", stage: "observation",
            message: "goal evaluation does not reference the returned verification evidence",
            category: "pending_verification_evidence",
          });
          return;
        }
        frame.pendingVerification = null;
      }
      this.consumeProgress(frame, receipt);
      frame.lastEvaluation = receipt;
      frame.lastEvaluationAtTransition = this.transitionsUsed;
      frame.progressBaseline = {
        stateRef: this.currentStateRecord().id,
        evaluation: receipt,
        capturedAtTransition: this.transitionsUsed,
      };
      frame.pendingProgressCheck = false;
      frame.fact = receipt.result;
      frame.evidenceRefs = mergeStrings(frame.evidenceRefs, receipt.evidenceRefs);
      if (frame.frameId === this.rootFrame.frameId) {
        this.rootEvaluation = {
          state: "evaluated",
          result: receipt.result,
          satisfaction: receipt.satisfaction,
          evaluatorId: receipt.evaluatorId,
          evidenceRefs: [...receipt.evidenceRefs],
          evaluatedAtTransition: this.transitionsUsed,
        };
      }
    } catch (error) {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "adapter_contract_invalid",
          stage: "evaluation",
          message: errorMessage(error),
          owner: "adapter",
          category: "evaluate",
          effectKnowledge: this.frameEffectKnowledge(frame),
          cause: this.diagnostics.capturedCause(error),
        },
        "error",
        "fatal_error",
      );
      return;
    }

    if (this.planningMode) {
      try {if(!(await this.reconcilePlanning(frame,receipt))) return;}
      catch(error) {
        this.stopWithNewDiagnostic(frame,{code:"adapter_contract_invalid",stage:"evaluation",message:errorMessage(error),category:"planning_actual_callback",cause:this.diagnostics.capturedCause(error)},"error","fatal_error");
        return;
      }
    }
    if (frame.fact === "satisfied") {
      if (this.activeConditions(frame).length > 0) {
        frame.phase = "await_children";
        return;
      }
      frame.errorId = null;
      this.finishSatisfiedFrame(frame);
      return;
    }
    if (evaluatesCommittedAtomic && (!this.planningMode || this.atomicResults.at(-1)?.outcome === "succeeded")) {
      const retryHandled = await this.applyRetryGate(frame, receipt);
      if (retryHandled) {
        if(this.planControl !== null && !this.finished) {
          this.planControl={...this.planControl,currentPathRef:null,cursor:null,recovery:{...this.planControl.recovery,phase:"replan"}};
        }
        return;
      }
    }
    if (!this.retryPolicyAppliesToFrame(frame) && frame.noProgressCount >= 2) {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "no_progress",
          stage: "aggregation",
          message: "two completed safe attempts made no factual progress",
          category: "stalled",
        },
        "stalled",
        "no_progress",
      );
      return;
    }
    if (frame.fact !== "unsatisfied" && frame.fact !== "unknown") {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "evidence_unavailable",
          stage: "observation",
          message: `frame fact ${frame.fact} cannot continue`,
          owner: "adapter",
          category: "evaluation_not_actionable",
        },
        "error",
        "fatal_error",
      );
      return;
    }

    const active = this.activeConditions(frame);
    if (active.length > 0) {
      frame.phase = "await_children";
      return;
    }
    if (frame.conditions.size > 0) {
      if (!frame.derivationClosed) {
        frame.phase = "derive";
        return;
      }
      this.stopWithNewDiagnostic(
        frame,
        {
          code:
            frame.fact === "unknown"
              ? "evidence_unavailable"
              : "precondition_unsatisfied",
          stage: "aggregation",
          message:
            frame.fact === "unknown"
              ? "all finite derivations were consumed without sufficient trusted evidence"
              : "all finite derivations were consumed but the goal remains unsatisfied",
          category: "derivation_closed",
          effectKnowledge: this.frameEffectKnowledge(frame),
        },
        "error",
        "fatal_error",
      );
      return;
    }
    if (!this.planningMode &&
      frame.lastAtomicOutcome === "succeeded" &&
      frame.safeRetrySkill === false
    ) {
      const receipt =
        frame.lastEvaluation === null
          ? null
          : {
              fact: frame.fact,
              satisfaction: frame.lastEvaluation.satisfaction,
              evaluatorId: frame.lastEvaluation.evaluatorId,
            };
      if (!this.finishUnsatisfiedAtomicFrame(frame, receipt)) {
        this.stopWithNewDiagnostic(
          frame,
          {
            code: "evidence_unavailable",
            stage: "observation",
            message: "the completed atomic step did not provide sufficient evidence",
            category: "postcondition_not_satisfied",
            effectKnowledge: this.frameEffectKnowledge(frame),
          },
          "error",
          "fatal_error",
        );
      }
      return;
    }
    frame.phase = "select";
  }

  private async applyRetryGate(
    frame: InternalFrame<G, B, C>,
    evaluation: EvaluationReceipt,
  ): Promise<boolean> {
    const frameRetry = this.ensureRetryFrame(frame);
    if (frameRetry === null) return false;
    const skill = this.selectedSkill(frame);
    if (skill === null) {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "policy_error",
          stage: "evaluation",
          message: "retry evaluation has no selected strategy",
          category: "retry_selected_skill_missing",
        },
        "error",
        "fatal_error",
      );
      return true;
    }
    const strategyRetry = frameRetry.strategies.find(
      strategy => strategy.skillId === skill.id,
    );
    if (strategyRetry === undefined) {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "policy_error",
          stage: "evaluation",
          message: `strategy ${skill.id} is outside the bounded retry policy`,
          origin: { skillId: skill.id },
          category: "retry_strategy_outside_policy",
        },
        "error",
        "fatal_error",
      );
      return true;
    }
    const dispatchId = frame.atomicResultRefs.at(-1);
    if (dispatchId === undefined) {
      throw new ModuleInvariantError(
        "retry evaluation lacks a committed atomic dispatch",
      );
    }
    if (frameRetry.lastAccountedDispatchId === dispatchId) return false;
    const atomicResult = this.atomicResults.find(
      result => result.dispatchId === dispatchId,
    );
    if (atomicResult === undefined) {
      throw new ModuleInvariantError(
        `retry evaluation references missing atomic result ${dispatchId}`,
      );
    }

    if (evaluation.result !== "unsatisfied") {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "evidence_unavailable",
          stage: "observation",
          message: `retry requires an explicit unsatisfied evaluation, received ${evaluation.result}`,
          category: "retry_evaluation_not_unsatisfied",
          effectKnowledge: atomicResult.effect.knowledge,
          atomicResultRefs: [dispatchId],
        },
        "error",
        "fatal_error",
      );
      return true;
    }
    if (
      atomicResult.outcome !== "succeeded" ||
      atomicResult.executionErrorIds.length > 0 ||
      atomicResult.verificationErrorIds.length > 0
    ) {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "execution_failed",
          stage: "execution",
          message: "retry requires a succeeded atomic outcome without errors",
          category: "retry_atomic_outcome_unsafe",
          effectKnowledge: atomicResult.effect.knowledge,
          atomicResultRefs: [dispatchId],
        },
        "error",
        "fatal_error",
      );
      return true;
    }
    if (atomicResult.effect.knowledge !== "none") {
      const unknownEffect =
        atomicResult.effect.knowledge === "unknown" ||
        atomicResult.effect.knowledge === "mixed";
      this.stopWithNewDiagnostic(
        frame,
        {
          code: unknownEffect ? "effect_outcome_unknown" : "effect_denied",
          stage: "effect",
          message:
            "automatic strategy retry requires explicit no-effect evidence",
          category: "retry_effect_not_none",
          effectKnowledge: atomicResult.effect.knowledge,
          atomicResultRefs: [dispatchId],
        },
        "error",
        "fatal_error",
      );
      return true;
    }
    if (frame.pendingVerification !== null) {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "evidence_unavailable",
          stage: "observation",
          message: "automatic strategy retry cannot precede pending verification",
          category: "retry_pending_verification",
          atomicResultRefs: [dispatchId],
        },
        "error",
        "fatal_error",
      );
      return true;
    }
    if (skill.retry !== "completed_no_effect") {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "policy_error",
          stage: "evaluation",
          message: `strategy ${skill.id} does not declare completed_no_effect retry`,
          origin: { skillId: skill.id },
          category: "retry_skill_contract",
          atomicResultRefs: [dispatchId],
        },
        "error",
        "fatal_error",
      );
      return true;
    }
    if (
      atomicResult.observedStateRef === null ||
      atomicResult.observedStateRef !== this.currentStateRecord().id
    ) {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "evidence_unavailable",
          stage: "observation",
          message: "retry evaluation does not reference the current atomic postcondition",
          category: "retry_current_postcondition_missing",
          atomicResultRefs: [dispatchId],
        },
        "error",
        "fatal_error",
      );
      return true;
    }
    const evidenceById = new Map(this.evidence.map(item => [item.id, item]));
    const evaluationEvidenceValid =
      evaluation.evidenceRefs.length > 0 &&
      evaluation.evidenceRefs.every(reference => {
        const item = evidenceById.get(reference);
        return item?.validity === "valid";
      }) &&
      evaluation.evidenceRefs.some(reference => {
        const item = evidenceById.get(reference);
        return item?.stateRef === atomicResult.observedStateRef;
      });
    if (!evaluationEvidenceValid) {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "evidence_unavailable",
          stage: "observation",
          message:
            "retry requires valid evaluation evidence from the current atomic postcondition",
          category: "retry_evidence_insufficient",
          atomicResultRefs: [dispatchId],
        },
        "error",
        "fatal_error",
      );
      return true;
    }
    if (this.deps.adapter.assessRetry === undefined) {
      throw new ModuleInvariantError(
        "retryPolicy admitted without adapter.assessRetry",
      );
    }

    let rawAssessment: unknown;
    try {
      rawAssessment = await this.deps.adapter.assessRetry(
        freezeSnapshot({
          goal: this.callbackGoal(frame.goal),
          bindings: this.callbackBindings(frame.bindings),
          skill,
          atomicResult,
          evaluation,
          state: this.callbackState(),
          evidence: this.callbackEvidence(),
        }),
      );
    } catch (error) {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "adapter_contract_invalid",
          stage: "evaluation",
          message: errorMessage(error),
          owner: "adapter",
          category: "assess_retry",
          effectKnowledge: atomicResult.effect.knowledge,
          atomicResultRefs: [dispatchId],
          cause: this.diagnostics.capturedCause(error),
        },
        "error",
        "fatal_error",
      );
      return true;
    }

    let assessment: RetryAssessment;
    try {
      assessment = readRetryAssessment(rawAssessment);
    } catch (error) {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "adapter_contract_invalid",
          stage: "evaluation",
          message: errorMessage(error),
          owner: "adapter",
          category: "assess_retry_receipt",
          effectKnowledge: atomicResult.effect.knowledge,
          atomicResultRefs: [dispatchId],
          cause: this.diagnostics.capturedCause(error),
        },
        "error",
        "fatal_error",
      );
      return true;
    }
    if (assessment.kind === "stop") {
      const stop = retryStopDiagnostic(assessment.reason);
      this.stopWithNewDiagnostic(
        frame,
        {
          ...stop,
          message: `retry assessment stopped: ${assessment.reason}`,
          category: `retry_assessment:${assessment.reason}`,
          effectKnowledge: atomicResult.effect.knowledge,
          atomicResultRefs: [dispatchId],
        },
        "error",
        "fatal_error",
      );
      return true;
    }

    if (
      assessment.evidenceRefs.length === 0 ||
      !assessment.evidenceRefs.every(reference => {
        const item = evidenceById.get(reference);
        return item?.validity === "valid";
      }) ||
      !assessment.evidenceRefs.some(reference =>
        evaluation.evidenceRefs.includes(reference),
      )
    ) {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "evidence_unavailable",
          stage: "observation",
          message:
            "safe retry must cite valid evidence from the current evaluation",
          category: "retry_assessment_evidence",
          atomicResultRefs: [dispatchId],
        },
        "error",
        "fatal_error",
      );
      return true;
    }

    const failure = strategyRetry.failures.find(
      entry => entry.failureKey === assessment.failureKey,
    );
    const nextCount = (failure?.count ?? 0) + 1;
    if (nextCount > this.retryControl!.policy.sameFailureLimit) {
      throw new ModuleInvariantError(
        `strategy ${skill.id} exceeded sameFailureLimit`,
      );
    }
    if (failure === undefined) {
      strategyRetry.failures.push({
        failureKey: assessment.failureKey,
        count: nextCount,
      });
    } else {
      failure.count = nextCount;
    }
    strategyRetry.latestAttemptRef = dispatchId;
    strategyRetry.exhausted =
      nextCount >= this.retryControl!.policy.sameFailureLimit;
    frameRetry.lastAccountedDispatchId = dispatchId;
    if (strategyRetry.exhausted) {
      frameRetry.lockedSkillId = null;
    } else {
      if (
        frameRetry.lockedSkillId !== null &&
        frameRetry.lockedSkillId !== skill.id
      ) {
        throw new ModuleInvariantError(
          `retry gate selected ${skill.id} while ${frameRetry.lockedSkillId} is locked`,
        );
      }
      frameRetry.lockedSkillId = skill.id;
    }

    if (frameRetry.strategies.every(strategy => strategy.exhausted)) {
      this.stopStrategiesExhausted(frame);
      return true;
    }
    if (
      this.retryControl!.atomicAttemptsUsed >=
      this.retryControl!.policy.maxAtomicAttempts
    ) {
      this.stopAtomicAttemptBudget(frame);
      return true;
    }
    if (
      this.invocationLimit !== null &&
      this.atomicDispatchesThisInvocation >= this.invocationLimit
    ) {
      if (this.planningMode) {
        this.yieldPlanningFromLastResult(frame, "select");
      } else {
        this.yieldStep(frame);
      }
      return true;
    }
    return false;
  }

  private async selectSkill(frame: InternalFrame<G, B, C>): Promise<void> {
    const selector = this.deps.selectorsById.get(frame.selectorId);
    if (selector === undefined) {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "invalid_binding",
          stage: "selection",
          message: `selector ${frame.selectorId} is not enabled`,
          category: "selector_missing",
        },
        "error",
        "fatal_error",
      );
      return;
    }
    let candidates = selector.skillIds.map(skillId => {
      const skill = this.deps.skillsById.get(skillId);
      if (skill === undefined) {
        throw new ModuleInvariantError(`selector ${selector.id} references ${skillId}`);
      }
      return skill;
    });
    const frameRetry = this.ensureRetryFrame(frame);
    let retryView: RetrySelectionView | undefined;
    if (frameRetry !== null) {
      const exhaustedSkillIds = frameRetry.strategies
        .filter(strategy => strategy.exhausted)
        .map(strategy => strategy.skillId);
      if (exhaustedSkillIds.length === frameRetry.strategies.length) {
        this.stopStrategiesExhausted(frame);
        return;
      }
      if (
        this.retryControl!.atomicAttemptsUsed >=
        this.retryControl!.policy.maxAtomicAttempts
      ) {
        this.stopAtomicAttemptBudget(frame);
        return;
      }
      candidates = candidates.filter(
        skill =>
          !exhaustedSkillIds.includes(skill.id) &&
          (frameRetry.lockedSkillId === null ||
            skill.id === frameRetry.lockedSkillId),
      );
      retryView = freezeSnapshot({
        eligibleSkillIds: candidates.map(skill => skill.id),
        lockedSkillId: frameRetry.lockedSkillId,
        exhaustedSkillIds,
        remainingAtomicAttempts:
          this.retryControl!.policy.maxAtomicAttempts -
          this.retryControl!.atomicAttemptsUsed,
      });
    }
    if (candidates.length === 0) {
      throw new ModuleInvariantError(
        `selector ${selector.id} has no candidate after retry filtering`,
      );
    }

    let coverage = false;
    try {
      for (const skill of candidates) {
        if (
          this.deps.adapter.supports({
            goal: this.callbackGoal(frame.goal),
            bindings: this.callbackBindings(frame.bindings),
            skill: freezeSnapshot(skill),
          })
        ) {
          coverage = true;
        }
      }
    } catch (error) {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "adapter_contract_invalid",
          stage: "selection",
          message: errorMessage(error),
          owner: "adapter",
          category: "supports",
          cause: this.diagnostics.capturedCause(error),
        },
        "error",
        "fatal_error",
      );
      return;
    }
    if (!coverage) {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "capability_missing",
          stage: "selection",
          message: "no enabled skill supports the current goal",
          category: "capability_coverage",
        },
        "error",
        "fatal_error",
      );
      return;
    }

    const unresolvedEffect = this.ledger.some(
      effect =>
        effect.frameId === frame.frameId &&
        (effect.knowledge === "unknown" || effect.knowledge === "mixed"),
    );
    const pendingVerification = frame.pendingVerification;
    const evidenceRecoveryRequired =
      pendingVerification !== null || unresolvedEffect;
    if (evidenceRecoveryRequired) {
      const recoveryCandidates = candidates.filter(
        skill => skill.effectClass === "none" || skill.effectClass === "read_only",
      );
      if (recoveryCandidates.length === 0) {
        const spec = {
          code: "evidence_unavailable" as const,
          stage: "effect" as const,
          message: pendingVerification
            ? "no declared read-only evidence skill can verify the committed effect"
            : "no declared read-only evidence skill can resolve the unknown effect",
          category: "recovery_capability_missing",
          effectKnowledge: aggregateEffectKnowledge(
            this.ledger.filter(effect => effect.frameId === frame.frameId),
          ),
        };
        if (pendingVerification) {
          this.stopPendingVerificationWithNewDiagnostic(frame, spec);
        } else {
          this.stopWithNewDiagnostic(frame, spec, "error", "fatal_error");
        }
        return;
      }
    }

    if (!(await this.preparePlanning(frame, candidates))) return;
    if (!this.beginTransition(frame, "selection")) return;
    const planningView = this.planningSelectionView(frame);
    let raw: unknown;
    try {
      raw = await this.deps.adapter.select({
        context: this.context(frame),
        selectorId: selector.id,
        goal: this.callbackGoal(frame.goal),
        satisfactionThreshold: frame.satisfactionThreshold,
        bindings: this.callbackBindings(frame.bindings),
        state: this.callbackState(),
        evidence: this.callbackEvidence(),
        conditions: this.callbackConditions(frame),
        previousEvaluation:
          frame.lastEvaluation === null
            ? null
            : freezeSnapshot(frame.lastEvaluation),
        candidates: this.callbackSkills(candidates),
        ...(retryView === undefined ? {} : { retry: retryView }),
        ...(planningView === null ? {} : { planning: planningView }),
      });
    } catch (error) {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "adapter_contract_invalid",
          stage: "selection",
          message: errorMessage(error),
          owner: "adapter",
          category: "select",
          cause: this.diagnostics.capturedCause(error),
        },
        "error",
        "fatal_error",
      );
      return;
    }

    const selectedId =
      isRecord(raw) && raw.kind === "selected" && typeof raw.skillId === "string"
        ? raw.skillId
        : null;
    if (selectedId !== null && !candidates.some(skill => skill.id === selectedId)) {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "policy_error",
          stage: "selection",
          message: `selector chose ${selectedId} outside its declared vocabulary`,
          owner: "adapter",
          category: "selection_head",
        },
        "error",
        "fatal_error",
      );
      return;
    }
    if (isRecord(raw) && raw.kind === "no_capability") {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "policy_error",
          stage: "selection",
          message: "selector reported no capability although enabled coverage exists",
          owner: "adapter",
          category: "selection_head",
        },
        "error",
        "fatal_error",
      );
      return;
    }

    let selection: ReturnType<typeof readSelection>;
    try {
      selection = readSelection(
        raw,
        candidates.map(skill => skill.id),
      );
    } catch (error) {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "adapter_contract_invalid",
          stage: "selection",
          message: errorMessage(error),
          owner: "adapter",
          category: "selection_receipt",
          cause: this.diagnostics.capturedCause(error),
        },
        "error",
        "fatal_error",
      );
      return;
    }
    if (selection.kind === "no_capability") {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "policy_error",
          stage: "selection",
          message: "selector returned no capability after coverage was established",
          owner: "adapter",
          category: "selection_head",
        },
        "error",
        "fatal_error",
      );
      return;
    }
    if (selection.kind === "defer") {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "policy_deferred",
          stage: "selection",
          message: `selector deferred: ${selection.reason}`,
          owner: "adapter",
          category: "policy_deferred",
        },
        "stalled",
        "no_progress",
      );
      return;
    }

    const skill = this.deps.skillsById.get(selection.skillId)!;
    if(this.planningMode && this.ledger.some(item=>item.skillId===skill.id && (item.dispatchState==="in_flight" || item.knowledge==="unknown" || item.knowledge==="mixed"))) {
      this.stopWithNewDiagnostic(frame,{code:"evidence_unavailable",stage:"effect",message:"unresolved atomic dispatch cannot be replayed",category:"planning_replay_guard"},"error","fatal_error");
      return;
    }
    if (
      planningView !== null &&
      !planningView.allowedEntrySkillRefs.some(reference =>
        sameVersionedRef(reference, {
          id: skill.id,
          version: skill.version,
        }),
      )
    ) {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "policy_error",
          stage: "selection",
          message: `selector chose ${skill.id} outside the current planning entry`,
          origin: { skillId: skill.id },
          owner: "adapter",
          category: "selection_plan_entry",
        },
        "error",
        "fatal_error",
      );
      return;
    }
    if (frame.expectedMode !== null && skill.mode !== frame.expectedMode) {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "policy_error",
          stage: "selection",
          message: `selector chose ${skill.id} mode ${skill.mode}; expected ${frame.expectedMode}`,
          owner: "adapter",
          category: "selection_mode",
        },
        "error",
        "fatal_error",
      );
      return;
    }
    if (skill.evaluatorId !== frame.evaluatorId) {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "policy_error",
          stage: "selection",
          message: `selector chose ${skill.id} with evaluator ${skill.evaluatorId}; expected ${frame.evaluatorId}`,
          owner: "adapter",
          category: "selection_evaluator",
        },
        "error",
        "fatal_error",
      );
      return;
    }
    if (
      evidenceRecoveryRequired &&
      (skill.mode !== "atomic" ||
        (skill.effectClass !== "none" && skill.effectClass !== "read_only"))
    ) {
      const spec = {
        code: "evidence_unavailable" as const,
        stage: "effect" as const,
        message: pendingVerification
          ? "committed effect can only be verified by a declared read-only skill"
          : "unknown effect must be clarified with a declared read-only skill",
        owner: "adapter" as const,
        category: "unsafe_recovery_selection",
        effectKnowledge: aggregateEffectKnowledge(
          this.ledger.filter(effect => effect.frameId === frame.frameId),
        ),
      };
      if (pendingVerification) {
        this.stopPendingVerificationWithNewDiagnostic(frame, spec);
      } else {
        this.stopWithNewDiagnostic(frame, spec, "error", "fatal_error");
      }
      return;
    }

    frame.selectedSkillId = skill.id;
    frame.mode = skill.mode;
    frame.obligationSnapshot = this.createObligationSnapshot(frame, skill.id);
    if (this.isCyclicDescent(frame, skill)) {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "derivation_cycle",
          stage: "derivation",
          message: "the same obligation re-derived without a mode or fact descent",
          category: "same_obligation",
          origin: { skillId: skill.id },
        },
        "error",
        "fatal_error",
      );
      return;
    }
    if (!this.effectsAllowed(frame, skill)) {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "effect_denied",
          stage: "dispatch",
          message: `skill ${skill.id} requests effects outside the current grant or scope`,
          origin: { skillId: skill.id },
          category: "effect_scope",
        },
        "error",
        "fatal_error",
      );
      return;
    }

    if (skill.mode === "composite") {
      frame.phase = "derive";
      return;
    }
    await this.dispatchAtomic(frame, skill, retryView);
  }

  private async deriveConditions(frame: InternalFrame<G, B, C>): Promise<void> {
    const skill = this.selectedSkill(frame);
    if (skill === null || skill.mode !== "composite") {
      throw new ModuleInvariantError("derive phase requires a selected composite skill");
    }
    if (!this.beginTransition(frame, "derivation")) return;

    let receipt: ReturnType<typeof readDerivationReceipt<G, B, C>>;
    try {
      const raw = await this.deps.adapter.derive({
        context: this.context(frame),
        skill: freezeSnapshot(skill),
        cursor: frame.cursor === null ? null : freezeSnapshot(frame.cursor),
        goal: this.callbackGoal(frame.goal),
        satisfactionThreshold: frame.satisfactionThreshold,
        bindings: this.callbackBindings(frame.bindings),
        state: this.callbackState(),
        evidence: this.callbackEvidence(),
        conditions: this.callbackConditions(frame),
      });
      receipt = freezeSnapshot(
        readDerivationReceipt<G, B, C>(raw, {
          goal: value => value as G,
          bindings: value => value as B,
          cursor: value => value as C,
        }),
      );
    } catch (error) {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "adapter_contract_invalid",
          stage: "derivation",
          message: errorMessage(error),
          owner: "adapter",
          category: "derive",
          origin: { skillId: skill.id },
          cause: this.diagnostics.capturedCause(error),
        },
        "error",
        "fatal_error",
      );
      return;
    }

    const existingIds = new Set(frame.conditions.keys());
    for (const condition of receipt.conditions) {
      if (existingIds.has(condition.id)) {
        this.stopWithNewDiagnostic(
          frame,
          {
            code: "adapter_contract_invalid",
            stage: "derivation",
            message: `derived condition ${condition.id} already exists in frame ${frame.frameId}`,
            owner: "adapter",
            category: "duplicate_condition",
            origin: { skillId: skill.id, conditionId: condition.id },
          },
          "error",
          "fatal_error",
        );
        return;
      }
      existingIds.add(condition.id);
      if (!this.deps.evaluatorsById.has(condition.evaluatorId)) {
        this.stopWithNewDiagnostic(
          frame,
          {
            code: "invalid_binding",
            stage: "derivation",
            message: `condition ${condition.id} uses disabled evaluator ${condition.evaluatorId}`,
            owner: "adapter",
            category: "condition_evaluator",
            origin: { skillId: skill.id, conditionId: condition.id },
          },
          "error",
          "fatal_error",
        );
        return;
      }
      if (!this.deps.selectorsById.has(condition.selectorId)) {
        this.stopWithNewDiagnostic(
          frame,
          {
            code: "invalid_binding",
            stage: "derivation",
            message: `condition ${condition.id} uses disabled selector ${condition.selectorId}`,
            owner: "adapter",
            category: "condition_selector",
            origin: { skillId: skill.id, conditionId: condition.id },
          },
          "error",
          "fatal_error",
        );
        return;
      }
      if (
        condition.allowedEffects.length > 0 &&
        condition.allowedEffects.some(
          effect =>
            !this.deps.grantedEffects.has(effect) || !frame.effectScope.has(effect),
        )
      ) {
        this.stopWithNewDiagnostic(
          frame,
          {
            code: "effect_denied",
            stage: "derivation",
            message: `condition ${condition.id} expands the current effect scope`,
            origin: { skillId: skill.id, conditionId: condition.id },
            category: "condition_effect_scope",
          },
          "error",
          "fatal_error",
        );
        return;
      }
    }

    for (const condition of receipt.conditions) {
      frame.conditions.set(
        condition.id,
        this.conditionFromDerived(condition),
      );
    }
    frame.cursor = receipt.nextCursor;
    frame.derivationClosed = receipt.expansion === "closed";
    frame.obligationSnapshot = this.createObligationSnapshot(
      frame,
      frame.selectedSkillId,
    );
    frame.phase = "await_children";

    const required = receipt.conditions.filter(
      condition => condition.activation === "required",
    );
    const remainingDerived =
      this.validated.limits.maxDerivedGoals - this.derivedGoalsUsed;
    const depthExceeded = required.some(
      _condition => frame.depth + 1 > this.validated.limits.maxDepth,
    );
    if (required.length > remainingDerived || depthExceeded) {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "budget_exceeded",
          stage: "derivation",
          message:
            depthExceeded
              ? "the derived condition exceeds maxDepth"
              : "the derived condition batch exceeds the shared maxDerivedGoals budget",
          origin: { skillId: skill.id },
          category: "derivation_budget",
        },
        "exceeded",
        "budget",
      );
    }
  }

  private async awaitChildren(frame: InternalFrame<G, B, C>): Promise<void> {
    const active = this.activeConditions(frame);
    if (active.length === 0) {
      frame.phase = "aggregate";
      return;
    }

    let wantsMore = false;
    for (const condition of active) {
      if (condition.childFrameId !== null) continue;
      const dependencies = condition.dependsOn.map(id => frame.conditions.get(id));
      if (dependencies.some(dependency => dependency === undefined)) {
        if (!frame.derivationClosed) {
          wantsMore = true;
          continue;
        }
        this.stopWithNewDiagnostic(
          frame,
          {
            code: "adapter_contract_invalid",
            stage: "derivation",
            message: `condition ${condition.id} has an unknown dependency`,
            owner: "adapter",
            category: "dependency_reference",
            origin: { conditionId: condition.id },
          },
          "error",
          "fatal_error",
        );
        return;
      }

      const failedDependency = dependencies.find(
        dependency =>
          dependency !== undefined &&
          (dependency.fact === "unknown" || dependency.execution === "failed") &&
          dependency.errorId !== null,
      );
      if (failedDependency !== undefined && failedDependency.errorId !== null) {
        const original = this.errorById(failedDependency.errorId);
        if (original !== null) {
          this.markDependentFrames(
            frame,
            failedDependency.id,
            original,
            new Set(),
          );
        }
        this.control = {
          outcome: "error",
          stopReason: "fatal_error",
          frameId: frame.frameId,
        };
        this.finished = true;
        return;
      }

      const ready = dependencies.every(
        dependency =>
          dependency !== undefined &&
          (dependency.fact === "satisfied" ||
            dependency.fact === "not_applicable"),
      );
      if (ready) {
        if (!this.createChildFrame(frame, condition)) return;
        return;
      }
    }

    if (wantsMore || !frame.derivationClosed) {
      frame.phase = "derive";
      return;
    }
    this.stopWithNewDiagnostic(
      frame,
      {
        code: "evidence_unavailable",
        stage: "aggregation",
        message: "derived requirements are unresolved and no finite expansion remains",
        category: "unresolved_requirements",
      },
      "error",
      "fatal_error",
    );
  }

  private async aggregateFrame(frame: InternalFrame<G, B, C>): Promise<void> {
    if (frame.conditions.size === 0) {
      this.stopWithNewDiagnostic(
        frame,
        {
          code: "precondition_unsatisfied",
          stage: "aggregation",
          message: "the selected composite skill derived no active conditions",
          category: "empty_derivation",
        },
        "error",
        "fatal_error",
      );
      return;
    }
    if (!this.beginTransition(frame, "aggregation")) return;
    if (!(await this.revalidatePersistentConditions(frame))) return;
    frame.errorId = null;
    frame.phase = "evaluate";
  }

  private async dispatchAtomic(
    frame: InternalFrame<G, B, C>,
    skill: EnabledSkill,
    selectedRetryView?: RetrySelectionView,
  ): Promise<void> {
    if (
      this.planningMode &&
      this.invocationLimit !== null &&
      this.atomicDispatchesThisInvocation >= this.invocationLimit
    ) {
      this.yieldPlanningFromLastResult(frame, "select");
      return;
    }
    const frameRetry = this.ensureRetryFrame(frame);
    if (
      this.retryControl !== null &&
      this.retryControl!.atomicAttemptsUsed >=
        this.retryControl!.policy.maxAtomicAttempts
    ) {
      this.stopAtomicAttemptBudget(frame);
      return;
    }
    if (!this.beginTransition(frame, "dispatch")) return;
    if (this.planningMode || this.retryControl !== null) {
      this.atomicDispatchesThisInvocation += 1;
    }
    let atomicRetryView: RetrySelectionView | undefined;
    if (this.retryControl !== null) {
      if (frameRetry !== null) {
        atomicRetryView =
          selectedRetryView ??
          freezeSnapshot({
            eligibleSkillIds: frameRetry.strategies
              .filter(strategy => !strategy.exhausted)
              .map(strategy => strategy.skillId),
            lockedSkillId: frameRetry.lockedSkillId,
            exhaustedSkillIds: frameRetry.strategies
              .filter(strategy => strategy.exhausted)
              .map(strategy => strategy.skillId),
            remainingAtomicAttempts:
              this.retryControl.policy.maxAtomicAttempts -
              this.retryControl.atomicAttemptsUsed,
          });
      }
      this.retryControl!.atomicAttemptsUsed += 1;
    }
    const dispatchId = `${frame.frameId}:dispatch:${this.ledger.length + 1}`;
    const riskEffect: EffectRecord<F> = {
      dispatchId,
      frameId: frame.frameId,
      skillId: skill.id,
      dispatchState: "in_flight",
      knowledge: "unknown",
      confirmedEffects: [],
      receiptRef: null,
    };
    const ledgerIndex = this.ledger.length;
    this.ledger.push(riskEffect);
    frame.dispatchRefs = mergeStrings(frame.dispatchRefs, [dispatchId]);
    frame.execution = "dispatched";
    this.synchronizeFrameConditionExecution(frame, "dispatched", null);

    let raw: unknown;
    try {
      raw = await this.deps.adapter.executeAtomic({
        context: this.context(frame),
        skill: freezeSnapshot(skill),
        goal: this.callbackGoal(frame.goal),
        satisfactionThreshold: frame.satisfactionThreshold,
        bindings: this.callbackBindings(frame.bindings),
        state: this.callbackState(),
        evidence: this.callbackEvidence(),
        ...(atomicRetryView === undefined ? {} : { retry: atomicRetryView }),
      });
    } catch (error) {
      const returnedRisk: EffectRecord<F> = {
        ...riskEffect,
        dispatchState: "returned",
      };
      this.ledger[ledgerIndex] = returnedRisk;
      const projection = this.recordUnverifiedAtomic(
        frame,
        skill,
        returnedRisk,
        {
          code: "effect_outcome_unknown",
          stage: "execution",
          message: errorMessage(error),
          owner: "adapter",
          category: "atomic_callback_exception",
          effectKnowledge: "unknown",
          cause: this.diagnostics.capturedCause(error),
        },
      );
      frame.atomicResultRefs = mergeStrings(frame.atomicResultRefs, [
        projection.result.dispatchId,
      ]);
      this.markRootUnknownFromAtomicFailure([]);
      this.finishAtomicFailure(
        frame,
        this.requiredDiagnostic(projection.executionErrorIds[0]),
        "unknown",
      );
      return;
    }

    let receipt: AtomicReceipt<S, E, F, R>;
    try {
      const adapterReceipt = this.deps.adapter.validateAtomicReceipt(raw);
      receipt = freezeSnapshot(
        readAtomicReceipt(snapshotData(adapterReceipt), {
          state: value => value as S,
          evidencePayload: value => value as E,
          effectFact: value => value as F,
          receiptPayload: value => value as R,
        }),
      );
      this.validateReceiptReferences(receipt);
    } catch (error) {
      const returnedRisk: EffectRecord<F> = {
        ...riskEffect,
        dispatchState: "returned",
      };
      this.ledger[ledgerIndex] = returnedRisk;
      const projection = this.recordUnverifiedAtomic(
        frame,
        skill,
        returnedRisk,
        {
          code: "adapter_contract_invalid",
          stage: "execution",
          message: errorMessage(error),
          owner: "adapter",
          category: "atomic_receipt",
          effectKnowledge: "unknown",
          cause: this.diagnostics.capturedCause(error),
        },
      );
      frame.atomicResultRefs = mergeStrings(frame.atomicResultRefs, [
        projection.result.dispatchId,
      ]);
      this.markRootUnknownFromAtomicFailure([]);
      this.finishAtomicFailure(
        frame,
        this.requiredDiagnostic(projection.executionErrorIds[0]),
        "unknown",
      );
      return;
    }

    const returnedEffect: EffectRecord<F> = {
      dispatchId,
      frameId: frame.frameId,
      skillId: skill.id,
      dispatchState: "returned",
      knowledge: receipt.effect.knowledge,
      confirmedEffects: [...receipt.effect.confirmedEffects],
      receiptRef: receipt.effect.receiptRef,
    };
    this.ledger[ledgerIndex] = returnedEffect;

    const projection = this.recordAtomicReceipt(
      frame,
      skill,
      returnedEffect,
      receipt,
    );
    frame.atomicResultRefs = mergeStrings(frame.atomicResultRefs, [
      projection.result.dispatchId,
    ]);
    this.applyAtomicData(frame, receipt);
    frame.lastAtomicOutcome = receipt.outcome;
    frame.lastAttemptEffectKnowledge = receipt.effect.knowledge;
    frame.safeRetrySkill = skill.retry === "completed_no_effect";

    if (projection.verificationErrorIds.length > 0) {
      const originalId = projection.verificationErrorIds[0]!;
      const primary = this.diagnostics.create({
        code: "evidence_unavailable",
        stage: "observation",
        message: "the atomic postcondition could not verify the goal",
        origin: {
          frameId: frame.frameId,
          skillId: skill.id,
          conditionId: frame.fulfillsConditionId,
        },
        owner: "module",
        category: "postcondition_verification",
        effectKnowledge: receipt.effect.knowledge,
        atomicResultRefs: [dispatchId],
        cause: { kind: "error_ref", errorId: originalId },
      });
      this.addDiagnostic(primary);
      this.markRootUnknownFromAtomicFailure(
        receipt.evidence.map(item => item.id),
      );
      if (receipt.effect.knowledge === "known") {
        frame.pendingVerification = {
          dispatchId,
          skillId: skill.id,
          verificationErrorIds: [...projection.verificationErrorIds],
        };
        frame.execution = "completed";
        this.synchronizeFrameConditionExecution(frame, "completed", null);
        this.stopPendingVerification(frame, primary);
      } else {
        this.finishAtomicFailure(frame, primary, "unknown");
      }
      return;
    }

    if (
      receipt.outcome === "failed" ||
      receipt.outcome === "rejected" ||
      projection.executionErrorIds.length > 0
    ) {
      const originalId = projection.executionErrorIds[0] ?? null;
      const original =
        originalId === null ? null : this.errorById(originalId);
      const primary =
        original ??
        this.diagnostics.create({
          code: "execution_failed",
          stage: "execution",
          message: this.atomicFailureMessage(receipt),
          origin: {
            frameId: frame.frameId,
            skillId: skill.id,
            conditionId: frame.fulfillsConditionId,
          },
          owner: "adapter",
          category:
            receipt.sourceResult !== null &&
            "category" in receipt.sourceResult
              ? receipt.sourceResult.category
              : `atomic_${receipt.outcome}`,
          effectKnowledge: receipt.effect.knowledge,
          atomicResultRefs: [dispatchId],
        });
      if (original === null) this.addDiagnostic(primary);
      const stopOnly = await this.refreshFactsBeforeAtomicStop(frame, receipt, projection.result, primary);
      this.finishAtomicFailure(frame, primary, frame.fact, stopOnly);
      return;
    }

    if (receipt.outcome === "unknown") {
      const primary = this.diagnostics.create({
        code: "effect_outcome_unknown",
        stage: "effect",
        message: "the atomic action crossed its effect boundary without a conclusive receipt",
        origin: {
          frameId: frame.frameId,
          skillId: skill.id,
          conditionId: frame.fulfillsConditionId,
        },
        owner: "adapter",
        category: "unknown_effect",
        effectKnowledge: receipt.effect.knowledge,
        atomicResultRefs: [dispatchId],
      });
      this.addDiagnostic(primary);
      const stopOnly = await this.refreshFactsBeforeAtomicStop(frame, receipt, projection.result, primary);
      if (!stopOnly) this.markRootUnknownFromAtomicFailure(receipt.evidence.map(item => item.id));
      this.finishAtomicFailure(frame, primary, stopOnly ? frame.fact : "unknown", stopOnly);
      return;
    }

    frame.execution = "completed";
    this.synchronizeFrameConditionExecution(frame, "completed", null);
    frame.errorId = null;
    frame.pendingProgressCheck = true;
    if (
      this.planningMode &&
      this.invocationLimit !== null &&
      this.atomicDispatchesThisInvocation >= this.invocationLimit
    ) {
      this.yieldPlanningAction(frame, projection.result, "evaluate_actual");
      return;
    }
    frame.phase = "evaluate";
  }

  /** Pure fact refresh only: execution failure still terminates with its original error. */
  private async refreshFactsBeforeAtomicStop(
    failed: InternalFrame<G, B, C>,
    atomic: AtomicReceipt<S, E, F, R>,
    result: AtomicExecutionResult<F, R>,
    original: RecursiveGoalErrorDiagnostic,
  ): Promise<boolean> {
    const stateRef = this.currentStateRecord().id;
    const plannedNode = this.planControl?.plan?.nodes.find(item => item.id === this.planControl?.cursor?.nodeRef);
    // This already has a normal evaluate/replan path; preserve its existing safe recovery.
    if (this.planningMode && plannedNode !== undefined && atomic.effect.knowledge === "none"
      && (atomic.outcome === "failed" || atomic.outcome === "rejected")
      && result.observedStateRef === stateRef && result.verificationErrorIds.length === 0
      && ["execution_failed", "precondition_unsatisfied", "invalid_binding"].includes(original.code)) return false;
    this.markRootUnknownFromAtomicFailure([]);
    if (atomic.newState === null || result.observedStateRef !== stateRef || atomic.newState.id !== stateRef
      || result.verificationErrorIds.length > 0) return false;
    const admitted = new Set(atomic.evidence.map(item => item.id));
    const evidence = this.evidence.filter(item => admitted.has(item.id)
      && item.stateRef === stateRef && item.validity === "valid");
    if (evidence.length === 0) return false;
    const currentIds = new Set(evidence.map(item => item.id));
    this.markRootUnknownFromAtomicFailure([...currentIds]);
    failed.execution = "failed";
    failed.errorId = original.errorId;
    if (this.primaryErrorId === null) this.primaryErrorId = original.errorId;
    const failurePath = new Set<string>();
    for (let item: InternalFrame<G, B, C> | null = failed; item !== null; item = this.parentFrame(item)) {
      failurePath.add(item.frameId);
    }
    const staged = new Map<string, EvaluationReceipt>();
    const stack = [{ frame: this.rootFrame, leave: false }];
    const visited = new Set<string>();
    try {
      while (stack.length > 0) {
        const entry = stack.pop()!;
        const target = entry.frame;
        if (!entry.leave) {
          if (visited.has(target.frameId)) continue;
          visited.add(target.frameId);
          stack.push({ frame: target, leave: true });
          for (const condition of target.conditions.values()) {
            if (condition.activation !== "required" || condition.childFrameId === null
              || (condition.lifetime === "stage" && condition.fact === "satisfied"
                && !failurePath.has(condition.childFrameId))) continue;
            const child = this.frames.get(condition.childFrameId);
            if (child === undefined) throw new TypeError("missing child for failure fact refresh");
            stack.push({ frame: child, leave: false });
          }
          continue;
        }
        if (!this.beginTransition(target, "evaluation")) return true;
        const conditions = this.conditionFacts(target).map(condition => {
          const updated = condition.childFrameId === null ? undefined : staged.get(condition.childFrameId);
          return updated === undefined ? condition : { ...condition, fact: updated.result,
            satisfaction: updated.satisfaction, evaluatorId: updated.evaluatorId, evidenceRefs: [...updated.evidenceRefs] };
        });
        const evaluation = readEvaluationReceipt(await this.deps.adapter.evaluate({
          context: this.context(target), goal: this.callbackGoal(target.goal),
          satisfactionThreshold: target.satisfactionThreshold, bindings: this.callbackBindings(target.bindings),
          state: this.callbackState(), evidence: freezeSnapshot(evidence), conditions: freezeSnapshot(conditions),
        }), target.satisfactionThreshold);
        if (this.deps.signal?.aborted === true) { this.stopCancelled(failed); return true; }
        if (evaluation.evaluatorId !== target.evaluatorId || !this.deps.evaluatorsById.has(evaluation.evaluatorId)
          || evaluation.evidenceRefs.some(id => !currentIds.has(id))
          || this.evaluationEvidenceFailure(evaluation) !== null
          || (evaluation.result === "satisfied" && conditions.some(condition =>
            condition.fact !== "satisfied" && condition.fact !== "not_applicable"))) {
          throw new TypeError("failure fact evaluation lacks current evidence or required conditions");
        }
        staged.set(target.frameId, evaluation);
      }
      for (const [id, evaluation] of staged) {
        const target = this.frames.get(id)!;
        target.lastEvaluation = evaluation;
        target.lastEvaluationAtTransition = this.transitionsUsed;
        target.fact = evaluation.result;
        target.evidenceRefs = [...evaluation.evidenceRefs];
        const parent = this.parentFrame(target);
        const condition = target.fulfillsConditionId === null ? undefined : parent?.conditions.get(target.fulfillsConditionId);
        if (condition !== undefined) {
          condition.fact = evaluation.result; condition.satisfaction = evaluation.satisfaction;
          condition.observedEvaluatorId = evaluation.evaluatorId; condition.evidenceRefs = [...evaluation.evidenceRefs];
        }
      }
      const root = staged.get(this.rootFrame.frameId)!;
      this.rootEvaluation = { state: "evaluated", result: root.result, satisfaction: root.satisfaction,
        evaluatorId: root.evaluatorId, evidenceRefs: [...root.evidenceRefs], evaluatedAtTransition: this.transitionsUsed };
    } catch (error) {
      this.addDiagnostic(this.diagnostics.create({
        code: "adapter_contract_invalid", stage: "evaluation", message: errorMessage(error),
        origin: { frameId: failed.frameId, skillId: failed.selectedSkillId, conditionId: failed.fulfillsConditionId },
        owner: "adapter", category: "failure_fact_evaluation", effectKnowledge: atomic.effect.knowledge,
        atomicResultRefs: [result.dispatchId], cause: this.diagnostics.capturedCause(error),
      }));
    }
    return true;
  }

  private finishAtomicFailure(
    frame: InternalFrame<G, B, C>,
    diagnostic: RecursiveGoalErrorDiagnostic,
    conditionFact: RecursiveGoalFact = frame.fact,
    stopOnly = false,
  ): void {
    if (this.finished) return;
    const atomic=this.atomicResults.at(-1);
    const node=this.planControl?.plan?.nodes.find(item=>item.id===this.planControl?.cursor?.nodeRef);
    if(!stopOnly && this.planningMode && this.planControl !== null && node!==undefined && atomic!==undefined &&
      (atomic.outcome==="failed" || atomic.outcome==="rejected") && atomic.effect.knowledge==="none" &&
      atomic.observedStateRef === this.currentStateRecord().id &&
      ["execution_failed","precondition_unsatisfied","invalid_binding"].includes(diagnostic.code) && atomic.verificationErrorIds.length===0) {
      frame.execution="failed";
      frame.errorId=diagnostic.errorId;
      if(this.primaryErrorId===null) this.primaryErrorId=diagnostic.errorId;
      const prior={id:`${atomic.dispatchId}:failure-prior`,rootRef:this.acceptedRoot.rootFrameId,obligationRef:node.obligationRef,skillRef:node.skillRef,
        source:{kind:"verified_failure" as const,dispatchId:atomic.dispatchId,atomicResultRef:atomic.dispatchId,errorRefs:atomic.executionErrorIds},
        scope:{bindings:frame.bindings,stateProjection:this.callbackState(),evidenceProjection:this.currentEvidence().map(item=>item.payload)},
        preconditions:node.preconditions,conclusion:{kind:"exclude_transition" as const,transitionRefs:node.predictedResults.map(result=>result.transitionRef)},invalidation:[]};
      this.planControl={...this.planControl,failurePriors:[...this.planControl.failurePriors,prior],recovery:{...this.planControl.recovery,phase:"checkpoint_recheck",reasonRefs:[...this.planControl.recovery.reasonRefs,diagnostic.errorId]}};
      frame.pendingProgressCheck=true;
      frame.phase="evaluate";
      if(this.invocationLimit!==null && this.atomicDispatchesThisInvocation>=this.invocationLimit) this.yieldPlanningAction(frame,atomic,"evaluate_actual");
      return;
    }
    frame.execution = "failed";
    frame.errorId = diagnostic.errorId;
    this.primaryErrorId = diagnostic.errorId;
    this.synchronizeFailedParentCondition(frame, diagnostic, conditionFact);
    this.propagateDiagnostic(frame, diagnostic);
    this.control = {
      outcome: "error",
      stopReason: "fatal_error",
      frameId: frame.frameId,
    };
    this.finished = true;
  }

  private stopPendingVerification(
    frame: InternalFrame<G, B, C>,
    diagnostic: RecursiveGoalErrorDiagnostic,
  ): void {
    if (this.finished) return;
    frame.execution = "completed";
    frame.errorId = diagnostic.errorId;
    this.primaryErrorId = diagnostic.errorId;
    this.synchronizeFrameConditionExecution(frame, "completed", null);
    this.propagateDiagnostic(frame, diagnostic);
    this.control = {
      outcome: "error",
      stopReason: "fatal_error",
      frameId: frame.frameId,
    };
    this.finished = true;
  }

  private stopPendingVerificationWithNewDiagnostic(
    frame: InternalFrame<G, B, C>,
    spec: StopDiagnosticSpec,
  ): void {
    const diagnostic = this.diagnostics.create({
      ...spec,
      origin: {
        frameId: frame.frameId,
        skillId: frame.selectedSkillId,
        conditionId: frame.fulfillsConditionId,
        ...spec.origin,
      },
      category: spec.category ?? "pending_verification",
      effectKnowledge:
        spec.effectKnowledge ??
        aggregateEffectKnowledge(
          this.ledger.filter(effect => effect.frameId === frame.frameId),
        ),
    });
    this.addDiagnostic(diagnostic);
    this.stopPendingVerification(frame, diagnostic);
  }

  private requiredDiagnostic(errorId: string | undefined): RecursiveGoalErrorDiagnostic {
    if (errorId === undefined) {
      throw new ModuleInvariantError(
        "unverified atomic result lacks its diagnostic reference",
      );
    }
    const diagnostic = this.errorById(errorId);
    if (diagnostic === null) {
      throw new ModuleInvariantError(
        `unverified atomic result references missing diagnostic ${errorId}`,
      );
    }
    return diagnostic;
  }

  private synchronizeFrameConditionExecution(
    frame: InternalFrame<G, B, C>,
    execution: RecursiveGoalExecution,
    errorId: string | null,
  ): void {
    if (frame.parentFrameId === null || frame.fulfillsConditionId === null) {
      return;
    }
    const parent = this.parentFrame(frame);
    const condition = parent?.conditions.get(frame.fulfillsConditionId);
    if (parent === null || condition === undefined) {
      throw new ModuleInvariantError(
        `frame ${frame.frameId} has no parent condition for execution sync`,
      );
    }
    condition.childFrameId = frame.frameId;
    condition.execution = execution;
    condition.errorId = errorId;
  }

  private synchronizeFailedParentCondition(
    frame: InternalFrame<G, B, C>,
    diagnostic: RecursiveGoalErrorDiagnostic,
    fact: RecursiveGoalFact,
  ): void {
    if (frame.parentFrameId === null || frame.fulfillsConditionId === null) {
      return;
    }
    this.synchronizeFrameConditionExecution(
      frame,
      frame.execution,
      diagnostic.errorId,
    );
    const parent = this.parentFrame(frame);
    const condition = parent?.conditions.get(frame.fulfillsConditionId);
    if (parent === null || condition === undefined) {
      throw new ModuleInvariantError(
        `frame ${frame.frameId} has no parent condition for failure sync`,
      );
    }
    condition.fact = fact;
    condition.satisfaction = frame.lastEvaluation?.satisfaction ?? null;
    condition.observedEvaluatorId = frame.lastEvaluation?.evaluatorId ?? null;
    condition.evidenceRefs = [...frame.evidenceRefs];
    parent.errorId = diagnostic.errorId;
    this.markDependentFrames(
      parent,
      condition.id,
      diagnostic,
      new Set(),
    );
  }

  private markRootUnknownFromAtomicFailure(
    evidenceRefs: readonly string[],
  ): void {
    const admittedRefs = mergeStrings(
      this.rootFrame.evidenceRefs,
      evidenceRefs,
    );
    const receipt: EvaluationReceipt = {
      evaluatorId: this.rootFrame.evaluatorId,
      result: "unknown",
      satisfaction: null,
      necessaryConditionsMet: false,
      evidenceRefs: admittedRefs,
    };
    this.rootFrame.fact = "unknown";
    this.rootFrame.evidenceRefs = admittedRefs;
    this.rootFrame.lastEvaluation = receipt;
    this.rootFrame.lastEvaluationAtTransition = this.transitionsUsed;
    this.rootEvaluation = {
      state: "evaluated",
      result: "unknown",
      satisfaction: null,
      evaluatorId: receipt.evaluatorId,
      evidenceRefs: [...admittedRefs],
      evaluatedAtTransition: this.transitionsUsed,
    };
  }

  private consumeProgress(
    frame: InternalFrame<G, B, C>,
    current: EvaluationReceipt,
  ): void {
    if (
      !frame.pendingProgressCheck ||
      frame.lastEvaluation === null
    ) {
      return;
    }
    let improved = false;
    try {
      const before =
        frame.progressBaseline === null
          ? this.currentState()
          : this.stateByRef(frame.progressBaseline.stateRef);
      const raw = this.deps.adapter.measureProgress({
        goal: this.callbackGoal(frame.goal),
        before: freezeSnapshot(before),
        after: this.callbackState(),
        previousEvaluation: freezeSnapshot(frame.lastEvaluation),
        currentEvaluation: freezeSnapshot(current),
      });
      if (!isRecord(raw) || typeof raw.improved !== "boolean") {
        throw new TypeError("measureProgress must return an improved boolean");
      }
      improved = raw.improved;
    } catch (error) {
      throw new TypeError(`measureProgress failed: ${errorMessage(error)}`);
    }
    if (improved) {
      frame.noProgressCount = 0;
    } else if (
      frame.safeRetrySkill &&
      frame.lastAttemptEffectKnowledge === "none"
    ) {
      frame.noProgressCount += 1;
    }
  }

  private pendingVerificationProof(
    frame: InternalFrame<G, B, C>,
  ): AtomicExecutionResult<F, R> | null {
    if (frame.pendingVerification === null) return null;
    const lastId = frame.atomicResultRefs.at(-1);
    const result = this.atomicResults.find(item => item.dispatchId === lastId);
    if (result === undefined || result.dispatchId === frame.pendingVerification.dispatchId ||
        result.outcome !== "succeeded" || result.executionErrorIds.length > 0 ||
        result.verificationErrorIds.length > 0 ||
        result.observedStateRef !== this.currentStateRecord().id) return null;
    const skill = this.deps.skillsById.get(result.skillId);
    if (skill?.mode !== "atomic" ||
        (skill.effectClass !== "none" && skill.effectClass !== "read_only")) return null;
    return result;
  }

  private unclosedRequiredFrame(
    frame: InternalFrame<G, B, C>,
  ): InternalFrame<G, B, C> | null {
    const work = [frame];
    const visited = new Set<string>();
    while (work.length > 0) {
      const current = work.pop()!;
      if (visited.has(current.frameId)) throw new ModuleInvariantError("required frame cycle");
      visited.add(current.frameId);
      if (current.pendingVerification !== null || this.activeConditions(current).length > 0) return current;
      for (const condition of current.conditions.values()) {
        if (condition.activation === "required" && condition.childFrameId !== null) {
          const child = this.frames.get(condition.childFrameId);
          if (child === undefined) throw new ModuleInvariantError("missing required child");
          work.push(child);
        }
      }
    }
    return null;
  }

  private finishSatisfiedFrame(frame: InternalFrame<G, B, C>): void {
    const unfinished = this.unclosedRequiredFrame(frame);
    if (unfinished !== null) {
      if (unfinished.pendingVerification !== null) {
        unfinished.phase = "select";
        this.stopPendingVerificationWithNewDiagnostic(unfinished, {
          code: "evidence_unavailable", stage: "aggregation",
          message: "a required committed effect still needs verification",
          category: "pending_verification_completion",
        });
      } else {
        this.stopWithNewDiagnostic(unfinished, {
          code: "precondition_unsatisfied", stage: "aggregation",
          message: "required descendant conditions remain unresolved",
          category: "unresolved_requirements",
        }, "error", "fatal_error");
      }
      return;
    }
    if (frame.frameId === this.rootFrame.frameId) {
      this.rootFrame.execution =
        this.rootFrame.execution === "not_started"
          ? "completed"
          : this.rootFrame.execution;
      this.control = {
        outcome: "completed",
        stopReason: "root_evaluation",
        frameId: frame.frameId,
      };
      if(!this.planningMode) this.primaryErrorId = null;
      else this.rootFrame.execution="completed";
      this.finished = true;
      return;
    }

    const parent = this.parentFrame(frame);
    if (parent === null || frame.fulfillsConditionId === null) {
      throw new ModuleInvariantError("satisfied child has no parent obligation");
    }
    const condition = parent.conditions.get(frame.fulfillsConditionId);
    if (condition === undefined) {
      throw new ModuleInvariantError("satisfied child condition is missing");
    }
    const evaluation = frame.lastEvaluation;
    if (evaluation === null) {
      throw new ModuleInvariantError("satisfied child has no evaluation receipt");
    }
    condition.fact = "satisfied";
    condition.satisfaction = evaluation.satisfaction;
    condition.observedEvaluatorId = evaluation.evaluatorId;
    condition.evidenceRefs = [...evaluation.evidenceRefs];
    condition.childFrameId = frame.frameId;
    condition.execution = "completed";
    condition.errorId = null;
    parent.errorId = null;
    this.stack.pop();
    parent.phase = "await_children";
  }

  private finishUnsatisfiedAtomicFrame(
    frame: InternalFrame<G, B, C>,
    evaluation: {
      readonly fact: RecursiveGoalFact;
      readonly satisfaction: number | null;
      readonly evaluatorId: string;
    } | null,
  ): boolean {
    if (frame.frameId === this.rootFrame.frameId) return false;
    const parent = this.parentFrame(frame);
    if (
      parent === null ||
      frame.fulfillsConditionId === null ||
      evaluation === null
    ) {
      throw new ModuleInvariantError(
        "completed unsatisfied child lacks its parent evaluation",
      );
    }
    const condition = parent.conditions.get(frame.fulfillsConditionId);
    if (condition === undefined) {
      throw new ModuleInvariantError(
        "completed unsatisfied child condition is missing",
      );
    }
    condition.fact = evaluation.fact;
    condition.satisfaction = evaluation.satisfaction;
    condition.observedEvaluatorId = evaluation.evaluatorId;
    condition.evidenceRefs = [...frame.evidenceRefs];
    condition.childFrameId = frame.frameId;
    condition.execution = "completed";
    condition.errorId = null;
    frame.execution = "completed";
    frame.errorId = null;
    this.stack.pop();
    parent.errorId = null;
    parent.phase = "evaluate";
    return true;
  }

  private createChildFrame(
    parent: InternalFrame<G, B, C>,
    condition: InternalCondition<G, B>,
  ): boolean {
    if (this.derivedGoalsUsed >= this.validated.limits.maxDerivedGoals) {
      this.stopWithNewDiagnostic(
        parent,
        {
          code: "budget_exceeded",
          stage: "derivation",
          message: "maxDerivedGoals is exhausted before child allocation",
          category: "derived_goal_budget",
          origin: { conditionId: condition.id },
        },
        "exceeded",
        "budget",
      );
      return false;
    }
    const depth = parent.depth + 1;
    if (depth > this.validated.limits.maxDepth) {
      this.stopWithNewDiagnostic(
        parent,
        {
          code: "budget_exceeded",
          stage: "derivation",
          message: "maxDepth is exceeded before child allocation",
          category: "depth_budget",
          origin: { conditionId: condition.id },
        },
        "exceeded",
        "budget",
      );
      return false;
    }
    const frameId = `${parent.frameId}:goal:${condition.id}`;
    const effectScope = this.childEffectScope(parent, condition);
    const child: InternalFrame<G, B, C> = {
      frameId,
      rootRef: this.acceptedRoot.rootFrameId,
      parentFrameId: parent.frameId,
      fulfillsConditionId: condition.id,
      goal: condition.goal,
      bindings: condition.bindings,
      satisfactionThreshold: condition.satisfactionThreshold,
      evaluatorId: condition.evaluatorId,
      selectorId: condition.selectorId,
      depth,
      effectScope,
      expectedMode: condition.mode,
      mode: condition.mode,
      selectedSkillId: null,
      cursor: null,
      conditions: new Map(),
      phase: "evaluate",
      derivationClosed: false,
      fact: "not_evaluated",
      execution: "not_started",
      unexecutedReason: null,
      errorId: null,
      evidenceRefs: [],
      dispatchRefs: [],
      atomicResultRefs: [],
      noProgressCount: 0,
      lastEvaluation: null,
      lastEvaluationAtTransition: null,
      progressBaseline: null,
      pendingVerification: null,
      obligationSnapshot: null,
      pendingProgressCheck: false,
      safeRetrySkill: false,
      lastAttemptEffectKnowledge: null,
      lastAtomicOutcome: null,
    };
    if (this.frames.has(frameId)) {
      throw new ModuleInvariantError(`duplicate child frame ${frameId}`);
    }
    this.frames.set(frameId, child);
    this.ensureRetryFrame(child);
    condition.childFrameId = frameId;
    condition.execution = "not_started";
    this.derivedGoalsUsed += 1;
    parent.phase = "await_children";
    this.stack.push(child);
    return true;
  }

  private async revalidatePersistentConditions(
    frame: InternalFrame<G, B, C>,
  ): Promise<boolean> {
    type Work =
      | { kind: "enter"; frame: InternalFrame<G, B, C> }
      | { kind: "leave"; frameId: string }
      | { kind: "evaluate"; owner: InternalFrame<G, B, C>;
          condition: InternalCondition<G, B>; child: InternalFrame<G, B, C> };
    const work: Work[] = [{ kind: "enter", frame }];
    const visiting = new Set<string>();
    let failure: { owner: InternalFrame<G, B, C>; conditionId: string;
      evaluatorId: string; unknown: boolean } | null = null;
    while (work.length > 0) {
      const step = work.pop()!;
      if (step.kind === "leave") {
        visiting.delete(step.frameId);
        continue;
      }
      if (step.kind === "enter") {
        if (visiting.has(step.frame.frameId)) {
          throw new ModuleInvariantError(`persistent condition cycle at frame ${step.frame.frameId}`);
        }
        visiting.add(step.frame.frameId);
        work.push({ kind: "leave", frameId: step.frame.frameId });
        for (const condition of [...step.frame.conditions.values()].reverse()) {
          if (condition.lifetime !== "persistent" || condition.childFrameId === null ||
              condition.fact === "not_applicable") continue;
          const child = this.frames.get(condition.childFrameId);
          if (child === undefined) throw new ModuleInvariantError(`persistent condition ${condition.id} has no child frame`);
          work.push({ kind: "evaluate", owner: step.frame, condition, child });
          work.push({ kind: "enter", frame: child });
        }
        continue;
      }
      const { owner, condition, child } = step;
        if (!this.beginTransition(child, "evaluation")) return false;
        let receipt: EvaluationReceipt;
        try {
          receipt = readEvaluationReceipt(
            await this.deps.adapter.evaluate({
              context: this.context(child),
              goal: this.callbackGoal(child.goal),
              satisfactionThreshold: child.satisfactionThreshold,
              bindings: this.callbackBindings(child.bindings),
              state: this.callbackState(),
              evidence: this.callbackEvidence(),
              conditions: this.callbackConditions(child),
            }),
            child.satisfactionThreshold,
          );
          if (receipt.evaluatorId !== child.evaluatorId) {
            throw new TypeError("persistent evaluation changed evaluator");
          }
          const evidenceFailure = this.evaluationEvidenceFailure(receipt);
          if (evidenceFailure !== null) {
            this.stopWithNewDiagnostic(
              child,
              evidenceFailure,
              "error",
              "fatal_error",
            );
            return false;
          }
        } catch (error) {
          this.stopWithNewDiagnostic(
            child,
            {
              code: "adapter_contract_invalid",
              stage: "observation",
              message: errorMessage(error),
              owner: "adapter",
              category: "persistent_revalidation",
              cause: this.diagnostics.capturedCause(error),
            },
            "error",
            "fatal_error",
          );
          return false;
        }
        child.lastEvaluation = receipt;
        child.lastEvaluationAtTransition = this.transitionsUsed;
        child.fact = receipt.result;
        child.evidenceRefs = mergeStrings(
          child.evidenceRefs,
          receipt.evidenceRefs,
        );
        condition.fact = receipt.result;
        condition.satisfaction = receipt.satisfaction;
        condition.observedEvaluatorId = receipt.evaluatorId;
        condition.evidenceRefs = [...receipt.evidenceRefs];
        const unresolved = this.activeConditions(child);
        if (failure === null && (receipt.result !== "satisfied" || unresolved.length > 0)) {
          failure = {
            owner, conditionId: condition.id, evaluatorId: receipt.evaluatorId,
            unknown: receipt.result === "unknown" || unresolved.some(item =>
              item.fact === "unknown" || item.fact === "not_evaluated"),
          };
        }
    }
    if (failure === null) return true;
    this.stopWithNewDiagnostic(failure.owner, {
      code: failure.unknown ? "evidence_unavailable" : "precondition_unsatisfied",
      stage: "aggregation",
      message: `persistent condition ${failure.conditionId} failed current-state closure`,
      origin: { frameId: failure.owner.frameId, conditionId: failure.conditionId,
        evaluatorId: failure.evaluatorId },
      owner: "adapter", category: "persistent_condition",
      effectKnowledge: aggregateEffectKnowledge(this.ledger),
    }, "error", "fatal_error");
    return false;
  }

  private recordAtomicReceipt(
    frame: InternalFrame<G, B, C>,
    skill: EnabledSkill,
    effect: EffectRecord<F>,
    receipt: AtomicReceipt<S, E, F, R>,
  ): AtomicOutcomeProjection<F, R> {
    const origin = {
      frameId: frame.frameId,
      skillId: skill.id,
      conditionId: frame.fulfillsConditionId,
    };
    const executionErrors = receipt.executionErrors.map(diagnostic =>
      this.diagnostics.fromAdapter(
        diagnostic,
        origin,
        receipt.effect.knowledge,
        [effect.dispatchId],
      ),
    );
    const verificationErrors = receipt.verificationErrors.map(diagnostic =>
      this.diagnostics.fromAdapter(
        diagnostic,
        origin,
        receipt.effect.knowledge,
        [effect.dispatchId],
      ),
    );
    for (const error of [...executionErrors, ...verificationErrors]) {
      this.addDiagnostic(error);
    }
    const result: AtomicExecutionResult<F, R> = {
      dispatchId: effect.dispatchId,
      frameId: frame.frameId,
      skillId: skill.id,
      runId: receipt.runId,
      executorInvoked: receipt.executorInvoked,
      outcome: receipt.outcome,
      sourceResult: receipt.sourceResult,
      executionErrorIds: executionErrors.map(error => error.errorId),
      verificationErrorIds: verificationErrors.map(error => error.errorId),
      effect,
      observedStateRef: receipt.newState?.id ?? null,
    };
    this.atomicResults.push(result);
    return {
      result,
      executionErrorIds: result.executionErrorIds,
      verificationErrorIds: result.verificationErrorIds,
    };
  }

  private recordUnverifiedAtomic(
    frame: InternalFrame<G, B, C>,
    skill: EnabledSkill,
    effect: EffectRecord<F>,
    diagnostic: {
      readonly code: RecursiveGoalErrorCode;
      readonly stage: RecursiveGoalErrorStage;
      readonly message: string;
      readonly owner: "adapter" | "module" | "workflow";
      readonly category: string;
      readonly effectKnowledge: EffectKnowledge;
      readonly cause: ReturnType<RecursiveGoalDiagnosticFactory["capturedCause"]>;
    },
  ): AtomicOutcomeProjection<F, R> {
    const result: AtomicExecutionResult<F, R> = {
      dispatchId: effect.dispatchId,
      frameId: frame.frameId,
      skillId: skill.id,
      runId: null,
      executorInvoked: "unknown",
      outcome: "unknown",
      sourceResult: null,
      executionErrorIds: [],
      verificationErrorIds: [],
      effect,
      observedStateRef: null,
    };
    const error = this.diagnostics.create({
      ...diagnostic,
      origin: {
        frameId: frame.frameId,
        skillId: skill.id,
        conditionId: frame.fulfillsConditionId,
      },
      atomicResultRefs: [result.dispatchId],
    });
    this.addDiagnostic(error);
    const recorded: AtomicExecutionResult<F, R> = {
      ...result,
      executionErrorIds: [error.errorId],
    };
    this.atomicResults.push(recorded);
    return {
      result: recorded,
      executionErrorIds: [error.errorId],
      verificationErrorIds: [],
    };
  }

  private applyAtomicData(
    frame: InternalFrame<G, B, C>,
    receipt: AtomicReceipt<S, E, F, R>,
  ): void {
    if (receipt.newState !== null) {
      this.states.push(receipt.newState);
    }
    for (const item of receipt.evidence) {
      if (!this.states.some(state => state.id === item.stateRef)) {
        throw new ModuleInvariantError(
          `atomic evidence ${item.id} references an unknown state`,
        );
      }
      this.evidence.push(item);
    }
    frame.evidenceRefs = mergeStrings(
      frame.evidenceRefs,
      receipt.evidence.map(item => item.id),
    );
  }

  private validateReceiptReferences(
    receipt: AtomicReceipt<S, E, F, R>,
  ): void {
    if (
      receipt.newState !== null &&
      this.states.some(state => state.id === receipt.newState!.id)
    ) {
      throw new TypeError(`atomic state ${receipt.newState.id} already exists`);
    }
    const existingStates = new Set(this.states.map(state => state.id));
    if (receipt.newState !== null) existingStates.add(receipt.newState.id);
    const existingEvidence = new Set(this.evidence.map(item => item.id));
    for (const item of receipt.evidence) {
      if (existingEvidence.has(item.id)) {
        throw new TypeError(`atomic evidence ${item.id} already exists`);
      }
      existingEvidence.add(item.id);
      if (!existingStates.has(item.stateRef)) {
        throw new TypeError(
          `atomic evidence ${item.id} references unknown state ${item.stateRef}`,
        );
      }
    }
  }

  private retryPolicyAppliesToFrame(frame: InternalFrame<G, B, C>): boolean {
    return (
      this.retryControl !== null &&
      this.retryControl.policy.selectorId === frame.selectorId
    );
  }

  private ensureRetryFrame(
    frame: InternalFrame<G, B, C>,
  ): MutableFrameStrategyRetryState | null {
    if (!this.retryPolicyAppliesToFrame(frame)) return null;
    const existing = this.retryControl!.frames.find(
      state => state.frameId === frame.frameId,
    );
    if (existing !== undefined) return existing;
    const state: MutableFrameStrategyRetryState = {
      frameId: frame.frameId,
      lockedSkillId: null,
      strategies: this.retryControl!.policy.strategySkillIds.map(skillId => ({
        skillId,
        failures: [],
        exhausted: false,
        latestAttemptRef: null,
      })),
      lastAccountedDispatchId: null,
    };
    this.retryControl!.frames.push(state);
    return state;
  }

  private currentFrame(): InternalFrame<G, B, C> {
    const frame = this.stack[this.stack.length - 1];
    if (frame === undefined) {
      throw new ModuleInvariantError("recursive goal stack is empty while active");
    }
    return frame;
  }

  private parentFrame(
    frame: InternalFrame<G, B, C>,
  ): InternalFrame<G, B, C> | null {
    if (frame.parentFrameId === null) return null;
    const parent = this.frames.get(frame.parentFrameId);
    if (parent === undefined) {
      throw new ModuleInvariantError(
        `frame ${frame.frameId} has missing parent ${frame.parentFrameId}`,
      );
    }
    return parent;
  }

  private selectedSkill(frame: InternalFrame<G, B, C>): EnabledSkill | null {
    if (frame.selectedSkillId === null) return null;
    return this.deps.skillsById.get(frame.selectedSkillId) ?? null;
  }

  private conditionFromDerived(
    condition: DerivedCondition<G, B>,
  ): InternalCondition<G, B> {
    return {
      id: condition.id,
      goal: condition.goal,
      bindings: condition.bindings,
      satisfactionThreshold: condition.satisfactionThreshold,
      evaluatorId: condition.evaluatorId,
      selectorId: condition.selectorId,
      mode: condition.mode,
      dependsOn: [...condition.dependsOn],
      lifetime: condition.lifetime,
      activation: condition.activation,
      allowedEffects: [...condition.allowedEffects],
      fact: condition.activation === "not_applicable" ? "not_applicable" : "not_evaluated",
      satisfaction: null,
      observedEvaluatorId: null,
      evidenceRefs: [],
      childFrameId: null,
      execution: "not_started",
      errorId: null,
    };
  }

  private childEffectScope(
    parent: InternalFrame<G, B, C>,
    condition: InternalCondition<G, B>,
  ): ReadonlySet<string> {
    const composite = this.selectedSkill(parent);
    if (composite === null || composite.mode !== "composite") {
      throw new ModuleInvariantError(
        `frame ${parent.frameId} derives children without a selected composite skill`,
      );
    }
    const skillAllowedEffects = new Set(composite.allowedEffects);
    return new Set(
      condition.allowedEffects.filter(
        effect =>
          this.deps.grantedEffects.has(effect) &&
          parent.effectScope.has(effect) &&
          skillAllowedEffects.has(effect),
      ),
    );
  }

  private activeConditions(
    frame: InternalFrame<G, B, C>,
  ): InternalCondition<G, B>[] {
    return [...frame.conditions.values()].filter(
      condition =>
        condition.activation === "required" &&
        condition.fact !== "satisfied" &&
        condition.fact !== "not_applicable",
    );
  }

  private conditionFacts(
    frame: InternalFrame<G, B, C>,
  ): ConditionFact[] {
    return [...frame.conditions.values()].map(condition => ({
      conditionId: condition.id,
      fact: condition.fact,
      satisfaction: condition.satisfaction,
      evaluatorId: condition.observedEvaluatorId,
      evidenceRefs: [...condition.evidenceRefs],
      childFrameId: condition.childFrameId,
    }));
  }

  private effectsAllowed(
    frame: InternalFrame<G, B, C>,
    skill: EnabledSkill,
  ): boolean {
    if (
      skill.requiredEffects.some(
        effect =>
          !this.deps.grantedEffects.has(effect) ||
          !skill.allowedEffects.includes(effect),
      )
    ) {
      return false;
    }
    return (
      skill.allowedEffects.every(
        effect => this.deps.grantedEffects.has(effect) && frame.effectScope.has(effect),
      ) && skill.requiredEffects.every(effect => frame.effectScope.has(effect))
    );
  }

  private isCyclicDescent(
    frame: InternalFrame<G, B, C>,
    selected: EnabledSkill,
  ): boolean {
    if (frame.parentFrameId === null) return false;
    let ancestor = this.parentFrame(frame);
    while (ancestor !== null) {
      const ancestorSkill = this.selectedSkill(ancestor);
      if (
        ancestorSkill !== null &&
        ancestorSkill.id === selected.id &&
        ancestor.mode === selected.mode
      ) {
        const childUnresolved =
          frame.fulfillsConditionId === null ? [] : [frame.fulfillsConditionId];
        if (
          sameRecursiveGoalObligation(
            {
              goal: ancestor.goal,
              bindings: ancestor.bindings,
              mode: ancestor.mode,
              selectedSkillId: ancestorSkill.id,
              unresolvedConditionIds: this.activeConditions(ancestor).map(
                condition => condition.id,
              ),
              facts: this.obligationFacts(ancestor),
            },
            {
              goal: frame.goal,
              bindings: frame.bindings,
              mode: frame.mode,
              selectedSkillId: selected.id,
              unresolvedConditionIds: childUnresolved,
              facts: this.obligationFacts(frame, ancestor),
            },
            this.deps.comparators,
          )
        ) {
          return true;
        }
      }
      ancestor = this.parentFrame(ancestor);
    }
    return false;
  }

  private obligationFacts(
    frame: InternalFrame<G, B, C>,
    conditionSource: InternalFrame<G, B, C> = frame,
  ) {
    if (frame.fulfillsConditionId === null || conditionSource === frame) {
      return {
        state: this.currentState(),
        evidence: this.currentEvidence(),
        conditions: this.conditionFacts(frame),
      };
    }
    const parent = this.parentFrame(frame);
    const inherited =
      parent?.conditions.get(frame.fulfillsConditionId) ?? null;
    return {
      state: this.currentState(),
      evidence: this.currentEvidence(),
      conditions:
        inherited === null
          ? []
          : [
              {
                conditionId: inherited.id,
                fact: inherited.fact,
                satisfaction: inherited.satisfaction,
                evaluatorId: inherited.observedEvaluatorId,
                evidenceRefs: [...inherited.evidenceRefs],
                childFrameId: inherited.childFrameId,
              } satisfies ConditionFact,
            ],
    };
  }

  private markDependentFrames(
    parent: InternalFrame<G, B, C>,
    failedConditionId: string,
    original: RecursiveGoalErrorDiagnostic,
    visited: Set<string>,
  ): void {
    if (visited.has(failedConditionId)) return;
    visited.add(failedConditionId);
    for (const condition of parent.conditions.values()) {
      if (
        condition.activation !== "required" ||
        condition.childFrameId !== null ||
        !condition.dependsOn.includes(failedConditionId)
      ) {
        continue;
      }
      if (this.derivedGoalsUsed >= this.validated.limits.maxDerivedGoals) continue;
      const frameId = `${parent.frameId}:goal:${condition.id}`;
      const dependent: InternalFrame<G, B, C> = {
        frameId,
        rootRef: this.acceptedRoot.rootFrameId,
        parentFrameId: parent.frameId,
        fulfillsConditionId: condition.id,
        goal: condition.goal,
        bindings: condition.bindings,
        satisfactionThreshold: condition.satisfactionThreshold,
        evaluatorId: condition.evaluatorId,
        selectorId: condition.selectorId,
        depth: parent.depth + 1,
        effectScope: this.childEffectScope(parent, condition),
        expectedMode: condition.mode,
        mode: condition.mode,
        selectedSkillId: null,
        cursor: null,
        conditions: new Map(),
        phase: "evaluate",
        derivationClosed: false,
        fact: "unknown",
        execution: "not_started",
        unexecutedReason: "dependency_not_met",
        errorId: original.errorId,
        evidenceRefs: [],
        dispatchRefs: [],
        atomicResultRefs: [],
        noProgressCount: 0,
        lastEvaluation: null,
        lastEvaluationAtTransition: null,
        progressBaseline: null,
        pendingVerification: null,
        obligationSnapshot: null,
        pendingProgressCheck: false,
        safeRetrySkill: false,
        lastAttemptEffectKnowledge: null,
        lastAtomicOutcome: null,
      };
      this.frames.set(frameId, dependent);
      condition.childFrameId = frameId;
      condition.fact = "unknown";
      condition.execution = "not_started";
      condition.errorId = original.errorId;
      this.derivedGoalsUsed += 1;
      this.propagateDiagnostic(dependent, original);
      this.markDependentFrames(parent, condition.id, original, visited);
    }
  }

  private beginTransition(
    frame: InternalFrame<G, B, C>,
    stage: RecursiveGoalErrorStage,
  ): boolean {
    if (this.deps.signal?.aborted === true) {
      this.stopCancelled(frame);
      return false;
    }
    if (this.transitionsUsed >= this.validated.limits.maxTransitions) {
      this.stopBudget(frame, stage);
      return false;
    }
    this.transitionsUsed += 1;
    return true;
  }

  private stopCancelled(frame: InternalFrame<G, B, C>): void {
    if (this.finished) return;
    const diagnostic = this.diagnostics.create({
      code: "cancelled",
      stage: "finalization",
      message: "the recursive goal request was cancelled",
      origin: {
        frameId: frame.frameId,
        skillId: frame.selectedSkillId,
        conditionId: frame.fulfillsConditionId,
      },
      category: "abort_signal",
      effectKnowledge: aggregateEffectKnowledge(
        this.ledger.filter(effect => effect.frameId === frame.frameId),
      ),
    });
    this.addDiagnostic(diagnostic);
    if (this.primaryErrorId === null) this.primaryErrorId = diagnostic.errorId;
    frame.errorId = diagnostic.errorId;
    if (
      frame.execution !== "completed" &&
      frame.execution !== "dispatched"
    ) {
      frame.execution = "cancelled";
      if (frame.unexecutedReason === null) frame.unexecutedReason = "cancel";
    }
    this.synchronizeFailedParentCondition(
      frame,
      diagnostic,
      frame.fact,
    );
    this.propagateDiagnostic(frame, diagnostic);
    this.control = {
      outcome: "cancelled",
      stopReason: "cancel",
      frameId: this.stack.at(-1)?.frameId ?? null,
    };
    this.finished = true;
  }

  private stopBudget(
    frame: InternalFrame<G, B, C>,
    stage: RecursiveGoalErrorStage,
  ): void {
    this.stopWithNewDiagnostic(
      frame,
      {
        code: "budget_exceeded",
        stage,
        message: "the shared maxTransitions budget is exhausted",
        origin: {
          frameId: frame.frameId,
          skillId: frame.selectedSkillId,
          conditionId: frame.fulfillsConditionId,
        },
        category: "transition_budget",
      },
      "exceeded",
      "budget",
    );
  }

  private stopAtomicAttemptBudget(frame: InternalFrame<G, B, C>): void {
    this.stopWithNewDiagnostic(
      frame,
      {
        code: "budget_exceeded",
        stage: "dispatch",
        message: "the bounded strategy maxAtomicAttempts budget is exhausted",
        category: "atomic_attempt_budget",
      },
      "exceeded",
      "budget",
    );
  }

  private stopStrategiesExhausted(frame: InternalFrame<G, B, C>): void {
    this.stopWithNewDiagnostic(
      frame,
      {
        code: "no_progress",
        stage: "aggregation",
        message: "all bounded retry strategies reached their same-failure limit",
        category: "strategies_exhausted",
        effectKnowledge: this.frameEffectKnowledge(frame),
      },
      "stalled",
      "no_progress",
    );
  }

  private yieldStep(frame: InternalFrame<G, B, C>): void {
    if (this.finished) return;
    frame.phase = "select";
    this.control = {
      outcome: "yielded",
      stopReason: "step_boundary",
      frameId: frame.frameId,
    };
    this.finished = true;
  }

  private yieldPlanningFromLastResult(
    frame: InternalFrame<G, B, C>,
    nextPhase: PlanningActionBoundary["nextPhase"],
  ): void {
    const result = this.atomicResults.at(-1);
    if (
      this.planningMode === false ||
      result === undefined ||
      result.frameId !== frame.frameId
    ) {
      throw new ModuleInvariantError(
        "planning action yield requires a committed frame dispatch",
      );
    }
    this.yieldPlanningAction(frame, result, nextPhase);
  }

  private yieldPlanningAction(
    frame: InternalFrame<G, B, C>,
    result: AtomicExecutionResult<F, R>,
    nextPhase: PlanningActionBoundary["nextPhase"],
  ): void {
    if (this.finished) return;
    if (!this.planningMode) {
      throw new ModuleInvariantError(
        "planning action boundary requires planning mode",
      );
    }
    this.planningActionBoundary = freezeSnapshot({
      kind: "planning_action_boundary.v1",
      dispatchId: result.dispatchId,
      frameId: result.frameId,
      atomicResultRef: result.dispatchId,
      observedStateRef: result.observedStateRef,
      nextPhase,
    });
    frame.phase =
      nextPhase === "evaluate_actual"
        ? "evaluate"
        : nextPhase === "verify_checkpoint"
          ? "aggregate"
          : "select";
    this.control = {
      outcome: "yielded",
      stopReason: "step_boundary",
      frameId: frame.frameId,
    };
    this.finished = true;
  }

  private stopWithNewDiagnostic(
    frame: InternalFrame<G, B, C>,
    spec: StopDiagnosticSpec,
    outcome: RecursiveGoalControlOutcome,
    stopReason: RecursiveGoalStopReason,
  ): void {
    if (this.finished) return;
    const diagnostic = this.diagnostics.create({
      ...spec,
      origin: {
        frameId: frame.frameId,
        skillId: frame.selectedSkillId,
        conditionId: frame.fulfillsConditionId,
        ...spec.origin,
      },
      category: spec.category ?? "recursive_goal_stop",
      effectKnowledge:
        spec.effectKnowledge ??
        aggregateEffectKnowledge(
          this.ledger.filter(effect => effect.frameId === frame.frameId),
        ),
    });
    this.addDiagnostic(diagnostic);
    if (this.primaryErrorId === null) this.primaryErrorId = diagnostic.errorId;
    frame.errorId = diagnostic.errorId;
    if (
      (outcome === "exceeded" || outcome === "cancelled") &&
      frame.execution === "not_started"
    ) {
      frame.unexecutedReason = outcome === "exceeded" ? "budget" : "cancel";
    }
    if (outcome === "cancelled" && frame.execution === "not_started") {
      frame.execution = "cancelled";
    }
    if (outcome === "error" || outcome === "exceeded") {
      this.synchronizeFailedParentCondition(
        frame,
        diagnostic,
        frame.fact === "not_evaluated" ? "unknown" : frame.fact,
      );
    }
    this.propagateDiagnostic(frame, diagnostic);
    this.control = { outcome, stopReason, frameId: this.stack.at(-1)?.frameId ?? null };
    this.finished = true;
  }

  private propagateDiagnostic(
    frame: InternalFrame<G, B, C>,
    diagnostic: RecursiveGoalErrorDiagnostic,
  ): void {
    let current: InternalFrame<G, B, C> | null = frame;
    let updated = diagnostic;
    const propagation: ErrorPropagation[] = [...diagnostic.propagation];
    const seen = new Set(
      propagation.map(
        entry => `${entry.frameId}\0${entry.satisfies?.conditionId ?? ""}`,
      ),
    );
    while (current !== null) {
      const parent = this.parentFrame(current);
      const key = `${current.frameId}\0${current.fulfillsConditionId ?? ""}`;
      if (!seen.has(key)) {
        propagation.push({
          frameId: current.frameId,
          parentFrameId: current.parentFrameId,
          satisfies:
            parent === null || current.fulfillsConditionId === null
              ? null
              : {
                  frameId: parent.frameId,
                  conditionId: current.fulfillsConditionId,
                },
        });
        seen.add(key);
      }
      if (current.frameId !== frame.frameId) {
        current.errorId = diagnostic.errorId;
      }
      current = parent;
    }
    updated = this.diagnostics.withPropagation(diagnostic, propagation);
    const index = this.errors.findIndex(error => error.errorId === diagnostic.errorId);
    if (index >= 0) this.errors[index] = updated;
  }

  private addDiagnostic(diagnostic: RecursiveGoalErrorDiagnostic): void {
    if (!this.errors.some(error => error.errorId === diagnostic.errorId)) {
      this.errors.push(diagnostic);
    }
    if (this.primaryErrorId === null) this.primaryErrorId = diagnostic.errorId;
  }

  private errorById(errorId: string): RecursiveGoalErrorDiagnostic | null {
    return this.errors.find(error => error.errorId === errorId) ?? null;
  }

  private context(frame: InternalFrame<G, B, C>) {
    return Object.freeze({
      requestId: this.acceptedRoot.requestId,
      frameId: frame.frameId,
      signal: this.deps.signal,
    });
  }

  private currentState(): S {
    return this.currentStateRecord().value;
  }

  private stateByRef(stateRef: string): S {
    const state = this.states.find(entry => entry.id === stateRef);
    if (state === undefined) {
      throw new ModuleInvariantError(`state record ${stateRef} is unavailable`);
    }
    return state.value;
  }

  private currentStateRecord(): StateRecord<S> {
    const state = this.states[this.states.length - 1];
    if (state === undefined) {
      throw new ModuleInvariantError("recursive goal has no typed state record");
    }
    return state;
  }

  private currentEvidence(): readonly EvidenceRecord<E>[] {
    return this.evidence;
  }

  private callbackGoal(goal: G): G {
    return freezeSnapshot(goal);
  }

  private callbackBindings(bindings: B): B {
    return freezeSnapshot(bindings);
  }

  private callbackState(): S {
    return freezeSnapshot(this.currentState());
  }

  private callbackEvidence(): readonly EvidenceRecord<E>[] {
    return freezeSnapshot(this.evidence);
  }

  private callbackConditions(
    frame: InternalFrame<G, B, C>,
  ): readonly ConditionFact[] {
    return freezeSnapshot(this.conditionFacts(frame));
  }

  private planningDecision(decision: PlanningDecision): void {
    if (this.planningReport !== null) this.planningReport = {...this.planningReport, decision};
  }

  private async preparePlanning(frame: InternalFrame<G, B, C>, candidates: readonly EnabledSkill[]): Promise<boolean> {
    if (!this.planningMode || this.planningRequest === null || this.planningCapability === null || this.planControl === null) return true;
    if (candidates.some(skill => skill.mode === "composite" && this.deps.adapter.supports({goal: frame.goal, bindings: frame.bindings, skill}))) return true;
    try {
    const control = this.planControl;
    const node = control.plan?.nodes.find(item => item.id === control.cursor?.nodeRef);
    if (node?.obligationRef.frameRef === frame.frameId && control.currentPathRef !== null && control.recovery.phase === "idle" &&
      candidates.some(skill=>skill.id===node.skillRef.id && skill.version===node.skillRef.version && this.effectsAllowed(frame,skill))) {
      const path=control.plan!.paths.find(path=>path.pathId===control.currentPathRef)!;
      if(this.planningEntryApplies(control.plan!,path,node)) return true;
    }
    const replanning = control.plan !== null;
    if (replanning && control.usage.replansUsed >= this.planningRequest.limits.maxReplans) {
      this.stopWithNewDiagnostic(frame, {code:"budget_exceeded",stage:"selection",message:"planning replan budget exhausted",category:"planning_budget"}, "exceeded", "budget");
      return false;
    }
      let output = await expandGoalGraph({
        planId: `${this.acceptedRoot.requestId}:plan:${control.usage.replansUsed + 1}:${this.transitionsUsed}`,
        rootRef:this.acceptedRoot.rootFrameId,frameRef:frame.frameId,goal:frame.goal,bindings:frame.bindings,
        state:this.callbackState(),stateRef:this.currentStateRecord().id,evidence:this.currentEvidence().map(item=>item.payload),
        skills:candidates.filter(skill=>skill.mode === "atomic" && this.effectsAllowed(frame,skill) && this.deps.adapter.supports({goal:frame.goal,bindings:frame.bindings,skill})),
        options:this.planningRequest,capability:this.planningCapability,control,
        consumePrediction:()=>this.beginTransition(frame,"selection"),rootSatisfied:false,
      });
      if (this.finished) return false;
      if(output.plan!==null) output={...output,plan:readGoalGraphPlan(output.plan,this.planningCapability.guards)};
      if(output.plan!==null && output.plan.paths.length>0 && (output.prediction.kind==="ready" || output.prediction.kind==="deferred")) {
        const plan=output.plan;
        const influences=control.failurePriors.filter(prior=>prior.conclusion.kind==="deprioritize_transition" && this.planningCapability!.assessPrior({prior,obligationRef:{rootRef:this.acceptedRoot.rootFrameId,frameRef:frame.frameId,conditionRef:null},skillRef:prior.skillRef,actualState:this.callbackState(),actualEvidence:this.currentEvidence().map(item=>item.payload),invalidation:prior.invalidation}).kind==="applicable").flatMap(prior=>plan.paths.flatMap(path=>{
          const transitions=plan.nodes.filter(n=>path.nodeRefs.includes(n.id)).flatMap(n=>n.predictedResults.map(r=>r.transitionRef));
          return prior.conclusion.transitionRefs.some(ref=>transitions.includes(ref)) ? [{priorRef:prior.id,pathRef:path.pathId,transitionRefs:prior.conclusion.transitionRefs}] : [];
        }));
        const ranking=this.planningCapability.decision === undefined ? output.ranking! : await resolvePlanningDecision(this.planningCapability.decision,{
          preference:this.planningRequest.preference,candidates:plan.paths.map(path=>({pathId:path.pathId,rankOrder:path.rankOrder,projection:path.projection,attemptOrder:path.attemptOrder})),priorInfluences:influences,unknown:[],
        });
        if(this.deps.signal?.aborted===true) {this.stopCancelled(frame);return false;}
        output={...output,ranking,prediction:ranking.kind==="ranked" ? {kind:"ready",transitionRef:plan.planId,rootRef:plan.rootRef,startStateRef:plan.startStateRef,planRef:plan.planId,rankedPathRefs:ranking.pathRefs,frontier:plan.frontier,predictionCallsUsed:output.usage.predictionCallsUsed} : {kind:"deferred",rootRef:plan.rootRef,startStateRef:plan.startStateRef,requirements:ranking.missingKeys.map(ref=>({ref,reason:ranking.reason})),frontier:plan.frontier,predictionCallsUsed:output.usage.predictionCallsUsed}};
      }
      this.planControl = {...control,plan:output.plan,usage:{...output.usage,replansUsed:control.usage.replansUsed + Number(replanning)}};
      this.planningReport = {kind:"bounded_goal_planning_report.v1",prediction:output.prediction,decision:this.planningReport?.decision ?? null,priorAssessments:output.priorAssessments};
      if (output.prediction.kind !== "ready" || output.ranking?.kind !== "ranked" || output.plan === null) {
        const prediction=output.prediction;
        const deferred=prediction.kind==="deferred";
        const exhausted=prediction.kind==="stopped" && prediction.reason==="budget_exhausted";
        const missing=prediction.kind==="not_ready" && ["missing_model","missing_skill","missing_evaluator"].includes(prediction.reason);
        const code:RecursiveGoalErrorCode=deferred ? "policy_deferred" : exhausted ? "budget_exceeded" : missing ? "capability_missing" : prediction.kind==="not_ready" && prediction.reason==="invalid_contract" ? "adapter_contract_invalid" : "precondition_unsatisfied";
        this.stopWithNewDiagnostic(frame, {code,stage:"selection",message:`planning ${prediction.kind}: ${"reason" in prediction ? prediction.reason : "no comparable path"}`,category:"planning_not_ready"},deferred ? "stalled" : exhausted ? "exceeded" : "error",deferred ? "no_progress" : exhausted ? "budget" : "fatal_error");
        return false;
      }
      const pathRef=output.ranking.pathRefs.find(ref=>{
        const path=output.plan!.paths.find(path=>path.pathId===ref)!;
        const entry=output.plan!.nodes.find(node=>node.id===path.entryNodeRef)!;
        return this.planningEntryApplies(output.plan!,path,entry);
      });
      if(pathRef===undefined) {
        this.stopWithNewDiagnostic(frame,{code:"precondition_unsatisfied",stage:"selection",message:"no planned entry is applicable to current State",category:"planning_entry_inapplicable"},"error","fatal_error");
        return false;
      }
      const selected=output.plan.paths.find(item=>item.pathId===pathRef);
      const first=output.plan.nodes.find(item=>item.id===selected?.entryNodeRef);
      if (selected === undefined || first === undefined) throw new TypeError("planning ranking has no valid entry");
      this.planControl={...this.planControl,currentPathRef:selected.pathId,alternatePathRefs:output.ranking.pathRefs.slice(1),cursor:{pathRef:selected.pathId,nodeRef:first.id,resultRef:first.predictedResults[0]!.resultRef,stepIndex:0},recovery:{...control.recovery,phase:"idle"}};
      return true;
    } catch(error) {
      this.stopWithNewDiagnostic(frame,{code:"adapter_contract_invalid",stage:"selection",message:errorMessage(error),category:"planning_callback",cause:this.diagnostics.capturedCause(error)},"error","fatal_error");
      return false;
    }
  }

  private async reconcilePlanning(frame: InternalFrame<G, B, C>, evaluation: EvaluationReceipt): Promise<boolean> {
    if (this.planControl === null || this.planningCapability === null || this.planningRequest === null) return true;
    const control=this.planControl;
    if(frame.frameId === this.rootFrame.frameId && evaluation.result === "satisfied" && this.unclosedRequiredFrame(frame)===null) {
      this.planningDecision({kind:"root_satisfied",evaluationStateRef:this.currentStateRecord().id});
      if(this.planningReport!==null) this.planningReport={...this.planningReport,recoveredFailureRefs:control.failurePriors.flatMap(prior=>prior.source.kind==="verified_failure" ? prior.source.errorRefs : [])};
      return true;
    }
    const atomic=this.atomicResults.find(item=>item.dispatchId===frame.atomicResultRefs.at(-1));
    if(atomic === undefined || control.recovery.recoveryRefs.includes(atomic.dispatchId)) return true;
    const plan=control.plan;
    const node=plan?.nodes.find(item=>item.id===control.cursor?.nodeRef);
    if(plan === null || node === undefined || node.obligationRef.frameRef !== frame.frameId) return true;
    this.planControl={...control,recovery:{...control.recovery,recoveryRefs:[...control.recovery.recoveryRefs,atomic.dispatchId]}};
    if(atomic.outcome==="failed" || atomic.outcome==="rejected") {
      let recovered:string|null=null;
      if(atomic.observedStateRef===this.currentStateRecord().id) {
        for(const priorCheckpoint of [...control.verifiedCheckpoints].reverse()) {
          const spec=this.planningRequest.checkpointSpecs.find(item=>item.id===priorCheckpoint.specRef);
          if(spec!==undefined && await this.evaluateCheckpoint(frame,spec)!==null) {recovered=spec.id;break;}
        }
      }
      if(recovered!==null && control.usage.rollbacksUsed>=this.planningRequest.limits.maxRollbacks) {
        this.stopWithNewDiagnostic(frame,{code:"budget_exceeded",stage:"selection",message:"checkpoint rollback budget exhausted",category:"planning_budget"},"exceeded","budget");
        return false;
      }
      this.planControl={...this.planControl,currentPathRef:null,cursor:null,usage:{...this.planControl.usage,rollbacksUsed:control.usage.rollbacksUsed+Number(recovered!==null)},recovery:{...this.planControl.recovery,phase:"replan",checkpointRef:recovered}};
      this.planningDecision(recovered===null ? {kind:"replan",frontierRefs:[],triggerRefs:[atomic.dispatchId]} : {kind:"rollback",checkpointRef:recovered,currentStateRef:this.currentStateRecord().id,sourceErrorRefs:atomic.executionErrorIds});
      return !this.finished;
    }
    if(this.planningReport!==null) this.planningReport={...this.planningReport,priorAssessments:control.failurePriors.map(prior=>({priorRef:prior.id,applicability:this.planningCapability!.assessPrior({prior,obligationRef:node.obligationRef,skillRef:prior.skillRef,actualState:this.callbackState(),actualEvidence:this.currentEvidence().map(item=>item.payload),invalidation:prior.invalidation})}))};
    const matches=node.predictedResults.filter(predicted=>this.planningCapability!.matchesActual({
      rootGoal:frame.goal,bindings:frame.bindings,obligationRef:node.obligationRef,skillRef:node.skillRef,predicted,
      actualState:this.callbackState(),actualEvidence:this.currentEvidence().map(item=>item.payload),actualEffects:atomic.effect.confirmedEffects,
      actualOutcome:atomic.outcome,
    }).kind === "applicable");
    for(const spec of this.planningRequest.checkpointSpecs) {
      if(this.planControl.verifiedCheckpoints.some(item=>item.specRef===spec.id)) continue;
      const checked=await this.evaluateCheckpoint(frame,spec);
      if(checked === null) continue;
      this.planControl={...this.planControl,verifiedCheckpoints:[...this.planControl.verifiedCheckpoints,{specRef:spec.id,planRef:plan.planId,cursor:control.cursor!,verifiedAtTransition:this.transitionsUsed,evaluation:{evaluatorId:checked.evaluatorId,result:checked.result,satisfaction:checked.satisfaction,evidenceRefs:checked.evidenceRefs,stateRef:this.currentStateRecord().id,evaluatedAtTransition:this.transitionsUsed}}],currentPathRef:null,cursor:null,recovery:{...this.planControl.recovery,phase:"replan"}};
      this.planningDecision({kind:"checkpoint_reached",checkpointRef:spec.id});
      return !this.finished;
    }
    const paths=[control.currentPathRef,...control.alternatePathRefs].flatMap(id=>plan.paths.filter(path=>path.pathId===id));
    for(const path of paths) {
      const index=path.nodeRefs.indexOf(node.id);
      if(index<0) continue;
      const nextRef=path.nodeRefs[index+1];
      if(nextRef===undefined) continue;
      const edge=plan.edges.find(item=>item.source.nodeRef===node.id && matches.some(result=>result.resultRef===item.source.resultRef) && item.target.kind==="node" && item.target.targetRef===nextRef);
      if(edge===undefined) continue;
      const next=plan.nodes.find(item=>item.id===nextRef)!;
      if(!this.planningEntryApplies(plan,path,next,edge)) continue;
      this.planControl={...this.planControl,currentPathRef:path.pathId,alternatePathRefs:paths.filter(item=>item.pathId!==path.pathId).map(item=>item.pathId),cursor:{pathRef:path.pathId,nodeRef:next.id,resultRef:next.predictedResults[0]!.resultRef,stepIndex:index+1},recovery:{...this.planControl.recovery,phase:"idle"}};
      this.planningDecision(path.pathId===control.currentPathRef ? {kind:"continue",pathRef:path.pathId,nodeRef:next.id} : {kind:"switch",fromPathRef:control.currentPathRef!,toPathRef:path.pathId,entryNodeRef:next.id});
      frame.phase="select";
      return true;
    }
    this.planControl={...this.planControl,currentPathRef:null,cursor:null,recovery:{...this.planControl.recovery,phase:"replan"}};
    this.planningDecision({kind:"replan",frontierRefs:plan.frontier.map(item=>item.frontierRef),triggerRefs:[atomic.dispatchId]});
    return true;
  }

  private async evaluateCheckpoint(frame: InternalFrame<G,B,C>, spec: BoundedPlanningRequest<G,B>["checkpointSpecs"][number]): Promise<EvaluationReceipt|null> {
    if(!this.deps.evaluatorsById.has(spec.evaluatorId)) throw new TypeError("checkpoint evaluator is disabled");
    if(!this.beginTransition(frame,"evaluation")) return null;
    const checked=readEvaluationReceipt(await this.deps.adapter.evaluate({context:this.context(frame),goal:spec.goal,bindings:spec.bindings,satisfactionThreshold:spec.satisfactionThreshold,state:this.callbackState(),evidence:this.callbackEvidence(),conditions:this.callbackConditions(frame)}),spec.satisfactionThreshold);
    if(checked.evaluatorId!==spec.evaluatorId) throw new TypeError("checkpoint evaluator mismatch");
    if(checked.result!=="satisfied" || this.evaluationEvidenceFailure(checked)!==null || !checked.evidenceRefs.some(id=>this.evidence.some(e=>e.id===id && e.validity==="valid" && e.stateRef===this.currentStateRecord().id)) || spec.evidenceRequirementRefs.some(id=>!checked.evidenceRefs.includes(id))) return null;
    const closed=spec.obligations.every(ref=>{
      const owner=this.frames.get(ref.frameRef);
      return ref.rootRef===this.acceptedRoot.rootFrameId && owner!==undefined && (ref.conditionRef===null ? owner.fact==="satisfied" : owner.conditions.get(ref.conditionRef)?.fact==="satisfied");
    });
    return closed ? checked : null;
  }

  private planningEntryApplies(
    plan: GoalGraphPlan<G,B,S,E,F>, path: PathCandidate<G,B,S,E>,
    node: PlanNode<G,B,S,E,F>, edge?: PlanEdge<G,B,S,E>,
  ): boolean {
    const incoming=edge ?? plan.edges.find(item=>item.target.kind==="node" && item.target.targetRef===node.id);
    const hasConditions=node.preconditions.length>0 || node.predictedResults.some(result=>result.preconditions.length>0) ||
      path.invalidation.length>0 || (incoming?.conditions.length ?? 0)>0;
    const assess=this.planningCapability!.assessEntry;
    if(assess===undefined) {
      if(hasConditions) throw new TypeError("typed planning entry requires an explicit assessEntry capability");
      return true;
    }
    const assessment=readPlanningEntryAssessment(assess(freezeSnapshot({path,node,edge:incoming ?? null,
      actualState:this.callbackState(),actualEvidence:this.currentEvidence().map(item=>item.payload)})));
    return assessment.kind==="applicable";
  }

  private planningSelectionView(
    frame: InternalFrame<G, B, C>,
  ): PlanningSelectionView | null {
    if (!this.planningMode || this.planControl === null) return null;
    const { plan, currentPathRef, cursor } = this.planControl;
    if (plan === null || currentPathRef === null || cursor === null) {
      return null;
    }
    const path = plan.paths.find(candidate => candidate.pathId === currentPathRef);
    const node = plan.nodes.find(candidate => candidate.id === cursor.nodeRef);
    if (
      path === undefined ||
      node === undefined ||
      cursor.pathRef !== path.pathId ||
      !path.nodeRefs.includes(node.id)
    ) {
      throw new ModuleInvariantError(
        `planning cursor for frame ${frame.frameId} has no current node`,
      );
    }
    if(node.obligationRef.frameRef !== frame.frameId) return null;
    const skill = this.deps.skillsById.get(node.skillRef.id);
    if (
      skill === undefined ||
      skill.version !== node.skillRef.version ||
      skill.mode !== "atomic" ||
      !selectorIncludes(this.deps.selectorsById.get(frame.selectorId), skill.id)
    ) {
      throw new ModuleInvariantError(
        `planning node ${node.id} is not an enabled current atomic skill`,
      );
    }
    return freezeSnapshot({
      planRef: plan.planId,
      pathRef: path.pathId,
      cursorRef: cursor.nodeRef,
      expectedSkillRef: node.skillRef,
      allowedEntrySkillRefs: [node.skillRef],
    });
  }

  private callbackSkills(
    skills: readonly EnabledSkill[],
  ): readonly EnabledSkill[] {
    return freezeSnapshot(skills);
  }

  private frameEffectKnowledge(
    frame: InternalFrame<G, B, C>,
  ): EffectKnowledge {
    return aggregateEffectKnowledge(
      this.ledger.filter(effect => effect.frameId === frame.frameId),
    );
  }

  private evaluationEvidenceFailure(
    receipt: EvaluationReceipt,
  ): StopDiagnosticSpec | null {
    const evidenceById = new Map(this.evidence.map(item => [item.id, item]));
    for (const evidenceRef of receipt.evidenceRefs) {
      const evidence = evidenceById.get(evidenceRef);
      if (evidence === undefined) {
        return {
          code: "evidence_unavailable",
          stage: "evaluation",
          message: `evaluation referenced unavailable evidence ${evidenceRef}`,
          owner: "adapter",
          category: "evidence_reference_missing",
          effectKnowledge: aggregateEffectKnowledge(this.ledger),
        };
      }
      if (receipt.result === "satisfied" && evidence.validity === "stale") {
        return {
          code: "evidence_unavailable",
          stage: "evaluation",
          message: `evaluation referenced stale evidence ${evidenceRef}`,
          owner: "adapter",
          category: "evidence_stale",
          effectKnowledge: aggregateEffectKnowledge(this.ledger),
        };
      }
      if (receipt.result === "satisfied" && evidence.validity === "conflicted") {
        return {
          code: "evidence_conflict",
          stage: "evaluation",
          message: `evaluation referenced conflicted evidence ${evidenceRef}`,
          owner: "adapter",
          category: "evidence_conflicted",
          effectKnowledge: aggregateEffectKnowledge(this.ledger),
        };
      }
    }
    return null;
  }

  private createObligationSnapshot(
    frame: InternalFrame<G, B, C>,
    selectedSkillId: string | null,
  ): RecursiveGoalObligationSnapshot {
    return {
      mode: frame.mode,
      selectedSkillId,
      unresolvedConditionIds: this.activeConditions(frame).map(
        condition => condition.id,
      ),
      stateRef: this.currentStateRecord().id,
      evidenceRefs: this.currentEvidence().map(item => item.id),
      conditions: this.conditionFacts(frame),
    };
  }

  private atomicFailureMessage(receipt: AtomicReceipt<S, E, F, R>): string {
    if (receipt.executionErrors.length > 0) {
      return receipt.executionErrors[0]!.message;
    }
    if (
      receipt.sourceResult !== null &&
      "message" in receipt.sourceResult
    ) {
      return receipt.sourceResult.message;
    }
    return `atomic execution ended with ${receipt.outcome}`;
  }

  private frameResult(
    frame: InternalFrame<G, B, C>,
  ): FrameResult<G, B, C> {
    const active = this.activeConditions(frame).map(condition => condition.id);
    return {
      frameId: frame.frameId,
      rootRef: frame.rootRef,
      parentFrameId: frame.parentFrameId,
      fulfillsConditionId: frame.fulfillsConditionId,
      goal: frame.goal,
      bindings: frame.bindings,
      mode: frame.mode,
      depth: frame.depth,
      selectedSkillId: frame.selectedSkillId,
      cursor: frame.cursor,
      conditionResults: this.conditionFacts(frame),
      activeRequirements: active,
      unresolvedRequirements: active,
      fact: frame.fact,
      execution: frame.execution,
      unexecutedReason: frame.unexecutedReason,
      errorId: frame.errorId,
      evidenceRefs: [...frame.evidenceRefs],
      dispatchRefs: [...frame.dispatchRefs],
      atomicResultRefs: [...frame.atomicResultRefs],
      noProgressCount: frame.noProgressCount,
    };
  }

  private dependencyStates(): DependencyState<G, B>[] {
    const dependencies: DependencyState<G, B>[] = [];
    for (const frame of this.frames.values()) {
      for (const condition of frame.conditions.values()) {
        dependencies.push({
          ownerFrameId: frame.frameId,
          condition: this.derivedConditionFromInternal(condition),
          fact: condition.fact,
          execution: condition.execution,
          childFrameId: condition.childFrameId,
        });
      }
    }
    return dependencies;
  }

  private frameControls(): RecursiveGoalFrameControl<G, B>[] {
    return [...this.frames.values()].map(frame => ({
      frameId: frame.frameId,
      satisfactionThreshold: frame.satisfactionThreshold,
      evaluatorId: frame.evaluatorId,
      selectorId: frame.selectorId,
      effectScope: [...frame.effectScope],
      expansion:
        frame.conditions.size === 0 && !frame.derivationClosed
          ? "not_derived"
          : frame.derivationClosed
            ? "closed"
            : "more",
      evaluation:
        frame.lastEvaluation === null || frame.lastEvaluationAtTransition === null
          ? null
          : {
              receipt: frame.lastEvaluation,
              evaluatedAtTransition: frame.lastEvaluationAtTransition,
            },
      progressBaseline: frame.progressBaseline,
      pendingVerification: frame.pendingVerification,
      obligationSnapshot: frame.obligationSnapshot,
    }));
  }

  private derivedConditionFromInternal(
    condition: InternalCondition<G, B>,
  ): DerivedCondition<G, B> {
    return {
      id: condition.id,
      goal: condition.goal,
      bindings: condition.bindings,
      satisfactionThreshold: condition.satisfactionThreshold,
      evaluatorId: condition.evaluatorId,
      selectorId: condition.selectorId,
      mode: condition.mode,
      dependsOn: [...condition.dependsOn],
      lifetime: condition.lifetime,
      activation: condition.activation,
      allowedEffects: [...condition.allowedEffects],
    };
  }

  private remainingRequirements(): RemainingRequirement[] {
    const remaining: RemainingRequirement[] = [];
    for (const frame of this.frames.values()) {
      for (const condition of this.activeConditions(frame)) {
        remaining.push({
          frameId: frame.frameId,
          conditionId: condition.id,
        });
      }
    }
    return remaining;
  }

  private compactControl(): RecursiveGoalControl {
    if (this.control !== null) return this.control;
    this.control = {
      outcome: "error",
      stopReason: "fatal_error",
      frameId: this.rootFrame.frameId,
    };
    return this.control;
  }

  private compactRootEvaluation(): RootEvaluation {
    if (this.rootEvaluation.state === "evaluated") return this.rootEvaluation;
    return this.rootEvaluation;
  }

  private continuation(): RecursiveGoalResumableContinuation<
    G,
    S,
    B,
    E,
    F,
    R,
    C
  > {
    const base = {
      acceptedRoot: this.acceptedRoot,
      lastTrustedTransition: this.transitionsUsed,
      rootEvaluation: this.compactRootEvaluation(),
      control: this.compactControl(),
      frames: [...this.frames.values()].map(frame => this.frameResult(frame)),
      frameControls: this.frameControls(),
      stack: this.stack.map(frame => ({
        frameId: frame.frameId,
        parentFrameId: frame.parentFrameId,
        fulfillsConditionId: frame.fulfillsConditionId,
        phase: frame.phase,
        cursor: frame.cursor,
      })),
      dependencies: this.dependencyStates(),
      states: [...this.states],
      evidence: [...this.evidence],
      ledger: [...this.ledger],
      atomicResults: [...this.atomicResults],
      errors: this.errors.map(cloneDiagnostic),
      primaryErrorId: this.primaryErrorId,
      relatedIssues: [...this.relatedIssues],
      budgetUsed: {
        transitionsUsed: this.transitionsUsed,
        derivedGoalsUsed: this.derivedGoalsUsed,
      },
      remainingRequirements: this.remainingRequirements(),
      contractRefs: {
        enabledSkillIds: this.deps.enabledSkills.map(skill => skill.id),
        evaluatorIds: this.deps.enabledEvaluators.map(evaluator => evaluator.id),
        selectorIds: this.deps.selectors.map(selector => selector.id),
        grantedEffects: [...this.deps.grantedEffects],
      },
      ...(this.retryControl === null
        ? {}
        : { retryControl: retryControlSnapshot(this.retryControl) }),
    };
    if (!this.planningMode) {
      return {
        schema: RECURSIVE_GOAL_CONTINUATION_SCHEMA,
        ...base,
      };
    }
    if (this.planControl === null || this.planningContract === null) {
      throw new ModuleInvariantError(
        "planning continuation requires plan control and contract refs",
      );
    }
    return {
      schema: "nnanything.recursive-goal.continuation.v2",
      ...base,
      planControl: this.planControl,
      planningContract: this.planningContract,
      actionBoundary: this.planningActionBoundary,
    };
  }

  private async buildRunResult(): Promise<
    RecursiveGoalRunResult<G, S, B, E, F, R, C>
  > {
    if (!this.finished) {
      throw new ModuleInvariantError(
        "report operator ran before recursive execution stopped",
      );
    }
    await this.finalizeSideEffects();
    return this.buildRunResultSync();
  }

  private buildRunResultSync(): RecursiveGoalRunResult<
    G,
    S,
    B,
    E,
    F,
    R,
    C
  > {
    const outcome = this.compactControl().outcome;
    const report: RecursiveGoalRunReport<G, S, B, E, F, R, C> = {
      root: this.acceptedRoot,
      rootEvaluation: this.compactRootEvaluation(),
      control: this.compactControl(),
      states: [...this.states],
      evidence: [...this.evidence],
      frames: [...this.frames.values()].map(frame => this.frameResult(frame)),
      effects: [...this.ledger],
      atomicResults: [...this.atomicResults],
      errors: this.errors.map(cloneDiagnostic),
      primaryErrorId: this.primaryErrorId,
      relatedIssues: [...this.relatedIssues],
      budgetUsed: {
        transitionsUsed: this.transitionsUsed,
        derivedGoalsUsed: this.derivedGoalsUsed,
      },
      continuation: outcome === "completed" ? null : this.continuation(),
      ...(this.planningReport === null
        ? {}
        : { planning: this.planningReport }),
      cleanup: this.cleanupReceipt,
      collection: this.collectionReceipt,
    };
    return freezeSnapshot({
      kind: "run_result",
      requestId: this.acceptedRoot.requestId,
      acceptedRoot: this.acceptedRoot,
      report,
    });
  }

  private async finalizeSideEffects(): Promise<void> {
    if (this.sideEffectsFinalized) return;
    this.sideEffectsFinalized = true;
    if (this.deps.adapter.cleanup !== undefined) {
      try {
        const raw = await this.deps.adapter.cleanup(
          this.sideEffectInput(this.rootFrame),
        );
        this.cleanupReceipt = readReceiptRef(raw, "cleanup");
      } catch (error) {
        this.recordRelatedFailure("cleanup", error);
      }
    }
    if (this.deps.adapter.collect !== undefined) {
      try {
        const raw = await this.deps.adapter.collect(
          this.sideEffectInput(this.rootFrame),
        );
        this.collectionReceipt = readReceiptRef(raw, "collection");
      } catch (error) {
        this.recordRelatedFailure("collection", error);
      }
    }
  }

  private sideEffectInput(
    frame: InternalFrame<G, B, C>,
  ):
    | Parameters<NonNullable<RecursiveGoalAdapter<G, S, B, E, F, R, C>["cleanup"]>>[0]
    | Parameters<
        NonNullable<RecursiveGoalAdapter<G, S, B, E, F, R, C>["collect"]>
      >[0] {
    return freezeSnapshot({
      context: this.context(frame),
      root: this.acceptedRoot,
      states: [...this.states],
      evidence: [...this.evidence],
      effects: [...this.ledger],
      atomicResults: [...this.atomicResults],
    });
  }

  private recordRelatedFailure(
    relation: "cleanup" | "collection",
    error: unknown,
  ): void {
    const primaryBefore = this.primaryErrorId;
    const diagnostic = this.diagnostics.create({
      code: "adapter_contract_invalid",
      stage: relation,
      message: errorMessage(error),
      origin: { frameId: this.rootFrame.frameId },
      owner: "adapter",
      category: `${relation}_failure`,
      effectKnowledge: aggregateEffectKnowledge(this.ledger),
      cause: this.diagnostics.capturedCause(error),
    });
    this.addDiagnostic(diagnostic);
    this.primaryErrorId = primaryBefore;
    this.relatedIssues.push(
      this.diagnostics.related(diagnostic.errorId, relation, false),
    );
  }

  private restoreFrames(
    continuation: RecursiveGoalResumableContinuation<
      G,
      S,
      B,
      E,
      F,
      R,
      C
    >,
  ): void {
    const stackPhases = new Map(
      continuation.stack.map(entry => [entry.frameId, entry]),
    );
    const controls = new Map(
      continuation.frameControls.map(control => [control.frameId, control]),
    );
    for (const result of continuation.frames) {
      const dependencyByCondition = new Map(
        continuation.dependencies
          .filter(dependency => dependency.ownerFrameId === result.frameId)
          .map(dependency => [dependency.condition.id, dependency]),
      );
      const control = controls.get(result.frameId);
      if (control === undefined) {
        throw new ModuleInvariantError(
          `continued frame ${result.frameId} lacks typed control`,
        );
      }
      const frame =
        result.depth === 0
          ? this.createRestoredRoot(
              result,
              control,
              stackPhases.get(result.frameId),
            )
          : this.createRestoredChild(
              result,
              control,
              stackPhases.get(result.frameId),
            );
      for (const conditionFact of result.conditionResults) {
        const dependency = dependencyByCondition.get(conditionFact.conditionId);
        if (dependency === undefined) {
          throw new ModuleInvariantError(
            `continued condition ${conditionFact.conditionId} lacks typed dependency`,
          );
        }
        const child =
          conditionFact.childFrameId === null
            ? undefined
            : continuation.frames.find(
                candidate => candidate.frameId === conditionFact.childFrameId,
              );
        const definition = dependency.condition;
        const condition: InternalCondition<G, B> = {
          id: definition.id,
          goal: definition.goal,
          bindings: definition.bindings,
          satisfactionThreshold: definition.satisfactionThreshold,
          evaluatorId: definition.evaluatorId,
          selectorId: definition.selectorId,
          mode: definition.mode,
          dependsOn: [...definition.dependsOn],
          lifetime: definition.lifetime,
          activation: definition.activation,
          allowedEffects: [...definition.allowedEffects],
          fact: conditionFact.fact,
          satisfaction: conditionFact.satisfaction,
          observedEvaluatorId: conditionFact.evaluatorId,
          evidenceRefs: [...conditionFact.evidenceRefs],
          childFrameId: conditionFact.childFrameId,
          execution: dependency.execution,
          errorId: child?.errorId ?? null,
        };
        frame.conditions.set(condition.id, condition);
      }
      frame.derivationClosed = control.expansion === "closed";
      this.frames.set(frame.frameId, frame);
    }

  }

  private createRestoredRoot(
    result: FrameResult<G, B, C>,
    control: RecursiveGoalFrameControl<G, B>,
    stack: RecursiveGoalFrameStackEntry<C> | undefined,
  ): InternalFrame<G, B, C> {
    return {
      frameId: result.frameId,
      rootRef: result.rootRef,
      parentFrameId: null,
      fulfillsConditionId: null,
      goal: this.acceptedRoot.rootGoal,
      bindings: this.acceptedRoot.rootBindings,
      satisfactionThreshold: control.satisfactionThreshold,
      evaluatorId: control.evaluatorId,
      selectorId: control.selectorId,
      depth: 0,
      effectScope: new Set(control.effectScope),
      expectedMode: null,
      mode: result.mode,
      selectedSkillId: result.selectedSkillId,
      cursor: result.cursor,
      conditions: new Map(),
      phase: stack?.phase ?? "evaluate",
      derivationClosed: control.expansion === "closed",
      fact: result.fact,
      execution: result.execution,
      unexecutedReason: result.unexecutedReason,
      errorId: result.errorId,
      evidenceRefs: [...result.evidenceRefs],
      dispatchRefs: [...result.dispatchRefs],
      atomicResultRefs: [...result.atomicResultRefs],
      noProgressCount: result.noProgressCount,
      lastEvaluation: control.evaluation?.receipt ?? null,
      lastEvaluationAtTransition:
        control.evaluation?.evaluatedAtTransition ?? null,
      progressBaseline: control.progressBaseline,
      pendingVerification: control.pendingVerification,
      obligationSnapshot: control.obligationSnapshot,
      pendingProgressCheck: false,
      safeRetrySkill: false,
      lastAttemptEffectKnowledge:
        result.selectedSkillId === null
          ? null
          : effectKnowledgeForSkill(this.ledger, result.frameId, result.selectedSkillId),
      lastAtomicOutcome:
        this.atomicResults.find(item => item.frameId === result.frameId)?.outcome ??
        null,
    };
  }

  private createRestoredChild(
    result: FrameResult<G, B, C>,
    control: RecursiveGoalFrameControl<G, B>,
    stack: RecursiveGoalFrameStackEntry<C> | undefined,
  ): InternalFrame<G, B, C> {
    return {
      frameId: result.frameId,
      rootRef: result.rootRef,
      parentFrameId: result.parentFrameId,
      fulfillsConditionId: result.fulfillsConditionId,
      goal: result.goal,
      bindings: result.bindings,
      satisfactionThreshold: control.satisfactionThreshold,
      evaluatorId: control.evaluatorId,
      selectorId: control.selectorId,
      depth: result.depth,
      effectScope: new Set(control.effectScope),
      expectedMode: result.mode,
      mode: result.mode,
      selectedSkillId: result.selectedSkillId,
      cursor: result.cursor,
      conditions: new Map(),
      phase: stack?.phase ?? "evaluate",
      derivationClosed: control.expansion === "closed",
      fact: result.fact,
      execution: result.execution,
      unexecutedReason: result.unexecutedReason,
      errorId: result.errorId,
      evidenceRefs: [...result.evidenceRefs],
      dispatchRefs: [...result.dispatchRefs],
      atomicResultRefs: [...result.atomicResultRefs],
      noProgressCount: result.noProgressCount,
      lastEvaluation: control.evaluation?.receipt ?? null,
      lastEvaluationAtTransition:
        control.evaluation?.evaluatedAtTransition ?? null,
      progressBaseline: control.progressBaseline,
      pendingVerification: control.pendingVerification,
      obligationSnapshot: control.obligationSnapshot,
      pendingProgressCheck: false,
      safeRetrySkill: false,
      lastAttemptEffectKnowledge:
        result.selectedSkillId === null
          ? null
          : effectKnowledgeForSkill(this.ledger, result.frameId, result.selectedSkillId),
      lastAtomicOutcome:
        this.atomicResults.find(item => item.frameId === result.frameId)?.outcome ??
        null,
    };
  }

  private restoreStack(
    continuation: RecursiveGoalResumableContinuation<
      G,
      S,
      B,
      E,
      F,
      R,
      C
    >,
  ): void {
    const ordered =
      continuation.stack.length > 0
        ? continuation.stack
        : [
            {
              frameId: this.acceptedRoot.rootFrameId,
              parentFrameId: null,
              fulfillsConditionId: null,
              phase: "evaluate" as const,
              cursor: null,
            },
          ];
    for (const entry of ordered) {
      const frame = this.frames.get(entry.frameId);
      if (frame === undefined) {
        throw new ModuleInvariantError(
          `continued stack refers to missing frame ${entry.frameId}`,
        );
      }
      frame.phase = entry.phase;
      frame.cursor = entry.cursor;
      this.stack.push(frame);
    }
  }

  private inferSelectorId(
    goal: G,
    bindings: B,
    mode: RecursiveGoalMode,
    selectedSkillId: string | null,
  ): string {
    for (const selector of this.deps.selectors) {
      if (selectedSkillId !== null && selector.skillIds.includes(selectedSkillId)) {
        return selector.id;
      }
    }
    for (const selector of this.deps.selectors) {
      for (const skillId of selector.skillIds) {
        const skill = this.deps.skillsById.get(skillId);
        if (
          skill !== undefined &&
          skill.mode === mode &&
          this.deps.adapter.supports({
            goal,
            bindings,
            skill,
          })
        ) {
          return selector.id;
        }
      }
    }
    return this.deps.selectors[0]?.id ?? this.validated.rootSelectorId;
  }

  private partialReport(
    fault: RecursiveGoalErrorDiagnostic,
  ): RecursiveGoalPartialRunReport<G, S, B, E, F, R, C> | null {
    try {
      return {
        lastTrustedTransition: this.transitionsUsed,
        rootEvaluation: this.rootEvaluation,
        control: this.control,
        states: [...this.states],
        evidence: [...this.evidence],
        frames: [...this.frames.values()].map(frame => this.frameResult(frame)),
        effects: [...this.ledger],
        atomicResults: [...this.atomicResults],
        errors: mergeDiagnostic(this.errors, fault),
        primaryErrorId: this.primaryErrorId ?? fault.errorId,
        relatedIssues: [...this.relatedIssues],
        budgetUsed: {
          transitionsUsed: this.transitionsUsed,
          derivedGoalsUsed: this.derivedGoalsUsed,
        },
        continuation: null,
        ...(this.planningReport === null
          ? {}
          : { planning: this.planningReport }),
        unavailableSections:
          this.finished ? [] : ["final-report", "cleanup", "collection"],
      };
    } catch {
      return null;
    }
  }
}

function normalizeDependencies<G, S, B, E, F, R, C>(
  deps: RecursiveGoalDependencies<G, S, B, E, F, R, C>,
): NormalizedDependencies<G, S, B, E, F, R, C> {
  if (!isRecord(deps) || !isRecord(deps.adapter)) {
    throw new TypeError("dependencies and adapter are required");
  }
  for (const callback of [
    "validateRequest",
    "supports",
    "evaluate",
    "select",
    "derive",
    "executeAtomic",
    "validateAtomicReceipt",
    "measureProgress",
  ] as const) {
    if (typeof deps.adapter[callback] !== "function") {
      throw new TypeError(`adapter.${callback} must be a function`);
    }
  }
  if (
    !isRecord(deps.comparators) ||
    typeof deps.comparators.sameGoal !== "function" ||
    typeof deps.comparators.sameBindings !== "function" ||
    typeof deps.comparators.sameFacts !== "function"
  ) {
    throw new TypeError("dependencies.comparators are required");
  }
  if (!Array.isArray(deps.enabledSkills)) {
    throw new TypeError("enabledSkills must be an array");
  }
  if (!Array.isArray(deps.enabledEvaluators)) {
    throw new TypeError("enabledEvaluators must be an array");
  }
  if (!Array.isArray(deps.selectors)) {
    throw new TypeError("selectors must be an array");
  }
  if (deps.grantedEffects === undefined || !isIterable(deps.grantedEffects)) {
    throw new TypeError("grantedEffects must be an iterable set");
  }
  if (
    deps.planning !== undefined &&
    (!isRecord(deps.planning) ||
      !isRecord(deps.planning.contract) ||
      typeof deps.planning.contract.id !== "string" ||
      typeof deps.planning.contract.version !== "string" ||
      !Array.isArray(deps.planning.resultModels) ||
      !isRecord(deps.planning.guards) ||
      typeof deps.planning.matchesActual !== "function" ||
      typeof deps.planning.assessPrior !== "function")
  ) {
    throw new TypeError("planning dependency is malformed");
  }
  const enabledSkills = freezeSnapshot(deps.enabledSkills.map(readEnabledSkill));
  const enabledEvaluators = freezeSnapshot(
    deps.enabledEvaluators.map(readEnabledEvaluator),
  );
  const selectors = freezeSnapshot(deps.selectors.map(readSelectorBinding));
  uniqueBy(enabledSkills, skill => skill.id, "enabled skill");
  uniqueBy(enabledEvaluators, evaluator => evaluator.id, "enabled evaluator");
  uniqueBy(selectors, selector => selector.id, "selector");
  const skillsById = new Map(enabledSkills.map(skill => [skill.id, skill]));
  const evaluatorsById = new Map(
    enabledEvaluators.map(evaluator => [evaluator.id, evaluator]),
  );
  const selectorsById = new Map(selectors.map(selector => [selector.id, selector]));
  for (const selector of selectors) {
    for (const skillId of selector.skillIds) {
      if (!skillsById.has(skillId)) {
        throw new TypeError(
          `selector ${selector.id} references disabled skill ${skillId}`,
        );
      }
    }
  }
  const grantedEffects = new Set(deps.grantedEffects);
  for (const effect of grantedEffects) {
    if (typeof effect !== "string" || effect.length === 0) {
      throw new TypeError("grantedEffects entries must be non-empty strings");
    }
  }
  const signal = deps.signal ?? null;
  if (
    signal !== null &&
    (typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function")
  ) {
    throw new TypeError("signal must be an AbortSignal");
  }
  return {
    adapter: deps.adapter,
    enabledSkills,
    skillsById,
    enabledEvaluators,
    evaluatorsById,
    selectors,
    selectorsById,
    comparators: deps.comparators,
    grantedEffects,
    planning: deps.planning ?? null,
    signal,
  };
}

function validateAdmissionVocabulary<G, S, B, E, F, R, C>(
  envelope: RecursiveGoalRequestEnvelope,
  deps: NormalizedDependencies<G, S, B, E, F, R, C>,
): void {
  if (!deps.evaluatorsById.has(envelope.rootEvaluatorId)) {
    throw new TypeError(
      `root evaluator ${envelope.rootEvaluatorId} is not enabled`,
    );
  }
  if (!deps.selectorsById.has(envelope.rootSelectorId)) {
    throw new TypeError(
      `root selector ${envelope.rootSelectorId} is not enabled`,
    );
  }
  assertBoundedPlanningPresence(
    envelope.planning,
    deps.planning ?? undefined,
  );
  if (envelope.retryPolicy !== undefined) {
    if (typeof deps.adapter.assessRetry !== "function") {
      throw new TypeError("adapter.assessRetry is required by retryPolicy");
    }
    const selector = deps.selectorsById.get(envelope.retryPolicy.selectorId);
    if (selector === undefined) {
      throw new TypeError(
        `retryPolicy selector ${envelope.retryPolicy.selectorId} is not enabled`,
      );
    }
    if (!sameStringSet(selector.skillIds, envelope.retryPolicy.strategySkillIds)) {
      throw new TypeError(
        "retryPolicy strategySkillIds must equal the selector skill set",
      );
    }
    for (const skillId of envelope.retryPolicy.strategySkillIds) {
      const skill = deps.skillsById.get(skillId);
      if (
        skill === undefined ||
        skill.mode !== "atomic" ||
        skill.retry !== "completed_no_effect"
      ) {
        throw new TypeError(
          `retryPolicy strategy ${skillId} must be an enabled atomic completed_no_effect skill`,
        );
      }
    }
  }
}

function validateValidatedRequest<G, S, B, E, F, R, C>(
  envelope: RecursiveGoalRequestEnvelope,
  validated: ValidatedRequest<G, S, B, E, F, R, C>,
  comparators: RecursiveGoalComparators<G, B, S, E>,
): void {
  if (validated.requestId !== envelope.requestId) {
    throw new TypeError("adapter changed requestId");
  }
  if (validated.satisfactionThreshold !== envelope.satisfactionThreshold) {
    throw new TypeError("adapter changed root satisfactionThreshold");
  }
  if (
    validated.rootEvaluatorId !== envelope.rootEvaluatorId ||
    validated.rootSelectorId !== envelope.rootSelectorId
  ) {
    throw new TypeError("adapter changed root evaluator or selector");
  }
  if (
    validated.limits.maxTransitions !== envelope.limits.maxTransitions ||
    validated.limits.maxDepth !== envelope.limits.maxDepth ||
    validated.limits.maxDerivedGoals !== envelope.limits.maxDerivedGoals
  ) {
    throw new TypeError("adapter changed request limits");
  }
  if (
    (envelope.retryPolicy === undefined) !==
    (validated.retryPolicy === undefined)
  ) {
    throw new TypeError("adapter changed the presence of retryPolicy");
  }
  if (envelope.retryPolicy !== undefined && validated.retryPolicy !== undefined) {
    const typedRetryPolicy = readBoundedRetryPolicy(
      validated.retryPolicy,
      "validated.retryPolicy",
    );
    if (!sameBoundedRetryPolicy(envelope.retryPolicy, typedRetryPolicy)) {
      throw new TypeError("adapter changed retryPolicy");
    }
  }
  if (
    (envelope.planning === undefined) !==
    (validated.planning === undefined)
  ) {
    throw new TypeError("adapter changed the presence of planning");
  }
  if (
    envelope.planning !== undefined &&
    validated.planning !== undefined &&
    !sameCopyableValue(envelope.planning, validated.planning)
  ) {
    throw new TypeError("adapter changed request planning");
  }
  if (!comparators.sameGoal(validated.rootGoal, envelope.rootGoal as G)) {
    throw new TypeError("adapter changed rootGoal");
  }
  if (
    !comparators.sameBindings(
      validated.rootBindings,
      envelope.rootBindings as B,
    )
  ) {
    throw new TypeError("adapter changed rootBindings");
  }
  assertRecursiveGoalInitialObservationContinuationBoundary(
    validated.initialObservation,
    validated.continuation,
  );
  if (
    (envelope.initialObservation === undefined) !==
    (validated.initialObservation === undefined)
  ) {
    throw new TypeError(
      "adapter changed the presence of initialObservation",
    );
  }
  if (
    envelope.initialObservation !== undefined &&
    validated.initialObservation !== undefined
  ) {
    const typed = readRecursiveGoalInitialObservation<E>(
      validated.initialObservation,
      value => value as E,
      "validated.initialObservation",
    );
    if (
      !sameCopyableValue(
        envelope.initialObservation,
        typed satisfies RecursiveGoalInitialObservation<E>,
      )
    ) {
      throw new TypeError("adapter changed initialObservation");
    }
  }
}

function readValidatedContinuation<G, S, B, E, F, R, C>(
  value: RecursiveGoalResumableContinuation<
    G,
    S,
    B,
    E,
    F,
    R,
    C
  > | null,
  deps: NormalizedDependencies<G, S, B, E, F, R, C>,
): RecursiveGoalResumableContinuation<
  G,
  S,
  B,
  E,
  F,
  R,
  C
> | null {
  if (value === null) return null;
  return freezeSnapshot(
    readRecursiveGoalResumableContinuation(value, {
      goal: raw => raw as G,
      state: raw => raw as S,
      bindings: raw => raw as B,
      evidencePayload: raw => raw as E,
      effectFact: raw => raw as F,
      sameEffectFact: sameCopyableValue,
      receiptPayload: raw => raw as R,
      cursor: raw => raw as C,
      sameGoal: deps.comparators.sameGoal,
      sameBindings: deps.comparators.sameBindings,
      sameCursor: sameCopyableValue,
    }),
  );
}

function validatePlanningContinuationAdmission<G, S, B, E, F, R, C>(
  continuation: RecursiveGoalResumableContinuation<
    G,
    S,
    B,
    E,
    F,
    R,
    C
  > | null,
  validated: ValidatedRequest<G, S, B, E, F, R, C>,
  deps: NormalizedDependencies<G, S, B, E, F, R, C>,
): void {
  if (continuation === null) return;
  const planningContinuation =
    continuation.schema === "nnanything.recursive-goal.continuation.v2"
      ? continuation
      : null;
  if (validated.planning === undefined) {
    if (planningContinuation !== null) {
      throw new TypeError(
        "v2 planning continuation requires an active planning request",
      );
    }
    return;
  }
  if (planningContinuation === null) {
    throw new TypeError(
      "planning request cannot continue from a v1 continuation",
    );
  }
  if (
    !sameVersionedRef(
      validated.planning.capabilityRef,
      planningContinuation.planningContract.capabilityRef,
    ) ||
    !sameCopyableValue(
      validated.planning.preference,
      planningContinuation.planningContract.preference,
    ) ||
    validated.planning.horizonN !== planningContinuation.planningContract.horizonN ||
    !sameCopyableValue(
      validated.planning.limits,
      planningContinuation.planningContract.limits,
    )
  ) {
    throw new TypeError(
      "planning request contract disagrees with v2 continuation",
    );
  }
  if (
    validated.planning.checkpointSpecs.length !==
      planningContinuation.planningContract.checkpointSpecRefs.length ||
    validated.planning.checkpointSpecs.some(
      (checkpoint, index) =>
        checkpoint.id !==
        planningContinuation.planningContract.checkpointSpecRefs[index],
    )
  ) {
    throw new TypeError(
      "planning checkpoint refs disagree with v2 continuation",
    );
  }
  if (
    validated.planning.resultModelRefs.length !==
      planningContinuation.planningContract.resultModelRefs.length ||
    validated.planning.resultModelRefs.some(
      (modelRef, index) =>
        planningContinuation.planningContract.resultModelRefs[index] ===
          undefined ||
        !sameVersionedRef(
          modelRef,
          planningContinuation.planningContract.resultModelRefs[index]!,
        ),
    )
  ) {
    throw new TypeError(
      "planning result model refs disagree with v2 continuation",
    );
  }
  const savedCheckpoints=planningContinuation.planControl.plan?.checkpoints ?? [];
  if(savedCheckpoints.length!==validated.planning.checkpointSpecs.length || validated.planning.checkpointSpecs.some((spec,index)=>{
    const saved=savedCheckpoints[index];
    if(saved===undefined) return true;
    const {goal:goalNow,bindings:bindingsNow,...controlNow}=spec;
    const {goal:goalThen,bindings:bindingsThen,...controlThen}=saved;
    return !deps.comparators.sameGoal(goalNow,goalThen) || !deps.comparators.sameBindings(bindingsNow,bindingsThen) || !sameCopyableValue(controlNow,controlThen);
  })) throw new TypeError("planning checkpoint specification changed during continuation");
  if (deps.planning === null) {
    throw new TypeError(
      "v2 planning continuation requires the planning dependency",
    );
  }
  const previousDecision=planningContinuation.planningContract.decisionRef;
  const nextDecision=deps.planning.decision?.ref;
  if((previousDecision===undefined)!==(nextDecision===undefined) || (previousDecision!==undefined && nextDecision!==undefined && !sameVersionedRef(previousDecision,nextDecision))) throw new TypeError("planning continuation decision provider changed");
}

function validateContinuationContracts<G, S, B, E, F, R, C>(
  continuation: RecursiveGoalResumableContinuation<
    G,
    S,
    B,
    E,
    F,
    R,
    C
  >,
  deps: NormalizedDependencies<G, S, B, E, F, R, C>,
  requestRetryPolicy: BoundedRetryPolicy | undefined,
): void {
  const continuationRetryPolicy = continuation.retryControl?.policy;
  if (
    (requestRetryPolicy === undefined) !==
    (continuationRetryPolicy === undefined)
  ) {
    throw new TypeError("continuation retry policy presence changed");
  }
  if (
    requestRetryPolicy !== undefined &&
    continuationRetryPolicy !== undefined &&
    !sameBoundedRetryPolicy(requestRetryPolicy, continuationRetryPolicy)
  ) {
    throw new TypeError("continuation retry policy changed");
  }
  if (continuationRetryPolicy !== undefined) {
    const selector = deps.selectorsById.get(continuationRetryPolicy.selectorId);
    if (selector === undefined) {
      throw new TypeError("continuation retry selector is not enabled");
    }
    if (
      !sameStringSet(
        selector.skillIds,
        continuationRetryPolicy.strategySkillIds,
      )
    ) {
      throw new TypeError("continuation retry strategy set changed");
    }
    for (const strategySkillId of continuationRetryPolicy.strategySkillIds) {
      const strategySkill = deps.skillsById.get(strategySkillId);
      if (
        strategySkill === undefined ||
        strategySkill.mode !== "atomic" ||
        strategySkill.retry !== "completed_no_effect"
      ) {
        throw new TypeError(
          `continuation retry strategy ${strategySkillId} is not safely dispatchable`,
        );
      }
    }
    const retryFrameIds = new Set(
      continuation.retryControl!.frames.map(frame => frame.frameId),
    );
    for (const frameControl of continuation.frameControls) {
      if (
        frameControl.selectorId === continuationRetryPolicy.selectorId &&
        !retryFrameIds.has(frameControl.frameId)
      ) {
        throw new TypeError(
          `continuation retry frame ${frameControl.frameId} is missing`,
        );
      }
    }
  }
  for (const control of continuation.frameControls) {
    if (control.pendingVerification === null) continue;
    const entry = continuation.stack.find(item => item.frameId === control.frameId);
    if (entry?.phase !== "evaluate") continue;
    const frame = continuation.frames.find(item => item.frameId === control.frameId)!;
    const proof = continuation.atomicResults.find(item => item.dispatchId === frame.atomicResultRefs.at(-1));
    const skill = proof === undefined ? undefined : deps.skillsById.get(proof.skillId);
    if (skill?.mode !== "atomic" ||
        (skill.effectClass !== "read_only" && skill.effectClass !== "none")) {
      throw new TypeError("pending verification evaluation lacks a declared read-only proof");
    }
  }
  if (
    !sameStringSet(
      continuation.contractRefs.enabledSkillIds,
      deps.enabledSkills.map(skill => skill.id),
    )
  ) {
    throw new TypeError("continuation enabled skill contract changed");
  }
  if (
    !sameStringSet(
      continuation.contractRefs.evaluatorIds,
      deps.enabledEvaluators.map(evaluator => evaluator.id),
    )
  ) {
    throw new TypeError("continuation evaluator contract changed");
  }
  if (
    !sameStringSet(
      continuation.contractRefs.selectorIds,
      deps.selectors.map(selector => selector.id),
    )
  ) {
    throw new TypeError("continuation selector contract changed");
  }
  if (
    !sameStringSet(
      continuation.contractRefs.grantedEffects,
      [...deps.grantedEffects],
    )
  ) {
    throw new TypeError("continuation effect authorization changed");
  }
}

function requestRejected<G, S, B, E, F, R, C>(
  requestId: string | null,
  error: RecursiveGoalErrorDiagnostic,
) {
  return {
    kind: "request_rejected" as const,
    requestId,
    acceptedRoot: null,
    error,
  };
}

function requestIdFromUnknown(value: unknown): string | null {
  return isRecord(value) &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0
    ? value.requestId
    : null;
}

function workflowFailureFrom(error: unknown): WorkflowRunFailure {
  if (error instanceof WorkflowContractError) {
    return {
      category: error.code,
      message: error.message,
      ...(error.nodeId === undefined ? {} : { nodeId: error.nodeId }),
    };
  }
  if (error instanceof WorkflowRunError) {
    return {
      category: error.category,
      message: error.message,
      ...(error.nodeId === undefined ? {} : { nodeId: error.nodeId }),
    };
  }
  return {
    category: "recursive_goal_facade_failure",
    message: errorMessage(error),
  };
}

function workflowFailureRefs(error: unknown): readonly string[] {
  return error instanceof WorkflowContractError && error.nodeId !== undefined
    ? [`node:${error.nodeId}`]
    : [];
}

function evaluationFromCondition<G, B>(
  condition: InternalCondition<G, B>,
): EvaluationReceipt | null {
  if (condition.observedEvaluatorId === null) return null;
  const result =
    condition.fact === "satisfied" ||
    condition.fact === "unsatisfied" ||
    condition.fact === "unknown"
      ? condition.fact
      : null;
  if (result === null) return null;
  return {
    evaluatorId: condition.observedEvaluatorId,
    result,
    satisfaction: condition.satisfaction,
    necessaryConditionsMet:
      condition.fact === "satisfied",
    evidenceRefs: [...condition.evidenceRefs],
  };
}

function cloneRetryPolicy(policy: BoundedRetryPolicy): BoundedRetryPolicy {
  return {
    kind: "bounded_strategy_retry.v1",
    selectorId: policy.selectorId,
    strategySkillIds: [...policy.strategySkillIds],
    sameFailureLimit: policy.sameFailureLimit,
    maxAtomicAttempts: policy.maxAtomicAttempts,
  };
}

function sameBoundedRetryPolicy(
  left: BoundedRetryPolicy,
  right: BoundedRetryPolicy,
): boolean {
  return (
    left.kind === right.kind &&
    left.selectorId === right.selectorId &&
    sameStringSet(left.strategySkillIds, right.strategySkillIds) &&
    left.sameFailureLimit === right.sameFailureLimit &&
    left.maxAtomicAttempts === right.maxAtomicAttempts
  );
}

function cloneRetryControl(
  control: RecursiveGoalRetryControl,
): MutableRecursiveGoalRetryControl {
  return {
    policy: cloneRetryPolicy(control.policy),
    atomicAttemptsUsed: control.atomicAttemptsUsed,
    frames: control.frames.map(frame => ({
      frameId: frame.frameId,
      lockedSkillId: frame.lockedSkillId,
      strategies: frame.strategies.map(strategy => ({
        skillId: strategy.skillId,
        failures: strategy.failures.map(failure => ({ ...failure })),
        exhausted: strategy.exhausted,
        latestAttemptRef: strategy.latestAttemptRef,
      })),
      lastAccountedDispatchId: frame.lastAccountedDispatchId,
    })),
  };
}

function retryControlSnapshot(
  control: MutableRecursiveGoalRetryControl,
): RecursiveGoalRetryControl {
  return cloneRetryControl(control);
}

function readRetryAssessment(value: unknown): RetryAssessment {
  if (!isRecord(value)) throw new TypeError("retry assessment must be an object");
  if (value.kind === "safe_same_failure") {
    if (Object.keys(value).some(key => key !== "kind" && key !== "failureKey" && key !== "evidenceRefs")) {
      throw new TypeError("safe retry assessment has unsupported fields");
    }
    if (
      typeof value.failureKey !== "string" ||
      value.failureKey.length === 0 ||
      value.failureKey.includes("\0")
    ) {
      throw new TypeError("retry assessment failureKey must be a non-empty string");
    }
    if (!Array.isArray(value.evidenceRefs)) {
      throw new TypeError("retry assessment evidenceRefs must be an array");
    }
    const evidenceRefs = value.evidenceRefs.map((entry, index) => {
      if (
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry.includes("\0")
      ) {
        throw new TypeError(
          `retry assessment evidenceRefs[${index}] must be a non-empty string`,
        );
      }
      return entry;
    });
    if (new Set(evidenceRefs).size !== evidenceRefs.length) {
      throw new TypeError("retry assessment evidenceRefs contains duplicates");
    }
    return {
      kind: "safe_same_failure",
      failureKey: value.failureKey,
      evidenceRefs,
    };
  }
  if (value.kind === "stop") {
    if (Object.keys(value).some(key => key !== "kind" && key !== "reason")) {
      throw new TypeError("retry stop assessment has unsupported fields");
    }
    if (
      value.reason !== "unsupported_retry" &&
      value.reason !== "evidence_insufficient" &&
      value.reason !== "effects_not_none" &&
      value.reason !== "precondition_changed"
    ) {
      throw new TypeError("retry stop assessment reason is invalid");
    }
    return { kind: "stop", reason: value.reason };
  }
  throw new TypeError("retry assessment kind is invalid");
}

function retryStopDiagnostic(
  reason: Extract<RetryAssessment, { readonly kind: "stop" }>["reason"],
): Pick<StopDiagnosticSpec, "code" | "stage" | "owner"> {
  switch (reason) {
    case "unsupported_retry":
      return { code: "policy_error", stage: "selection", owner: "adapter" };
    case "evidence_insufficient":
      return {
        code: "evidence_unavailable",
        stage: "observation",
        owner: "adapter",
      };
    case "effects_not_none":
      return { code: "effect_denied", stage: "effect", owner: "adapter" };
    case "precondition_changed":
      return {
        code: "precondition_unsatisfied",
        stage: "selection",
        owner: "adapter",
      };
  }
}

function effectKnowledgeForSkill<F>(
  ledger: readonly EffectRecord<F>[],
  frameId: string,
  skillId: string,
): EffectKnowledge | null {
  const effects = ledger.filter(
    effect => effect.frameId === frameId && effect.skillId === skillId,
  );
  if (effects.length === 0) return null;
  return aggregateEffectKnowledge(effects);
}

function aggregateEffectKnowledge<F>(
  effects: readonly { readonly knowledge: EffectKnowledge }[],
): EffectKnowledge {
  if (effects.some(effect => effect.knowledge === "mixed")) return "mixed";
  if (effects.some(effect => effect.knowledge === "unknown")) return "unknown";
  if (effects.some(effect => effect.knowledge === "known")) return "known";
  return "none";
}

function boundaryEffects<F>(
  effects: readonly EffectRecord<F>[],
): "none" | "known" | "unknown" | "mixed" {
  return aggregateEffectKnowledge(effects);
}

function validateContextPayload(value: unknown): unknown {
  if (
    !isRecord(value) ||
    typeof value.requestId !== "string" ||
    typeof value.rootFrameId !== "string"
  ) {
    throw new TypeError("recursive goal context payload is invalid");
  }
  return value;
}

function validateOutcomePayload(value: unknown): unknown {
  return validateContextPayload(value);
}

function validateRunResultPayload(
  value: unknown,
): RecursiveGoalRunResult<
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown
> {
  if (
    !isRecord(value) ||
    value.kind !== "run_result" ||
    typeof value.requestId !== "string" ||
    !isRecord(value.acceptedRoot) ||
    !isRecord(value.report)
  ) {
    throw new TypeError("recursive goal result payload is invalid");
  }
  return value as unknown as RecursiveGoalRunResult<
    unknown,
    unknown,
    unknown,
    unknown,
    unknown,
    unknown,
    unknown
  >;
}

function isRunResultPayload(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.kind === "run_result" &&
    typeof value.requestId === "string" &&
    isRecord(value.acceptedRoot) &&
    isRecord(value.report)
  );
}

function readReceiptRef(value: unknown, label: string): { readonly receiptId: string } {
  if (
    !isRecord(value) ||
    typeof value.receiptId !== "string" ||
    value.receiptId.length === 0
  ) {
    throw new TypeError(`${label} must return a non-empty receiptId`);
  }
  return { receiptId: value.receiptId };
}

function cloneDiagnostic(
  error: RecursiveGoalErrorDiagnostic,
): RecursiveGoalErrorDiagnostic {
  return {
    ...error,
    origin: { ...error.origin },
    source: { ...error.source, refs: [...error.source.refs] },
    atomicResultRefs: [...error.atomicResultRefs],
    cause:
      error.cause === null
        ? null
        : { ...error.cause },
    propagation: error.propagation.map(entry => ({
      ...entry,
      satisfies:
        entry.satisfies === null ? null : { ...entry.satisfies },
    })),
  };
}

function mergeDiagnostic(
  errors: readonly RecursiveGoalErrorDiagnostic[],
  diagnostic: RecursiveGoalErrorDiagnostic,
): RecursiveGoalErrorDiagnostic[] {
  const result = errors.map(cloneDiagnostic);
  if (!result.some(error => error.errorId === diagnostic.errorId)) {
    result.push(diagnostic);
  }
  return result;
}

function mergeStrings(
  left: readonly string[],
  right: readonly string[],
): string[] {
  return [...new Set([...left, ...right])];
}

function uniqueBy<T>(
  values: readonly T[],
  id: (value: T) => string,
  label: string,
): void {
  if (new Set(values.map(id)).size !== values.length) {
    throw new TypeError(`${label} ids must be unique`);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  const message = String(error);
  return message.length > 0 ? message : "unknown recursive goal error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIterable(value: unknown): value is Iterable<string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.iterator in value
  );
}

function selectorIncludes(
  selector: SelectorBinding | undefined,
  skillId: string,
): boolean {
  return selector !== undefined && selector.skillIds.includes(skillId);
}

function snapshotData<T>(value: T): T {
  return structuredClone(value);
}

function freezeSnapshot<T>(value: T): T {
  return deepFreeze(snapshotData(value));
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const entry of Object.values(value)) {
    deepFreeze(entry, seen);
  }
  return Object.freeze(value);
}

function sameCopyableValue(
  left: unknown,
  right: unknown,
  seen = new WeakMap<object, WeakSet<object>>(),
): boolean {
  if (Object.is(left, right)) return true;
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  ) {
    return false;
  }
  let rightValues = seen.get(left);
  if (rightValues?.has(right) === true) return true;
  if (rightValues === undefined) {
    rightValues = new WeakSet<object>();
    seen.set(left, rightValues);
  }
  rightValues.add(right);
  if (left instanceof Date || right instanceof Date) {
    return (
      left instanceof Date &&
      right instanceof Date &&
      left.getTime() === right.getTime()
    );
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) =>
        sameCopyableValue(entry, right[index], seen),
      )
    );
  }
  if (left instanceof Map || right instanceof Map) {
    if (!(left instanceof Map) || !(right instanceof Map)) return false;
    if (left.size !== right.size) return false;
    const leftEntries = [...left.entries()];
    const rightEntries = [...right.entries()];
    return leftEntries.every(([key, value], index) => {
      const other = rightEntries[index];
      return (
        other !== undefined &&
        sameCopyableValue(key, other[0], seen) &&
        sameCopyableValue(value, other[1], seen)
      );
    });
  }
  if (left instanceof Set || right instanceof Set) {
    if (!(left instanceof Set) || !(right instanceof Set)) return false;
    if (left.size !== right.size) return false;
    const leftValues = [...left.values()];
    const rightValues = [...right.values()];
    return leftValues.every((value, index) =>
      sameCopyableValue(value, rightValues[index], seen),
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        sameCopyableValue(leftRecord[key], rightRecord[key], seen),
    )
  );
}
