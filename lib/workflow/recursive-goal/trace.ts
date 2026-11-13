import type { EventEnvelope } from "../../core/events.js";
import type {
  AtomicExecutionResult,
  ConditionFact,
  DerivedCondition,
  EnabledSkill,
  EvaluationReceipt,
  EvidenceRecord,
  PlanningDecision,
  RecursiveGoalControl,
  RecursiveGoalErrorDiagnostic,
  RecursiveGoalExecution,
  RecursiveGoalFact,
  RecursiveGoalUnexecutedReason,
  RemainingRequirement,
  RootEvaluation,
  Selection,
  StateRecord,
} from "./contracts.js";

export const RECURSIVE_GOAL_TRACE_SCHEMA =
  "nnanything.recursive-goal.trace.v1" as const;

export interface RecursiveGoalTracePrefix {
  readonly segmentId: string;
  readonly terminalEventId: string;
}

export interface RecursiveGoalTraceOptions<
  G = unknown,
  S = unknown,
  B = unknown,
  E = unknown,
  F = unknown,
  R = unknown,
  C = unknown,
> {
  readonly segmentId: string;
  readonly emit: (
    event: RecursiveGoalTraceEvent<G, S, B, E, F, R, C>,
  ) => void;
  readonly prefix?: RecursiveGoalTracePrefix;
}

export type RecursiveGoalTraceKind =
  | "segment_started"
  | "segment_ended"
  | "final_summary"
  | "step_started"
  | "step_ended"
  | "frame_defined"
  | "evidence_view_defined"
  | "condition_view_defined"
  | "conditions_derived"
  | "evaluation_started"
  | "evaluation_returned"
  | "evaluation_failed"
  | "evaluation_applied"
  | "evaluation_discarded"
  | "selection_returned"
  | "selection_accepted"
  | "selection_disposed"
  | "selection_rejected"
  | "selection_failed"
  | "dispatch_started"
  | "atomic_returned"
  | "observation_accepted"
  | "branch_changed"
  | "planning_changed"
  | "control_projection"
  | "diagnostic"
  | "resource_defined";

export type RecursiveGoalTraceCauseRelation =
  | "invocation"
  | "returned_evaluation"
  | "returned_selection"
  | "selected_action"
  | "dispatch"
  | "atomic_receipt"
  | "blocked_event"
  | "changed_observation"
  | "parent_derivation"
  | "step"
  | "terminal_summary";

export interface RecursiveGoalTraceCause {
  readonly eventRef: string;
  readonly relation: RecursiveGoalTraceCauseRelation;
}

export interface RecursiveGoalTraceInputRefs {
  readonly stateRef: string;
  readonly evidenceViewRef: string;
  readonly conditionViewRef: string;
}

export type RecursiveGoalTraceGoalInput<G, B> =
  | {
      readonly kind: "frame_definition";
      readonly eventRef: string;
    }
  | {
      readonly kind: "inline";
      readonly goal: G;
      readonly bindings: B;
      readonly satisfactionThreshold: number;
      readonly evaluatorId: string;
    };

export interface RecursiveGoalTraceFrameSummary {
  readonly frameRef: string;
  readonly fact: RecursiveGoalFact;
  readonly execution: RecursiveGoalExecution;
  readonly unexecutedReason: RecursiveGoalUnexecutedReason;
  readonly errorId: string | null;
  readonly activeRequirementIds: readonly string[];
  readonly pendingVerificationDispatchRef: string | null;
}

export interface RecursiveGoalTraceTerminalSummary {
  readonly responseKind:
    | "request_rejected"
    | "run_result"
    | "module_fault";
  readonly control: RecursiveGoalControl | null;
  readonly rootEvaluation: RootEvaluation | null;
  readonly remainingRequirements: readonly RemainingRequirement[];
  readonly errorRefs: readonly string[];
  readonly frames: readonly RecursiveGoalTraceFrameSummary[];
  readonly primaryErrorId: string | null;
  readonly cleanupReceiptRef: string | null;
  readonly collectionReceiptRef: string | null;
  readonly faultRef: string | null;
  readonly knownBoundary:
    | {
        readonly evidence: "none" | "partial" | "retained";
        readonly effects: "none" | "known" | "unknown" | "mixed";
      }
    | null;
}

