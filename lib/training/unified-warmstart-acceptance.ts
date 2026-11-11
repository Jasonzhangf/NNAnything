import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  forwardUnified,
  type UnifiedTensors,
} from "./unified-forward.js";
import {
  epochLoss,
  type EncodedCandidate,
  type EncodedGroup,
} from "./group-loss.js";
import {
  aggregateFamilyLabel,
  familyLabelOfGold,
  requireSourceFamily,
  type FamilyLabelAggregation,
  type FamilyLabelAggregationRow,
  type FamilyLabelGoldLabel,
} from "./unified-evaluation-aggregation.js";
import {
  loadUnifiedModelPackageFromFile,
} from "./unified-model-package.js";
import {
  loadUnifiedTrainingCheckpointFromFile,
  type UnifiedTrainingCheckpoint,
} from "./unified-training-checkpoint.js";
import { monotonicSeconds } from "./unified-timing.js";

export const UNIFIED_WARMSTART_ACCEPTANCE_CONFIG_SCHEMA =
  "nnanything.unified.warmstart-acceptance-config.v1" as const;
export const UNIFIED_WARMSTART_ACCEPTANCE_REPORT_SCHEMA =
  "nnanything.unified.warmstart-acceptance-report.v1" as const;

export interface UnifiedWarmStartAcceptanceConfig {
  readonly schema: typeof UNIFIED_WARMSTART_ACCEPTANCE_CONFIG_SCHEMA;
  readonly rowsReportPath: string;
  readonly sourcePackagePath: string;
  readonly candidatePackagePath: string;
  readonly candidateCheckpointPath: string;
  readonly rawWarmStartReportPath: string;
  readonly tau: number;
}

export interface UnifiedWarmStartAcceptanceRequest {
  readonly commandStartNs: bigint;
  readonly startedAt: string;
  readonly route: Readonly<{
    readonly domain: string;
    readonly decisionKind: "R" | "D" | "E" | "A";
  }>;
  readonly phase: string;
  readonly encoderVersion: string;
  readonly outputDir: string;
  readonly warmstartAcceptance: UnifiedWarmStartAcceptanceConfig | undefined;
}

export type UnifiedWarmStartAcceptanceErrorCode =
  | "CONFIG_INVALID"
  | "WARMSTART_EVIDENCE_INVALID"
  | "WARMSTART_LINEAGE_INVALID"
  | "WARMSTART_EPOCH_ZERO_INVALID"
  | "WARMSTART_RAW_REPORT_INVALID"
  | "WARMSTART_TIMING_INVALID"
  | "WARMSTART_DECISION_FAILED"
  | "WARMSTART_AGGREGATION_INVALID";

