export * from "./adapters/browser/single-action-contract.js";
export * from "./adapters/browser/single-action-observation.js";
export * from "./filters/browser-single-action-policy.js";
export * from "./training/browser-single-action-numeric.js";
export * from "./training/browser-single-action-samples.js";
export * from "./training/browser-single-action-training.js";
export * from "./nodes/browser-single-action.js";
export * from "./nodes/browser-single-action-training.js";

import type { TrainableSemanticUnit } from "./core/trainable-unit.js";
import type { SingleActionEpisodeResult, SingleActionRequest, SingleActionResources } from "./adapters/browser/single-action-contract.js";
import { runBrowserSingleActionEpisode } from "./nodes/browser-single-action.js";
import { runBrowserSingleActionTraining, type BrowserSingleActionTrainingOptions } from "./nodes/browser-single-action-training.js";
import type { BrowserSingleActionTrainingReceipt } from "./training/browser-single-action-training.js";

export type SingleActionUnitTrainingInput = Omit<BrowserSingleActionTrainingOptions, "handwiredRoot" | "outputDirectory">;
export type SingleActionUnitTrainingResources = Pick<BrowserSingleActionTrainingOptions, "handwiredRoot" | "outputDirectory">;
/** Thin lifecycle view; all inference, fitting and validation stay with their existing owners. */
export const browserSingleActionUnit: TrainableSemanticUnit<SingleActionRequest, SingleActionEpisodeResult, SingleActionResources,
  SingleActionUnitTrainingInput, BrowserSingleActionTrainingReceipt, SingleActionUnitTrainingResources> = {
  infer: runBrowserSingleActionEpisode,
  train: (input, resources) => runBrowserSingleActionTraining({ ...input, ...resources }),
};
