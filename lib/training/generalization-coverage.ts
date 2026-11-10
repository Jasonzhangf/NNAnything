import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expectRecord } from "../core/schema.js";
import {
  BASIC_KIND_WIRE_NAMES,
  extractBasicKindWires,
  type BasicKindWireName,
} from "../filters/basic-kinds.js";
import type { FeedbackProfile } from "../adapters/browser/feedback-contract.js";
import {
  createZeroFeedbackProfile,
  feedbackFeatures,
  predictFeedback,
  validateFeedbackProfile,
} from "../filters/browser-feedback.js";
import type { BrowserSingleActionProfile } from "../adapters/browser/single-action-contract.js";
import {
  createZeroBrowserSingleActionProfile,
  predictBrowserSingleAction,
  singleActionCapabilityFeatures,
  singleActionRelationFeatures,
  validateBrowserSingleActionProfile,
} from "../filters/browser-single-action-policy.js";
import type { BrowserStrategyProfile } from "../adapters/browser/strategy-contract.js";
import {
  createZeroBrowserStrategyProfile,
  predictBrowserStrategy,
  projectStrategyCandidates,
  validateBrowserStrategyProfile,
} from "../filters/browser-strategy.js";
import {
  CLI_COMMAND_HEADS,
  migrateCliCommandProfileToCurrent,
  type CliCommandProfile,
} from "../filters/cli-command-policy.js";
import {
  rolloutPath,
  validatePathProfile,
  type PathProfile,
} from "../filters/cli-path-controller.js";
import { prepareBasicKindSamples } from "./basic-kind-samples.js";
import {
  partitionBasicKindSamples,
  type BasicKindTransition,
} from "./basic-kind-training.js";
import {
  makeFeedbackSamples,
  partitionFeedbackEpisodes,
} from "./browser-feedback-samples.js";
import {
  makeBrowserSingleActionSamples,
  partitionBrowserSingleActionSamples,
} from "./browser-single-action-samples.js";
import {
  makeStrategySamples,
  partitionStrategyEpisodes,
} from "./browser-strategy-samples.js";
import {
  prepareCliCommandDataset,
  sampleFeatures,
} from "./cli-command-samples.js";
import {
  preparePathDataset,
  teacherPathRows,
} from "./cli-path-samples.js";

export type CoverageReportMode = "audit_diagnostic" | "admission_gate";

export type PartitionRole =
  | "train"
  | "development_diagnostic"
  | "known_combo_ablation"
  | "independent_verification";

export type ProjectionSource =
  | "direct_sample_features"
  | "teacher_conditioned"
  | "handwired_reference_diagnostic"
  | "candidate_inference";

export type SamplingUnitKind =
  | "independent_scene_request"
  | "step_clustered_by_trajectory"
  | "element_row_clustered_by_snapshot"
  | "candidate_row_clustered_by_decision_set";

export type RowOutcomeStatus =
  | "passed"
  | "failed"
  | "not_applicable_candidate_row"
  | "not_available";

export type EpisodeOutcomeStatus =
  | "passed"
  | "failed"
  | "not_available";

export type RealTargetStatus =
  | "achieved"
  | "not_achieved"
  | "not_available";

export type TargetBehaviorVerificationStatus =
  | "static_forward_only"
  | "real_execution_post_state_verified"
  | "not_available";

export type SiteName = "weibo" | "xiaohongshu" | "zhihu";

export interface HeadObservationInputRow {
  readonly rowId: string;
  readonly unitId: string;
  readonly headGroupId: string;
  readonly featureSchemaId: string;
  readonly expectedDimension: number;
  readonly projectionSource: ProjectionSource;
  readonly upstreamProfileSource: string;
  readonly features: readonly (number | null)[];
  readonly partition: string;
  readonly partitionRole: PartitionRole;
  readonly sourceGroupId: string;
  readonly site: SiteName | null;
  readonly episodeOrTrajectoryId: string;
  readonly rowOutcome: RowOutcomeStatus;
}

export interface EpisodeOrTrajectoryRow {
  readonly episodeOrTrajectoryId: string;
  readonly unitId: string;
  readonly partition: string;
  readonly partitionRole: PartitionRole;
  readonly sourceGroupId: string;
  readonly site: SiteName | null;
  readonly compositionTag: string;
  readonly episodeOutcome: EpisodeOutcomeStatus;
  readonly realTargetStatus: RealTargetStatus;
}

export interface DescriptiveWilsonInterval {
  readonly confidenceLevel: 0.95;
  readonly passed: number;
  readonly total: number;
  readonly pointEstimate: number;
  readonly lower: number;
  readonly upper: number;
  readonly samplingUnit: SamplingUnitKind;
  readonly withinPartitionClustered: boolean;
  readonly independenceAssumptionHolds: boolean;
}

export interface InputVectorCoverageStats {
  readonly totalRowCount: number;
  readonly evaluatedRowCount: number;
  readonly passedRowCount: number;
  readonly overallRowAccuracy: number | null;
  readonly distinctVectors: number;
  readonly overlappingTrainDistinctVectors: number;
  readonly novelDistinctVectors: number;
  readonly novelRowCount: number;
  readonly novelEvaluatedRowCount: number;
  readonly novelPassedRowCount: number;
  readonly novelRowAccuracy: number | null;
}

export interface SourceIndependenceStats {
  readonly partitionRole: PartitionRole;
  readonly sourceClusterKey: string;
  readonly distinctSourceGroupCount: number;
  readonly withinPartitionClustered: boolean;
  readonly sourceIsolationStatus: "clean" | "leaked_across_partitions";
  readonly overlappingSourceGroupCount: number;
  readonly overlappingSourceGroupIds: readonly string[];
  readonly bySiteRowCounts: Readonly<Record<SiteName, number>> | null;
}

export interface HeadPartitionCoverageReport {
  readonly partition: string;
  readonly inputVectorCoverage: InputVectorCoverageStats;
  readonly sourceIndependence: SourceIndependenceStats;
  readonly wilsonInterval: DescriptiveWilsonInterval | null;
}

export interface HeadGroupCoverageReport {
  readonly headGroupId: string;
  readonly featureSchemaId: string;
  readonly expectedDimension: number;
  readonly projectionSource: ProjectionSource;
  readonly upstreamProfileSource: string;
  readonly partitions: Readonly<Record<string, HeadPartitionCoverageReport>>;
}

export interface TrajectoryOrDecisionSetPartitionStats {
  readonly partition: string;
  readonly partitionRole: PartitionRole;
  readonly totalCount: number;
  readonly evaluatedCount: number;
  readonly passedCount: number;
  readonly passRate: number | null;
  readonly distinctSourceGroups: number;
  readonly withinPartitionClustered: boolean;
  readonly sourceIsolationStatus: "clean" | "leaked_across_partitions";
  readonly overlappingSourceGroupCount: number;
  readonly overlappingSourceGroupIds: readonly string[];
  readonly realTargetAchievedCount: number | "not_available";
  readonly realTargetEvaluatedCount: number | "not_available";
  readonly realTargetAchievementRate: number | null | "not_available";
  readonly wilsonInterval: DescriptiveWilsonInterval | null;
}

