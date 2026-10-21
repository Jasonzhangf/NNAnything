import {
  DEFAULT_PLANNING_DECISION_RULE_REF,
  PlanningDecisionTrainingNotImplementedError,
  type PlanningDecisionBinding,
  type PlanningDecisionInferenceResources,
  type PlanningDecisionInput,
  type PlanningDecisionTrainingInput,
  type PlanningDecisionTrainingResources,
  type PlanningDecisionUnit,
  createPlanningDecisionBinding,
  validatePlanningDecisionInput,
} from "../workflow/recursive-goal/decision-contracts.js";
import {
  rankPlanningPaths,
  type PathRanking,
} from "../workflow/recursive-goal/planning.js";

export function inferPlanningDecisionRule(
  input: PlanningDecisionInput,
): PathRanking {
  const validated = validatePlanningDecisionInput(input);
  return rankPlanningPaths(validated.candidates, validated.preference);
}

export function createDefaultPlanningDecisionUnit(): PlanningDecisionUnit {
  return Object.freeze({
    infer: (
      input: PlanningDecisionInput,
      resources: PlanningDecisionInferenceResources,
    ) => {
      if (resources.kind !== "planning_decision.rule.v1") {
        return Promise.reject(
          new TypeError("default planning decision unit requires rule resources"),
        );
      }
      return Promise.resolve(inferPlanningDecisionRule(input));
    },
    train: (
      _input: PlanningDecisionTrainingInput,
      _resources: PlanningDecisionTrainingResources,
    ) => Promise.reject(new PlanningDecisionTrainingNotImplementedError()),
  });
}

export function createDefaultPlanningDecisionBinding(): PlanningDecisionBinding {
  return createPlanningDecisionBinding(createDefaultPlanningDecisionUnit(), {
    kind: "planning_decision.rule.v1",
    ref: DEFAULT_PLANNING_DECISION_RULE_REF,
  });
}
