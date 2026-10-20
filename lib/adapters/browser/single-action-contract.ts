import type { BasicKindLabel, BasicKindStatus } from "../../filters/basic-kinds.js";
import type { BrowserExpansionStrategy } from "./strategy-contract.js";

/** Shared typed contract. Raw identifiers and content are never numeric student inputs. */
export type ActionObservation<T> =
  | { readonly status: "observed"; readonly value: T; readonly evidenceRefs: readonly string[] }
  | { readonly status: "unknown"; readonly reason: string };

export interface SingleActionElement {
  readonly ref: string;
  readonly parentRef: string | null;
  readonly tag: string | null;
  readonly role: string | null;
  readonly basicKind: BasicKindLabel | null;
  readonly judgmentStatus: BasicKindStatus;
  readonly candidateStatus: "ok" | "filtered_out" | "skipped" | "unknown";
  readonly controls: ActionObservation<readonly string[]>;
  readonly enabled: ActionObservation<boolean>;
  readonly hit: ActionObservation<boolean>;
  readonly buttonSemantics: ActionObservation<boolean>;
  readonly point: ActionObservation<{ readonly x: number; readonly y: number }>;
  readonly evidenceRefs: readonly string[];
}

export interface SingleActionRegion {
  readonly ref: string;
  readonly expanded: ActionObservation<boolean>;
  readonly rendered: ActionObservation<boolean>;
}

export interface SingleActionControl {
  readonly documentRef: string;
  readonly observationId: string;
  readonly revision: number;
}

export interface SingleActionSnapshot extends SingleActionControl {
  readonly scopeRef: string;
  readonly regions: readonly SingleActionRegion[];
  readonly elements: readonly SingleActionElement[];
  readonly evidence: readonly {
    readonly id: string;
    readonly observationId: string;
    readonly source: string;
    readonly fact: unknown;
  }[];
}

export interface SingleActionRequest {
  readonly goal: { readonly kind: "SetExpanded"; readonly regionRef: string; readonly desired: true };
  readonly satisfactionThreshold: 100;
  readonly state: SingleActionSnapshot;
}

export interface SingleActionTargetConstraint {
  readonly targetRef: string;
  readonly goalRegionRef: string;
}

export interface SelectedExpansionStrategy {
  readonly strategyRef: string;
  readonly skillId: string;
  readonly targetRef: string;
  readonly goalRegionRef: string;
  readonly equivalenceSetRef: string;
  readonly evidenceRefs: readonly string[];
}

export interface SelectedSingleActionRequest extends SingleActionRequest {
  readonly contract: "browser.single-action.selected.v1";
  readonly selectedStrategy: SelectedExpansionStrategy;
}

export interface SelectedSingleActionResources extends SingleActionResources {
  readonly strategyRegistry: readonly BrowserExpansionStrategy[];
}

export const SINGLE_ACTION_RELATION_HEADS = ["actionable_provider", "not_provider"] as const;
export const SINGLE_ACTION_CAPABILITY_HEADS = ["CLICK", "NOOP", "DEFER"] as const;
export const SINGLE_ACTION_RELATION_WIRES = [
  "bias", "controls.known", "controls.target", "enabled.known", "enabled.value",
  "hit.known", "hit.value", "candidate.isGoalRegion", "buttonSemantics.known",
  "buttonSemantics.value", "controls.target*enabled.value", "controls.target*hit.value",
  "controls.target*enabled.value*hit.value",
] as const;
export const SINGLE_ACTION_CAPABILITY_WIRES = [
  "bias", "regionExpanded.known", "regionExpanded.value", "providers.zero",
  "providers.one", "providers.many", "relationCoverage.complete", "actionabilityCoverage.complete",
] as const;
export type SingleActionCapability = typeof SINGLE_ACTION_CAPABILITY_HEADS[number];

export interface BrowserSingleActionProfile {
  readonly contract: "browser.single-action-policy.v1";
  readonly relationHeads: readonly typeof SINGLE_ACTION_RELATION_HEADS[number][];
  readonly relationWires: readonly typeof SINGLE_ACTION_RELATION_WIRES[number][];
  readonly capabilityHeads: readonly SingleActionCapability[];
  readonly capabilityWires: readonly typeof SINGLE_ACTION_CAPABILITY_WIRES[number][];
  readonly relationWeights: readonly (readonly number[])[];
  readonly capabilityWeights: readonly (readonly number[])[];
  readonly calibration: "uncalibrated";
  readonly adoption: "not_applied";
}

export interface SingleActionRelationPrediction {
  readonly ref: string;
  readonly features: readonly number[];
  readonly scores: readonly number[];
  readonly judgment: "actionable_provider" | "not_provider" | "unknown";
}
export interface SingleActionPrediction {
  readonly relations: readonly SingleActionRelationPrediction[];
  readonly capability: SingleActionCapability;
  readonly capabilityFeatures: readonly number[];
  readonly capabilityScores: readonly number[];
  readonly proposedTargetRef: string | null;
}

export interface NativeClickInvocation extends SingleActionControl {
  readonly kind: "click";
  readonly targetRef: string;
  readonly point: { readonly x: number; readonly y: number };
}
export interface NativeClickReceipt {
  readonly dispatched: boolean;
  readonly ok: boolean;
  readonly effectKnowledge: "none" | "known" | "unknown";
  readonly source: string;
  readonly error: { readonly code: string; readonly message: string } | null;
}

export interface SingleActionEpisodeResult {
  readonly prediction: SingleActionPrediction | null;
  readonly invocation: NativeClickInvocation | null;
  readonly receipt: NativeClickReceipt | null;
  readonly dispatchState: "not_dispatched" | "dispatched" | "unknown";
  readonly effectKnowledge: "none" | "known" | "unknown";
  readonly newState: SingleActionSnapshot | null;
  readonly satisfaction: 0 | 100 | null;
  readonly achieved: boolean;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly collectionError: string | null;
}

export interface SingleActionResources {
  readonly profile: BrowserSingleActionProfile;
  readonly grantedEffects: ReadonlySet<string>;
  readonly observe: () => Promise<SingleActionSnapshot>;
  readonly currentControl: () => SingleActionControl | Promise<SingleActionControl>;
  readonly nativeClick: (invocation: NativeClickInvocation) => Promise<NativeClickReceipt>;
  readonly collect: (result: SingleActionEpisodeResult) => Promise<void>;
}

export interface SingleActionTeacherEpisode {
  readonly id: string;
  readonly family: string;
  readonly partition: "train" | "development" | "verification";
  readonly request: SingleActionRequest;
  readonly teacher: {
    readonly providerRefs: readonly string[];
    readonly unknownRefs: readonly string[];
    readonly capability: SingleActionCapability;
    readonly source: "synthetic_projection" | "observed_episode";
    readonly evidenceRefs: readonly string[];
  };
}

export interface SingleActionFitTiming {
  backendLoadMs: number;
  circuitBuildMs: number;
  relationFitMs: number;
  capabilityFitMs: number;
  totalFitMs: number;
  relationEpochs: number;
  capabilityEpochs: number;
  relationRows: number;
  capabilityRows: number;
  gradientRowEpochs: number;
  totalForwardRows: number;
  trainableParamCount: number;
}