export interface DomPairedTransitionSummary {
  readonly historicalResultSource: string;
  readonly baseProfileId: string;
  readonly candidateId: string;
  readonly splits: Readonly<
    Record<
      "train" | "eval",
      {
        readonly eligibleCount: number;
        readonly transitions: Readonly<Record<BasicKindTransition, number>>;
      }
    >
  >;
  readonly bySite: Readonly<
    Record<
      SiteName,
      Readonly<Record<BasicKindTransition, number>>
    >
  >;
}

export interface UnitCoverageReport {
  readonly unitId: string;
  readonly mode: CoverageReportMode;
  readonly samplingUnit: SamplingUnitKind;
  readonly sourceClusterKey: string;
  readonly targetBehaviorStatus: TargetBehaviorVerificationStatus;
  readonly candidateInferenceStatus: "available" | "not_available" | "not_applicable";
  readonly historicalDiagnosticSource: string | null;
  readonly headGroups: Readonly<Record<string, HeadGroupCoverageReport>>;
  readonly trajectoryAndDecisionSetMetrics: {
    readonly partitions: Readonly<Record<string, TrajectoryOrDecisionSetPartitionStats>>;
  };
  readonly domPairedTransitions?: DomPairedTransitionSummary | "not_available";
}

export function serializeFeatureVector(
  features: readonly (number | null)[],
  expectedDimension: number,
): string {
  if (!Array.isArray(features)) {
    throw new TypeError("features must be an array");
  }
  if (!Number.isSafeInteger(expectedDimension) || expectedDimension <= 0) {
    throw new TypeError("expectedDimension must be a positive safe integer");
  }
  if (features.length !== expectedDimension) {
    throw new TypeError(
      `feature vector length ${features.length} does not match expectedDimension ${expectedDimension}`,
    );
  }
  const tokens = features.map((entry, index) => {
    if (entry === null) return "m";
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw new TypeError(`feature at index ${index} must be a finite number or null`);
    }
    const normalized = Object.is(entry, -0) ? 0 : entry;
    return `v:${String(normalized)}`;
  });
  return tokens.join("|");
}

export function descriptiveWilsonInterval(
  passed: number,
  total: number,
  samplingUnit: SamplingUnitKind,
  overlappingSourceGroupCount: number,
  withinPartitionClustered = false,
): DescriptiveWilsonInterval | null {
  if (!Number.isSafeInteger(total) || total <= 0) return null;
  if (!Number.isSafeInteger(passed) || passed < 0 || passed > total) {
    throw new TypeError(`invalid Wilson counts passed=${passed}, total=${total}`);
  }
  const z = 1.959963984540054;
  const z2 = z * z;
  const phat = passed / total;
  const denom = 1 + z2 / total;
  const center = (phat + z2 / (2 * total)) / denom;
  const halfWidth =
    (z * Math.sqrt((phat * (1 - phat) + z2 / (4 * total)) / total)) / denom;
  const lower = Math.max(0, center - halfWidth);
  const upper = Math.min(1, center + halfWidth);
  const independenceAssumptionHolds =
    samplingUnit === "independent_scene_request" &&
    overlappingSourceGroupCount === 0 &&
    !withinPartitionClustered;
  return Object.freeze({
    confidenceLevel: 0.95,
    passed,
    total,
    pointEstimate: phat,
    lower,
    upper,
    samplingUnit,
    withinPartitionClustered,
    independenceAssumptionHolds,
  });
}

