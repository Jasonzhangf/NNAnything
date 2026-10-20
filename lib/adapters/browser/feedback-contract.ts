import type { SingleActionControl, SingleActionEpisodeResult, SingleActionRequest } from "./single-action-contract.js";

export const FEEDBACK_HEADS = ["completed_without_goal", "execution_rejected", "indeterminate"] as const;
export type FeedbackHead = typeof FEEDBACK_HEADS[number];
export const FEEDBACK_WIRES = [
  "bias", "dispatch.known", "dispatch.value", "receipt.ok.known", "receipt.ok.value",
  "executionError.present", "post.currentValid", "regionExpanded.known", "regionExpanded.value",
  "regionRendered.known", "regionRendered.value", "effectKnowledge.resolved",
] as const;

/** A previous, completed attempt. No current-action future state enters this unit. */
export interface FeedbackInput {
  readonly request: SingleActionRequest;
  readonly result: SingleActionEpisodeResult;
  readonly controlAtCompletion: SingleActionControl | null;
}
export interface FeedbackProfile {
  readonly contract: "browser.action-feedback.v1";
  readonly heads: readonly FeedbackHead[];
  readonly wires: readonly string[];
  readonly weights: readonly (readonly number[])[];
  readonly calibration: "uncalibrated";
  readonly adoption: "not_applied";
}
export interface FeedbackPrediction {
  readonly status: "predicted" | "unknown" | "goal_achieved";
  readonly head: FeedbackHead | null;
  readonly features: readonly number[];
  readonly scores: readonly number[];
  readonly evidenceRefs: readonly string[];
}
export interface FeedbackInferenceResult {
  readonly prediction: FeedbackPrediction;
  readonly input: FeedbackInput;
  /** No learned diagnostic can replace the original goal's evidence evaluation. */
  readonly satisfaction: null;
}
export interface FeedbackEpisode {
  readonly id: string;
  readonly family: string;
  readonly partition: "train" | "development" | "verification";
  readonly input: FeedbackInput;
  readonly teacher: {
    readonly head: FeedbackHead;
    readonly source: "synthetic_projection" | "observed_episode";
    readonly evidenceRefs: readonly string[];
    readonly note: string;
  };
}
export interface FeedbackFitInput {
  readonly initial: FeedbackProfile;
  readonly episodes: readonly FeedbackEpisode[];
  readonly handwiredRoot: string;
  readonly epochs: number;
  readonly learningRate: number;
}
export interface FeedbackTrajectoryEntry {
  readonly epoch: number;
  readonly loss: number;
  readonly gradient: readonly number[];
  readonly weights: readonly number[];
}
export interface FeedbackFitResult {
  readonly profile: FeedbackProfile;
  readonly objective: {
    readonly kind: "distinct_projection_coverage";
    readonly projectionCount: number;
    readonly groupSizes: readonly number[];
  };
  readonly trajectory: readonly FeedbackTrajectoryEntry[];
  readonly timing: {
    readonly backendLoadMs: number;
    readonly circuitBuildMs: number;
    readonly fitMs: number;
    readonly totalMs: number;
    readonly epochs: number;
    readonly rows: number;
    readonly gradientRowEpochs: number;
    readonly trainableParamCount: number;
  };
}
export interface FeedbackEvaluation {
  readonly count: number;
  readonly passed: number;
  readonly failed: number;
  readonly rows: readonly { readonly id: string; readonly expected: FeedbackHead; readonly actual: FeedbackHead | null; readonly passed: boolean }[];
}
export interface FeedbackTrainingRequest {
  readonly episodes: readonly FeedbackEpisode[];
  readonly initial: FeedbackProfile;
  readonly epochs: number;
  readonly learningRate: number;
}
export interface FeedbackTrainingResources {
  readonly handwiredRoot: string;
  readonly outputDirectory: string;
}
export interface FeedbackTrainingReceipt {
  readonly runId: string;
  readonly accepted: boolean;
  readonly profile: FeedbackProfile;
  readonly fit: FeedbackFitResult;
  readonly comparison: {
    readonly train: { readonly zero: FeedbackEvaluation; readonly trained: FeedbackEvaluation };
    readonly development: { readonly zero: FeedbackEvaluation; readonly trained: FeedbackEvaluation };
  };
  readonly candidatePath: string;
  readonly reportPath: string;
  readonly error: string | null;
}
