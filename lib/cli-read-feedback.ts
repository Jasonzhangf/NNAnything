export { BASE_WIRES, BASE_LABELS, REASONING_WIRES, REASONING_LABELS } from "./adapters/cli/read-expectation-contract.js";
export type {
  BaseWire, BaseLabel, ReasoningWire, ReasoningLabel, ReadAttempt, ReadContext,
  ReadRequest, ReadObservation, ReadFailure, CoverageInterval, BaseVector,
  ReasoningVector, BaseSupervision, ReasoningSupervision,
} from "./adapters/cli/read-expectation-contract.js";

export {
  measureBase, superviseBase, measureQuantity, measureReasoning, superviseReasoning,
  mergeCoverage, coversRange, requestedRange, attemptCoverage,
} from "./filters/cli-read-expectation.js";

export {
  fitReadFeedbackProfile, fitReadReasoningProfile, assertGradientMatches,
} from "./training/cli-read-expectation-numeric.js";
export type {
  BaseEpisode, ReasoningEpisode, ReadProfile, UnitFitResult,
} from "./training/cli-read-expectation-numeric.js";

export {
  buildCases, measureCase, prepareSamples, buildReasoningEpisodes, measurementCoverage,
} from "./training/cli-read-expectation-samples.js";
export type {
  CaseSpec, CaseMeasurement, Partition, PreparedSamples,
} from "./training/cli-read-expectation-samples.js";

export { readReadFeedbackUnit, loadReadProfile } from "./training/cli-read-expectation-load.js";
export type { ReadFeedbackUnit } from "./training/cli-read-expectation-load.js";

export {
  runCliReadExpectationGoal,
  createReadExpectationAdapter,
  createReadExpectationDependencies,
  READ_EXPECTATION_COMPOSITE_SKILL,
  READ_EXPECTATION_READ_SKILL,
  READ_EXPECTATION_ROOT_EVALUATOR,
  READ_EXPECTATION_READ_EVALUATOR,
  READ_EXPECTATION_ROOT_SELECTOR,
  READ_EXPECTATION_READ_SELECTOR,
  READ_EXPECTATION_SKILLS,
  READ_EXPECTATION_EVALUATORS,
  READ_EXPECTATION_SELECTORS,
} from "./adapters/cli/read-expectation-recursive.js";
export type {
  ReadExpectationGoal,
  ReadExpectationState,
  ReadExpectationDecision,
  ReadExpectationRunResult,
  ReadExpectationGoalResources,
  ReadExpectationBindings,
} from "./adapters/cli/read-expectation-recursive.js";