export function buildUnitCoverageReport(input: {
  readonly unitId: string;
  readonly mode: CoverageReportMode;
  readonly samplingUnit: SamplingUnitKind;
  readonly sourceClusterKey: string;
  readonly targetBehaviorStatus: TargetBehaviorVerificationStatus;
  readonly candidateInferenceStatus?: "available" | "not_available" | "not_applicable";
  readonly historicalDiagnosticSource?: string | null;
  readonly headRows: readonly HeadObservationInputRow[];
  readonly episodeRows: readonly EpisodeOrTrajectoryRow[];
  readonly domPairedTransitions?: DomPairedTransitionSummary | "not_available";
}): UnitCoverageReport {
  const {
    unitId,
    mode,
    samplingUnit,
    sourceClusterKey,
    targetBehaviorStatus,
    candidateInferenceStatus = "not_applicable",
    historicalDiagnosticSource = null,
    headRows,
    episodeRows,
    domPairedTransitions,
  } = input;

  if (typeof unitId !== "string" || unitId.length === 0) {
    throw new TypeError("unitId must be a non-empty string");
  }
  if (mode !== "audit_diagnostic" && mode !== "admission_gate") {
    throw new TypeError("mode must be audit_diagnostic or admission_gate");
  }

  const headMetaByGroup = new Map<
    string,
    {
      readonly featureSchemaId: string;
      readonly expectedDimension: number;
      readonly projectionSource: ProjectionSource;
      readonly upstreamProfileSource: string;
    }
  >();

  const rowsByHeadGroup = new Map<string, HeadObservationInputRow[]>();
  const unitSourcesByPartition = new Map<string, Set<string>>();

  for (const row of headRows) {
    if (row.unitId !== unitId) {
      throw new TypeError(`headRow ${row.rowId} unitId ${row.unitId} does not match ${unitId}`);
    }
    if (typeof row.headGroupId !== "string" || row.headGroupId.length === 0) {
      throw new TypeError(`headRow ${row.rowId} headGroupId must be a non-empty string`);
    }
    if (typeof row.featureSchemaId !== "string" || row.featureSchemaId.length === 0) {
      throw new TypeError(`headRow ${row.rowId} featureSchemaId must be a non-empty string`);
    }
    if (typeof row.upstreamProfileSource !== "string" || row.upstreamProfileSource.length === 0) {
      throw new TypeError(`headRow ${row.rowId} upstreamProfileSource must be a non-empty string`);
    }
    if (typeof row.sourceGroupId !== "string" || row.sourceGroupId.length === 0) {
      throw new TypeError(`headRow ${row.rowId} sourceGroupId must be a non-empty string`);
    }
    serializeFeatureVector(row.features, row.expectedDimension);
    if (!unitSourcesByPartition.has(row.partition)) {
      unitSourcesByPartition.set(row.partition, new Set());
    }
    unitSourcesByPartition.get(row.partition)!.add(row.sourceGroupId);

    const existingMeta = headMetaByGroup.get(row.headGroupId);
    if (existingMeta === undefined) {
      headMetaByGroup.set(row.headGroupId, {
        featureSchemaId: row.featureSchemaId,
        expectedDimension: row.expectedDimension,
        projectionSource: row.projectionSource,
        upstreamProfileSource: row.upstreamProfileSource,
      });
      rowsByHeadGroup.set(row.headGroupId, []);
    } else if (
      existingMeta.featureSchemaId !== row.featureSchemaId ||
      existingMeta.expectedDimension !== row.expectedDimension ||
      existingMeta.projectionSource !== row.projectionSource ||
      existingMeta.upstreamProfileSource !== row.upstreamProfileSource
    ) {
      throw new TypeError(
        `headGroupId ${row.headGroupId} mixes incompatible schema/dimension/projectionSource metadata`,
      );
    }
    rowsByHeadGroup.get(row.headGroupId)!.push(row);
  }

  const headGroupsRecord: Record<string, HeadGroupCoverageReport> = {};

  for (const [headGroupId, groupRows] of rowsByHeadGroup.entries()) {
    const meta = headMetaByGroup.get(headGroupId)!;
    const rowsByPartition = new Map<string, HeadObservationInputRow[]>();
    const sourceGroupsByPartition = new Map<string, Set<string>>();

    for (const row of groupRows) {
      if (!rowsByPartition.has(row.partition)) {
        rowsByPartition.set(row.partition, []);
        sourceGroupsByPartition.set(row.partition, new Set());
      }
      rowsByPartition.get(row.partition)!.push(row);
      sourceGroupsByPartition.get(row.partition)!.add(row.sourceGroupId);
    }

    const trainRows = rowsByPartition.get("train") ?? [];
    const trainVectorSet = new Set(
      trainRows.map(r => serializeFeatureVector(r.features, r.expectedDimension)),
    );

    const partitionsRecord: Record<string, HeadPartitionCoverageReport> = {};

    for (const [partition, partRows] of rowsByPartition.entries()) {
      const roleSet = new Set(partRows.map(r => r.partitionRole));
      if (roleSet.size !== 1) {
        throw new TypeError(`partition ${partition} in ${headGroupId} mixes multiple partitionRoles`);
      }
      const partitionRole = partRows[0]!.partitionRole;
      const ownSources = sourceGroupsByPartition.get(partition)!;
      const overlappingIds = new Set<string>();
      for (const [otherPartition, otherSources] of sourceGroupsByPartition.entries()) {
        if (otherPartition === partition) continue;
        for (const src of ownSources) {
          if (otherSources.has(src)) overlappingIds.add(src);
        }
      }
      const sortedOverlap = [...overlappingIds].sort();
      if (mode === "admission_gate" && sortedOverlap.length > 0) {
        throw new TypeError(
          `admission_gate rejected ${unitId}/${headGroupId}/${partition}: cross-partition sourceGroupId overlap [${sortedOverlap.join(", ")}]`,
        );
      }

      const vectorKeys = partRows.map(r =>
        serializeFeatureVector(r.features, r.expectedDimension),
      );
      const distinctSet = new Set(vectorKeys);
      const isTrain = partition === "train";
      const overlappingTrainDistinctVectors = isTrain
        ? distinctSet.size
        : [...distinctSet].filter(k => trainVectorSet.has(k)).length;
      const novelDistinctVectors = isTrain
        ? 0
        : [...distinctSet].filter(k => !trainVectorSet.has(k)).length;

      let evaluatedRowCount = 0;
      let passedRowCount = 0;
      let novelRowCount = 0;
      let novelEvaluatedRowCount = 0;
      let novelPassedRowCount = 0;
      const evaluatedSourceGroups = new Set<string>();

      const siteCounts: Record<SiteName, number> = {
        weibo: 0,
        xiaohongshu: 0,
        zhihu: 0,
      };
      let hasAnySite = false;

      partRows.forEach((row, idx) => {
        const key = vectorKeys[idx]!;
        const isNovel = !isTrain && !trainVectorSet.has(key);
        if (isNovel) novelRowCount += 1;
        if (row.rowOutcome === "passed" || row.rowOutcome === "failed") {
          evaluatedRowCount += 1;
          evaluatedSourceGroups.add(row.sourceGroupId);
          if (row.rowOutcome === "passed") passedRowCount += 1;
          if (isNovel) {
            novelEvaluatedRowCount += 1;
            if (row.rowOutcome === "passed") novelPassedRowCount += 1;
          }
        }
        if (row.site !== null) {
          hasAnySite = true;
          siteCounts[row.site] += 1;
        }
      });

      const withinPartitionClustered =
        ownSources.size < partRows.length ||
        evaluatedSourceGroups.size < evaluatedRowCount;

      const overallRowAccuracy =
        evaluatedRowCount > 0 ? passedRowCount / evaluatedRowCount : null;
      const novelRowAccuracy =
        novelEvaluatedRowCount > 0 ? novelPassedRowCount / novelEvaluatedRowCount : null;

      partitionsRecord[partition] = Object.freeze({
        partition,
        inputVectorCoverage: Object.freeze({
          totalRowCount: partRows.length,
          evaluatedRowCount,
          passedRowCount,
          overallRowAccuracy,
          distinctVectors: distinctSet.size,
          overlappingTrainDistinctVectors,
          novelDistinctVectors,
          novelRowCount,
          novelEvaluatedRowCount,
          novelPassedRowCount,
          novelRowAccuracy,
        }),
        sourceIndependence: Object.freeze({
          partitionRole,
          sourceClusterKey,
          distinctSourceGroupCount: ownSources.size,
          withinPartitionClustered,
          sourceIsolationStatus:
            sortedOverlap.length === 0 ? "clean" : "leaked_across_partitions",
          overlappingSourceGroupCount: sortedOverlap.length,
          overlappingSourceGroupIds: Object.freeze(sortedOverlap),
          bySiteRowCounts: hasAnySite ? Object.freeze(siteCounts) : null,
        }),
        wilsonInterval: descriptiveWilsonInterval(
          passedRowCount,
          evaluatedRowCount,
          samplingUnit,
          sortedOverlap.length,
          withinPartitionClustered,
        ),
      });
    }

    headGroupsRecord[headGroupId] = Object.freeze({
      headGroupId,
      featureSchemaId: meta.featureSchemaId,
      expectedDimension: meta.expectedDimension,
      projectionSource: meta.projectionSource,
      upstreamProfileSource: meta.upstreamProfileSource,
      partitions: Object.freeze(partitionsRecord),
    });
  }

  const epByPartition = new Map<string, EpisodeOrTrajectoryRow[]>();
  const epSourcesByPartition = new Map<string, Set<string>>();
  const seenEpisodeIds = new Set<string>();
  for (const ep of episodeRows) {
    if (ep.unitId !== unitId) {
      throw new TypeError(
        `episodeRow ${ep.episodeOrTrajectoryId} unitId ${ep.unitId} does not match ${unitId}`,
      );
    }
    if (typeof ep.episodeOrTrajectoryId !== "string" || ep.episodeOrTrajectoryId.length === 0) {
      throw new TypeError("episodeOrTrajectoryId must be a non-empty string");
    }
    if (seenEpisodeIds.has(ep.episodeOrTrajectoryId)) {
      throw new TypeError(`duplicate episodeOrTrajectoryId ${ep.episodeOrTrajectoryId}`);
    }
    seenEpisodeIds.add(ep.episodeOrTrajectoryId);
    if (typeof ep.sourceGroupId !== "string" || ep.sourceGroupId.length === 0) {
      throw new TypeError(
        `episodeRow ${ep.episodeOrTrajectoryId} sourceGroupId must be a non-empty string`,
      );
    }
    if (!epByPartition.has(ep.partition)) {
      epByPartition.set(ep.partition, []);
      epSourcesByPartition.set(ep.partition, new Set());
    }
    epByPartition.get(ep.partition)!.push(ep);
    epSourcesByPartition.get(ep.partition)!.add(ep.sourceGroupId);
    if (!unitSourcesByPartition.has(ep.partition)) {
      unitSourcesByPartition.set(ep.partition, new Set());
    }
    unitSourcesByPartition.get(ep.partition)!.add(ep.sourceGroupId);
  }

  const trajectoryPartitions: Record<string, TrajectoryOrDecisionSetPartitionStats> = {};
  for (const [partition, eps] of epByPartition.entries()) {
    const roleSet = new Set(eps.map(e => e.partitionRole));
    if (roleSet.size !== 1) {
      throw new TypeError(
        `episodeRows partition ${partition} in ${unitId} mixes multiple partitionRoles`,
      );
    }
    const partitionRole = eps[0]!.partitionRole;
    const ownSources = epSourcesByPartition.get(partition)!;
    const overlappingIds = new Set<string>();
    for (const [otherPartition, otherSources] of unitSourcesByPartition.entries()) {
      if (otherPartition === partition) continue;
      for (const s of ownSources) {
        if (otherSources.has(s)) overlappingIds.add(s);
      }
    }
    const sortedOverlap = [...overlappingIds].sort();
    if (mode === "admission_gate" && sortedOverlap.length > 0) {
      throw new TypeError(
        `admission_gate rejected ${unitId}/episodeRows/${partition}: cross-partition sourceGroupId overlap [${sortedOverlap.join(", ")}]`,
      );
    }

    let evaluatedCount = 0;
    let passedCount = 0;
    let realTargetAvailable = true;
    let realTargetEvaluated = 0;
    let realTargetAchieved = 0;
    const evaluatedSourceGroups = new Set<string>();

    for (const ep of eps) {
      if (ep.episodeOutcome === "passed" || ep.episodeOutcome === "failed") {
        evaluatedCount += 1;
        evaluatedSourceGroups.add(ep.sourceGroupId);
        if (ep.episodeOutcome === "passed") passedCount += 1;
      }
      if (ep.realTargetStatus === "not_available") {
        realTargetAvailable = false;
      } else {
        realTargetEvaluated += 1;
        if (ep.realTargetStatus === "achieved") realTargetAchieved += 1;
      }
    }

    const withinPartitionClustered =
      ownSources.size < eps.length ||
      evaluatedSourceGroups.size < evaluatedCount;

    trajectoryPartitions[partition] = Object.freeze({
      partition,
      partitionRole,
      totalCount: eps.length,
      evaluatedCount,
      passedCount,
      passRate: evaluatedCount > 0 ? passedCount / evaluatedCount : null,
      distinctSourceGroups: ownSources.size,
      withinPartitionClustered,
      sourceIsolationStatus:
        sortedOverlap.length === 0 ? "clean" : "leaked_across_partitions",
      overlappingSourceGroupCount: sortedOverlap.length,
      overlappingSourceGroupIds: Object.freeze(sortedOverlap),
      realTargetAchievedCount:
        realTargetAvailable && realTargetEvaluated > 0 ? realTargetAchieved : "not_available",
      realTargetEvaluatedCount:
        realTargetAvailable && realTargetEvaluated > 0 ? realTargetEvaluated : "not_available",
      realTargetAchievementRate:
        realTargetAvailable && realTargetEvaluated > 0
          ? realTargetAchieved / realTargetEvaluated
          : "not_available",
      wilsonInterval: descriptiveWilsonInterval(
        passedCount,
        evaluatedCount,
        samplingUnit,
        sortedOverlap.length,
        withinPartitionClustered,
      ),
    });
  }

  const hasCandidateInferenceGroup = Object.values(headGroupsRecord).some(
    g => g.projectionSource === "candidate_inference",
  );
  if (candidateInferenceStatus === "available" && !hasCandidateInferenceGroup) {
    throw new TypeError(
      `unit ${unitId} cannot report candidateInferenceStatus="available" without a headGroup having projectionSource="candidate_inference"`,
    );
  }

  return Object.freeze({
    unitId,
    mode,
    samplingUnit,
    sourceClusterKey,
    targetBehaviorStatus,
    candidateInferenceStatus,
    historicalDiagnosticSource,
    headGroups: Object.freeze(headGroupsRecord),
    trajectoryAndDecisionSetMetrics: Object.freeze({
      partitions: Object.freeze(trajectoryPartitions),
    }),
    ...(domPairedTransitions !== undefined ? { domPairedTransitions } : {}),
  });
}