export interface RecursiveGoalTraceResourceDefinition<
  S = unknown,
  E = unknown,
  F = unknown,
  R = unknown,
> {
  readonly imported: boolean;
  readonly resourceType: "state" | "evidence" | "atomic";
  readonly resource:
    | StateRecord<S>
    | EvidenceRecord<E>
    | AtomicExecutionResult<F, R>;
}

export type InternalTracePhase =
  | "evaluate"
  | "select"
  | "derive"
  | "await_children"
  | "aggregate";

export interface RecursiveGoalTraceDetailsByKind<
  G,
  S,
  B,
  E,
  F,
  R,
  C,
> {
  readonly segment_started: {
    readonly requestId: string | null;
    readonly resumed: boolean;
    readonly prefix: RecursiveGoalTracePrefix | null;
    readonly prefixExternal: true;
  };
  readonly segment_ended: RecursiveGoalTraceTerminalSummary;
  readonly final_summary: RecursiveGoalTraceTerminalSummary;
  readonly step_started: {
    readonly phase: InternalTracePhase;
    readonly inputRefs: RecursiveGoalTraceInputRefs;
    readonly control: RecursiveGoalControl | null;
    readonly activeStackEventRefs: readonly string[];
  };
  readonly step_ended: {
    readonly startedPhase: InternalTracePhase;
    readonly endedPhase: InternalTracePhase;
    readonly inputRefs: RecursiveGoalTraceInputRefs;
    readonly finished: boolean;
    readonly control: RecursiveGoalControl | null;
    readonly activeStackEventRefs: readonly string[];
  };
  readonly frame_defined: {
    readonly imported: boolean;
    readonly rootRef: string;
    readonly parentFrameRef: string | null;
    readonly conditionRef: string | null;
    readonly goal: G;
    readonly bindings: B;
    readonly satisfactionThreshold: number;
    readonly evaluatorId: string;
    readonly selectorId: string;
    readonly parentDerivationEventRef: string | null;
  };
  readonly evidence_view_defined: {
    readonly imported: boolean;
    readonly purpose: string;
    readonly memberIds: readonly string[];
  };
  readonly condition_view_defined: {
    readonly imported: boolean;
    readonly purpose: string;
    readonly conditions: readonly ConditionFact[];
  };
  readonly conditions_derived: {
    readonly conditions: readonly DerivedCondition<G, B>[];
    readonly cursor: C;
    readonly expansion: "more" | "closed";
    readonly selectionEventRef: string | null;
  };
  readonly evaluation_started: {
    readonly purpose: string;
    readonly inputRefs: RecursiveGoalTraceInputRefs;
    readonly inputDefinition: RecursiveGoalTraceGoalInput<G, B>;
    readonly evaluatorId: string;
  };
  readonly evaluation_returned: {
    readonly purpose: string;
    readonly rawReturn: unknown;
    readonly evaluation: unknown;
    readonly invocationEventRef: string | null;
  };
  readonly evaluation_failed: {
    readonly purpose: string;
    readonly message: string;
    readonly invocationEventRef: string | null;
  };
  readonly evaluation_applied: {
    readonly purpose: string;
    readonly evaluationEventRef: string;
  };
  readonly evaluation_discarded: {
    readonly purpose: string;
    readonly evaluationEventRef: string;
    readonly reason?: string;
  };
  readonly selection_returned: {
    readonly selectorId: string;
    readonly rawReturn: unknown;
    readonly selection: unknown;
    readonly candidates: readonly EnabledSkill[];
    readonly inputRefs: RecursiveGoalTraceInputRefs;
  };
  readonly selection_accepted: {
    readonly selection: Extract<Selection, { readonly kind: "selected" }>;
    readonly selectionEventRef: string;
  };
  readonly selection_disposed: {
    readonly selection: Extract<Selection, {
      readonly kind: "no_capability" | "defer";
    }>;
    readonly selectionEventRef: string;
    readonly disposition: "no_capability" | "deferred";
  };
  readonly selection_rejected: {
    readonly rawReturn: unknown;
    readonly message: string;
    readonly selectionEventRef: string;
  };
  readonly selection_failed: {
    readonly selectorId: string;
    readonly message: string;
    readonly inputRefs: RecursiveGoalTraceInputRefs;
  };
  readonly dispatch_started: {
    readonly dispatchId: string;
    readonly skillId: string;
    readonly skillVersion: string;
    readonly decision: Readonly<Record<string, unknown>> | null;
    readonly selectionEventRef: string;
    readonly inputRefs: RecursiveGoalTraceInputRefs;
  };
  readonly atomic_returned: {
    readonly dispatchId: string;
    readonly atomicResultRef: string;
    readonly outcome: AtomicExecutionResult<F, R>["outcome"];
    readonly executorInvoked: AtomicExecutionResult<F, R>["executorInvoked"];
    readonly runId: string | null;
    readonly sourceResult: AtomicExecutionResult<F, R>["sourceResult"];
    readonly executionErrorIds: readonly string[];
    readonly verificationErrorIds: readonly string[];
    readonly diagnosticRefs: readonly string[];
    readonly effectKnowledge: AtomicExecutionResult<F, R>["effect"]["knowledge"];
    readonly observationAccepted: boolean;
  };
  readonly observation_accepted: {
    readonly stateRef: string;
    readonly evidenceRefs: readonly string[];
    readonly atomicResultRef: string;
    readonly atomicReceiptEventRef: string;
  };
  readonly branch_changed: {
    readonly state: "blocked" | "resumed" | "reevaluating";
    readonly reason: string;
    readonly stateRef?: string;
    readonly diagnosticRef?: string;
    readonly priorDiagnosticRef?: string | null;
  };
  readonly planning_changed: {
    readonly decision: PlanningDecision;
    readonly inputRefs: RecursiveGoalTraceInputRefs;
  };
  readonly control_projection: {
    readonly projection: "root_unknown";
    readonly reason: string;
    readonly evaluation: EvaluationReceipt;
  };
  readonly diagnostic: {
    readonly imported: boolean;
    readonly diagnostic: RecursiveGoalErrorDiagnostic;
  };
  readonly resource_defined: RecursiveGoalTraceResourceDefinition<S, E, F, R>;
}

