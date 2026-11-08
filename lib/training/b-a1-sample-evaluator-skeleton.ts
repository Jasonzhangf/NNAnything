// B-A1 independent sample and evaluator skeleton (design:
// b-a1-sample-skeleton.md §7 and b-a1-evaluator-contract.md §8).
//
// This is a typed skeleton only: it fixes the sample families, the supervision
// status vocabulary, the training-eligibility mapping and the evaluator gold
// union. It generates no samples, fits nothing, and never reads gold into a
// student row. The three physical families stay on separate denominators:
// model-semantic (teacher), contract-gate (fixed harness rejection) and
// aggregator-test (injected-score engineering tests).

export const BA1_SEMANTIC_SUPERVISION_STATUSES = Object.freeze([
  "labeled_selected",
  "labeled_ambiguous",
  "labeled_none",
  "observation_missing",
  "unresolved_supervision",
] as const);

export type BA1SemanticSupervisionStatus = (typeof BA1_SEMANTIC_SUPERVISION_STATUSES)[number];

export type BA1SampleFamily = "model-semantic" | "contract-gate" | "aggregator-test";
export type BA1SamplePartition = "TRAIN" | "DEV" | "VERIFICATION";

export const BA1_CONTRACT_GATE_REASONS = Object.freeze([
  "unsupported_requested_role",
  "outside_scope",
  "access_unknown",
  "unverified_coverage",
  "stale_candidate",
] as const);

export type BA1ContractGateReason = (typeof BA1_CONTRACT_GATE_REASONS)[number];

export const BA1_AGGREGATOR_STATES = Object.freeze([
  "selected",
  "none",
  "ambiguous",
  "insufficient_observation",
] as const);

export type BA1AggregatorState = (typeof BA1_AGGREGATOR_STATES)[number];

export interface BA1SemanticTeacherRow {
  readonly family: "model-semantic";
  readonly group_id: string;
  readonly sampleId: string;
  readonly sourceGroup: string;
  readonly partition: BA1SamplePartition;
  readonly supervisionStatus: BA1SemanticSupervisionStatus;
  readonly goldAllowedCandidateRefs: readonly string[];
  readonly evaluationClass: "semantic";
  readonly labelAuthority: string;
  readonly oracleKind: string;
}

export interface BA1ContractGateRow {
  readonly family: "contract-gate";
  readonly group_id: string;
  readonly sampleId: string;
  readonly sourceGroup: string;
  readonly expectedReason: BA1ContractGateReason;
  readonly evaluationClass: "contract";
}

export interface BA1AggregatorTestRow {
  readonly family: "aggregator-test";
  readonly group_id: string;
  readonly sampleId: string;
  readonly injectedScores: readonly number[];
  readonly expectedState: BA1AggregatorState;
  readonly evaluationClass: "aggregator";
}

export type BA1SampleSkeleton = {
  readonly semantic: readonly BA1SemanticTeacherRow[];
  readonly contractGate: readonly BA1ContractGateRow[];
  readonly aggregatorTest: readonly BA1AggregatorTestRow[];
};

export interface BA1TrainingEligibility {
  readonly trainingEligible: boolean;
  readonly evaluationClass: "semantic" | "insufficient" | "none" | "unresolved";
}

/**
 * Training eligibility by supervision status. Only teacher-selected and
 * teacher-ambiguous rows enter the group-loss TRAIN set; none / missing /
 * unresolved keep their own evaluation class and never become a negative label.
 */
export function classifyBA1TrainingEligibility(status: BA1SemanticSupervisionStatus): BA1TrainingEligibility {
  switch (status) {
    case "labeled_selected":
    case "labeled_ambiguous":
      return { trainingEligible: true, evaluationClass: "semantic" };
    case "labeled_none":
      return { trainingEligible: false, evaluationClass: "none" };
    case "observation_missing":
      return { trainingEligible: false, evaluationClass: "insufficient" };
    case "unresolved_supervision":
      return { trainingEligible: false, evaluationClass: "unresolved" };
    default: {
      const never: never = status;
      throw new TypeError(`unknown B-A1 supervision status: ${String(never)}`);
    }
  }
}

export type BA1EvaluatorBoundGold = {
  readonly kind: "bound";
  readonly state: "selected" | "none" | "ambiguous" | "insufficient_observation";
  readonly selectedRef?: string | null;
  readonly family: string;
  readonly group: string;
};

export type BA1EvaluatorRejectGold = {
  readonly kind: "reject";
  readonly reason: BA1ContractGateReason;
  readonly family: string;
  readonly group: string;
};

export type BA1EvaluatorGold = BA1EvaluatorBoundGold | BA1EvaluatorRejectGold;

export interface BA1EvaluationCounts {
  readonly semantic: number;
  readonly unresolved: number;
  readonly contract: number;
  readonly aggregator: number;
}

/**
 * Reject is an independent typed channel: it is never folded into `none`, and a
 * bound non-selected gold must not carry a selectedRef.
 */
export function validateBA1EvaluatorGold(gold: BA1EvaluatorGold): void {
  if (gold.kind === "reject") {
    if ("selectedRef" in gold && (gold as { selectedRef?: unknown }).selectedRef !== undefined) {
      throw new TypeError("a reject gold must not carry a selectedRef field");
    }
    if (!BA1_CONTRACT_GATE_REASONS.includes(gold.reason)) {
      throw new TypeError(`unknown reject reason: ${String(gold.reason)}`);
    }
    return;
  }
  if (gold.state === "selected") {
    if (typeof gold.selectedRef !== "string" || gold.selectedRef.length === 0) {
      throw new TypeError("a selected bound gold must name a non-empty selectedRef");
    }
    return;
  }
  if (gold.selectedRef !== undefined && gold.selectedRef !== null) {
    throw new TypeError(`a bound ${gold.state} gold must not carry a selectedRef`);
  }
}

/**
 * The semantic accuracy denominator counts model-semantic rows only; the fixed
 * contract-gate and injected aggregator-test rows are reported separately.
 */
export function independentEvaluationDenominators(skeleton: BA1SampleSkeleton): BA1EvaluationCounts {
  return {
    semantic: skeleton.semantic.filter(
      row => row.family === "model-semantic" && row.supervisionStatus !== "unresolved_supervision",
    ).length,
    unresolved: skeleton.semantic.filter(
      row => row.family === "model-semantic" && row.supervisionStatus === "unresolved_supervision",
    ).length,
    contract: skeleton.contractGate.filter(row => row.family === "contract-gate").length,
    aggregator: skeleton.aggregatorTest.filter(row => row.family === "aggregator-test").length,
  };
}