function parseSiteFromRef(ref: string): SiteName | null {
  if (ref.includes("weibo")) return "weibo";
  if (ref.includes("xiaohongshu")) return "xiaohongshu";
  if (ref.includes("zhihu")) return "zhihu";
  return null;
}

function dot(weights: readonly number[], features: readonly number[]): number {
  return weights.reduce((sum, w, i) => sum + w * features[i]!, 0);
}

export interface ConvertAllExistingUnitsOptions {
  readonly repositoryRoot: string;
  readonly mode?: CoverageReportMode;
  readonly cliCommandSamplesPath?: string;
  readonly cliCommandProfilePath?: string | null;
  readonly cliPathProfilePath?: string | null;
  readonly cliPathReportPath?: string | null;
  readonly domResultPath?: string | null;
  readonly browserAtomicProfilePath?: string | null;
  readonly browserFeedbackProfilePath?: string | null;
  readonly browserStrategyProfilePath?: string | null;
  readonly includeUpstreamCandidateInference?: boolean;
}

export interface AllUnitsCoverageBundle {
  readonly schemaVersion: 1;
  readonly mode: CoverageReportMode;
  readonly units: Readonly<Record<string, UnitCoverageReport>>;
}

function convertCliCommandDatasetToReport(input: {
  readonly samplesPath: string;
  readonly profilePath: string | null;
  readonly mode: CoverageReportMode;
}): UnitCoverageReport {
  const rawSamples = JSON.parse(readFileSync(input.samplesPath, "utf8"));
  const prep = prepareCliCommandDataset(rawSamples, ["train", "development"], "stage2-13x38");

  let profile: CliCommandProfile | null = null;
  if (input.profilePath !== null && existsSync(input.profilePath)) {
    const rawProfileJson = JSON.parse(readFileSync(input.profilePath, "utf8"));
    const rawProfile = expectRecord(rawProfileJson, "cli command candidate").profile ?? rawProfileJson;
    profile = migrateCliCommandProfileToCurrent(rawProfile);
  }

  const headRows: HeadObservationInputRow[] = [];
  const episodeRows: EpisodeOrTrajectoryRow[] = [];

  for (const partition of ["train", "development"] as const) {
    const partitionRole: PartitionRole =
      partition === "train" ? "train" : "development_diagnostic";
    for (const sample of prep[partition]) {
      const scene = prep.scenes.get(sample.scenarioId)!;
      const features = sampleFeatures(sample, scene, "stage2-13x38");
      let rowOutcome: RowOutcomeStatus = "not_available";
      let episodeOutcome: EpisodeOutcomeStatus = "not_available";
      if (profile !== null) {
        const scores = profile.weights.map(row => dot(row, features));
        let bestIdx = 0;
        for (let i = 1; i < scores.length; i += 1) {
          if (scores[i]! > scores[bestIdx]!) bestIdx = i;
        }
        const predictedHead = CLI_COMMAND_HEADS[bestIdx]!;
        const passed = predictedHead === sample.expectedHead;
        rowOutcome = passed ? "passed" : "failed";
        episodeOutcome = passed ? "passed" : "failed";
      }
      headRows.push({
        rowId: sample.id,
        unitId: "cli.command-policy.v1",
        headGroupId: "cli.command.head-13x38",
        featureSchemaId: "cli.command.stage2.v1",
        expectedDimension: 38,
        projectionSource: "direct_sample_features",
        upstreamProfileSource: "none_required",
        features,
        partition,
        partitionRole,
        sourceGroupId: sample.sourceGroup,
        site: null,
        episodeOrTrajectoryId: sample.id,
        rowOutcome,
      });
      episodeRows.push({
        episodeOrTrajectoryId: sample.id,
        unitId: "cli.command-policy.v1",
        partition,
        partitionRole,
        sourceGroupId: sample.sourceGroup,
        site: null,
        compositionTag: sample.case,
        episodeOutcome,
        realTargetStatus: "not_available",
      });
    }
  }

  return buildUnitCoverageReport({
    unitId: "cli.command-policy.v1",
    mode: input.mode,
    samplingUnit: "independent_scene_request",
    sourceClusterKey: "scene_group",
    targetBehaviorStatus: "static_forward_only",
    candidateInferenceStatus: "not_applicable",
    historicalDiagnosticSource:
      profile !== null && input.profilePath !== null ? input.profilePath : null,
    headRows,
    episodeRows,
  });
}

