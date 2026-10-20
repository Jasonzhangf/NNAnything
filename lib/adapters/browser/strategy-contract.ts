import type { FeedbackInput, FeedbackPrediction, FeedbackProfile } from "./feedback-contract.js";
import type { BrowserSingleActionProfile, NativeClickInvocation, NativeClickReceipt, SingleActionEpisodeResult, SingleActionRequest, SingleActionSnapshot } from "./single-action-contract.js";
import type { RetrySelectionView } from "../../workflow/recursive-goal/contracts.js";

export const STRATEGY_HEADS = ["choose", "defer"] as const;
export const STRATEGY_WIRES = ["bias", "nativeButton", "explicitRoleButton", "relation.providerMargin", "feedback.present",
  "feedback.completedWithoutGoal", "feedback.executionRejected", "feedback.indeterminate", "verifiedSuccess.known", "verifiedSuccess.value"] as const;
export interface BrowserExpansionStrategy {
  readonly strategyRef: string;
  readonly skillId: string;
  readonly targetRef: string;
  readonly goalRegionRef: string;
  readonly equivalenceSetRef: string;
  readonly documentRef: string;
  readonly scopeRef: string;
  readonly operation: "CLICK";
  readonly evidenceRefs: readonly string[];
}
export interface StrategyHistory {
  readonly strategyRef: string;
  readonly skillId: string;
  readonly targetRef: string;
  readonly equivalenceSetRef: string;
  readonly input: FeedbackInput;
}
export interface BrowserStrategyRequest {
  readonly request: SingleActionRequest;
  readonly history: readonly StrategyHistory[];
}
export interface BrowserStrategyProfile {
  readonly contract: "browser.strategy-policy.v1";
  readonly heads: readonly string[];
  readonly wires: readonly string[];
  readonly weights: readonly (readonly number[])[];
  readonly calibration: "uncalibrated";
  readonly adoption: "not_applied";
}
export interface StrategyModels {
  readonly profile: BrowserStrategyProfile;
  readonly atomicProfile: BrowserSingleActionProfile;
  readonly feedbackProfile: FeedbackProfile;
}
export interface StrategyInferenceResources extends StrategyModels {
  readonly registry: readonly BrowserExpansionStrategy[];
  /** Immutable current authorization view supplied by the recursive control owner. */
  readonly selection: RetrySelectionView;
}
export interface StrategyCandidatePrediction {
  readonly strategyRef: string;
  readonly skillId: string;
  readonly targetRef: string;
  readonly features: readonly number[];
  readonly logits: readonly number[];
  readonly margin: number;
  readonly feedback: FeedbackPrediction | null;
}
export interface BrowserStrategyPrediction {
  readonly kind: "SELECT" | "DEFER";
  readonly skillId: string | null;
  readonly strategyRef: string | null;
  readonly targetRef: string | null;
  readonly reason: string | null;
  readonly candidates: readonly StrategyCandidatePrediction[];
}
export interface StrategyEpisode {
  readonly id: string;
  readonly family: string;
  readonly partition: "train" | "development" | "verification";
  readonly input: BrowserStrategyRequest;
  readonly registry: readonly BrowserExpansionStrategy[];
  /** Historical read-only control projection; never authoritative for a live run. */
  readonly selection: RetrySelectionView;
  readonly teacher: {
    readonly selectedSkillId: string | null;
    readonly source: "synthetic_projection" | "observed_episode";
    readonly evidenceRefs: readonly string[];
    readonly note: string;
  };
}
export interface StrategyFitInput extends StrategyModels {
  readonly episodes: readonly StrategyEpisode[];
  readonly handwiredRoot: string;
  readonly epochs: number;
  readonly learningRate: number;
}
export interface StrategyFitResult {
  readonly profile: BrowserStrategyProfile;
  readonly trajectory: readonly { readonly epoch: number; readonly loss: number; readonly gradient: readonly number[]; readonly weights: readonly number[] }[];
  readonly timing: { readonly backendLoadMs: number; readonly circuitBuildMs: number; readonly fitMs: number; readonly totalMs: number;
    readonly epochs: number; readonly decisionSets: number; readonly candidateRows: number; readonly gradientCandidateEpochs: number; readonly trainableParamCount: number };
}
export interface StrategyEvaluation {
  readonly count: number;
  readonly passed: number;
  readonly failed: number;
  readonly rows: readonly { readonly id: string; readonly expectedSkillId: string | null; readonly actualSkillId: string | null; readonly passed: boolean; readonly reason: string | null }[];
}
export interface StrategyTrainingRequest {
  readonly initial: BrowserStrategyProfile;
  readonly episodes: readonly StrategyEpisode[];
  readonly epochs: number;
  readonly learningRate: number;
}
export interface StrategyTrainingResources {
  readonly atomicProfile: BrowserSingleActionProfile;
  readonly feedbackProfile: FeedbackProfile;
  readonly handwiredRoot: string;
  readonly outputDirectory: string;
}
export interface StrategyTrainingReceipt {
  readonly accepted: boolean;
  readonly profile: BrowserStrategyProfile;
  readonly fit: StrategyFitResult;
  readonly comparison: { readonly train: { readonly zero: StrategyEvaluation; readonly trained: StrategyEvaluation };
    readonly development: { readonly zero: StrategyEvaluation; readonly trained: StrategyEvaluation } };
  readonly candidatePath: string;
  readonly reportPath: string;
  readonly error: string | null;
}
export interface StrategyEffectProof {
  readonly kind: "controlled_fixture_no_effect";
  readonly targetRef: string;
  readonly documentRef: string;
  readonly beforeObservationId: string;
  readonly afterObservationId: string;
  readonly evidenceRefs: readonly string[];
}
export interface StrategyStepResult {
  readonly decision: BrowserStrategyPrediction | null;
  readonly atomic: SingleActionEpisodeResult | null;
  readonly feedback: FeedbackPrediction | null;
  readonly feedbackInput: FeedbackInput | null;
  readonly effectProof: StrategyEffectProof | null;
  readonly newState: SingleActionSnapshot | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly collectionError: string | null;
}
export interface StrategyStepResources extends StrategyInferenceResources {
  readonly selectedSkillId: string;
  readonly grantedEffects: ReadonlySet<string>;
  observe(): Promise<SingleActionSnapshot> | SingleActionSnapshot;
  currentControl(): Promise<{ readonly documentRef: string; readonly observationId: string; readonly revision: number }> | { readonly documentRef: string; readonly observationId: string; readonly revision: number };
  nativeClick(invocation: NativeClickInvocation): Promise<NativeClickReceipt>;
  collectAtomic(result: SingleActionEpisodeResult): Promise<void> | void;
  collectStep(result: StrategyStepResult): Promise<void> | void;
  proveNoEffect(input: FeedbackInput): Promise<StrategyEffectProof | null> | StrategyEffectProof | null;
}