interface RecursiveGoalTraceBase<K extends RecursiveGoalTraceKind> {
  readonly schema: typeof RECURSIVE_GOAL_TRACE_SCHEMA;
  readonly sequence: number;
  readonly transition: number | null;
  readonly frameRef: string | null;
  readonly previousEventRef: string | null;
  readonly causes: readonly RecursiveGoalTraceCause[];
  readonly kind: K;
}

export type RecursiveGoalTracePayload<
  G = unknown,
  S = unknown,
  B = unknown,
  E = unknown,
  F = unknown,
  R = unknown,
  C = unknown,
> = {
  readonly [K in RecursiveGoalTraceKind]: RecursiveGoalTraceBase<K> & {
    readonly details: RecursiveGoalTraceDetailsByKind<
      G,
      S,
      B,
      E,
      F,
      R,
      C
    >[K];
  };
}[RecursiveGoalTraceKind];

export type RecursiveGoalTraceEvent<
  G = unknown,
  S = unknown,
  B = unknown,
  E = unknown,
  F = unknown,
  R = unknown,
  C = unknown,
> = EventEnvelope<RecursiveGoalTracePayload<G, S, B, E, F, R, C>>;

export interface RecursiveGoalTraceSummary {
  readonly segmentId: string;
  readonly capture: "complete" | "incomplete";
  readonly history:
    | "from_admission"
    | "linked_prefix"
    | "prefix_unavailable";
  readonly lastDeliveredEventId: string | null;
  readonly missingCoverage: readonly string[];
  readonly terminalEventId: string | null;
  readonly failure: {
    readonly eventId: string | null;
    readonly category: "sink" | "capture";
    readonly name: string;
    readonly message: string;
  } | null;
}

export class RecursiveGoalTraceRecorder<
  G = unknown,
  S = unknown,
  B = unknown,
  E = unknown,
  F = unknown,
  R = unknown,
  C = unknown,
