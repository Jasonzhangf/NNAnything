export interface UnifiedCheckpointIoTiming {
  readonly serializeSeconds: number;
  readonly atomicReplaceSeconds: number;
  readonly packageReloadSeconds: number;
  readonly totalSeconds: number;
}

export interface UnifiedThisRunTiming {
  readonly loadSeconds: number;
  readonly dataValidationSeconds: number;
  readonly optimizationSeconds: number | null;
  readonly checkpointIoSecs: UnifiedCheckpointIoTiming;
  readonly evaluationSeconds: number | null;
  readonly totalWallSeconds: number;
  readonly rowsPerSecond: number | null;
  readonly throughputDenominator: "optimizationSeconds" | null;
}

export interface UnifiedCumulativeTiming {
  readonly loadSeconds: number;
  readonly dataValidationSeconds: number;
  readonly optimizationSeconds: number;
  readonly checkpointIoSecs: UnifiedCheckpointIoTiming;
  readonly totalWallSeconds: number;
  readonly optimizerSteps: number;
  readonly processedRows: number;
}

export interface UnifiedTimingCutPoint {
  readonly committedOptimizerSteps: number;
  readonly committedProcessedRows: number;
  readonly reason: "epoch_commit" | "paused";
}

export interface UnifiedPersistedTiming {
  readonly cumulative: UnifiedCumulativeTiming;
  readonly timingCutPoint: UnifiedTimingCutPoint;
}

export function monotonicSeconds(startNs: bigint, endNs: bigint = process.hrtime.bigint()): number {
  return Math.max(0, Number(endNs - startNs) / 1e9);
}

export function emptyCheckpointIoTiming(): UnifiedCheckpointIoTiming {
  return {
    serializeSeconds: 0,
    atomicReplaceSeconds: 0,
    packageReloadSeconds: 0,
    totalSeconds: 0,
  };
}

export function addCheckpointIoTiming(
  left: UnifiedCheckpointIoTiming,
  right: UnifiedCheckpointIoTiming,
): UnifiedCheckpointIoTiming {
  const serializeSeconds = left.serializeSeconds + right.serializeSeconds;
  const atomicReplaceSeconds = left.atomicReplaceSeconds + right.atomicReplaceSeconds;
  const packageReloadSeconds = left.packageReloadSeconds + right.packageReloadSeconds;
  return {
    serializeSeconds,
    atomicReplaceSeconds,
    packageReloadSeconds,
    totalSeconds: serializeSeconds + atomicReplaceSeconds + packageReloadSeconds,
  };
}

export function addPackageReloadSeconds(
  timing: UnifiedCheckpointIoTiming,
  seconds: number,
): UnifiedCheckpointIoTiming {
  return addCheckpointIoTiming(timing, {
    serializeSeconds: 0,
    atomicReplaceSeconds: 0,
    packageReloadSeconds: seconds,
    totalSeconds: seconds,
  });
}