interface WarmStartAcceptanceError {
  readonly code: UnifiedWarmStartAcceptanceErrorCode;
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

interface WarmStartGroupResult {
  readonly rowId: string;
  readonly sourceFamily: string;
  readonly partition: string;
  readonly gold: string;
  readonly goldLabel: FamilyLabelGoldLabel;
  readonly labelMissing: boolean;
  readonly allowed: readonly string[];
  readonly assessed: boolean;
  readonly loss: number | null;
  readonly previous: {
    readonly selected: string;
    readonly correct: boolean;
    readonly scores: readonly { readonly candidateRef: string; readonly score: number }[];
  };
  readonly candidate: {
    readonly selected: string;
    readonly correct: boolean;
    readonly scores: readonly { readonly candidateRef: string; readonly score: number }[];
  };
  readonly margin: number | null;
  readonly marginOk: boolean;
  readonly outcome:
    | "retained"
    | "fixed"
    | "regressed"
    | "still_incorrect"
    | "not_accepted_margin"
    | "unassessed";
}

export interface UnifiedWarmStartAcceptanceReport {
  readonly schema: typeof UNIFIED_WARMSTART_ACCEPTANCE_REPORT_SCHEMA;
  readonly runId: string;
  readonly command: "warmstart-acceptance";
  readonly route: UnifiedWarmStartAcceptanceRequest["route"];
  readonly phase: string;
  readonly encoderVersion: string;
  readonly status: "accepted" | "rejected";
  readonly passed: boolean;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly wallSeconds: number;
  readonly tau: number | null;
  readonly inputs: {
    readonly rowsReportPath: string | null;
    readonly sourcePackagePath: string | null;
    readonly candidatePackagePath: string | null;
    readonly candidateCheckpointPath: string | null;
    readonly rawWarmStartReportPath: string | null;
  };
  readonly sourcePackage: {
    readonly packagePath: string | null;
    readonly modelId: string | null;
    readonly version: string | null;
    readonly route: UnifiedWarmStartAcceptanceRequest["route"] | null;
    readonly encoderVersion: string | null;
  };
  readonly candidate: {
    readonly packagePath: string | null;
    readonly checkpointPath: string | null;
    readonly modelId: string | null;
    readonly version: string | null;
    readonly route: UnifiedWarmStartAcceptanceRequest["route"] | null;
    readonly encoderVersion: string | null;
    readonly completedEpochs: number | null;
  };
  readonly lineage: {
    readonly sourcePackagePathMatch: boolean;
    readonly sourceModelIdMatch: boolean;
    readonly sourceVersionMatch: boolean;
    readonly sourceRouteMatch: boolean;
    readonly sourceEncoderVersionMatch: boolean;
    readonly rawWarmStartCopyMatch: boolean;
    readonly epochZero: UnifiedTrainingCheckpoint["warmStart"] extends infer T
      ? T extends { readonly epochZero: infer E }
        ? E | null
        : null
      : null;
    readonly epochZeroExact: boolean;
    readonly epochZeroTensorEquality: boolean;
    readonly epochZeroCheckedInputsPositive: boolean;
    readonly epochZeroMaxAbsDeltaZero: boolean;
  };
  readonly execution: {
    readonly rawStatus: string | null;
    readonly trainStatus: string | null;
    readonly stopReason: string | null;
    readonly error: unknown;
    readonly rawRunSucceeded: boolean;
    readonly checkpointReloadMatches: boolean;
    readonly packageReloadMatches: boolean;
    readonly timingReceiptComplete: boolean;
    readonly failureReceiptPresent: boolean;
    readonly resumedFromEpoch: number | null;
    readonly resumeGateApplied: false;
  };
  readonly timing: unknown;
  readonly loss: {
    readonly recordedFinalLoss: number | null;
    readonly recomputedMeanLoss: number | null;
    readonly note: string;
  };
  readonly groups: readonly WarmStartGroupResult[];
  readonly aggregation: FamilyLabelAggregation;
  readonly error: WarmStartAcceptanceError | null;
  readonly paths: {
    readonly outputDir: string;
    readonly reportJsonPath: string;
    readonly reportMdPath: string;
  };
}

class WarmStartAcceptanceFailure extends Error {
  readonly code: UnifiedWarmStartAcceptanceErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(
    code: UnifiedWarmStartAcceptanceErrorCode,
    message: string,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "WarmStartAcceptanceFailure";
    this.code = code;
    this.detail = detail;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WarmStartAcceptanceFailure("CONFIG_INVALID", `${field} must be a non-empty string`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WarmStartAcceptanceFailure("CONFIG_INVALID", `${field} must be a finite number`);
  }
  return value;
}

async function readJson(path: string, label: string): Promise<unknown> {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new WarmStartAcceptanceFailure("WARMSTART_EVIDENCE_INVALID", `${label} is missing: ${resolved}`);
  }
  try {
    return JSON.parse(await readFile(resolved, "utf8")) as unknown;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    throw new WarmStartAcceptanceFailure(
      "WARMSTART_EVIDENCE_INVALID",
      `${label} is not valid JSON: ${message}`,
      { path: resolved },
    );
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new WarmStartAcceptanceFailure("WARMSTART_EVIDENCE_INVALID", `${label} must be an object`);
  }
  return value;
}

function sameRoute(
  left: { readonly domain: string; readonly decisionKind: string },
  right: { readonly domain: string; readonly decisionKind: string },
): boolean {
  return left.domain === right.domain && left.decisionKind === right.decisionKind;
}

function sameTensors(left: UnifiedTensors, right: UnifiedTensors): boolean {
  for (const key of ["W1", "b1", "W2", "b2", "W3", "b3"] as const) {
    if (left[key].length !== right[key].length) return false;
    for (let index = 0; index < left[key].length; index += 1) {
      if (left[key][index] !== right[key][index]) return false;
    }
  }
  return true;
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function validateEpochZero(receipt: unknown): {
  readonly receipt: NonNullable<UnifiedTrainingCheckpoint["warmStart"]>["epochZero"] | null;
  readonly exact: boolean;
  readonly tensorEquality: boolean;
  readonly checkedInputsPositive: boolean;
  readonly maxAbsDeltaZero: boolean;
} {
  if (!isRecord(receipt)) {
    return {
      receipt: null,
      exact: false,
      tensorEquality: false,
      checkedInputsPositive: false,
      maxAbsDeltaZero: false,
    };
  }
  const exact = receipt.exact === true;
  const tensorEquality = receipt.tensorEquality === true;
  const checkedInputsPositive = typeof receipt.checkedInputs === "number"
    && Number.isInteger(receipt.checkedInputs)
    && receipt.checkedInputs > 0;
  const maxAbsDeltaZero = receipt.maxAbsDelta === 0;
  return {
    receipt: exact && tensorEquality && checkedInputsPositive && maxAbsDeltaZero
      ? {
          exact: true,
          tensorEquality: true,
          checkedInputs: receipt.checkedInputs as number,
          maxAbsDelta: 0,
        }
      : null,
    exact,
    tensorEquality,
    checkedInputsPositive,
    maxAbsDeltaZero,
  };
}

function validateTimingReceipt(rawReport: Record<string, unknown>): {
  readonly complete: boolean;
  readonly detail: string | null;
} {
  const thisRun = isRecord(rawReport.thisRun) ? rawReport.thisRun : null;
  if (thisRun === null) return { complete: false, detail: "raw report has no thisRun timing receipt" };
  const checkpointIo = isRecord(thisRun.checkpointIoSecs) ? thisRun.checkpointIoSecs : null;
  const numericFields = [
    ["loadSeconds", thisRun.loadSeconds],
    ["dataValidationSeconds", thisRun.dataValidationSeconds],
    ["optimizationSeconds", thisRun.optimizationSeconds],
    ["totalWallSeconds", thisRun.totalWallSeconds],
  ] as const;
  for (const [name, value] of numericFields) {
    if (!finiteNonnegative(value)) {
      return { complete: false, detail: `thisRun.${name} must be a nonnegative finite number` };
    }
  }
  if (checkpointIo === null) {
    return { complete: false, detail: "thisRun.checkpointIoSecs must be an object" };
  }
  for (const field of ["serializeSeconds", "atomicReplaceSeconds", "packageReloadSeconds", "totalSeconds"] as const) {
    if (!finiteNonnegative(checkpointIo[field])) {
      return { complete: false, detail: `thisRun.checkpointIoSecs.${field} must be a nonnegative finite number` };
    }
  }
  for (const field of [
    "attemptOptimizerSteps",
    "attemptProcessedRows",
    "completedOptimizerSteps",
    "completedProcessedRows",
  ] as const) {
    if (!nonnegativeInteger(thisRun[field])) {
      return { complete: false, detail: `thisRun.${field} must be a nonnegative integer` };
    }
  }
  if (!(thisRun.rowsPerSecond === null || finiteNonnegative(thisRun.rowsPerSecond))) {
    return { complete: false, detail: "thisRun.rowsPerSecond must be null or a nonnegative finite number" };
  }
  if (!(thisRun.throughputDenominator === null || typeof thisRun.throughputDenominator === "string")) {
    return { complete: false, detail: "thisRun.throughputDenominator must be null or a string" };
  }
  if (!(thisRun.evaluationSeconds === null || finiteNonnegative(thisRun.evaluationSeconds))) {
    return { complete: false, detail: "thisRun.evaluationSeconds must be null or a nonnegative finite number" };
  }
  if (thisRun.cumulative !== undefined && thisRun.cumulative !== null) {
    const cumulative = isRecord(thisRun.cumulative) ? thisRun.cumulative : null;
    if (cumulative === null) return { complete: false, detail: "thisRun.cumulative must be an object or null" };
    for (const field of ["loadSeconds", "dataValidationSeconds", "optimizationSeconds", "totalWallSeconds"] as const) {
      if (!finiteNonnegative(cumulative[field])) {
        return { complete: false, detail: `thisRun.cumulative.${field} must be a nonnegative finite number` };
      }
    }
    for (const field of ["optimizerSteps", "processedRows"] as const) {
      if (!nonnegativeInteger(cumulative[field])) {
        return { complete: false, detail: `thisRun.cumulative.${field} must be a nonnegative integer` };
      }
    }
  }
  return { complete: true, detail: null };
}

export function scoresOf(
  group: EncodedGroup,
  tensors: UnifiedTensors,
): readonly { readonly candidateRef: string; readonly score: number }[] {
  return group.candidates
    .map(candidate => ({
      candidateRef: candidate.candidateRef,
      score: forwardUnified(candidate.input, tensors).score,
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.candidateRef < right.candidateRef ? -1 : left.candidateRef > right.candidateRef ? 1 : 0;
    });
}

export function selectedCandidate(scores: readonly { readonly candidateRef: string; readonly score: number }[]): string {
  if (scores.length === 0) {
    throw new WarmStartAcceptanceFailure("WARMSTART_EVIDENCE_INVALID", "candidate score set is empty");
  }
  return scores[0]!.candidateRef;
}

function classifyGroup(
  previousScores: readonly { readonly candidateRef: string; readonly score: number }[],
  candidateScores: readonly { readonly candidateRef: string; readonly score: number }[],
  goldCandidateRef: string | null,
  tau: number,
): {
  readonly previousSelected: string;
  readonly candidateSelected: string;
  readonly previousCorrect: boolean;
  readonly candidateCorrect: boolean;
  readonly margin: number | null;
  readonly marginOk: boolean;
  readonly outcome: WarmStartGroupResult["outcome"];
} {
  const previousSelected = selectedCandidate(previousScores);
  const candidateSelected = selectedCandidate(candidateScores);
  if (goldCandidateRef === null) {
    return {
      previousSelected,
      candidateSelected,
      previousCorrect: false,
      candidateCorrect: false,
      margin: null,
      marginOk: false,
      outcome: "unassessed",
    };
  }
  const goldScore = candidateScores.find(entry => entry.candidateRef === goldCandidateRef);
  if (goldScore === undefined) {
    throw new WarmStartAcceptanceFailure(
      "WARMSTART_EVIDENCE_INVALID",
      `gold candidate ${goldCandidateRef} is missing from candidate scores`,
    );
  }
  const nonGold = candidateScores.filter(entry => entry.candidateRef !== goldCandidateRef);
  if (nonGold.length === 0) {
    throw new WarmStartAcceptanceFailure(
      "WARMSTART_EVIDENCE_INVALID",
      `group for gold candidate ${goldCandidateRef} has no non-gold candidate`,
    );
  }
  const margin = goldScore.score - Math.max(...nonGold.map(entry => entry.score));
  const previousCorrect = previousSelected === goldCandidateRef;
  const candidateCorrect = candidateSelected === goldCandidateRef;
  const marginOk = candidateCorrect && margin >= tau;
  const outcome: WarmStartGroupResult["outcome"] =
    previousCorrect && !candidateCorrect
      ? "regressed"
      : !previousCorrect && !candidateCorrect
        ? "still_incorrect"
        : candidateCorrect && !marginOk
          ? "not_accepted_margin"
          : !previousCorrect && marginOk
            ? "fixed"
            : "retained";
  return {
    previousSelected,
    candidateSelected,
    previousCorrect,
    candidateCorrect,
    margin,
    marginOk,
    outcome,
  };
}

function asGroup(
  row: Record<string, unknown>,
): {
  readonly group: EncodedGroup;
  readonly rowId: string;
  readonly gold: string;
  readonly labelMissing: boolean;
  readonly partition: string;
  readonly sourceFamily: string;
  readonly goldCandidateRef: string | null;
} {
  const rowId = requireString(row.rowId, "rows-report row.rowId");
  const candidateInputs = Array.isArray(row.candidateInputs) ? row.candidateInputs : null;
  if (candidateInputs === null || candidateInputs.length === 0) {
    throw new WarmStartAcceptanceFailure(
      "WARMSTART_EVIDENCE_INVALID",
      `rows-report row ${rowId} has no candidateInputs`,
    );
  }
  const candidates: EncodedCandidate[] = candidateInputs.map((raw, index) => {
    const candidate = requireRecord(raw, `rows-report row ${rowId} candidateInputs[${index}]`);
    const candidateRef = requireString(candidate.candidateRef, `rows-report row ${rowId} candidateRef`);
    const input = candidate.input;
    if (!Array.isArray(input) || input.length !== 64 || !input.every(value => typeof value === "number" && Number.isFinite(value))) {
      throw new WarmStartAcceptanceFailure(
        "WARMSTART_EVIDENCE_INVALID",
        `rows-report row ${rowId} candidate ${candidateRef} input must have 64 finite values`,
      );
    }
    return {
      candidateRef,
      input: input as readonly number[],
      optionSemantics: "",
      candidateKind: "control" as const,
    };
  });
  const allowed = Array.isArray(row.allowed) && row.allowed.every(entry => typeof entry === "string")
    ? row.allowed as readonly string[]
    : [];
  if (allowed.length === 0) {
    throw new WarmStartAcceptanceFailure(
      "WARMSTART_EVIDENCE_INVALID",
      `rows-report row ${rowId} has no allowed candidates`,
    );
  }
  const gold = requireString(row.gold, `rows-report row ${rowId}.gold`);
  const labelMissing = row.labelMissing === true;
  const knownLabels = candidates.flatMap(candidate => {
    try {
      const label = familyLabelOfGold(candidate.candidateRef);
      return [{ candidateRef: candidate.candidateRef, label }];
    } catch {
      return [];
    }
  });
  const requestedLabel = familyLabelOfGold(gold);
  const exactGoldCandidateRef = candidates.some(candidate => candidate.candidateRef === gold)
    ? gold
    : null;
  const labelCandidateRef = requestedLabel === "non_relation"
    ? null
    : knownLabels.find(entry => entry.label === requestedLabel)?.candidateRef ?? null;
  const goldCandidateRef = labelMissing
    ? null
    : exactGoldCandidateRef ?? labelCandidateRef;
  if (!labelMissing && goldCandidateRef === null) {
    throw new WarmStartAcceptanceFailure(
      "WARMSTART_EVIDENCE_INVALID",
      `rows-report row ${rowId} gold ${gold} is not present in candidateInputs`,
    );
  }
  return {
    group: {
      groupRef: rowId,
      candidates,
      allowedCandidateRefs: allowed,
    },
    rowId,
    gold,
    labelMissing,
    partition: typeof row.partition === "string" ? row.partition : "unknown",
    sourceFamily: requireSourceFamily(row.sourceGroup ?? row.sourceFamily ?? row.family, rowId),
    goldCandidateRef,
  };
}

function buildReport(
  request: UnifiedWarmStartAcceptanceRequest,
  runId: string,
  paths: UnifiedWarmStartAcceptanceReport["paths"],
  input: {
    readonly status: "accepted" | "rejected";
    readonly tau: number | null;
    readonly inputs: UnifiedWarmStartAcceptanceReport["inputs"];
    readonly sourcePackage: UnifiedWarmStartAcceptanceReport["sourcePackage"];
    readonly candidate: UnifiedWarmStartAcceptanceReport["candidate"];
    readonly lineage: UnifiedWarmStartAcceptanceReport["lineage"];
    readonly execution: UnifiedWarmStartAcceptanceReport["execution"];
    readonly timing: unknown;
    readonly loss: UnifiedWarmStartAcceptanceReport["loss"];
    readonly groups: readonly WarmStartGroupResult[];
    readonly aggregation: FamilyLabelAggregation;
    readonly error: WarmStartAcceptanceError | null;
  },
): UnifiedWarmStartAcceptanceReport {
  return {
    schema: UNIFIED_WARMSTART_ACCEPTANCE_REPORT_SCHEMA,
    runId,
    command: "warmstart-acceptance",
    route: request.route,
    phase: request.phase,
    encoderVersion: request.encoderVersion,
    status: input.status,
    passed: input.status === "accepted",
    startedAt: request.startedAt,
    endedAt: new Date().toISOString(),
    wallSeconds: monotonicSeconds(request.commandStartNs),
    tau: input.tau,
    inputs: input.inputs,
    sourcePackage: input.sourcePackage,
    candidate: input.candidate,
    lineage: input.lineage,
    execution: input.execution,
    timing: input.timing,
    loss: input.loss,
    groups: input.groups,
    aggregation: input.aggregation,
    error: input.error,
    paths,
  };
}

function formatMarkdown(report: UnifiedWarmStartAcceptanceReport): string {
  const lines = [
    `# Warmstart Acceptance Report (${report.runId})`,
    "",
    `- Status: \`${report.status}\``,
    `- Route: \`${report.route.domain}/${report.route.decisionKind}\``,
    `- Tau: \`${String(report.tau)}\``,
    `- Source Package: \`${String(report.sourcePackage.packagePath)}\``,
    `- Candidate Package: \`${String(report.candidate.packagePath)}\``,
    `- Candidate Checkpoint: \`${String(report.candidate.checkpointPath)}\``,
    `- Raw Stop Reason: \`${String(report.execution.stopReason)}\``,
    `- Groups: \`${report.groups.length}\``,
    `- Aggregation Rows: \`${report.aggregation.rowCount}\``,
    `- Machine Detail: \`${report.paths.reportJsonPath}\``,
    "",
  ];
  if (report.error !== null) {
    lines.push("## Error", "", "```json", JSON.stringify(report.error, null, 2), "```", "");
  }
  lines.push("## Family/Label Aggregation", "");
  for (const bucket of report.aggregation.buckets) {
    lines.push(
      `- ${bucket.sourceFamily} / ${bucket.goldLabel}: rows=${bucket.rowCount} `
      + `loss=${bucket.loss === null ? "n/a" : bucket.loss.mean.toFixed(6)} `
      + `decision=${JSON.stringify(bucket.decision.outcomeCounts)}`,
    );
  }
  lines.push("", "## Group Decisions", "");
  for (const group of report.groups) {
    lines.push(
      `- ${group.rowId}: family=${group.sourceFamily} label=${group.goldLabel} `
      + `selected=${group.candidate.selected} margin=${group.margin === null ? "n/a" : group.margin.toFixed(6)} `
      + `outcome=${group.outcome}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function runUnifiedWarmStartAcceptance(
  request: UnifiedWarmStartAcceptanceRequest,
): Promise<{
  readonly exitCode: number;
  readonly report: UnifiedWarmStartAcceptanceReport;
  readonly markdown: string;
}> {
  const runId = `warmstart-acceptance-${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const outputDir = resolve(request.outputDir);
  const paths = {
    outputDir,
    reportJsonPath: join(outputDir, "runs", runId, "run-report.json"),
    reportMdPath: join(outputDir, "runs", runId, "run-report.md"),
  };
  const config = request.warmstartAcceptance;
  const baselineInputs = {
    rowsReportPath: config?.rowsReportPath === undefined ? null : resolve(config.rowsReportPath),
    sourcePackagePath: config?.sourcePackagePath === undefined ? null : resolve(config.sourcePackagePath),
    candidatePackagePath: config?.candidatePackagePath === undefined ? null : resolve(config.candidatePackagePath),
    candidateCheckpointPath: config?.candidateCheckpointPath === undefined ? null : resolve(config.candidateCheckpointPath),
    rawWarmStartReportPath: config?.rawWarmStartReportPath === undefined ? null : resolve(config.rawWarmStartReportPath),
  };
  const baselineSource: UnifiedWarmStartAcceptanceReport["sourcePackage"] = {
    packagePath: baselineInputs.sourcePackagePath,
    modelId: null,
    version: null,
    route: null,
    encoderVersion: null,
  };
  const baselineCandidate: UnifiedWarmStartAcceptanceReport["candidate"] = {
    packagePath: baselineInputs.candidatePackagePath,
    checkpointPath: baselineInputs.candidateCheckpointPath,
    modelId: null,
    version: null,
    route: null,
    encoderVersion: null,
    completedEpochs: null,
  };
  const baselineLineage: UnifiedWarmStartAcceptanceReport["lineage"] = {
    sourcePackagePathMatch: false,
    sourceModelIdMatch: false,
    sourceVersionMatch: false,
    sourceRouteMatch: false,
    sourceEncoderVersionMatch: false,
    rawWarmStartCopyMatch: false,
    epochZero: null,
    epochZeroExact: false,
    epochZeroTensorEquality: false,
    epochZeroCheckedInputsPositive: false,
    epochZeroMaxAbsDeltaZero: false,
  };
  const baselineExecution: UnifiedWarmStartAcceptanceReport["execution"] = {
    rawStatus: null,
    trainStatus: null,
    stopReason: null,
    error: null,
    rawRunSucceeded: false,
    checkpointReloadMatches: false,
    packageReloadMatches: false,
    timingReceiptComplete: false,
    failureReceiptPresent: false,
    resumedFromEpoch: null,
    resumeGateApplied: false,
  };
  const emptyAggregation = aggregateFamilyLabel([]);

  const finalize = (
    status: "accepted" | "rejected",
    input: {
      readonly tau?: number | null;
      readonly sourcePackage?: UnifiedWarmStartAcceptanceReport["sourcePackage"];
      readonly candidate?: UnifiedWarmStartAcceptanceReport["candidate"];
      readonly lineage?: UnifiedWarmStartAcceptanceReport["lineage"];
      readonly execution?: UnifiedWarmStartAcceptanceReport["execution"];
      readonly timing?: unknown;
      readonly loss?: UnifiedWarmStartAcceptanceReport["loss"];
      readonly groups?: readonly WarmStartGroupResult[];
      readonly aggregation?: FamilyLabelAggregation;
      readonly error?: WarmStartAcceptanceError | null;
    },
  ): { readonly exitCode: number; readonly report: UnifiedWarmStartAcceptanceReport; readonly markdown: string } => {
    const report = buildReport(request, runId, paths, {
      status,
      tau: input.tau ?? config?.tau ?? null,
      inputs: baselineInputs,
      sourcePackage: input.sourcePackage ?? baselineSource,
      candidate: input.candidate ?? baselineCandidate,
      lineage: input.lineage ?? baselineLineage,
      execution: input.execution ?? baselineExecution,
      timing: input.timing ?? null,
      loss: input.loss ?? {
        recordedFinalLoss: null,
        recomputedMeanLoss: null,
        note: "recordedFinalLoss is the runner's pre-update epoch value; recomputedMeanLoss is a post-update forward on the saved candidate tensors.",
      },
      groups: input.groups ?? [],
      aggregation: input.aggregation ?? emptyAggregation,
      error: input.error ?? null,
    });
    return { exitCode: status === "accepted" ? 0 : 1, report, markdown: formatMarkdown(report) };
  };

  try {
    if (config === undefined) {
      throw new WarmStartAcceptanceFailure("CONFIG_INVALID", "warmstart-acceptance requires config.warmstartAcceptance");
    }
    if (config.schema !== UNIFIED_WARMSTART_ACCEPTANCE_CONFIG_SCHEMA) {
      throw new WarmStartAcceptanceFailure("CONFIG_INVALID", "config.warmstartAcceptance.schema is not supported");
    }
    const rowsReportPath = requireString(config.rowsReportPath, "config.warmstartAcceptance.rowsReportPath");
    const sourcePackagePath = requireString(config.sourcePackagePath, "config.warmstartAcceptance.sourcePackagePath");
    const candidatePackagePath = requireString(config.candidatePackagePath, "config.warmstartAcceptance.candidatePackagePath");
    const candidateCheckpointPath = requireString(config.candidateCheckpointPath, "config.warmstartAcceptance.candidateCheckpointPath");
    const rawWarmStartReportPath = requireString(config.rawWarmStartReportPath, "config.warmstartAcceptance.rawWarmStartReportPath");
    const tau = requireNumber(config.tau, "config.warmstartAcceptance.tau");
    if (tau !== 0.1) {
      throw new WarmStartAcceptanceFailure("CONFIG_INVALID", `config.warmstartAcceptance.tau must be the fixed 0.1 margin, got ${tau}`);
    }

    const loadedSource = await loadUnifiedModelPackageFromFile(sourcePackagePath);
    const loadedCandidate = await loadUnifiedModelPackageFromFile(candidatePackagePath);
    const checkpoint = await loadUnifiedTrainingCheckpointFromFile(candidateCheckpointPath);
    const rowsReportRaw = await readJson(rowsReportPath, "rows report");
    const rawReportRaw = await readJson(rawWarmStartReportPath, "raw warmstart report");
    const rowsReport = requireRecord(rowsReportRaw, "rows report");
    const rawReport = requireRecord(rawReportRaw, "raw warmstart report");
    const dataGate = requireRecord(rowsReport.dataGate, "rows report dataGate");
    const rows = Array.isArray(dataGate.rows) ? dataGate.rows : null;
    if (rows === null || rows.length === 0) {
      throw new WarmStartAcceptanceFailure("WARMSTART_EVIDENCE_INVALID", "rows report has no dataGate.rows");
    }

    const warmStart = checkpoint.warmStart;
    if (warmStart === undefined) {
      throw new WarmStartAcceptanceFailure("WARMSTART_LINEAGE_INVALID", "candidate checkpoint has no warmStart lineage");
    }
    const epochZeroValidation = validateEpochZero(warmStart.epochZero);
    const sourcePackage = loadedSource.package;
    const lineage = {
      sourcePackagePathMatch: resolve(warmStart.sourcePackagePath) === loadedSource.packagePath,
      sourceModelIdMatch: warmStart.sourceModelId === sourcePackage.modelId,
      sourceVersionMatch: warmStart.sourceVersion === sourcePackage.version,
      sourceRouteMatch: sameRoute(warmStart.sourceRoute, sourcePackage.route),
      sourceEncoderVersionMatch: warmStart.sourceEncoderVersion === sourcePackage.encoderVersion,
      rawWarmStartCopyMatch: false,
      epochZero: epochZeroValidation.receipt,
      epochZeroExact: epochZeroValidation.exact,
      epochZeroTensorEquality: epochZeroValidation.tensorEquality,
      epochZeroCheckedInputsPositive: epochZeroValidation.checkedInputsPositive,
      epochZeroMaxAbsDeltaZero: epochZeroValidation.maxAbsDeltaZero,
    };
    if (
      !lineage.sourcePackagePathMatch
      || !lineage.sourceModelIdMatch
      || !lineage.sourceVersionMatch
      || !lineage.sourceRouteMatch
      || !lineage.sourceEncoderVersionMatch
    ) {
      throw new WarmStartAcceptanceFailure(
        "WARMSTART_LINEAGE_INVALID",
        "source package metadata does not match checkpoint warmStart lineage",
        { lineage },
      );
    }
    if (epochZeroValidation.receipt === null) {
      throw new WarmStartAcceptanceFailure(
        "WARMSTART_EPOCH_ZERO_INVALID",
        "checkpoint warmStart epoch-zero receipt is incomplete",
        { epochZero: warmStart.epochZero },
      );
    }

    const candidatePackage = loadedCandidate.package;
    if (
      candidatePackage.modelId !== checkpoint.modelId
      || candidatePackage.version !== checkpoint.version
      || !sameRoute(candidatePackage.route, checkpoint.route)
      || candidatePackage.inputSchema !== checkpoint.inputSchema
      || candidatePackage.encoderVersion !== checkpoint.encoderVersion
      || JSON.stringify(candidatePackage.architecture) !== JSON.stringify(checkpoint.architecture)
      || !sameTensors(candidatePackage.tensors, checkpoint.tensors)
    ) {
      throw new WarmStartAcceptanceFailure(
        "WARMSTART_LINEAGE_INVALID",
        "candidate package metadata or tensors do not match the candidate checkpoint",
      );
    }
    const checkpointResourcesMatch =
      resolve(checkpoint.resources.thresholdsRef) === loadedCandidate.resolvedResources.thresholdsPath
      && resolve(checkpoint.resources.missingModeTableRef) === loadedCandidate.resolvedResources.missingModeTablePath
      && (checkpoint.resources.slotMapRef === undefined
        ? loadedCandidate.resolvedResources.slotMapPath === null
        : resolve(checkpoint.resources.slotMapRef) === loadedCandidate.resolvedResources.slotMapPath);
    if (!checkpointResourcesMatch) {
      throw new WarmStartAcceptanceFailure(
        "WARMSTART_LINEAGE_INVALID",
        "candidate package resolved resources do not match the candidate checkpoint",
      );
    }

    const rawWarmStart = isRecord(rawReport.warmStart) ? rawReport.warmStart : null;
    const rawWarmStartCopyMatch = rawWarmStart !== null
      && typeof rawWarmStart.sourcePackagePath === "string"
      && resolve(rawWarmStart.sourcePackagePath) === loadedSource.packagePath
      && rawWarmStart.sourceModelId === warmStart.sourceModelId
      && rawWarmStart.sourceVersion === warmStart.sourceVersion
      && JSON.stringify(rawWarmStart.epochZero) === JSON.stringify(warmStart.epochZero)
      && rawWarmStart.initializer === "inherited_package"
      && rawWarmStart.inheritanceSource === "source_package"
      && rawWarmStart.sourcePackageLoadedThisRun === true
      && finiteNonnegative(rawWarmStart.sourcePackageLoadSeconds);
    lineage.rawWarmStartCopyMatch = rawWarmStartCopyMatch;
    if (!rawWarmStartCopyMatch) {
      throw new WarmStartAcceptanceFailure(
        "WARMSTART_RAW_REPORT_INVALID",
        "raw warmstart report does not carry the checkpoint's actual warmstart lineage and epoch-zero receipt",
        { rawWarmStart: rawReport.warmStart ?? null },
      );
    }

    const failureReceiptPresent = Object.prototype.hasOwnProperty.call(rawReport, "error");
    const rawStatus = typeof rawReport.status === "string" ? rawReport.status : null;
    const trainReport = isRecord(rawReport.trainReport) ? rawReport.trainReport : null;
    const trainStatus = typeof trainReport?.status === "string" ? trainReport.status : null;
    const stopReason = typeof rawReport.stopReason === "string"
      ? rawReport.stopReason
      : typeof trainReport?.stopReason === "string"
        ? trainReport.stopReason
        : null;
    const rawRunSucceeded = rawStatus === "completed"
      && trainStatus === "completed"
      && stopReason !== null
      && rawReport.error === null
      && failureReceiptPresent;
    if (!rawRunSucceeded) {
      throw new WarmStartAcceptanceFailure(
        "WARMSTART_RAW_REPORT_INVALID",
        "raw warmstart report is not a completed run with a null failure receipt",
        { status: rawStatus, trainStatus, stopReason, error: rawReport.error ?? null },
      );
    }

    const checkpointReload = isRecord(rawReport.checkpointReload) ? rawReport.checkpointReload : null;
    const packageReload = isRecord(rawReport.packageReload) ? rawReport.packageReload : null;
    const checkpointReloadMatches = checkpointReload !== null
      && typeof checkpointReload.checkpointPath === "string"
      && resolve(checkpointReload.checkpointPath) === resolve(candidateCheckpointPath)
      && checkpointReload.tensorsMatch === true
      && checkpointReload.completedEpochs === checkpoint.completedEpochs
      && checkpointReload.epochRecordCount === checkpoint.epochRecords.length;
    const packageReloadMatches = packageReload !== null
      && typeof packageReload.packagePath === "string"
      && resolve(packageReload.packagePath) === resolve(candidatePackagePath)
      && packageReload.tensorsMatch === true
      && packageReload.modelId === candidatePackage.modelId
      && packageReload.version === candidatePackage.version;
    if (!checkpointReloadMatches || !packageReloadMatches) {
      throw new WarmStartAcceptanceFailure(
        "WARMSTART_RAW_REPORT_INVALID",
        "raw warmstart report is missing matching checkpoint or package reload receipts",
        { checkpointReload: rawReport.checkpointReload ?? null, packageReload: rawReport.packageReload ?? null },
      );
    }

    const timingValidation = validateTimingReceipt(rawReport);
    if (!timingValidation.complete) {
      throw new WarmStartAcceptanceFailure(
        "WARMSTART_TIMING_INVALID",
        timingValidation.detail ?? "raw warmstart report timing receipt is incomplete",
      );
    }

    const rowMetadata: {
      readonly group: EncodedGroup;
      readonly rowId: string;
      readonly gold: string;
      readonly labelMissing: boolean;
      readonly partition: string;
      readonly sourceFamily: string;
      readonly goldCandidateRef: string | null;
    }[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = requireRecord(rows[index], `rows-report dataGate.rows[${index}]`);
      const mapped = asGroup(row);
      rowMetadata.push(mapped);
    }

    const supervisedGroups = rowMetadata
      .filter(row => !row.labelMissing)
      .map(row => row.group);
    const candidateLosses = supervisedGroups.length === 0
      ? new Map<string, number>()
      : new Map(
          epochLoss(supervisedGroups, checkpoint.tensors)
            .groupLosses.map(entry => [entry.groupRef, entry.loss]),
        );
    const groupResults = rowMetadata.map(row => {
      const previousScores = scoresOf(row.group, loadedSource.package.tensors);
      const candidateScores = scoresOf(row.group, checkpoint.tensors);
      const classification = classifyGroup(previousScores, candidateScores, row.goldCandidateRef, tau);
      const candidateLoss = candidateLosses.get(row.rowId);
      if (!row.labelMissing && (candidateLoss === undefined || !Number.isFinite(candidateLoss))) {
        throw new WarmStartAcceptanceFailure(
          "WARMSTART_EVIDENCE_INVALID",
          `no candidate loss was computed for group ${row.rowId}`,
        );
      }
      const loss = row.labelMissing ? null : candidateLoss!;
      return {
        rowId: row.rowId,
        sourceFamily: row.sourceFamily,
        partition: row.partition,
        gold: row.gold,
        goldLabel: familyLabelOfGold(row.gold),
        labelMissing: row.labelMissing,
        allowed: row.group.allowedCandidateRefs,
        assessed: row.goldCandidateRef !== null,
        loss,
        previous: {
          selected: classification.previousSelected,
          correct: classification.previousCorrect,
          scores: previousScores,
        },
        candidate: {
          selected: classification.candidateSelected,
          correct: classification.candidateCorrect,
          scores: candidateScores,
        },
        margin: classification.margin,
        marginOk: classification.marginOk,
        outcome: classification.outcome,
      } satisfies WarmStartGroupResult;
    });
    const assessedGroups = groupResults.filter(group => group.assessed);
    const semanticMarginPassed = assessedGroups.length > 0
      && assessedGroups.every(group => group.candidate.correct && group.marginOk);
    const aggregationRows: FamilyLabelAggregationRow[] = groupResults.map(group => ({
      rowRef: group.rowId,
      sourceFamily: group.sourceFamily,
      goldLabel: group.goldLabel,
      loss: group.loss,
      decision: {
        selected: group.candidate.selected,
        correct: group.assessed ? group.candidate.correct : null,
        margin: group.margin,
        marginOk: group.marginOk,
        outcome: group.outcome,
      },
    }));
    const aggregation = aggregateFamilyLabel(aggregationRows);
    const execution = {
      rawStatus,
      trainStatus,
      stopReason,
      error: rawReport.error ?? null,
      rawRunSucceeded,
      checkpointReloadMatches,
      packageReloadMatches,
      timingReceiptComplete: timingValidation.complete,
      failureReceiptPresent,
      resumedFromEpoch: typeof rawReport.resumedFromEpoch === "number" ? rawReport.resumedFromEpoch : null,
      resumeGateApplied: false as const,
    };
    const candidateReport: UnifiedWarmStartAcceptanceReport["candidate"] = {
      packagePath: loadedCandidate.packagePath,
      checkpointPath: resolve(candidateCheckpointPath),
      modelId: candidatePackage.modelId,
      version: candidatePackage.version,
      route: candidatePackage.route,
      encoderVersion: candidatePackage.encoderVersion,
      completedEpochs: checkpoint.completedEpochs,
    };
    const sourceReport: UnifiedWarmStartAcceptanceReport["sourcePackage"] = {
      packagePath: loadedSource.packagePath,
      modelId: sourcePackage.modelId,
      version: sourcePackage.version,
      route: sourcePackage.route,
      encoderVersion: sourcePackage.encoderVersion,
    };
    const rawThisRun = isRecord(rawReport.thisRun) ? rawReport.thisRun : null;
    const timing = {
      thisRun: rawThisRun,
      cumulative: rawReport.cumulative ?? null,
      checkpointIoSecs: rawThisRun?.checkpointIoSecs ?? null,
    };
    const loss = {
      recordedFinalLoss: typeof trainReport?.finalLoss === "number"
        ? trainReport.finalLoss
        : typeof rawReport.finalLoss === "number"
          ? rawReport.finalLoss
          : null,
      recomputedMeanLoss: supervisedGroups.length === 0
        ? null
        : [...candidateLosses.values()].reduce((sum, value) => sum + value, 0)
          / candidateLosses.size,
      note: "recordedFinalLoss is the runner's pre-update epoch value; recomputedMeanLoss is a post-update forward on the saved candidate tensors.",
    };

    if (!semanticMarginPassed) {
      return finalize("rejected", {
        tau,
        sourcePackage: sourceReport,
        candidate: candidateReport,
        lineage,
        execution,
        timing,
        loss,
        groups: groupResults,
        aggregation,
        error: {
          code: "WARMSTART_DECISION_FAILED",
          message: "at least one assessed singleton-gold group did not satisfy the fixed tau=0.1 decision margin",
          detail: { assessedGroups: assessedGroups.length, outcomes: groupResults.map(group => group.outcome) },
        },
      });
    }
    return finalize("accepted", {
      tau,
      sourcePackage: sourceReport,
      candidate: candidateReport,
      lineage,
      execution,
      timing,
      loss,
      groups: groupResults,
      aggregation,
      error: null,
    });
  } catch (caught) {
    const error = caught instanceof WarmStartAcceptanceFailure
      ? { code: caught.code, message: caught.message, ...(Object.keys(caught.detail).length === 0 ? {} : { detail: caught.detail }) }
      : {
          code: "WARMSTART_EVIDENCE_INVALID" as const,
          message: caught instanceof Error ? caught.message : String(caught),
        };
    return finalize("rejected", { error });
  }
}