export function convertAllExistingUnitsToCoverageReport(
  options: ConvertAllExistingUnitsOptions,
): AllUnitsCoverageBundle {
  const repoRoot = options.repositoryRoot;
  const mode = options.mode ?? "audit_diagnostic";
  const includeUpstream = options.includeUpstreamCandidateInference !== false;

  // 1. CLI Command Policy (repo baseline 262 samples)
  const cliBaseSamplesPath =
    options.cliCommandSamplesPath ??
    resolve(
      repoRoot,
      "training/samples/filesystem/command/35bd5ad9-15dc-409e-9001-bcab24f75398/samples.json",
    );
  const cliBaseProfilePath =
    options.cliCommandProfilePath !== undefined
      ? options.cliCommandProfilePath
      : includeUpstream
        ? resolve(
            repoRoot,
            "training/weights/filesystem/command/35bd5ad9-15dc-409e-9001-bcab24f75398/candidate.json",
          )
        : null;
  const cliCommandReport = convertCliCommandDatasetToReport({
    samplesPath: cliBaseSamplesPath,
    profilePath: cliBaseProfilePath,
    mode,
  });

  // 2. CLI Path Controller
  const pathSamplesPath = resolve(
    repoRoot,
    "training/samples/path-resolve/5be5fe28-1dbe-4558-9d23-23d2b441870a/samples.json",
  );
  const resolvedPathProfilePath =
    options.cliPathProfilePath !== undefined
      ? options.cliPathProfilePath
      : includeUpstream
        ? resolve(
            repoRoot,
            "training/weights/path-resolve/5be5fe28-1dbe-4558-9d23-23d2b441870a/candidate.json",
          )
        : null;
  const resolvedPathReportPath =
    options.cliPathReportPath !== undefined
      ? options.cliPathReportPath
      : resolve(
          repoRoot,
          "training/results/path-resolve/5be5fe28-1dbe-4558-9d23-23d2b441870a/report.json",
        );
  const pathPrep = preparePathDataset(JSON.parse(readFileSync(pathSamplesPath, "utf8")));
  let pathProfile: PathProfile | null = null;
  if (resolvedPathProfilePath !== null && existsSync(resolvedPathProfilePath)) {
    const raw = JSON.parse(readFileSync(resolvedPathProfilePath, "utf8"));
    pathProfile = validatePathProfile(raw.profile ?? raw);
  }
  const hasPathHistoricalReport =
    resolvedPathReportPath !== null && existsSync(resolvedPathReportPath);
  const pathRolloutOutcomeById = new Map<string, boolean>();
  if (hasPathHistoricalReport && resolvedPathReportPath !== null) {
    const rawReport = JSON.parse(readFileSync(resolvedPathReportPath, "utf8"));
    for (const part of ["train", "development", "holdout"] as const) {
      const rows =
        rawReport?.comparison?.[part]?.trained?.rows ??
        rawReport?.comparison?.[part]?.candidate?.rows;
      if (Array.isArray(rows)) {
        for (const r of rows) {
          if (typeof r?.id === "string") {
            const ok = Boolean(r?.rollout?.ok && r?.rollout?.absolute === r?.expected);
            pathRolloutOutcomeById.set(r.id, ok);
          }
        }
      }
    }
  }

  const pathHeadRows: HeadObservationInputRow[] = [];
  const pathEpisodeRows: EpisodeOrTrajectoryRow[] = [];
  for (const partition of ["train", "development", "holdout"] as const) {
    const partitionRole: PartitionRole =
      partition === "train"
        ? "train"
        : partition === "development"
          ? "development_diagnostic"
          : "independent_verification";
    for (const sample of pathPrep[partition]) {
      const steps = teacherPathRows(sample);
      steps.forEach((step, idx) => {
        pathHeadRows.push({
          rowId: `${sample.id}:step:${idx}`,
          unitId: "cli.path-controller.v1",
          headGroupId: "cli.path.step-4x9.teacher_conditioned",
          featureSchemaId: "cli.path.step.v1",
          expectedDimension: 9,
          projectionSource: "teacher_conditioned",
          upstreamProfileSource: "teacherPathRows",
          features: step.features,
          partition,
          partitionRole,
          sourceGroupId: sample.sourceGroup,
          site: null,
          episodeOrTrajectoryId: sample.id,
          rowOutcome: "not_available",
        });
      });

      if (pathProfile !== null && resolvedPathProfilePath !== null) {
        const rollout = rolloutPath(
          { cwd: sample.cwd, input: sample.input },
          pathProfile,
        );
        let prefixAligned = true;
        rollout.trace.forEach((candStep, idx) => {
          const teacherStep = steps[idx];
          const sameStateAsTeacher =
            prefixAligned &&
            teacherStep !== undefined &&
            serializeFeatureVector(candStep.features, 9) ===
              serializeFeatureVector(teacherStep.features, 9);
          const stepPassed =
            sameStateAsTeacher && candStep.action === teacherStep.expected;
          if (!stepPassed) {
            prefixAligned = false;
          }
          pathHeadRows.push({
            rowId: `${sample.id}:cand-step:${idx}`,
            unitId: "cli.path-controller.v1",
            headGroupId: "cli.path.step-4x9.candidate_inference",
            featureSchemaId: "cli.path.step.v1",
            expectedDimension: 9,
            projectionSource: "candidate_inference",
            upstreamProfileSource: resolvedPathProfilePath,
            features: candStep.features,
            partition,
            partitionRole,
            sourceGroupId: sample.sourceGroup,
            site: null,
            episodeOrTrajectoryId: sample.id,
            rowOutcome: stepPassed ? "passed" : "failed",
          });
        });
      }

      const knownRollout = pathRolloutOutcomeById.get(sample.id);
      pathEpisodeRows.push({
        episodeOrTrajectoryId: sample.id,
        unitId: "cli.path-controller.v1",
        partition,
        partitionRole,
        sourceGroupId: sample.sourceGroup,
        site: null,
        compositionTag: sample.sourceGroup,
        episodeOutcome:
          knownRollout === undefined ? "not_available" : knownRollout ? "passed" : "failed",
        realTargetStatus: "not_available",
      });
    }
  }

  const cliPathReport = buildUnitCoverageReport({
    unitId: "cli.path-controller.v1",
    mode,
    samplingUnit: "step_clustered_by_trajectory",
    sourceClusterKey: "synthetic_family",
    targetBehaviorStatus: "static_forward_only",
    candidateInferenceStatus: pathProfile !== null ? "available" : "not_available",
    historicalDiagnosticSource: hasPathHistoricalReport ? resolvedPathReportPath : null,
    headRows: pathHeadRows,
    episodeRows: pathEpisodeRows,
  });

  // 3. DOM Basic Kinds
  const domSamplesPath = resolve(
    repoRoot,
    "training/samples/training-m1/reviewed-existing.json",
  );
  const resolvedDomResultPath =
    options.domResultPath !== undefined
      ? options.domResultPath
      : resolve(
          repoRoot,
          "training/results/dom-basic-kinds/existing-properties-320c80ef-447e-41b3-be03-33197cd4b8d6.result.json",
        );
  const domPrepared = prepareBasicKindSamples(
    JSON.parse(readFileSync(domSamplesPath, "utf8")),
    { taskId: "dom.basic-kinds.v1", inputScope: "properties_offline" },
  );
  const domPartResult = partitionBasicKindSamples(domPrepared, {
    mode: "source_group_holdout",
    seed: 17,
    evalFraction: 0.25,
    allowInSampleEval: false,
  });
  if (!domPartResult.ok) {
    throw new Error(`Failed to partition DOM basic-kind samples: ${domPartResult.reason}`);
  }
  const domParts = domPartResult.partitions;
  const clusterByRowIndex = new Map<number, string>();
  for (const cluster of domParts.sourceClusters) {
    for (const rowIndex of cluster.rowIndices) {
      clusterByRowIndex.set(rowIndex, cluster.clusterId);
    }
  }
  const trainIdxSet = new Set(domParts.trainIndices);

  const comparedRowByIndex = new Map<
    number,
    {
      readonly split: "train" | "eval" | null;
      readonly transition: BasicKindTransition;
      readonly expectedLabel: string | null;
      readonly newBasicKind: string | null;
    }
  >();
  let domPairedTransitions: DomPairedTransitionSummary | "not_available" = "not_available";
  const hasDomHistoricalResult =
    resolvedDomResultPath !== null && existsSync(resolvedDomResultPath);
  if (hasDomHistoricalResult && resolvedDomResultPath !== null) {
    const rawDomResult = JSON.parse(readFileSync(resolvedDomResultPath, "utf8"));
    const comp = rawDomResult?.assessment?.comparison;
    const cand = rawDomResult?.assessment?.candidate;
    if (comp && cand && Array.isArray(comp.rows)) {
      const bySite: Record<SiteName, Record<BasicKindTransition, number>> = {
        weibo: { fixed: 0, regressed: 0, retained: 0, unresolved: 0, unassessed: 0 },
        xiaohongshu: { fixed: 0, regressed: 0, retained: 0, unresolved: 0, unassessed: 0 },
        zhihu: { fixed: 0, regressed: 0, retained: 0, unresolved: 0, unassessed: 0 },
      };
      for (const r of comp.rows) {
        if (typeof r?.index === "number") {
          comparedRowByIndex.set(r.index, {
            split: r.split ?? null,
            transition: r.transition,
            expectedLabel: r.expectedLabel ?? null,
            newBasicKind: r.new?.basicKind ?? null,
          });
          const rowObj = domParts.rows[r.index];
          const site = rowObj ? parseSiteFromRef(rowObj.inputRef.snapshotRef) : null;
          if (site !== null && r.transition in bySite[site]) {
            bySite[site][r.transition as BasicKindTransition] += 1;
          }
        }
      }
      domPairedTransitions = Object.freeze({
        historicalResultSource: resolvedDomResultPath,
        baseProfileId: String(cand.baseProfileId),
        candidateId: String(cand.candidateId),
        splits: Object.freeze({
          train: Object.freeze({
            eligibleCount: Number(comp.splits.train.eligibleCount),
            transitions: Object.freeze({ ...comp.splits.train.transitions }),
          }),
          eval: Object.freeze({
            eligibleCount: Number(comp.splits.eval.eligibleCount),
            transitions: Object.freeze({ ...comp.splits.eval.transitions }),
          }),
        }),
        bySite: Object.freeze({
          weibo: Object.freeze(bySite.weibo),
          xiaohongshu: Object.freeze(bySite.xiaohongshu),
          zhihu: Object.freeze(bySite.zhihu),
        }),
      });
    }
  }

  const domHeadRows: HeadObservationInputRow[] = [];
  const domEpisodeRows: EpisodeOrTrajectoryRow[] = [];
  for (const rowIndex of domParts.includedIndices) {
    const row = domParts.rows[rowIndex]!;
    const wires = extractBasicKindWires(row.properties);
    const features = BASIC_KIND_WIRE_NAMES.map(
      (w: BasicKindWireName) => wires[w] ?? null,
    );
    const partition = trainIdxSet.has(rowIndex) ? "train" : "eval";
    const partitionRole: PartitionRole =
      partition === "train" ? "train" : "independent_verification";
    const clusterId = clusterByRowIndex.get(rowIndex) ?? row.inputRef.snapshotRef;
    const site = parseSiteFromRef(row.inputRef.snapshotRef);
    const compRow = comparedRowByIndex.get(rowIndex);
    let rowOutcome: RowOutcomeStatus = "not_available";
    let episodeOutcome: EpisodeOutcomeStatus = "not_available";
    if (compRow && compRow.expectedLabel !== null && compRow.newBasicKind !== null) {
      const passed = compRow.newBasicKind === compRow.expectedLabel;
      rowOutcome = passed ? "passed" : "failed";
      episodeOutcome = passed ? "passed" : "failed";
    }
    domHeadRows.push({
      rowId: row.sampleId,
      unitId: "dom.basic-kinds.v1",
      headGroupId: "dom.basic-kinds.wires-80",
      featureSchemaId: "dom.basic-kinds.wires.v1",
      expectedDimension: BASIC_KIND_WIRE_NAMES.length,
      projectionSource: "direct_sample_features",
      upstreamProfileSource: "none_required",
      features,
      partition,
      partitionRole,
      sourceGroupId: clusterId,
      site,
      episodeOrTrajectoryId: row.sampleId,
      rowOutcome,
    });
    domEpisodeRows.push({
      episodeOrTrajectoryId: row.sampleId,
      unitId: "dom.basic-kinds.v1",
      partition,
      partitionRole,
      sourceGroupId: clusterId,
      site,
      compositionTag: row.review.expectedLabel ?? "unverified",
      episodeOutcome,
      realTargetStatus: "not_available",
    });
  }

  const domReport = buildUnitCoverageReport({
    unitId: "dom.basic-kinds.v1",
    mode,
    samplingUnit: "element_row_clustered_by_snapshot",
    sourceClusterKey: "snapshot_cluster",
    targetBehaviorStatus: "static_forward_only",
    candidateInferenceStatus: "not_applicable",
    historicalDiagnosticSource:
      domPairedTransitions !== "not_available" ? resolvedDomResultPath : null,
    headRows: domHeadRows,
    episodeRows: domEpisodeRows,
    domPairedTransitions,
  });

  // 4. Browser Single-Action Policy (relation 13w + capability 8w teacher_conditioned + capability 8w candidate_inference)
  const saParts = partitionBrowserSingleActionSamples(makeBrowserSingleActionSamples());
  const resolvedAtomicPath =
    options.browserAtomicProfilePath !== undefined
      ? options.browserAtomicProfilePath
      : null;
  let savedAtomicProfile: BrowserSingleActionProfile | null = null;
  if (resolvedAtomicPath !== null && existsSync(resolvedAtomicPath)) {
    const raw = JSON.parse(readFileSync(resolvedAtomicPath, "utf8"));
    savedAtomicProfile = validateBrowserSingleActionProfile(raw.profile ?? raw);
  }

  const saHeadRows: HeadObservationInputRow[] = [];
  const saEpisodeRows: EpisodeOrTrajectoryRow[] = [];

  for (const partition of ["train", "development"] as const) {
    const partitionRole: PartitionRole =
      partition === "train" ? "train" : "development_diagnostic";
    for (const ep of saParts[partition]) {
      const provSet = new Set(ep.teacher.providerRefs);
      const unkSet = new Set(ep.teacher.unknownRefs);
      const candPred =
        savedAtomicProfile !== null
          ? predictBrowserSingleAction(ep.request, savedAtomicProfile)
          : null;
      const candRelByRef = new Map(
        candPred?.relations.map(r => [r.ref, r]) ?? [],
      );

      for (const el of ep.request.state.elements) {
        const relFeatures = singleActionRelationFeatures(ep.request, el);
        const expectedJudgment = unkSet.has(el.ref)
          ? "unknown"
          : provSet.has(el.ref)
            ? "actionable_provider"
            : "not_provider";
        const predRel = candRelByRef.get(el.ref);
        const relOutcome: RowOutcomeStatus =
          predRel === undefined
            ? "not_available"
            : predRel.judgment === expectedJudgment
              ? "passed"
              : "failed";
        saHeadRows.push({
          rowId: `${ep.id}:rel:${el.ref}`,
          unitId: "browser.single-action-policy.v1",
          headGroupId: "browser.single-action.relation-2x13",
          featureSchemaId: "browser.single-action.relation.v1",
          expectedDimension: 13,
          projectionSource: "direct_sample_features",
          upstreamProfileSource: "none_required",
          features: relFeatures,
          partition,
          partitionRole,
          sourceGroupId: ep.family,
          site: null,
          episodeOrTrajectoryId: ep.id,
          rowOutcome: relOutcome,
        });
      }

      const teacherRelations = ep.request.state.elements.map(el => ({
        ref: el.ref,
        features: singleActionRelationFeatures(ep.request, el),
        scores: unkSet.has(el.ref) ? [0, 0] : provSet.has(el.ref) ? [1, 0] : [0, 1],
        judgment: (unkSet.has(el.ref)
          ? "unknown"
          : provSet.has(el.ref)
            ? "actionable_provider"
            : "not_provider") as "unknown" | "actionable_provider" | "not_provider",
      }));
      const teacherCapFeatures = singleActionCapabilityFeatures(
        ep.request,
        teacherRelations,
      );
      saHeadRows.push({
        rowId: `${ep.id}:cap:teacher`,
        unitId: "browser.single-action-policy.v1",
        headGroupId: "browser.single-action.capability-3x8.teacher_conditioned",
        featureSchemaId: "browser.single-action.capability.v1",
        expectedDimension: 8,
        projectionSource: "teacher_conditioned",
        upstreamProfileSource: "episode.teacher.providerRefs+unknownRefs",
        features: teacherCapFeatures,
        partition,
        partitionRole,
        sourceGroupId: ep.family,
        site: null,
        episodeOrTrajectoryId: ep.id,
        rowOutcome: "not_available",
      });

      if (candPred !== null && resolvedAtomicPath !== null) {
        const capPassed = candPred.capability === ep.teacher.capability;
        const targetPassed =
          ep.teacher.capability !== "CLICK"
            ? candPred.proposedTargetRef === null
            : candPred.proposedTargetRef !== null &&
              provSet.has(candPred.proposedTargetRef);
        saHeadRows.push({
          rowId: `${ep.id}:cap:candidate`,
          unitId: "browser.single-action-policy.v1",
          headGroupId: "browser.single-action.capability-3x8.candidate_inference",
          featureSchemaId: "browser.single-action.capability.v1",
          expectedDimension: 8,
          projectionSource: "candidate_inference",
          upstreamProfileSource: resolvedAtomicPath,
          features: candPred.capabilityFeatures,
          partition,
          partitionRole,
          sourceGroupId: ep.family,
          site: null,
          episodeOrTrajectoryId: ep.id,
          rowOutcome: capPassed ? "passed" : "failed",
        });
        saEpisodeRows.push({
          episodeOrTrajectoryId: ep.id,
          unitId: "browser.single-action-policy.v1",
          partition,
          partitionRole,
          sourceGroupId: ep.family,
          site: null,
          compositionTag: ep.teacher.capability,
          episodeOutcome: capPassed && targetPassed ? "passed" : "failed",
          realTargetStatus: "not_available",
        });
      } else {
        saEpisodeRows.push({
          episodeOrTrajectoryId: ep.id,
          unitId: "browser.single-action-policy.v1",
          partition,
          partitionRole,
          sourceGroupId: ep.family,
          site: null,
          compositionTag: ep.teacher.capability,
          episodeOutcome: "not_available",
          realTargetStatus: "not_available",
        });
      }
    }
  }

  const singleActionReport = buildUnitCoverageReport({
    unitId: "browser.single-action-policy.v1",
    mode,
    samplingUnit: "element_row_clustered_by_snapshot",
    sourceClusterKey: "synthetic_family",
    targetBehaviorStatus: "static_forward_only",
    candidateInferenceStatus: savedAtomicProfile !== null ? "available" : "not_available",
    headRows: saHeadRows,
    episodeRows: saEpisodeRows,
  });

  // 5. Browser Action Feedback (F1)
  const f1Parts = partitionFeedbackEpisodes(makeFeedbackSamples());
  const resolvedFbPath =
    options.browserFeedbackProfilePath !== undefined
      ? options.browserFeedbackProfilePath
      : null;
  let savedFbProfile: FeedbackProfile | null = null;
  if (resolvedFbPath !== null && existsSync(resolvedFbPath)) {
    const raw = JSON.parse(readFileSync(resolvedFbPath, "utf8"));
    savedFbProfile = validateFeedbackProfile(raw.profile ?? raw);
  }

  const f1HeadRows: HeadObservationInputRow[] = [];
  const f1EpisodeRows: EpisodeOrTrajectoryRow[] = [];
  for (const partition of ["train", "development"] as const) {
    const partitionRole: PartitionRole =
      partition === "train" ? "train" : "development_diagnostic";
    for (const ep of f1Parts[partition]) {
      const features = feedbackFeatures(ep.input);
      let rowOutcome: RowOutcomeStatus = "not_available";
      let episodeOutcome: EpisodeOutcomeStatus = "not_available";
      if (savedFbProfile !== null) {
        const pred = predictFeedback(ep.input, savedFbProfile);
        const passed = pred.head === ep.teacher.head;
        rowOutcome = passed ? "passed" : "failed";
        episodeOutcome = passed ? "passed" : "failed";
      }
      f1HeadRows.push({
        rowId: ep.id,
        unitId: "browser.action-feedback.v1",
        headGroupId: "browser.feedback.3x12",
        featureSchemaId: "browser.feedback.v1",
        expectedDimension: 12,
        projectionSource: "direct_sample_features",
        upstreamProfileSource: "none_required",
        features,
        partition,
        partitionRole,
        sourceGroupId: ep.family,
        site: null,
        episodeOrTrajectoryId: ep.id,
        rowOutcome,
      });
      f1EpisodeRows.push({
        episodeOrTrajectoryId: ep.id,
        unitId: "browser.action-feedback.v1",
        partition,
        partitionRole,
        sourceGroupId: ep.family,
        site: null,
        compositionTag: ep.teacher.head,
        episodeOutcome,
        realTargetStatus: "not_available",
      });
    }
  }

  const f1Report = buildUnitCoverageReport({
    unitId: "browser.action-feedback.v1",
    mode,
    samplingUnit: "independent_scene_request",
    sourceClusterKey: "synthetic_family",
    targetBehaviorStatus: "static_forward_only",
    candidateInferenceStatus: "not_applicable",
    historicalDiagnosticSource:
      savedFbProfile !== null && resolvedFbPath !== null ? resolvedFbPath : null,
    headRows: f1HeadRows,
    episodeRows: f1EpisodeRows,
  });

  // 6. Browser Progressive Strategy (F2: handwired_reference_diagnostic + candidate_inference)
  const sParts = partitionStrategyEpisodes(makeStrategySamples());
  const zeroA = createZeroBrowserSingleActionProfile();
  const rw = zeroA.relationWeights.map(r => [...r]);
  rw[0]![0] = -3;
  rw[0]![12] = 6;
  const handwiredAtomicProf = validateBrowserSingleActionProfile({
    ...zeroA,
    relationWeights: rw,
  });
  const zeroF = createZeroFeedbackProfile();
  const fw = zeroF.weights.map(r => [...r]);
  const wIdx = (n: (typeof zeroF.wires)[number]) => zeroF.wires.indexOf(n);
  fw[0]![wIdx("post.currentValid")] = 3;
  fw[0]![wIdx("regionExpanded.known")] = 1;
  fw[0]![wIdx("regionRendered.known")] = 1;
  fw[0]![wIdx("regionExpanded.value")] = -2;
  fw[0]![wIdx("regionRendered.value")] = -1;
  fw[1]![wIdx("dispatch.known")] = 5;
  fw[1]![wIdx("dispatch.value")] = -5;
  fw[2]![wIdx("bias")] = 1;
  const handwiredFbProf = validateFeedbackProfile({ ...zeroF, weights: fw });
  const zeroStratProf = createZeroBrowserStrategyProfile();

  const resolvedStratPath =
    options.browserStrategyProfilePath !== undefined
      ? options.browserStrategyProfilePath
      : null;
  let savedStratProfile: BrowserStrategyProfile | null = null;
  if (resolvedStratPath !== null && existsSync(resolvedStratPath)) {
    const raw = JSON.parse(readFileSync(resolvedStratPath, "utf8"));
    savedStratProfile = validateBrowserStrategyProfile(raw.profile ?? raw);
  }

  const hasAllF2Upstream =
    savedAtomicProfile !== null &&
    savedFbProfile !== null &&
    savedStratProfile !== null &&
    resolvedAtomicPath !== null &&
    resolvedFbPath !== null &&
    resolvedStratPath !== null;

  const f2CandUpstreamSource = hasAllF2Upstream
    ? JSON.stringify({
        atomicProfile: resolvedAtomicPath,
        feedbackProfile: resolvedFbPath,
        strategyProfile: resolvedStratPath,
      })
    : "";

  const f2HeadRows: HeadObservationInputRow[] = [];
  const f2EpisodeRows: EpisodeOrTrajectoryRow[] = [];

  for (const partition of ["train", "development"] as const) {
    const partitionRole: PartitionRole =
      partition === "train" ? "train" : "development_diagnostic";
    for (const ep of sParts[partition]) {
      const hwCandidates = projectStrategyCandidates(ep.input, {
        profile: zeroStratProf,
        atomicProfile: handwiredAtomicProf,
        feedbackProfile: handwiredFbProf,
        registry: ep.registry,
        selection: ep.selection,
      });
      hwCandidates.forEach((cand, idx) => {
        f2HeadRows.push({
          rowId: `${ep.id}:hw:${idx}:${cand.skillId}`,
          unitId: "browser.strategy-policy.v1",
          headGroupId:
            "browser.strategy.candidate-2x10.handwired_reference_diagnostic",
          featureSchemaId: "browser.strategy.candidate.v1",
          expectedDimension: 10,
          projectionSource: "handwired_reference_diagnostic",
          upstreamProfileSource:
            "inline_handwired_atomic_and_feedback_reference_weights",
          features: cand.features,
          partition,
          partitionRole,
          sourceGroupId: ep.family,
          site: null,
          episodeOrTrajectoryId: ep.id,
          rowOutcome: "not_applicable_candidate_row",
        });
      });

      if (hasAllF2Upstream) {
        const pred = predictBrowserStrategy(ep.input, {
          profile: savedStratProfile!,
          atomicProfile: savedAtomicProfile!,
          feedbackProfile: savedFbProfile!,
          registry: ep.registry,
          selection: ep.selection,
        });
        pred.candidates.forEach((cand, idx) => {
          f2HeadRows.push({
            rowId: `${ep.id}:cand:${idx}:${cand.skillId}`,
            unitId: "browser.strategy-policy.v1",
            headGroupId: "browser.strategy.candidate-2x10.candidate_inference",
            featureSchemaId: "browser.strategy.candidate.v1",
            expectedDimension: 10,
            projectionSource: "candidate_inference",
            upstreamProfileSource: f2CandUpstreamSource,
            features: cand.features,
            partition,
            partitionRole,
            sourceGroupId: ep.family,
            site: null,
            episodeOrTrajectoryId: ep.id,
            rowOutcome: "not_applicable_candidate_row",
          });
        });
        const selected = pred.kind === "SELECT" ? pred.skillId : null;
        const passed = selected === ep.teacher.selectedSkillId;
        f2EpisodeRows.push({
          episodeOrTrajectoryId: ep.id,
          unitId: "browser.strategy-policy.v1",
          partition,
          partitionRole,
          sourceGroupId: ep.family,
          site: null,
          compositionTag: ep.family,
          episodeOutcome: passed ? "passed" : "failed",
          realTargetStatus: "not_available",
        });
      } else {
        f2EpisodeRows.push({
          episodeOrTrajectoryId: ep.id,
          unitId: "browser.strategy-policy.v1",
          partition,
          partitionRole,
          sourceGroupId: ep.family,
          site: null,
          compositionTag: ep.family,
          episodeOutcome: "not_available",
          realTargetStatus: "not_available",
        });
      }
    }
  }

  const f2Report = buildUnitCoverageReport({
    unitId: "browser.strategy-policy.v1",
    mode,
    samplingUnit: "candidate_row_clustered_by_decision_set",
    sourceClusterKey: "synthetic_family",
    targetBehaviorStatus: "static_forward_only",
    candidateInferenceStatus: hasAllF2Upstream ? "available" : "not_available",
    headRows: f2HeadRows,
    episodeRows: f2EpisodeRows,
  });

  return Object.freeze({
    schemaVersion: 1,
    mode,
    units: Object.freeze({
      "cli.command-policy.v1": cliCommandReport,
      "cli.path-controller.v1": cliPathReport,
      "dom.basic-kinds.v1": domReport,
      "browser.single-action-policy.v1": singleActionReport,
      "browser.action-feedback.v1": f1Report,
      "browser.strategy-policy.v1": f2Report,
    }),
  });
}
