import type {
  ConditionFact,
  DerivedCondition,
  RecursiveGoalControl,
  RecursiveGoalErrorDiagnostic,
  RecursiveGoalRunReport,
  RecursiveGoalStopReason,
  RootEvaluation,
} from "./contracts.js";

export type RecursiveGoalCompletion = "complete" | "partial" | "incomplete";

export interface RecursiveGoalCompletedItem {
  readonly frameId: string;
  readonly conditionId: string;
  readonly lifetime: DerivedCondition<unknown, unknown>["lifetime"];
  readonly evaluation: ConditionFact;
}

export type RecursiveGoalRemainingItem =
  | { readonly kind: "root"; readonly frameId: string; readonly evaluation: RootEvaluation }
  | { readonly kind: "condition"; readonly frameId: string; readonly conditionId: string;
      readonly evaluation: ConditionFact };

export interface RecursiveGoalCompletionSummary<G, S, B, E, F, R, C> {
  readonly completion: RecursiveGoalCompletion;
  readonly rootEvaluation: RootEvaluation;
  readonly completedItems: readonly RecursiveGoalCompletedItem[];
  readonly remainingItems: readonly RecursiveGoalRemainingItem[];
  readonly conditionAccounting: "available" | "unavailable";
  readonly stopReason: RecursiveGoalStopReason;
  readonly control: RecursiveGoalControl;
  readonly errors: readonly RecursiveGoalErrorDiagnostic[];
  readonly report: RecursiveGoalRunReport<G, S, B, E, F, R, C>;
}

/** Project evaluated accomplishments, never infer them from successful execution. */
export function projectRecursiveGoalCompletion<G, S, B, E, F, R, C>(
  report: RecursiveGoalRunReport<G, S, B, E, F, R, C>,
): RecursiveGoalCompletionSummary<G, S, B, E, F, R, C> {
  const rootSatisfied = report.rootEvaluation.state === "evaluated" &&
    report.rootEvaluation.result === "satisfied";
  const definitions = new Map<string, Map<string, DerivedCondition<G, B>>>();
  for (const dependency of report.continuation?.dependencies ?? []) {
    let conditions = definitions.get(dependency.ownerFrameId);
    if (conditions === undefined) {
      conditions = new Map();
      definitions.set(dependency.ownerFrameId, conditions);
    }
    conditions.set(dependency.condition.id, dependency.condition);
  }
  const frames = new Map(report.frames.map(frame => [frame.frameId, frame]));
  const requiredFrames = new Set<string>([report.root.rootFrameId]);
  const pending = [report.root.rootFrameId];
  for (let index = 0; index < pending.length; index += 1) {
    const owner = frames.get(pending[index]!);
    for (const condition of owner?.conditionResults ?? []) {
      if (condition.childFrameId === null ||
          definitions.get(owner!.frameId)?.get(condition.conditionId)?.activation !== "required") continue;
      if (!requiredFrames.has(condition.childFrameId)) {
        requiredFrames.add(condition.childFrameId);
        pending.push(condition.childFrameId);
      }
    }
  }
  // A satisfied evaluator does not bypass the runtime's required-subtree closure.
  // Completed reports have already passed that gate. Other reports retain the
  // definitions and pending-verification state needed to check it explicitly.
  const controls = new Map(report.continuation?.frameControls.map(frame => [frame.frameId, frame]));
  const closed = report.continuation === null
    ? report.control.outcome === "completed"
    : [...requiredFrames].every(id => frames.get(id)?.unresolvedRequirements.length === 0 &&
        controls.get(id)?.pendingVerification === null);
  const complete = rootSatisfied && closed;
  const completedItems: RecursiveGoalCompletedItem[] = [];
  const remainingItems: RecursiveGoalRemainingItem[] = complete ? [] : [{
    kind: "root", frameId: report.root.rootFrameId, evaluation: report.rootEvaluation,
  }];
  for (const frame of report.frames) {
    const unresolved = new Set(frame.unresolvedRequirements);
    for (const evaluation of frame.conditionResults) {
      const definition = definitions.get(frame.frameId)?.get(evaluation.conditionId);
      if (requiredFrames.has(frame.frameId) && definition?.activation === "required" &&
          evaluation.fact === "satisfied") {
        completedItems.push({ frameId: frame.frameId, conditionId: evaluation.conditionId,
          lifetime: definition.lifetime, evaluation });
      }
      if (unresolved.has(evaluation.conditionId)) {
        remainingItems.push({ kind: "condition", frameId: frame.frameId,
          conditionId: evaluation.conditionId, evaluation });
      }
    }
  }
  return {
    completion: complete ? "complete" : completedItems.length > 0 ? "partial" : "incomplete",
    rootEvaluation: report.rootEvaluation,
    completedItems,
    remainingItems,
    conditionAccounting: report.continuation === null ? "unavailable" : "available",
    stopReason: report.control.stopReason,
    control: report.control,
    errors: report.errors,
    report,
  };
}