> {
  private sequence = 0;
  private lastDeliveredEventId: string | null = null;
  private failure: RecursiveGoalTraceSummary["failure"] = null;
  private transition: number | null = null;
  private segmentStartedDelivered = false;
  private segmentEndedDelivered = false;
  private readonly pendingEvaluationFrames = new Set<string>();
  private readonly prefix: RecursiveGoalTracePrefix | null;

  constructor(
    private readonly options: RecursiveGoalTraceOptions<G, S, B, E, F, R, C>,
    private readonly requestId: string | null,
  ) {
    this.prefix =
      options.prefix === undefined
        ? null
        : {
            segmentId: options.prefix.segmentId,
            terminalEventId: options.prefix.terminalEventId,
          };
  }

  setTransition(transition: number): void {
    this.transition = transition;
  }

  emit<K extends RecursiveGoalTraceKind>(
    kind: K,
    frameRef: string | null,
    details: () => RecursiveGoalTraceDetailsByKind<
      G,
      S,
      B,
      E,
      F,
      R,
      C
    >[K],
    causes: readonly RecursiveGoalTraceCause[] = [],
  ): string | null {
    if (this.failure !== null) return null;
    const eventId = `${this.options.segmentId}:event:${++this.sequence}`;
    let event: RecursiveGoalTraceEvent<G, S, B, E, F, R, C>;
    try {
      event = {
        runId: this.options.segmentId,
        eventId,
        producer: { nodeId: "recursive-goal", port: "trace" },
        type: "recursive-goal.trace",
        correlation: {},
        status: "ok",
        payload: {
          schema: RECURSIVE_GOAL_TRACE_SCHEMA,
          sequence: this.sequence,
          transition: this.transition,
          frameRef,
          previousEventRef: this.lastDeliveredEventId,
          causes: structuredClone(causes),
          kind,
          details: structuredClone(details()),
        } as RecursiveGoalTracePayload<G, S, B, E, F, R, C>,
      };
    } catch (error) {
      this.failure = traceFailure("capture", error, eventId);
      return null;
    }

    try {
      const result = (
        this.options.emit as (
          event: RecursiveGoalTraceEvent<G, S, B, E, F, R, C>,
        ) => unknown
      )(event);
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined);
        throw new TypeError("recursive-goal trace sink must be synchronous");
      }
    } catch (error) {
      this.failure = traceFailure("sink", error, eventId);
      return null;
    }

    this.lastDeliveredEventId = eventId;
    if (kind === "segment_started") this.segmentStartedDelivered = true;
    if (kind === "segment_ended") this.segmentEndedDelivered = true;
    if (kind === "evaluation_returned" && frameRef !== null) {
      this.pendingEvaluationFrames.add(frameRef);
    }
    if (
      (kind === "evaluation_applied" || kind === "evaluation_discarded") &&
      frameRef !== null
    ) {
      this.pendingEvaluationFrames.delete(frameRef);
    }
    return eventId;
  }

  summary(resumed: boolean): RecursiveGoalTraceSummary {
    const missingCoverage: string[] = [];
    if (!this.segmentStartedDelivered) missingCoverage.push("segment_start");
    if (this.pendingEvaluationFrames.size > 0) {
      missingCoverage.push("evaluation_disposition");
    }
    if (!this.segmentEndedDelivered) missingCoverage.push("segment_end");
    const capture =
      this.failure === null &&
      this.segmentStartedDelivered &&
      this.segmentEndedDelivered &&
      this.pendingEvaluationFrames.size === 0
        ? "complete"
        : "incomplete";
    return {
      segmentId: this.options.segmentId,
      capture,
      history: resumed
        ? this.prefix === null
          ? "prefix_unavailable"
          : "linked_prefix"
        : "from_admission",
      lastDeliveredEventId: this.lastDeliveredEventId,
      missingCoverage,
      terminalEventId: this.segmentEndedDelivered
        ? this.lastDeliveredEventId
        : null,
      failure: this.failure,
    };
  }
}

function traceFailure(
  category: "sink" | "capture",
  error: unknown,
  eventId: string | null,
): NonNullable<RecursiveGoalTraceSummary["failure"]> {
  return {
    eventId,
    category,
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : "trace capture failed",
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { readonly then?: unknown }).then === "function"
  );
}
