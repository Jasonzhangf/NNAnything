import type {
  L2BackendOptions,
  L2ComputeBackend,
  L2MlpCheckpointV1,
  L2TrainingError,
  L2TrainingEvent,
  L2TrainingPhase,
  L2TrainingState,
} from "../../training/l2-mlp-backend.js";

export type {
  L2BackendOptions,
  L2ComputeBackend,
  L2MlpCheckpointV1,
  L2TrainingError,
  L2TrainingEvent,
  L2TrainingPhase,
  L2TrainingState,
};

/** Experimental, finite L2 semantic units. These are readout heads, not attention heads. */
export const L2_HEADS = ["R", "D", "E", "A"] as const;
export type L2Head = typeof L2_HEADS[number];
export type L2Partition = "train" | "dev" | "verification";

export interface L2HeadSpec {
  readonly features: readonly string[];
  readonly labels: readonly string[];
  readonly hidden: readonly [number, number];
}
export type L2Specs = Readonly<Record<L2Head, L2HeadSpec>>;

export interface L2MlpHeadProfile {
  readonly spec: L2HeadSpec;
  /** Dense layers, row-major weights followed by biases, per documented implementation. */
  readonly parameters: readonly number[];
}
export interface L2MlpProfile {
  readonly schema: "nnanything.l2.mlp.v1";
  readonly heads: Readonly<Record<L2Head, L2MlpHeadProfile>>;
  readonly calibration: "uncalibrated";
  readonly adoption: "not_applied";
}
export interface L2Prediction {
  readonly head: L2Head;
  readonly label: string;
  readonly logits: readonly number[];
}
export interface L2Unit {
  readonly profile: L2MlpProfile;
  infer(head: L2Head, features: readonly number[]): L2Prediction;
}
export interface L2TrainingRow {
  readonly id: string;
  readonly sourceGroup: string;
  readonly partition: L2Partition;
  readonly head: L2Head;
  readonly features: readonly number[];
  /** Independent supervision; multiple equally valid labels are preserved. */
  readonly allowed: readonly string[];
}
export interface L2FitInput extends L2BackendOptions {
  readonly handwiredRoot: string;
  readonly specs: L2Specs;
  readonly rows: readonly L2TrainingRow[];
  readonly seed: number;
  readonly learningRate: number;
  readonly epochs: number;
  readonly stopCheckpoints: readonly number[];
  /** Explicit staged pretraining: only these heads update; omitted means all four. */
  readonly trainHeads?: readonly L2Head[];
  readonly initialProfile?: L2MlpProfile;
}
export interface L2FitReport {
  readonly trainedHeads: readonly L2Head[];
  readonly initialization: "pretraining" | "warm_start";
  readonly fittedRows: number;
  readonly fittedByHead: Readonly<Record<L2Head, number>>;
  readonly epochZero: Readonly<Record<L2Head, { readonly correct: number; readonly scored: number }>>;
  readonly final: Readonly<Record<L2Head, { readonly correct: number; readonly scored: number }>>;
  readonly epochsCompleted: number;
  readonly stopped: "satisfied" | "epochs_exhausted";
  readonly trajectory: readonly { readonly epoch: number; readonly loss: Readonly<Record<L2Head, number | null>> }[];
  readonly parameterCount: number;
  readonly changedParameters: number;
  readonly gradientProbe: { readonly checked: number; readonly passed: boolean; readonly maxAbsoluteError: number };
  /** Which backend actually produced this fit. */
  readonly backend?: L2ComputeBackend;
  /** Torch device or `handwired-reference`; never guessed from logs. */
  readonly device?: string;
  /** Global update step this run continued from; null for a fresh run. */
  readonly resumedFromStep?: number | null;
  /** Last update boundary committed to disk; null when not checkpointing. */
  readonly lastPersistedStep?: number | null;
  /** Measured phase durations and step-time percentiles, in milliseconds. */
  readonly timing?: L2FitTiming;
}

export interface L2FitTiming {
  readonly deviceLoadMs?: number;
  readonly dataPrepareMs?: number;
  readonly firstComputeMs?: number;
  readonly warmTrainingMs?: number;
  readonly checkpointWriteMs?: number;
  readonly checkpointWriteCount?: number;
  readonly evaluationMs?: number;
  readonly reloadMs?: number;
  readonly totalMs?: number;
  readonly stepCount?: number;
  readonly meanStepMs?: number | null;
  readonly p50StepMs?: number | null;
  readonly p95StepMs?: number | null;
  readonly minStepMs?: number | null;
  readonly maxStepMs?: number | null;
}
export interface L2FitResult { readonly profile: L2MlpProfile; readonly report: L2FitReport }

export type L2ConditionState = "satisfied" | "unsatisfied" | "unknown" | "not_applicable";
export interface L2ScopedEvidence {
  readonly id: string;
  readonly stateRef: string;
  readonly objectRef: string;
  readonly scopeRef: string;
  readonly contextRevision: number;
}
