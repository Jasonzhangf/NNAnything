#!/usr/bin/env node
/**
 * Standard L2 training, data-validation, resume, evaluation, and sample-migration
 * runner (`validate-data | train | resume | evaluate | convert-samples`).
 *
 * Contract:
 * - Single shared runner across heads (`R | D | E | A`); no per-head copied `fit.py`.
 * - Pre-optimizer data gate (`validateStandardTrainingData`) runs before any device
 *   load or optimizer creation. `DATA_INVALID` exits non-zero with 0 steps and no
 *   candidate. `NO_LEARNED_ROWS` exits with 0 steps, no candidate, and preserves
 *   fixed rows.
 * - Reuses `runBackendFit` (`lib/training/l2-mlp-backend.ts` + `l2-gpu-bridge.py`),
 *   whose current supported optimizer is `full_batch_sgd` (`momentum: 0`). Reports
 *   this recipe explicitly and never claims silent equivalence with historical
 *   external `Adam` scripts.
 * - Every run (including failed, cancelled, resumed, and validation/evaluation-only
 *   runs) emits machine-readable `run-report.json` and human-readable `run-report.md`.
 */

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { L2_HEADS } from "../adapters/l2/contracts.js";
import type {
  L2ComputeBackend,
  L2Head,
  L2TrainingEvent,
} from "../adapters/l2/contracts.js";
import {
  createHybridPackageResource,
  loadHybridPackageFromFile,
  saveHybridPackageAtomic,
  withUpdatedHeadParameters,
  type HybridPackageResource,
} from "./l2-hybrid-package.js";
import { readL2Checkpoint, runBackendFit } from "./l2-mlp-backend.js";
import {
  convertSamplesToUnifiedJsonl,
  validateStandardTrainingData,
  type DataGateValidationResult,
  type DataInvalidViolation,
  type StandardDataSourceDecl,
} from "./l2-standard-data-gate.js";
import {
  UNIFIED_DATA_ROW_SCHEMA,
  validateUnified64SlotTrainingData,
  type UnifiedDataGateConfig,
  type UnifiedDataGateResult,
  type UnifiedDataGateRow,
  type UnifiedDataGateViolation,
} from "./unified-data-gate.js";
import {
  UNIFIED_STUDENT_ROW_SCHEMA,
  convertEpisodeToStudentGroup,
  loadEpisodeFamily,
  type StudentGroup,
} from "./unified-student-converter.js";
import {
  convertGoldToSupervisionRow,
  loadGoldFamily,
  type SupervisionRow,
} from "./unified-supervision-converter.js";
import {
  UNIFIED_TRAIN_CONFIG_SCHEMA,
  buildEncodedGroups,
  loadStudentRowsFile,
  loadSupervisionRowsFile,
  runUnifiedTraining,
  saveUnifiedTrainPackage,
  UnifiedTrainDataError,
  type UnifiedPackageReloadReceipt,
  type UnifiedTrainConfig,
  type UnifiedTrainReport,
} from "./unified-train-config.js";
import type { UnifiedModelPackage } from "./unified-model-package.js";

const execFileAsync = promisify(execFile);

export type StandardRunnerCommand =
  | "validate-data"
  | "train"
  | "resume"
  | "evaluate"
  | "convert-samples";

export type StandardRunnerPhase =
  | "pretraining"
  | "posttraining"
  | "validation"
  | "evaluation"
  | "sample_migration";

export type StandardRunnerStatus =
  | "completed"
  | "paused_or_cancelled"
  | "not_trained"
  | "NO_LEARNED_ROWS"
  | "DATA_INVALID"
  | "failed";

export interface StandardRunnerBudgetConfig {
  readonly budgetSteps: number;
  readonly learningRate: number;
  readonly seed: number;
  readonly checkpointEverySteps?: number;
  readonly updatesThisRun?: number;
}

export interface StandardRunnerConfig {
  readonly schema: "nnanything.l2.standard-runner-config.v1";
  readonly head: L2Head;
  readonly phase: StandardRunnerPhase;
  readonly handwiredRoot: string;
  readonly inputPackagePath: string;
  readonly outputDir: string;
  readonly computeBackend?: L2ComputeBackend;
  readonly sources?: readonly StandardDataSourceDecl[];
  readonly trainSources?: readonly StandardDataSourceDecl[];
  readonly evalSources?: readonly StandardDataSourceDecl[];
  readonly budget?: StandardRunnerBudgetConfig;
  readonly checkpointPath?: string;
  readonly candidatePackagePath?: string;
  readonly eventLogPath?: string;
  readonly convertedJsonlPath?: string;
  readonly filterMultiPartitionJson?: boolean;
}

export interface UnifiedRunnerCorpusConfig {
  readonly root: string;
  readonly admissionsPath: string;
  readonly studentRowsPath: string;
  readonly supervisionRowsPath: string;
  readonly packagePath: string;
  readonly missingModeTablePath: string;
}

export interface UnifiedRunnerTrainingConfig {
  readonly modelId: string;
  readonly version: string;
  readonly optimizer: "full_batch_sgd";
  readonly learningRate: number;
  readonly maxEpochs: number;
  readonly seed: number;
  readonly init: "xavier_uniform";
}

export interface UnifiedRunnerConfig {
  readonly schema: "nnanything.unified.runner-config.v1";
  readonly command: StandardRunnerCommand;
  readonly route: Readonly<{
    readonly domain: string;
    readonly decisionKind: "R" | "D" | "E" | "A";
  }>;
  readonly phase: StandardRunnerPhase;
  readonly encoderVersion: string;
  readonly dataGate: UnifiedDataGateConfig;
  readonly outputDir: string;
  readonly corpus?: UnifiedRunnerCorpusConfig;
  readonly training?: UnifiedRunnerTrainingConfig;
}

export interface EvaluationBreakdown {
  readonly totalRows: number;
  readonly overallCorrect: number;
  readonly overallAccuracy: number | null;
  readonly overallDenominator: number;
  readonly fixed: {
    readonly total: number;
    readonly correct: number;
    readonly status: "evaluated" | "not_applicable";
    readonly accuracy: number | null;
    readonly errors: readonly {
      readonly rowId: string;
      readonly gold: string;
      readonly predicted: string;
    }[];
  };
  readonly learned: {
    readonly total: number;
    readonly correct: number;
    readonly status: "evaluated" | "not_applicable";
    readonly accuracy: number | null;
    readonly uniqueProjectionsTotal: number;
    readonly uniqueProjectionsCorrect: number;
    readonly errors: readonly {
      readonly rowId: string;
      readonly gold: string;
      readonly predicted: string;
      readonly logits: readonly number[];
    }[];
  };
  readonly unresolved: {
    readonly total: number;
    readonly status: "unassessable_retained_in_denominator";
    readonly rowIds: readonly string[];
    readonly rows: readonly {
      readonly rowId: string;
      readonly reason: string;
    }[];
  };
  readonly packageImmutableVerified: boolean;
}

export interface StandardHeadRunReport {
  readonly schema: "nnanything.l2.standard-run-report.v1";
  readonly runId: string;
  readonly command: StandardRunnerCommand;
  readonly head: L2Head;
  readonly phase: StandardRunnerPhase;
  readonly status: StandardRunnerStatus;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly wallSeconds: number;
  readonly validationSeconds: number;
  readonly dataValidationSeconds: number;
  readonly packageLoadSeconds: number;
  readonly backendLoadSeconds: number | null;
  readonly loadSeconds: number | null;
  readonly optimizationSeconds: number | null;
  readonly cumulativeOptimizationSeconds: number | null;
  readonly previousOptimizationSeconds: number | null;
  readonly checkpointIOSeconds: number | null;
  readonly evaluationSeconds: number;
  readonly otherProcessOverheadSeconds: number | null;
  readonly timingSemantics: {
    readonly mutuallyExclusivePhases: true;
    readonly wallEquation: "wallSeconds = actual monotonic process wall clock; when all phase measurements are available, otherProcessOverheadSeconds = wallSeconds - (validationSeconds + loadSeconds + optimizationSeconds + checkpointIOSeconds + evaluationSeconds)";
    readonly loadEquation: "loadSeconds = packageLoadSeconds + backendLoadSeconds (deviceLoad + dataPrepare + reload)";
    readonly optimizationNote: "optimizationSeconds is the pure step forward/backward/parameter-update compute time from backend stepMs measurements (strictly excluding package/device load, data preparation, checkpoint I/O, and post-fit evaluation); if backend step timing is unavailable, optimizationSeconds is null and throughput is not computed.";
  };
  readonly stepsThisInvocation: number;
  readonly stepsCumulative: number;
  readonly resumedFromStep: number | null;
  readonly lastPersistedStep: number | null;
  readonly budgetSteps: number;
  readonly processedRows: number;
  readonly learnedRows: number;
  readonly fixedRows: number;
  readonly unresolvedRows: number;
  readonly uniqueOriginalProjections: number;
  readonly uniqueHybridProjections: number;
  readonly uniqueLearnedProjections: number;
  readonly samplesPerSecond: number | null;
  readonly stepsPerSecond: number | null;
  readonly throughputDenominator: string | null;
  readonly stopReason: string;
  readonly error: DataInvalidViolation | { readonly code: string; readonly message: string } | null;
  readonly backend: {
    readonly computeBackend: L2ComputeBackend | "none";
    readonly device: string;
    readonly dtype: "float32";
    readonly threads: 1;
    readonly optimizer: "full_batch_sgd" | "none";
    readonly recipeNote: string;
  };
  readonly paths: {
    readonly inputPackagePath: string;
    readonly outputDir: string;
    readonly checkpointPath: string | null;
    readonly candidatePackagePath: string | null;
    readonly eventLogPath: string | null;
    readonly reportJsonPath: string;
    readonly reportMdPath: string;
  };
  readonly headIsolation: {
    readonly trainedHead: L2Head;
    readonly frozenHeadsUnchanged: boolean | null;
    readonly changedParameterCount: number | null;
  };
  readonly evaluation: EvaluationBreakdown | null;
  readonly dataGateSummary: {
    readonly status: DataGateValidationResult["status"] | "NOT_RUN";
    readonly perSource: DataGateValidationResult["perSource"];
    readonly violations: DataGateValidationResult["violations"];
    readonly coverageLimits: readonly string[];
  };
}

interface CumulativeTimingState {
  readonly cumulativeOptimizationSeconds: number | null;
  readonly cumulativeCheckpointIOSeconds: number;
  readonly cumulativeValidationSeconds: number;
  readonly cumulativeLoadSeconds: number;
  readonly cumulativeWallSeconds: number;
  readonly completedSteps: number;
}

const RECIPE_NOTE =
  "Standard runner delegates optimization to lib/training/l2-mlp-backend.ts + l2-gpu-bridge.py (full_batch_sgd, momentum=0, float32, threads=1). Historical external g3-fit-* scripts used Adam and are HISTORICAL_ONLY; recipes are not interchangeable and no historical Adam reproduction is claimed.";

async function writeAtomicText(targetPath: string, content: string): Promise<string> {
  const resolved = resolve(targetPath);
  await mkdir(dirname(resolved), { recursive: true });
  const tempPath = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, resolved);
  return resolved;
}

type UnifiedRunnerOutputStatus =
  | "READY"
  | "NO_LEARNED_ROWS"
  | "DATA_INVALID"
  | "completed"
  | "failed";

interface UnifiedRunnerCounts {
  readonly studentGroups: number;
  readonly studentRows: number;
  readonly supervisionRows: number;
  readonly labelMissingExcluded: number;
  readonly trainableGroups: number;
}

interface UnifiedRunnerReport {
  readonly schema: "nnanything.unified.run-report.v1";
  readonly runId: string;
  readonly command: StandardRunnerCommand;
  readonly route: UnifiedRunnerConfig["route"];
  readonly phase: StandardRunnerPhase;
  readonly encoderVersion: string;
  readonly status: UnifiedRunnerOutputStatus;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly wallSeconds: number;
  readonly dataGate: UnifiedDataGateResult | null;
  readonly counts: UnifiedRunnerCounts | null;
  readonly trainReport: UnifiedTrainReport | null;
  readonly packageReload: UnifiedPackageReloadReceipt | null;
  readonly error: UnifiedDataGateViolation | { readonly code: string; readonly message: string } | null;
  readonly candidateState: {
    readonly calibration: "uncalibrated";
    readonly adoption: "not_applied";
  };
  readonly hybridPackageLoaded: false;
  readonly paths: {
    readonly inputPackagePath: null;
    readonly outputDir: string;
    readonly reportJsonPath: string;
    readonly reportMdPath: string;
    readonly studentRowsPath: string;
    readonly supervisionRowsPath: string;
    readonly dataGateRowsPath: string;
    readonly packagePath: string;
  };
}

function requireUnifiedCorpus(config: UnifiedRunnerConfig): UnifiedRunnerCorpusConfig {
  if (config.corpus === undefined) {
    throw new UnifiedTrainDataError("unified convert-samples/train requires config.corpus");
  }
  return config.corpus;
}

function requireUnifiedTraining(config: UnifiedRunnerConfig): UnifiedRunnerTrainingConfig {
  if (config.training === undefined) {
    throw new UnifiedTrainDataError("unified train requires config.training");
  }
  return config.training;
}

async function discoverUnifiedFamilyDirs(root: string): Promise<readonly string[]> {
  const resolvedRoot = resolve(root);
  if (existsSync(join(resolvedRoot, "manifest.json"))) return [resolvedRoot];
  const entries = await readdir(resolvedRoot, { withFileTypes: true });
  const dirs = entries
    .filter(entry => entry.isDirectory())
    .map(entry => join(resolvedRoot, entry.name))
    .filter(candidate => existsSync(join(candidate, "manifest.json")))
    .sort();
  if (dirs.length === 0) {
    throw new UnifiedTrainDataError(`no source family with manifest.json under ${resolvedRoot}`);
  }
  return dirs;
}

interface UnifiedFamilyAdmission {
  readonly partition: string;
  readonly usableForTrainingSupervision: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function loadUnifiedFamilyAdmissions(
  admissionsPath: string,
): Promise<ReadonlyMap<string, UnifiedFamilyAdmission>> {
  const resolvedPath = resolve(admissionsPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolvedPath, "utf8")) as unknown;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    throw new UnifiedTrainDataError(`cannot load corpus admissions ${resolvedPath}: ${message}`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.familyAdmissions)) {
    throw new UnifiedTrainDataError(`corpus admissions ${resolvedPath} must declare familyAdmissions[]`);
  }
  const admissions = new Map<string, UnifiedFamilyAdmission>();
  for (const entry of parsed.familyAdmissions) {
    if (
      !isRecord(entry)
      || typeof entry.sourceGroup !== "string"
      || typeof entry.partition !== "string"
      || typeof entry.usableForTrainingSupervision !== "boolean"
    ) {
      throw new UnifiedTrainDataError(`corpus admissions ${resolvedPath} contains a malformed family admission`);
    }
    admissions.set(entry.sourceGroup, {
      partition: entry.partition,
      usableForTrainingSupervision: entry.usableForTrainingSupervision,
    });
  }
  return admissions;
}

async function loadUnifiedFamilyManifestSource(familyDir: string): Promise<{
  readonly sourceGroup: string;
  readonly partition: string;
}> {
  const manifestPath = join(familyDir, "manifest.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    throw new UnifiedTrainDataError(`cannot load source family manifest ${manifestPath}: ${message}`);
  }
  if (
    !isRecord(parsed)
    || typeof parsed.sourceGroup !== "string"
    || typeof parsed.partition !== "string"
  ) {
    throw new UnifiedTrainDataError(`source family manifest ${manifestPath} must declare sourceGroup and partition`);
  }
  return { sourceGroup: parsed.sourceGroup, partition: parsed.partition };
}

function requireAdmittedTrainingSource(
  admissions: ReadonlyMap<string, UnifiedFamilyAdmission>,
  sourceGroup: string,
): void {
  const admission = admissions.get(sourceGroup);
  if (admission === undefined) {
    throw new UnifiedTrainDataError(`source ${sourceGroup} is not declared in corpus admissions`);
  }
  if (admission.usableForTrainingSupervision !== true) {
    throw new UnifiedTrainDataError(
      `source ${sourceGroup} is not usable for training supervision in corpus admissions`,
    );
  }
}

function requireAdmittedSourcePartition(
  admissions: ReadonlyMap<string, UnifiedFamilyAdmission>,
  sourceGroup: string,
  partition: string,
): void {
  const admission = admissions.get(sourceGroup);
  if (admission === undefined) {
    throw new UnifiedTrainDataError(`source ${sourceGroup} is not declared in corpus admissions`);
  }
  if (admission.partition.toLowerCase() !== partition.toLowerCase()) {
    throw new UnifiedTrainDataError(
      `source ${sourceGroup} partition ${partition} does not match admitted partition ${admission.partition}`,
    );
  }
}

function studentRowsForRunner(groups: readonly StudentGroup[]): readonly Record<string, unknown>[] {
  return groups.flatMap(group =>
    group.candidates.map(candidate => ({
      schema: UNIFIED_STUDENT_ROW_SCHEMA,
      group_id: group.group_id,
      sampleId: group.sampleId,
      requestRef: group.requestRef,
      sourceGroup: group.sourceGroup,
      language: group.language,
      adapterRef: group.adapterRef,
      derivationFamily: group.derivationFamily,
      semanticStratum: group.semanticStratum,
      stepContextRef: group.stepContextRef,
      candidateGroupRef: group.candidateGroupRef,
      featureSchemaVersion: group.featureSchemaVersion,
      encoderVersion: group.encoderVersion,
      partition: group.partition,
      candidateEnumeration: group.candidateEnumeration,
      coverageCursorRef: group.coverageCursorRef,
      evidenceRefs: group.evidenceRefs,
      failureMode: group.failureMode,
      candidateRef: candidate.candidateRef,
      optionSemantics: candidate.optionSemantics,
      candidateKind: candidate.candidateKind,
      x: candidate.input,
      missingMode: candidate.missingMode,
    })),
  );
}

function dataGateRowsForRunner(
  groups: readonly StudentGroup[],
  supervisionRows: readonly SupervisionRow[],
  route: UnifiedRunnerConfig["route"],
): readonly UnifiedDataGateRow[] {
  const supervisionByGroup = new Map<string, SupervisionRow>();
  for (const row of supervisionRows) {
    if (supervisionByGroup.has(row.group_id)) {
      throw new UnifiedTrainDataError(`duplicate supervision group ${row.group_id}`);
    }
    supervisionByGroup.set(row.group_id, row);
  }
  return groups.map(group => {
    const supervision = supervisionByGroup.get(group.group_id);
    if (supervision === undefined) {
      throw new UnifiedTrainDataError(`missing supervision for ${group.group_id}`);
    }
    const first = group.candidates[0];
    if (first === undefined) {
      throw new UnifiedTrainDataError(`candidate set S_g is empty for ${group.group_id}`);
    }
    if (group.partition === "VERIFICATION") {
      throw new UnifiedTrainDataError(`data gate does not accept VERIFICATION group ${group.group_id}`);
    }
    const candidates = group.candidates.map(candidate => candidate.candidateRef);
    const allowed = supervision.labelMissing
      ? candidates
      : supervision.goldAllowedCandidateRefs;
    return {
      schema: UNIFIED_DATA_ROW_SCHEMA,
      rowId: group.group_id,
      partition: group.partition,
      route,
      input: first.input,
      candidateInputs: group.candidates.map(candidate => ({
        candidateRef: candidate.candidateRef,
        input: candidate.input,
      })),
      missingMode: first.missingMode,
      candidates,
      allowed,
      gold: supervision.labelMissing ? "unknown" : (allowed[0] ?? "unknown"),
      labelMissing: supervision.labelMissing,
      enumeration: group.candidateEnumeration,
    };
  });
}

async function writeJsonlAtomic(targetPath: string, rows: readonly unknown[]): Promise<string> {
  const text = rows.length === 0
    ? ""
    : `${rows.map(row => JSON.stringify(row)).join("\n")}\n`;
  return writeAtomicText(targetPath, text);
}

function buildUnifiedTrainConfig(config: UnifiedRunnerConfig): UnifiedTrainConfig {
  const training = requireUnifiedTraining(config);
  const corpus = requireUnifiedCorpus(config);
  return {
    schema: UNIFIED_TRAIN_CONFIG_SCHEMA,
    route: config.route,
    architecture: { input: 64, hidden: [64, 64], output: 1 },
    optimizer: training.optimizer,
    learningRate: training.learningRate,
    maxEpochs: training.maxEpochs,
    seed: training.seed,
    init: training.init,
    resources: {
      thresholdsRef: resolve(config.dataGate.thresholdsPath),
      thresholdsSchema: "nnanything.feature-thresholds.v1",
      missingModeTableRef: resolve(corpus.missingModeTablePath),
      missingModeSchema: "nnanything.unified.missing-mode.v1",
    },
    modelId: training.modelId,
    version: training.version,
  };
}

function findNonFiniteUnifiedInput(
  groups: readonly {
    readonly groupRef: string;
    readonly candidates: readonly {
      readonly candidateRef: string;
      readonly input: readonly number[];
    }[];
  }[],
): string | null {
  for (const group of groups) {
    for (const candidate of group.candidates) {
      for (let slotIndex = 0; slotIndex < candidate.input.length; slotIndex += 1) {
        if (!Number.isFinite(candidate.input[slotIndex])) {
          return `${group.groupRef}/${candidate.candidateRef} input[${slotIndex}] is not finite`;
        }
      }
    }
  }
  return null;
}

function nonFiniteUnifiedTrainReport(
  groupCount: number,
  message: string,
): UnifiedTrainReport {
  return {
    schema: "nnanything.unified.train-report.v1",
    status: "failed",
    stopReason: "non_finite",
    completedEpochs: 0,
    initialLoss: null,
    finalLoss: null,
    lastDecileMeanAbsDelta: null,
    monotonicViolations: 0,
    firstMonotonicViolationEpoch: null,
    groupCount,
    epochs: [],
    violations: [message],
  };
}

function compareUnifiedTensors(
  expected: UnifiedModelPackage["tensors"],
  actual: UnifiedModelPackage["tensors"],
): boolean {
  for (const key of ["W1", "b1", "W2", "b2", "W3", "b3"] as const) {
    const left = expected[key];
    const right = actual[key];
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return false;
    }
  }
  return true;
}

async function verifyUnifiedPackageReloadInNewProcess(
  packagePath: string,
  expected: UnifiedModelPackage,
): Promise<UnifiedPackageReloadReceipt> {
  const resolvedPackagePath = resolve(packagePath);
  const loaderUrl = new URL("./unified-model-package.js", import.meta.url).href;
  const script = `
import { loadUnifiedModelPackageFromFile } from ${JSON.stringify(loaderUrl)};
const loaded = await loadUnifiedModelPackageFromFile(${JSON.stringify(resolvedPackagePath)});
process.stdout.write(JSON.stringify({
  modelId: loaded.package.modelId,
  version: loaded.package.version,
  tensors: loaded.package.tensors,
  thresholdsPath: loaded.resolvedResources.thresholdsPath,
  missingModeTablePath: loaded.resolvedResources.missingModeTablePath
}));
`;
  const { stdout } = await execFileAsync(process.execPath, [
    "--input-type=module",
    "-e",
    script,
  ], { maxBuffer: 16 * 1024 * 1024 });
  const loaded = JSON.parse(String(stdout)) as {
    readonly modelId: string;
    readonly version: string;
    readonly tensors: UnifiedModelPackage["tensors"];
    readonly thresholdsPath: string;
    readonly missingModeTablePath: string;
  };
  const tensorsMatch = compareUnifiedTensors(expected.tensors, loaded.tensors);
  if (!tensorsMatch) {
    throw new UnifiedTrainDataError("new-process package reload tensors differ from the saved package");
  }
  return {
    packagePath: resolvedPackagePath,
    modelId: loaded.modelId,
    version: loaded.version,
    tensorsMatch,
    thresholdsPath: loaded.thresholdsPath,
    missingModeTablePath: loaded.missingModeTablePath,
  };
}

async function writeUnifiedRunnerReport(
  outputDir: string,
  report: UnifiedRunnerReport,
): Promise<{ readonly reportJsonPath: string; readonly reportMdPath: string }> {
  const reportJsonPath = join(outputDir, "run-report.json");
  const reportMdPath = join(outputDir, "run-report.md");
  await writeAtomicText(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`);
  const lines = [
    `# Unified Runner Report (${report.runId})`,
    "",
    `- Command: \`${report.command}\``,
    `- Route: \`${report.route.domain}/${report.route.decisionKind}\``,
    `- Phase: \`${report.phase}\``,
    `- Status: \`${report.status}\``,
    `- Data Gate Status: \`${report.dataGate?.status ?? "not_run"}\``,
    `- Candidate State: \`${report.candidateState.calibration}/${report.candidateState.adoption}\``,
  ];
  if (report.counts !== null) {
    lines.push(
      `- Student Groups: \`${report.counts.studentGroups}\``,
      `- Student Rows: \`${report.counts.studentRows}\``,
      `- Supervision Rows: \`${report.counts.supervisionRows}\``,
      `- Label Missing Excluded: \`${report.counts.labelMissingExcluded}\``,
      `- Trainable Groups: \`${report.counts.trainableGroups}\``,
    );
  }
  if (report.trainReport !== null) {
    lines.push(
      `- Train Stop Reason: \`${report.trainReport.stopReason}\``,
      `- Completed Epochs: \`${report.trainReport.completedEpochs}\``,
      `- Group Count: \`${report.trainReport.groupCount}\``,
    );
  }
  if (report.packageReload !== null) {
    lines.push(`- Package Reload tensorsMatch: \`${String(report.packageReload.tensorsMatch)}\``);
  }
  if (report.error !== null) {
    lines.push("", "## Error", "", "```json", JSON.stringify(report.error, null, 2), "```");
  }
  await writeAtomicText(reportMdPath, `${lines.join("\n")}\n`);
  return { reportJsonPath, reportMdPath };
}

function formatMarkdownReport(report: StandardHeadRunReport): string {
  const lines: string[] = [
    `# Standard L2 Runner Report (${report.runId})`,
    "",
    `- Command: \`${report.command}\``,
    `- Head: \`${report.head}\``,
    `- Phase: \`${report.phase}\``,
    `- Status: \`${report.status}\``,
    `- Stop Reason: \`${report.stopReason}\``,
    `- Started At: \`${report.startedAt}\``,
    `- Ended At: \`${report.endedAt}\``,
    "",
    "## Timings (Mutually Exclusive Monotonic Seconds)",
    "",
    `- wallSeconds: \`${report.wallSeconds.toFixed(6)}\``,
    `- validationSeconds (dataValidationSeconds): \`${report.validationSeconds.toFixed(6)}\``,
    `- loadSeconds: \`${report.loadSeconds !== null ? report.loadSeconds.toFixed(6) : "unavailable (null)"}\` (packageLoadSeconds=\`${report.packageLoadSeconds.toFixed(6)}\`, backendLoadSeconds=\`${report.backendLoadSeconds !== null ? report.backendLoadSeconds.toFixed(6) : "unavailable (null)"}\`)`,
    `- optimizationSeconds (pure step compute this invocation): \`${report.optimizationSeconds !== null ? report.optimizationSeconds.toFixed(6) : "unavailable (null)"}\``,
    `- previousOptimizationSeconds: \`${report.previousOptimizationSeconds !== null ? report.previousOptimizationSeconds.toFixed(6) : "unavailable (null)"}\``,
    `- cumulativeOptimizationSeconds: \`${report.cumulativeOptimizationSeconds !== null ? report.cumulativeOptimizationSeconds.toFixed(6) : "unavailable (null)"}\``,
    `- checkpointIOSeconds: \`${report.checkpointIOSeconds !== null ? report.checkpointIOSeconds.toFixed(6) : "unavailable (null)"}\``,
    `- evaluationSeconds: \`${report.evaluationSeconds.toFixed(6)}\``,
    `- otherProcessOverheadSeconds: \`${report.otherProcessOverheadSeconds !== null ? report.otherProcessOverheadSeconds.toFixed(6) : "unavailable (null)"}\``,
    `- timingSemantics: ${report.timingSemantics.optimizationNote}`,
    "",
    "## Steps, Rows & Throughput",
    "",
    `- stepsThisInvocation: \`${report.stepsThisInvocation}\``,
    `- stepsCumulative: \`${report.stepsCumulative}\``,
    `- resumedFromStep: \`${report.resumedFromStep ?? "null"}\``,
    `- lastPersistedStep: \`${report.lastPersistedStep ?? "null"}\``,
    `- budgetSteps: \`${report.budgetSteps}\``,
    `- processedRows: \`${report.processedRows}\` (learned: \`${report.learnedRows}\`, fixed: \`${report.fixedRows}\`, unresolved: \`${report.unresolvedRows}\`)`,
    `- uniqueProjections: original=\`${report.uniqueOriginalProjections}\`, hybrid=\`${report.uniqueHybridProjections}\`, learned=\`${report.uniqueLearnedProjections}\``,
    `- samplesPerSecond: \`${report.samplesPerSecond !== null ? report.samplesPerSecond.toFixed(4) : "null"}\``,
    `- stepsPerSecond: \`${report.stepsPerSecond !== null ? report.stepsPerSecond.toFixed(4) : "null"}\``,
    `- throughputDenominator: \`${report.throughputDenominator ?? "null"}\``,
    "",
    "## Backend & Recipe Boundary",
    "",
    `- computeBackend: \`${report.backend.computeBackend}\``,
    `- device: \`${report.backend.device}\``,
    `- dtype / threads: \`${report.backend.dtype}\` / \`${report.backend.threads}\``,
    `- optimizer: \`${report.backend.optimizer}\``,
    `- recipeNote: ${report.backend.recipeNote}`,
  ];
  if (report.error !== null) {
    lines.push("", "## Error Detail", "", "```json", JSON.stringify(report.error, null, 2), "```");
  }
  if (report.evaluation !== null) {
    const overallAccStr =
      report.evaluation.overallAccuracy !== null
        ? `${(report.evaluation.overallAccuracy * 100).toFixed(2)}%`
        : "not_applicable";
    const fixedAccStr =
      report.evaluation.fixed.accuracy !== null
        ? `${(report.evaluation.fixed.accuracy * 100).toFixed(2)}%`
        : "not_applicable";
    const learnedAccStr =
      report.evaluation.learned.accuracy !== null
        ? `${(report.evaluation.learned.accuracy * 100).toFixed(2)}%`
        : "not_applicable";
    lines.push(
      "",
      "## Evaluation Summary",
      "",
      `- overallBehavior: \`${report.evaluation.overallCorrect}/${report.evaluation.overallDenominator}\` (\`${overallAccStr}\`)`,
      `- fixed: \`${report.evaluation.fixed.correct}/${report.evaluation.fixed.total}\` (status=\`${report.evaluation.fixed.status}\`, accuracy=\`${fixedAccStr}\`)`,
      `- learned: \`${report.evaluation.learned.correct}/${report.evaluation.learned.total}\` (status=\`${report.evaluation.learned.status}\`, accuracy=\`${learnedAccStr}\`, unique=\`${report.evaluation.learned.uniqueProjectionsCorrect}/${report.evaluation.learned.uniqueProjectionsTotal}\`)`,
      `- unresolved retained in denominator: \`${report.evaluation.unresolved.total}\` (\`${report.evaluation.unresolved.status}\`)`,
      `- packageImmutableVerified: \`${report.evaluation.packageImmutableVerified}\``,
    );
  }
  return `${lines.join("\n")}\n`;
}

function timingStatePath(checkpointPath: string): string {
  return `${resolve(checkpointPath)}.timing.json`;
}

async function readCumulativeTimingState(checkpointPath: string | null): Promise<CumulativeTimingState | null> {
  if (checkpointPath === null) return null;
  const path = timingStatePath(checkpointPath);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as CumulativeTimingState;
  } catch {
    return null;
  }
}

async function writeCumulativeTimingState(
  checkpointPath: string | null,
  state: CumulativeTimingState,
): Promise<void> {
  if (checkpointPath === null) return;
  await writeAtomicText(timingStatePath(checkpointPath), `${JSON.stringify(state, null, 2)}\n`);
}

function checkFrozenHeadsUnchanged(
  beforePkg: HybridPackageResource["package"],
  afterProfile: HybridPackageResource["profile"],
  trainedHead: L2Head,
): boolean {
  for (const h of L2_HEADS) {
    if (h === trainedHead) continue;
    const beforeParams = beforePkg.heads[h].parameters;
    const afterParams = afterProfile.heads[h].parameters;
    if (beforeParams.length !== afterParams.length) return false;
    for (let i = 0; i < beforeParams.length; i += 1) {
      if (Math.fround(beforeParams[i]!) !== Math.fround(afterParams[i]!)) {
        return false;
      }
    }
  }
  return true;
}

function evaluateValidatedRows(
  hybridResource: HybridPackageResource,
  validation: DataGateValidationResult,
  packageImmutableVerified: boolean,
): EvaluationBreakdown {
  const head = validation.head;
  const fixedErrors: { rowId: string; gold: string; predicted: string }[] = [];
  let fixedCorrect = 0;

  for (const row of validation.fixedRows) {
    const res = hybridResource.inferE({
      goal: { kind: row.family === "read" ? "gcm.read" : "g3.literal-search" },
      features19: row.mlpFeatures19,
      receiptFact: row.receiptFact,
    });
    if (res.label === row.semanticGold) {
      fixedCorrect += 1;
    } else {
      fixedErrors.push({
        rowId: row.sourceRef.originalId,
        gold: row.semanticGold,
        predicted: res.label,
      });
    }
  }

  const learnedErrors: {
    rowId: string;
    gold: string;
    predicted: string;
    logits: readonly number[];
  }[] = [];
  let learnedCorrect = 0;
  const uniqueMap = new Map<string, boolean>();

  for (const row of validation.learnedRows) {
    const pred =
      head === "E"
        ? hybridResource.inferE({
            goal: { kind: row.family === "read" ? "gcm.read" : "g3.literal-search" },
            features19: row.mlpFeatures19,
            receiptFact: row.receiptFact,
          })
        : hybridResource.inferHead(head, row.mlpFeatures19);
    const isCorrect = pred.label === row.semanticGold;
    const uKey = `${row.mlpFeatures19.map(v => `${Math.fround(v)}`).join(",")}|${row.semanticGold}`;
    if (!uniqueMap.has(uKey)) {
      uniqueMap.set(uKey, isCorrect);
    } else if (!isCorrect) {
      uniqueMap.set(uKey, false);
    }
    if (isCorrect) {
      learnedCorrect += 1;
    } else {
      learnedErrors.push({
        rowId: row.sourceRef.originalId,
        gold: row.semanticGold,
        predicted: pred.label,
        logits: pred.logits,
      });
    }
  }

  const uniqueProjectionsTotal = uniqueMap.size;
  const uniqueProjectionsCorrect = [...uniqueMap.values()].filter(Boolean).length;
  const unresolvedCount = validation.unresolvedRows.length;
  const overallDenominator = validation.rows.length;
  const overallCorrect = fixedCorrect + learnedCorrect;

  return {
    totalRows: validation.rows.length,
    overallCorrect,
    overallDenominator,
    overallAccuracy: overallDenominator > 0 ? overallCorrect / overallDenominator : null,
    fixed: {
      total: validation.fixedRows.length,
      correct: fixedCorrect,
      status: validation.fixedRows.length > 0 ? "evaluated" : "not_applicable",
      accuracy: validation.fixedRows.length > 0 ? fixedCorrect / validation.fixedRows.length : null,
      errors: fixedErrors,
    },
    learned: {
      total: validation.learnedRows.length,
      correct: learnedCorrect,
      status: validation.learnedRows.length > 0 ? "evaluated" : "not_applicable",
      accuracy: validation.learnedRows.length > 0 ? learnedCorrect / validation.learnedRows.length : null,
      uniqueProjectionsTotal,
      uniqueProjectionsCorrect,
      errors: learnedErrors,
    },
    unresolved: {
      total: unresolvedCount,
      status: "unassessable_retained_in_denominator",
      rowIds: validation.unresolvedRows.map(r => r.sourceRef.originalId),
      rows: validation.unresolvedRows.map(r => ({
        rowId: r.sourceRef.originalId,
        reason: r.unresolvedReason ?? "unresolved provenance",
      })),
    },
    packageImmutableVerified,
  };
}

export async function executeStandardRunner(
  command: StandardRunnerCommand,
  config: StandardRunnerConfig,
  options: {
    readonly signal?: AbortSignal;
    readonly onProgress?: (event: L2TrainingEvent) => void;
  } = {},
): Promise<{
  readonly exitCode: number;
  readonly report: StandardHeadRunReport;
}> {
  const wallStartNs = process.hrtime.bigint();
  const startedAt = new Date().toISOString();
  const runId = `std-${command}-${config.head}-${Date.now().toString(36)}`;
  const outputDir = resolve(config.outputDir);
  await mkdir(outputDir, { recursive: true });

  const reportJsonPath = join(outputDir, "run-report.json");
  const reportMdPath = join(outputDir, "run-report.md");
  const checkpointPath =
    config.checkpointPath !== undefined
      ? resolve(config.checkpointPath)
      : command === "train" || command === "resume"
        ? join(outputDir, "checkpoint.json")
        : null;
  const candidatePackagePath =
    command === "train" || command === "resume"
      ? config.candidatePackagePath !== undefined
        ? resolve(config.candidatePackagePath)
        : join(outputDir, "candidate-hybrid-package.json")
      : null;
  const eventLogPath =
    config.eventLogPath !== undefined
      ? resolve(config.eventLogPath)
      : command === "train" || command === "resume"
        ? join(outputDir, "progress-events.jsonl")
        : null;

  let packageLoadSeconds = 0;
  let backendLoadSeconds: number | null = 0;
  let loadSeconds: number | null = 0;
  let validationSeconds = 0;
  let optimizationSeconds: number | null = 0;
  let previousOptimizationSeconds: number | null = 0;
  let checkpointIOSeconds: number | null = 0;
  let evaluationSeconds = 0;

  const finalizeReport = async (
    partial: Omit<
      StandardHeadRunReport,
      | "schema"
      | "runId"
      | "command"
      | "head"
      | "phase"
      | "startedAt"
      | "endedAt"
      | "wallSeconds"
      | "validationSeconds"
      | "dataValidationSeconds"
      | "packageLoadSeconds"
      | "backendLoadSeconds"
      | "loadSeconds"
      | "optimizationSeconds"
      | "cumulativeOptimizationSeconds"
      | "previousOptimizationSeconds"
      | "checkpointIOSeconds"
      | "evaluationSeconds"
      | "otherProcessOverheadSeconds"
      | "timingSemantics"
      | "paths"
      | "lastPersistedStep"
    > & {
      readonly lastPersistedStep?: number | null;
    },
    exitCode: number,
  ) => {
    const endedAt = new Date().toISOString();
    const wallSeconds = Number(process.hrtime.bigint() - wallStartNs) / 1e9;
    loadSeconds =
      backendLoadSeconds !== null ? packageLoadSeconds + backendLoadSeconds : null;
    const accountedPhases =
      loadSeconds !== null && optimizationSeconds !== null && checkpointIOSeconds !== null
        ? validationSeconds + loadSeconds + optimizationSeconds + checkpointIOSeconds + evaluationSeconds
        : null;
    const otherProcessOverheadSeconds =
      accountedPhases !== null && wallSeconds >= accountedPhases
        ? wallSeconds - accountedPhases
        : null;
    const cumulativeOptimizationSeconds =
      optimizationSeconds !== null && previousOptimizationSeconds !== null
        ? previousOptimizationSeconds + optimizationSeconds
        : null;
    const report: StandardHeadRunReport = {
      schema: "nnanything.l2.standard-run-report.v1",
      runId,
      command,
      head: config.head,
      phase: config.phase,
      startedAt,
      endedAt,
      wallSeconds,
      validationSeconds,
      dataValidationSeconds: validationSeconds,
      packageLoadSeconds,
      backendLoadSeconds,
      loadSeconds,
      optimizationSeconds,
      cumulativeOptimizationSeconds,
      previousOptimizationSeconds,
      checkpointIOSeconds,
      evaluationSeconds,
      otherProcessOverheadSeconds,
      timingSemantics: {
        mutuallyExclusivePhases: true,
        wallEquation:
          "wallSeconds = actual monotonic process wall clock; when all phase measurements are available, otherProcessOverheadSeconds = wallSeconds - (validationSeconds + loadSeconds + optimizationSeconds + checkpointIOSeconds + evaluationSeconds)",
        loadEquation:
          "loadSeconds = packageLoadSeconds + backendLoadSeconds (deviceLoad + dataPrepare + reload)",
        optimizationNote:
          "optimizationSeconds is the pure step forward/backward/parameter-update compute time from backend stepMs measurements (strictly excluding package/device load, data preparation, checkpoint I/O, and post-fit evaluation); if backend step timing is unavailable, optimizationSeconds is null and throughput is not computed.",
      },
      paths: {
        inputPackagePath: resolve(config.inputPackagePath),
        outputDir,
        checkpointPath,
        candidatePackagePath:
          partial.status === "completed" ? candidatePackagePath : null,
        eventLogPath,
        reportJsonPath,
        reportMdPath,
      },
      lastPersistedStep: partial.lastPersistedStep ?? null,
      ...partial,
    };
    await writeAtomicText(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`);
    await writeAtomicText(reportMdPath, formatMarkdownReport(report));
    return { exitCode, report };
  };

  // 1. Load hybrid package (`cli.hybrid-package.v1`)
  const loadStartNs = process.hrtime.bigint();
  let originalPackageRawBytes: string | null = null;
  let hybridResource: HybridPackageResource;
  try {
    originalPackageRawBytes = await readFile(resolve(config.inputPackagePath), "utf8");
    hybridResource = await createHybridPackageResource(
      JSON.parse(originalPackageRawBytes),
      config.handwiredRoot,
      resolve(config.inputPackagePath),
    );
  } catch (err) {
    packageLoadSeconds = Number(process.hrtime.bigint() - loadStartNs) / 1e9;
    const message = err instanceof Error ? err.message : String(err);
    return finalizeReport(
      {
        status: "failed",
        stepsThisInvocation: 0,
        stepsCumulative: 0,
        resumedFromStep: null,
        budgetSteps: config.budget?.budgetSteps ?? 0,
        processedRows: 0,
        learnedRows: 0,
        fixedRows: 0,
        unresolvedRows: 0,
        uniqueOriginalProjections: 0,
        uniqueHybridProjections: 0,
        uniqueLearnedProjections: 0,
        samplesPerSecond: null,
        stepsPerSecond: null,
        throughputDenominator: null,
        stopReason: "package_load_failed",
        error: { code: "HYBRID_CONTRACT_ERROR", message },
        backend: {
          computeBackend: "none",
          device: "none",
          dtype: "float32",
          threads: 1,
          optimizer: "none",
          recipeNote: RECIPE_NOTE,
        },
        headIsolation: {
          trainedHead: config.head,
          frozenHeadsUnchanged: null,
          changedParameterCount: 0,
        },
        evaluation: null,
        dataGateSummary: {
          status: "NOT_RUN",
          perSource: [],
          violations: [],
          coverageLimits: [],
        },
      },
      1,
    );
  }
  packageLoadSeconds = Number(process.hrtime.bigint() - loadStartNs) / 1e9;

  // Reject DEV/VERIFY sources inside `train` or `resume` before data validation
  if (
    (command === "train" || command === "resume")
    && config.evalSources !== undefined
    && config.evalSources.length > 0
  ) {
    const violation: DataInvalidViolation = {
      code: "DATA_INVALID",
      source: config.evalSources[0]!.path,
      rowIndex: null,
      rowId: null,
      reason: "fit/resume process strictly refuses evalSources (DEV/VERIFY paths must not enter train/resume)",
    };
    return finalizeReport(
      {
        status: "DATA_INVALID",
        stepsThisInvocation: 0,
        stepsCumulative: 0,
        resumedFromStep: null,
        budgetSteps: config.budget?.budgetSteps ?? 0,
        processedRows: 0,
        learnedRows: 0,
        fixedRows: 0,
        unresolvedRows: 0,
        uniqueOriginalProjections: 0,
        uniqueHybridProjections: 0,
        uniqueLearnedProjections: 0,
        samplesPerSecond: null,
        stepsPerSecond: null,
        throughputDenominator: null,
        stopReason: "DATA_INVALID",
        error: violation,
        backend: {
          computeBackend: "none",
          device: "none",
          dtype: "float32",
          threads: 1,
          optimizer: "none",
          recipeNote: RECIPE_NOTE,
        },
        headIsolation: {
          trainedHead: config.head,
          frozenHeadsUnchanged: true,
          changedParameterCount: 0,
        },
        evaluation: null,
        dataGateSummary: {
          status: "DATA_INVALID",
          perSource: [],
          violations: [violation],
          coverageLimits: [],
        },
      },
      1,
    );
  }

  // 2. Run Data Gate (`validateStandardTrainingData` or `convertSamplesToUnifiedJsonl`)
  const valStartNs = process.hrtime.bigint();
  const activeSources =
    command === "evaluate"
      ? (config.evalSources ?? config.sources ?? [])
      : command === "convert-samples" || command === "validate-data"
        ? (config.sources ?? config.trainSources ?? config.evalSources ?? [])
        : (config.trainSources ?? []);
  const expectedPartition: "TRAIN" | "DEV" =
    command === "evaluate"
      ? (activeSources[0]?.expectedPartition ?? "DEV")
      : (command === "validate-data" || command === "convert-samples")
        ? (activeSources[0]?.expectedPartition ?? "TRAIN")
        : "TRAIN";

  if (command === "convert-samples") {
    const outJsonl = config.convertedJsonlPath ?? join(outputDir, "converted-samples.jsonl");
    const convReportPath = join(outputDir, "sample-migration-report.json");
    const { validation, outputWritten } = await convertSamplesToUnifiedJsonl({
      head: config.head,
      expectedPartition,
      sources: activeSources,
      hybridResource,
      outputJsonlPath: outJsonl,
      reportJsonPath: convReportPath,
      ...(config.filterMultiPartitionJson !== undefined
        ? { filterMultiPartitionJson: config.filterMultiPartitionJson }
        : {}),
    });
    validationSeconds = Number(process.hrtime.bigint() - valStartNs) / 1e9;
    const isInvalid = validation.status === "DATA_INVALID" || !outputWritten;
    return finalizeReport(
      {
        status: isInvalid ? "DATA_INVALID" : "not_trained",
        stepsThisInvocation: 0,
        stepsCumulative: 0,
        resumedFromStep: null,
        budgetSteps: 0,
        processedRows: validation.counts.totalRows,
        learnedRows: validation.counts.learnedRows,
        fixedRows: validation.counts.fixedRows,
        unresolvedRows: validation.counts.unresolvedRows,
        uniqueOriginalProjections: validation.counts.originalUniqueProjections,
        uniqueHybridProjections: validation.counts.hybridUniqueProjections,
        uniqueLearnedProjections: validation.counts.learnedUniqueProjections,
        samplesPerSecond: null,
        stepsPerSecond: null,
        throughputDenominator: null,
        stopReason: isInvalid ? "DATA_INVALID" : "sample_migration_completed",
        error: validation.firstViolation,
        backend: {
          computeBackend: "none",
          device: "none",
          dtype: "float32",
          threads: 1,
          optimizer: "none",
          recipeNote: RECIPE_NOTE,
        },
        headIsolation: {
          trainedHead: config.head,
          frozenHeadsUnchanged: true,
          changedParameterCount: 0,
        },
        evaluation: null,
        dataGateSummary: {
          status: validation.status,
          perSource: validation.perSource,
          violations: validation.violations,
          coverageLimits: validation.coverageLimits,
        },
      },
      isInvalid ? 1 : 0,
    );
  }

  const validation = await validateStandardTrainingData({
    head: config.head,
    expectedPartition,
    sources: activeSources,
    hybridResource,
    ...(config.filterMultiPartitionJson !== undefined
      ? { filterMultiPartitionJson: config.filterMultiPartitionJson }
      : {}),
    allowUnresolvedForEvaluation: command === "evaluate",
  });
  validationSeconds = Number(process.hrtime.bigint() - valStartNs) / 1e9;

  if (validation.status === "DATA_INVALID") {
    return finalizeReport(
      {
        status: "DATA_INVALID",
        stepsThisInvocation: 0,
        stepsCumulative: 0,
        resumedFromStep: null,
        budgetSteps: config.budget?.budgetSteps ?? 0,
        processedRows: validation.counts.totalRows,
        learnedRows: validation.counts.learnedRows,
        fixedRows: validation.counts.fixedRows,
        unresolvedRows: validation.counts.unresolvedRows,
        uniqueOriginalProjections: validation.counts.originalUniqueProjections,
        uniqueHybridProjections: validation.counts.hybridUniqueProjections,
        uniqueLearnedProjections: validation.counts.learnedUniqueProjections,
        samplesPerSecond: null,
        stepsPerSecond: null,
        throughputDenominator: null,
        stopReason: "DATA_INVALID",
        error: validation.firstViolation,
        backend: {
          computeBackend: "none",
          device: "none",
          dtype: "float32",
          threads: 1,
          optimizer: "none",
          recipeNote: RECIPE_NOTE,
        },
        headIsolation: {
          trainedHead: config.head,
          frozenHeadsUnchanged: true,
          changedParameterCount: 0,
        },
        evaluation: null,
        dataGateSummary: {
          status: validation.status,
          perSource: validation.perSource,
          violations: validation.violations,
          coverageLimits: validation.coverageLimits,
        },
      },
      1,
    );
  }

  if (command === "validate-data") {
    const status: StandardRunnerStatus =
      validation.status === "NO_LEARNED_ROWS" ? "NO_LEARNED_ROWS" : "not_trained";
    return finalizeReport(
      {
        status,
        stepsThisInvocation: 0,
        stepsCumulative: 0,
        resumedFromStep: null,
        budgetSteps: config.budget?.budgetSteps ?? 0,
        processedRows: validation.counts.totalRows,
        learnedRows: validation.counts.learnedRows,
        fixedRows: validation.counts.fixedRows,
        unresolvedRows: validation.counts.unresolvedRows,
        uniqueOriginalProjections: validation.counts.originalUniqueProjections,
        uniqueHybridProjections: validation.counts.hybridUniqueProjections,
        uniqueLearnedProjections: validation.counts.learnedUniqueProjections,
        samplesPerSecond: null,
        stepsPerSecond: null,
        throughputDenominator: null,
        stopReason: validation.status === "NO_LEARNED_ROWS" ? "NO_LEARNED_ROWS" : "validation_only",
        error: null,
        backend: {
          computeBackend: "none",
          device: "none",
          dtype: "float32",
          threads: 1,
          optimizer: "none",
          recipeNote: RECIPE_NOTE,
        },
        headIsolation: {
          trainedHead: config.head,
          frozenHeadsUnchanged: true,
          changedParameterCount: 0,
        },
        evaluation: null,
        dataGateSummary: {
          status: validation.status,
          perSource: validation.perSource,
          violations: validation.violations,
          coverageLimits: validation.coverageLimits,
        },
      },
      0,
    );
  }

  if (command === "evaluate") {
    const evalStartNs = process.hrtime.bigint();
    const afterPackageRawBytes = await readFile(resolve(config.inputPackagePath), "utf8");
    const packageImmutableVerified = originalPackageRawBytes === afterPackageRawBytes;
    const evaluation = evaluateValidatedRows(
      hybridResource,
      validation,
      packageImmutableVerified,
    );
    evaluationSeconds = Number(process.hrtime.bigint() - evalStartNs) / 1e9;
    return finalizeReport(
      {
        status: "not_trained",
        stepsThisInvocation: 0,
        stepsCumulative: 0,
        resumedFromStep: null,
        budgetSteps: 0,
        processedRows: validation.counts.totalRows,
        learnedRows: validation.counts.learnedRows,
        fixedRows: validation.counts.fixedRows,
        unresolvedRows: validation.counts.unresolvedRows,
        uniqueOriginalProjections: validation.counts.originalUniqueProjections,
        uniqueHybridProjections: validation.counts.hybridUniqueProjections,
        uniqueLearnedProjections: validation.counts.learnedUniqueProjections,
        samplesPerSecond: null,
        stepsPerSecond: null,
        throughputDenominator: null,
        stopReason: "evaluation_only",
        error: null,
        backend: {
          computeBackend: "none",
          device: "js-float32-hybrid-circuit",
          dtype: "float32",
          threads: 1,
          optimizer: "none",
          recipeNote: RECIPE_NOTE,
        },
        headIsolation: {
          trainedHead: config.head,
          frozenHeadsUnchanged: true,
          changedParameterCount: 0,
        },
        evaluation,
        dataGateSummary: {
          status: validation.status,
          perSource: validation.perSource,
          violations: validation.violations,
          coverageLimits: validation.coverageLimits,
        },
      },
      0,
    );
  }

  // 3. Handle `NO_LEARNED_ROWS` in `train` or `resume` (Scenario 5)
  if (validation.status === "NO_LEARNED_ROWS") {
    return finalizeReport(
      {
        status: "NO_LEARNED_ROWS",
        stepsThisInvocation: 0,
        stepsCumulative: 0,
        resumedFromStep: null,
        budgetSteps: config.budget?.budgetSteps ?? 0,
        processedRows: validation.counts.totalRows,
        learnedRows: 0,
        fixedRows: validation.counts.fixedRows,
        unresolvedRows: validation.counts.unresolvedRows,
        uniqueOriginalProjections: validation.counts.originalUniqueProjections,
        uniqueHybridProjections: validation.counts.hybridUniqueProjections,
        uniqueLearnedProjections: 0,
        samplesPerSecond: null,
        stepsPerSecond: null,
        throughputDenominator: null,
        stopReason: "NO_LEARNED_ROWS",
        error: null,
        backend: {
          computeBackend: "none",
          device: "none",
          dtype: "float32",
          threads: 1,
          optimizer: "none",
          recipeNote: RECIPE_NOTE,
        },
        headIsolation: {
          trainedHead: config.head,
          frozenHeadsUnchanged: true,
          changedParameterCount: 0,
        },
        evaluation: null,
        dataGateSummary: {
          status: "NO_LEARNED_ROWS",
          perSource: validation.perSource,
          violations: [],
          coverageLimits: validation.coverageLimits,
        },
      },
      0,
    );
  }

  // 4. Execute `train` or `resume` via `runBackendFit`
  if (config.budget === undefined) {
    return finalizeReport(
      {
        status: "failed",
        stepsThisInvocation: 0,
        stepsCumulative: 0,
        resumedFromStep: null,
        budgetSteps: 0,
        processedRows: validation.counts.totalRows,
        learnedRows: validation.counts.learnedRows,
        fixedRows: validation.counts.fixedRows,
        unresolvedRows: 0,
        uniqueOriginalProjections: validation.counts.originalUniqueProjections,
        uniqueHybridProjections: validation.counts.hybridUniqueProjections,
        uniqueLearnedProjections: validation.counts.learnedUniqueProjections,
        samplesPerSecond: null,
        stepsPerSecond: null,
        throughputDenominator: null,
        stopReason: "missing_budget_config",
        error: { code: "CONFIG_ERROR", message: "train/resume requires config.budget" },
        backend: {
          computeBackend: "none",
          device: "none",
          dtype: "float32",
          threads: 1,
          optimizer: "none",
          recipeNote: RECIPE_NOTE,
        },
        headIsolation: {
          trainedHead: config.head,
          frozenHeadsUnchanged: true,
          changedParameterCount: 0,
        },
        evaluation: null,
        dataGateSummary: {
          status: validation.status,
          perSource: validation.perSource,
          violations: [],
          coverageLimits: validation.coverageLimits,
        },
      },
      1,
    );
  }

  const computeBackend: L2ComputeBackend = config.computeBackend ?? "batch-cpu";
  const isResume = command === "resume";
  let priorCheckpointStep = 0;
  if (isResume) {
    if (checkpointPath === null || !existsSync(checkpointPath)) {
      return finalizeReport(
        {
          status: "failed",
          stepsThisInvocation: 0,
          stepsCumulative: 0,
          resumedFromStep: null,
          budgetSteps: config.budget.budgetSteps,
          processedRows: validation.counts.totalRows,
          learnedRows: validation.counts.learnedRows,
          fixedRows: validation.counts.fixedRows,
          unresolvedRows: 0,
          uniqueOriginalProjections: validation.counts.originalUniqueProjections,
          uniqueHybridProjections: validation.counts.hybridUniqueProjections,
          uniqueLearnedProjections: validation.counts.learnedUniqueProjections,
          samplesPerSecond: null,
          stepsPerSecond: null,
          throughputDenominator: null,
          stopReason: "missing_checkpoint_for_resume",
          error: {
            code: "RESUME_ERROR",
            message: `resume requires an existing committed checkpoint at ${checkpointPath ?? "<null>"}`,
          },
          backend: {
            computeBackend,
            device: "none",
            dtype: "float32",
            threads: 1,
            optimizer: "full_batch_sgd",
            recipeNote: RECIPE_NOTE,
          },
          headIsolation: {
            trainedHead: config.head,
            frozenHeadsUnchanged: true,
            changedParameterCount: 0,
          },
          evaluation: null,
          dataGateSummary: {
            status: validation.status,
            perSource: validation.perSource,
            violations: [],
            coverageLimits: validation.coverageLimits,
          },
        },
        1,
      );
    }
    const existingCkpt = await readL2Checkpoint(checkpointPath);
    priorCheckpointStep = existingCkpt.completedUpdates;
    const priorTiming = await readCumulativeTimingState(checkpointPath);
    if (priorTiming !== null) {
      previousOptimizationSeconds = priorTiming.cumulativeOptimizationSeconds;
    }
  } else if (eventLogPath !== null && existsSync(eventLogPath)) {
    await rm(eventLogPath, { force: true });
  }

  const cancelController = new AbortController();
  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      cancelController.abort();
    } else {
      options.signal.addEventListener("abort", () => cancelController.abort(), { once: true });
    }
  }

  let wasCancelledEvent = false;
  let pureStepComputeMs = 0;
  let measuredStepCount = 0;
  let observedCompletedUpdates = priorCheckpointStep;
  let observedLastPersistedStep: number | null = isResume ? priorCheckpointStep : null;
  let observedDevice = "unknown";
  let observedCheckpointWriteMs = 0;
  let observedCheckpointEvents = 0;
  const stepMsByUpdate = new Map<number, number>();

  let fitResult;
  try {
    fitResult = await runBackendFit({
      handwiredRoot: config.handwiredRoot,
      specs: {
        R: hybridResource.profile.heads.R.spec,
        D: hybridResource.profile.heads.D.spec,
        E: hybridResource.profile.heads.E.spec,
        A: hybridResource.profile.heads.A.spec,
      },
      rows: validation.learnedTrainingRows,
      trainHeads: [config.head],
      seed: config.budget.seed,
      learningRate: config.budget.learningRate,
      epochs: config.budget.budgetSteps,
      stopCheckpoints: [],
      initialProfile: hybridResource.profile,
      computeBackend,
      ...(checkpointPath !== null ? { checkpointPath } : {}),
      checkpointEverySteps: config.budget.checkpointEverySteps ?? 1,
      resume: isResume,
      ...(config.budget.updatesThisRun !== undefined
        ? { updatesThisRun: config.budget.updatesThisRun }
        : {}),
      ...(eventLogPath !== null ? { eventLogPath } : {}),
      signal: cancelController.signal,
      onProgress: event => {
        if (event.state === "paused_or_cancelled" || event.phase === "cancelled") {
          wasCancelledEvent = true;
        }
        if (typeof event.device === "string" && event.device.length > 0 && event.device !== "unknown") {
          observedDevice = event.device;
        }
        if (typeof event.completedUpdates === "number" && Number.isFinite(event.completedUpdates)) {
          observedCompletedUpdates = Math.max(observedCompletedUpdates, event.completedUpdates);
        }
        if (
          event.error !== undefined
          && typeof event.error.completedUpdates === "number"
          && Number.isFinite(event.error.completedUpdates)
        ) {
          observedCompletedUpdates = Math.max(observedCompletedUpdates, event.error.completedUpdates);
        }
        if (typeof event.lastPersistedStep === "number" && Number.isFinite(event.lastPersistedStep)) {
          observedLastPersistedStep =
            observedLastPersistedStep === null
              ? event.lastPersistedStep
              : Math.max(observedLastPersistedStep, event.lastPersistedStep);
        }
        if (
          event.error !== undefined
          && typeof event.error.lastPersistedStep === "number"
          && Number.isFinite(event.error.lastPersistedStep)
        ) {
          observedLastPersistedStep =
            observedLastPersistedStep === null
              ? event.error.lastPersistedStep
              : Math.max(observedLastPersistedStep, event.error.lastPersistedStep);
        }
        if (
          event.type === "checkpoint"
          && typeof event.stepMs === "number"
          && Number.isFinite(event.stepMs)
          && event.stepMs >= 0
        ) {
          observedCheckpointWriteMs += event.stepMs;
          observedCheckpointEvents += 1;
        }
        if (
          event.type === "step"
          && typeof event.stepMs === "number"
          && Number.isFinite(event.stepMs)
          && event.stepMs > 0
        ) {
          pureStepComputeMs += event.stepMs;
          measuredStepCount += 1;
          stepMsByUpdate.set(event.completedUpdates, event.stepMs);
        }
        options.onProgress?.(event);
      },
    });
  } catch (err) {
    if (checkpointPath !== null && existsSync(checkpointPath)) {
      try {
        const committedCkpt = await readL2Checkpoint(checkpointPath);
        if (
          typeof committedCkpt.completedUpdates === "number"
          && Number.isFinite(committedCkpt.completedUpdates)
        ) {
          observedLastPersistedStep = committedCkpt.completedUpdates;
          observedCompletedUpdates = Math.max(
            observedCompletedUpdates,
            committedCkpt.completedUpdates,
          );
        }
        if (
          observedDevice === "unknown"
          && typeof committedCkpt.device === "string"
          && committedCkpt.device.length > 0
        ) {
          observedDevice = committedCkpt.device;
        }
      } catch {
        // Ignore unreadable checkpoint on failure
      }
    }

    const resumedFromStep = isResume ? priorCheckpointStep : null;
    const stepsCumulative = observedCompletedUpdates;
    const stepsThisInvocation = Math.max(0, stepsCumulative - priorCheckpointStep);

    backendLoadSeconds = null;
    checkpointIOSeconds =
      observedCheckpointEvents > 0
        ? observedCheckpointWriteMs / 1000
        : observedLastPersistedStep === (isResume ? priorCheckpointStep : null)
          ? 0
          : null;
    optimizationSeconds =
      stepsThisInvocation === 0
        ? 0
        : measuredStepCount === stepsThisInvocation && pureStepComputeMs > 0
          ? pureStepComputeMs / 1000
          : null;

    if (checkpointPath !== null && existsSync(checkpointPath)) {
      await writeCumulativeTimingState(checkpointPath, {
        cumulativeOptimizationSeconds:
          optimizationSeconds !== null && previousOptimizationSeconds !== null
            ? previousOptimizationSeconds + optimizationSeconds
            : null,
        cumulativeCheckpointIOSeconds: checkpointIOSeconds ?? 0,
        cumulativeValidationSeconds: validationSeconds,
        cumulativeLoadSeconds: packageLoadSeconds,
        cumulativeWallSeconds: Number(process.hrtime.bigint() - wallStartNs) / 1e9,
        completedSteps: observedLastPersistedStep ?? priorCheckpointStep,
      });
    }

    const learnedRowDenom = validation.counts.learnedRows * stepsThisInvocation;
    const samplesPerSecond =
      optimizationSeconds !== null && optimizationSeconds > 0 && learnedRowDenom > 0
        ? learnedRowDenom / optimizationSeconds
        : null;
    const stepsPerSecond =
      optimizationSeconds !== null && optimizationSeconds > 0 && stepsThisInvocation > 0
        ? stepsThisInvocation / optimizationSeconds
        : null;
    const throughputDenominator =
      stepsThisInvocation === 0
        ? null
        : optimizationSeconds !== null && optimizationSeconds > 0
          ? `learnedRows(${validation.counts.learnedRows}) * stepsThisInvocation(${stepsThisInvocation}) / optimizationSeconds`
          : "optimizationSeconds_unavailable";

    const message = err instanceof Error ? err.message : String(err);
    return finalizeReport(
      {
        status: "failed",
        stepsThisInvocation,
        stepsCumulative,
        resumedFromStep,
        lastPersistedStep: observedLastPersistedStep,
        budgetSteps: config.budget.budgetSteps,
        processedRows: validation.counts.totalRows,
        learnedRows: validation.counts.learnedRows,
        fixedRows: validation.counts.fixedRows,
        unresolvedRows: validation.counts.unresolvedRows,
        uniqueOriginalProjections: validation.counts.originalUniqueProjections,
        uniqueHybridProjections: validation.counts.hybridUniqueProjections,
        uniqueLearnedProjections: validation.counts.learnedUniqueProjections,
        samplesPerSecond,
        stepsPerSecond,
        throughputDenominator,
        stopReason: "backend_fit_failed",
        error: { code: "BACKEND_FIT_ERROR", message },
        backend: {
          computeBackend,
          device: observedDevice,
          dtype: "float32",
          threads: 1,
          optimizer: "full_batch_sgd",
          recipeNote: RECIPE_NOTE,
        },
        headIsolation: {
          trainedHead: config.head,
          frozenHeadsUnchanged: null,
          changedParameterCount: null,
        },
        evaluation: null,
        dataGateSummary: {
          status: validation.status,
          perSource: validation.perSource,
          violations: [],
          coverageLimits: validation.coverageLimits,
        },
      },
      1,
    );
  }

  const backendTimings = fitResult.timings ?? {};
  const deviceLoadSec = (backendTimings.deviceLoadMs ?? 0) / 1000;
  const dataPrepSec = (backendTimings.dataPrepareMs ?? 0) / 1000;
  const reloadSec = (backendTimings.reloadMs ?? 0) / 1000;
  const firstComputeSec = (backendTimings.firstComputeMs ?? 0) / 1000;
  const ckptWriteSec = (backendTimings.checkpointWriteMs ?? 0) / 1000;
  const rawEvalSec = (backendTimings.evaluationMs ?? 0) / 1000;

  // Mutually exclusive phase assignment:
  // - backendLoadSeconds = deviceLoad + dataPrepare + reload
  // - optimizationSeconds = pure step compute (sum of step.stepMs across committed updates),
  //   strictly from backend measurements without wall-clock fallback or 1e-6 floor;
  //   if any committed step lacks stepMs, optimizationSeconds is null and throughput is disabled.
  // - checkpointIOSeconds = bridge checkpoint writes + candidate package save
  // - evaluationSeconds = post-fit evaluation (rawEvalSec minus firstComputeSec, which belongs to step 1)
  backendLoadSeconds = deviceLoadSec + dataPrepSec + reloadSec;
  checkpointIOSeconds = ckptWriteSec;
  evaluationSeconds = Math.max(0, rawEvalSec - firstComputeSec);

  const stepsCumulative = fitResult.report.epochsCompleted;
  const resumedFromStep = isResume ? (fitResult.resumedFromStep ?? priorCheckpointStep) : null;
  const stepsThisInvocation = Math.max(0, stepsCumulative - (resumedFromStep ?? 0));

  optimizationSeconds =
    stepsThisInvocation === 0
      ? 0
      : measuredStepCount === stepsThisInvocation && pureStepComputeMs > 0
        ? pureStepComputeMs / 1000
        : null;

  await writeCumulativeTimingState(checkpointPath, {
    cumulativeOptimizationSeconds:
      optimizationSeconds !== null && previousOptimizationSeconds !== null
        ? previousOptimizationSeconds + optimizationSeconds
        : null,
    cumulativeCheckpointIOSeconds: checkpointIOSeconds,
    cumulativeValidationSeconds: validationSeconds,
    cumulativeLoadSeconds: packageLoadSeconds + backendLoadSeconds,
    cumulativeWallSeconds: Number(process.hrtime.bigint() - wallStartNs) / 1e9,
    completedSteps: stepsCumulative,
  });

  const frozenHeadsUnchanged = checkFrozenHeadsUnchanged(
    hybridResource.package,
    fitResult.profile,
    config.head,
  );
  if (!frozenHeadsUnchanged) {
    throw new Error(`Frozen head parameters were mutated during ${config.head} training!`);
  }

  const isIncompleteOrCancelled =
    wasCancelledEvent || stepsCumulative < config.budget.budgetSteps;

  if (!isIncompleteOrCancelled && candidatePackagePath !== null) {
    const ckptWriteStartNs = process.hrtime.bigint();
    const updatedPackage = withUpdatedHeadParameters(
      hybridResource.package,
      config.head,
      fitResult.profile.heads[config.head].parameters,
    );
    await saveHybridPackageAtomic(candidatePackagePath, updatedPackage);
    checkpointIOSeconds += Number(process.hrtime.bigint() - ckptWriteStartNs) / 1e9;
  }

  const status: StandardRunnerStatus = isIncompleteOrCancelled
    ? "paused_or_cancelled"
    : "completed";
  const stopReason = wasCancelledEvent
    ? "controlled_cancel"
    : isIncompleteOrCancelled
      ? "bounded_updates_this_run"
      : "budget_reached";

  const learnedRowDenom = validation.counts.learnedRows * stepsThisInvocation;
  const samplesPerSecond =
    optimizationSeconds !== null && optimizationSeconds > 0 && learnedRowDenom > 0
      ? learnedRowDenom / optimizationSeconds
      : null;
  const stepsPerSecond =
    optimizationSeconds !== null && optimizationSeconds > 0 && stepsThisInvocation > 0
      ? stepsThisInvocation / optimizationSeconds
      : null;

  return finalizeReport(
    {
      status,
      stepsThisInvocation,
      stepsCumulative,
      resumedFromStep,
      lastPersistedStep: fitResult.lastPersistedStep ?? observedLastPersistedStep,
      budgetSteps: config.budget.budgetSteps,
      processedRows: validation.counts.totalRows,
      learnedRows: validation.counts.learnedRows,
      fixedRows: validation.counts.fixedRows,
      unresolvedRows: validation.counts.unresolvedRows,
      uniqueOriginalProjections: validation.counts.originalUniqueProjections,
      uniqueHybridProjections: validation.counts.hybridUniqueProjections,
      uniqueLearnedProjections: validation.counts.learnedUniqueProjections,
      samplesPerSecond,
      stepsPerSecond,
      throughputDenominator:
        stepsThisInvocation === 0
          ? null
          : optimizationSeconds !== null && optimizationSeconds > 0
            ? `learnedRows(${validation.counts.learnedRows}) * stepsThisInvocation(${stepsThisInvocation}) / optimizationSeconds`
            : "optimizationSeconds_unavailable",
      stopReason,
      error: null,
      backend: {
        computeBackend,
        device: fitResult.device,
        dtype: "float32",
        threads: 1,
        optimizer: "full_batch_sgd",
        recipeNote: RECIPE_NOTE,
      },
      headIsolation: {
        trainedHead: config.head,
        frozenHeadsUnchanged,
        changedParameterCount: fitResult.report.changedParameters,
      },
      evaluation: null,
      dataGateSummary: {
        status: validation.status,
        perSource: validation.perSource,
        violations: [],
        coverageLimits: validation.coverageLimits,
      },
    },
    0,
  );
}

export async function runStandardRunnerCli(argv: readonly string[]): Promise<number> {
  const args = [...argv];
  const command = args[0] as StandardRunnerCommand | undefined;
  const validCommands: readonly StandardRunnerCommand[] = [
    "validate-data",
    "train",
    "resume",
    "evaluate",
    "convert-samples",
  ];
  if (command === undefined || !validCommands.includes(command)) {
    process.stderr.write(
      `Usage: l2-standard-runner <validate-data|train|resume|evaluate|convert-samples> --config <config.json>\n`,
    );
    return 2;
  }
  const configIdx = args.indexOf("--config");
  const configPath = configIdx >= 0 ? args[configIdx + 1] : undefined;
  if (typeof configPath !== "string" || configPath.length === 0) {
    process.stderr.write("Missing required --config <config.json>\n");
    return 2;
  }
  const parsedConfig: unknown = JSON.parse(
    await readFile(resolve(configPath), "utf8"),
  );
  if (
    parsedConfig !== null
    && typeof parsedConfig === "object"
    && !Array.isArray(parsedConfig)
    && (parsedConfig as Readonly<Record<string, unknown>>).schema
      === "nnanything.unified.runner-config.v1"
  ) {
    return executeUnifiedRunnerRoute(command, parsedConfig as UnifiedRunnerConfig);
  }
  const rawConfig = parsedConfig as StandardRunnerConfig;
  const cliAbortController = new AbortController();
  const onSignal = () => {
    cliAbortController.abort();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const { exitCode } = await executeStandardRunner(command, rawConfig, {
      signal: cliAbortController.signal,
    });
    return exitCode;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

export async function executeUnifiedRunnerRoute(
  command: StandardRunnerCommand,
  config: UnifiedRunnerConfig,
): Promise<number> {
  if (command === "resume" || command === "evaluate") {
    process.stderr.write(
      `Unified runner route is NOT_READY for ${command}; convert-samples, train, and validate-data are available. No fitter or legacy fallback was used.\n`,
    );
    return 2;
  }
  if (command !== "validate-data" && command !== "convert-samples" && command !== "train") {
    process.stderr.write(
      `Unified runner route is NOT_READY for ${command}; no fitter or legacy fallback was used.\n`,
    );
    return 2;
  }

  const startedAt = new Date().toISOString();
  const wallStartNs = process.hrtime.bigint();
  const outputDir = resolve(config.outputDir);
  await mkdir(outputDir, { recursive: true });

  if (command === "validate-data") {
    const dataGate = await validateUnified64SlotTrainingData(config.dataGate);
    const endedAt = new Date().toISOString();
    const wallSeconds = Number(process.hrtime.bigint() - wallStartNs) / 1e9;
    const status =
      dataGate.status === "DATA_INVALID"
        ? "DATA_INVALID"
        : dataGate.status === "NO_LEARNED_ROWS"
          ? "NO_LEARNED_ROWS"
          : "READY";
    const reportJsonPath = join(outputDir, "run-report.json");
    const reportMdPath = join(outputDir, "run-report.md");
    const report = {
      schema: "nnanything.unified.run-report.v1",
      runId: `unified-${command}-${Date.now().toString(36)}`,
      command,
      route: config.route,
      phase: config.phase,
      encoderVersion: config.encoderVersion,
      status,
      startedAt,
      endedAt,
      wallSeconds,
      dataGate,
      hybridPackageLoaded: false,
      paths: {
        inputPackagePath: null,
        outputDir,
        reportJsonPath,
        reportMdPath,
      },
    };
    await writeAtomicText(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`);
    await writeAtomicText(
      reportMdPath,
      [
        `# Unified Runner Route Report (${report.runId})`,
        "",
        `- Command: \`${report.command}\``,
        `- Route: \`${report.route.domain}/${report.route.decisionKind}\``,
        `- Phase: \`${report.phase}\``,
        `- Status: \`${report.status}\``,
        `- Data Gate Status: \`${report.dataGate.status}\``,
        `- Data Gate Learned Rows: \`${report.dataGate.counts.learnedRows}\``,
        `- Hybrid Package Loaded: \`${String(report.hybridPackageLoaded)}\``,
        `- Input Package Path: \`${String(report.paths.inputPackagePath)}\``,
        "",
      ].join("\n"),
    );
    return status === "DATA_INVALID" ? 1 : 0;
  }

  const corpus = requireUnifiedCorpus(config);
  const studentRowsPath = resolve(corpus.studentRowsPath);
  const supervisionRowsPath = resolve(corpus.supervisionRowsPath);
  const dataGateRowsPath = resolve(config.dataGate.rowsPath);
  const packagePath = resolve(corpus.packagePath);
  let dataGate: UnifiedDataGateResult | null = null;
  let counts: UnifiedRunnerCounts | null = null;
  let trainReport: UnifiedTrainReport | null = null;
  let packageReload: UnifiedPackageReloadReceipt | null = null;
  let error: UnifiedRunnerReport["error"] = null;

  const finalize = async (
    status: UnifiedRunnerOutputStatus,
    exitCode: number,
  ): Promise<number> => {
    const endedAt = new Date().toISOString();
    const wallSeconds = Number(process.hrtime.bigint() - wallStartNs) / 1e9;
    const report: UnifiedRunnerReport = {
      schema: "nnanything.unified.run-report.v1",
      runId: `unified-${command}-${Date.now().toString(36)}`,
      command,
      route: config.route,
      phase: config.phase,
      encoderVersion: config.encoderVersion,
      status,
      startedAt,
      endedAt,
      wallSeconds,
      dataGate,
      counts,
      trainReport,
      packageReload,
      error,
      candidateState: { calibration: "uncalibrated", adoption: "not_applied" },
      hybridPackageLoaded: false,
      paths: {
        inputPackagePath: null,
        outputDir,
        reportJsonPath: join(outputDir, "run-report.json"),
        reportMdPath: join(outputDir, "run-report.md"),
        studentRowsPath,
        supervisionRowsPath,
        dataGateRowsPath,
        packagePath,
      },
    };
    await writeUnifiedRunnerReport(outputDir, report);
    return exitCode;
  };

  try {
    if (command === "convert-samples") {
      const admissions = await loadUnifiedFamilyAdmissions(corpus.admissionsPath);
      const familyDirs = await discoverUnifiedFamilyDirs(corpus.root);
      const episodes = [];
      const goldRecords = [];
      for (const familyDir of familyDirs) {
        const manifest = await loadUnifiedFamilyManifestSource(familyDir);
        requireAdmittedTrainingSource(admissions, manifest.sourceGroup);
        requireAdmittedSourcePartition(admissions, manifest.sourceGroup, manifest.partition);
        const familyEpisodes = await loadEpisodeFamily(familyDir);
        for (const episode of familyEpisodes) {
          requireAdmittedTrainingSource(admissions, episode.sourceGroup);
          requireAdmittedSourcePartition(admissions, episode.sourceGroup, episode.partition);
        }
        episodes.push(...familyEpisodes);
        const familyGold = await loadGoldFamily(familyDir);
        for (const gold of familyGold) {
          requireAdmittedTrainingSource(admissions, gold.sourceGroup);
          requireAdmittedSourcePartition(admissions, gold.sourceGroup, gold.partition);
        }
        goldRecords.push(...familyGold);
      }
      const studentGroups = episodes.map(episode => convertEpisodeToStudentGroup(episode));
      const studentRows = studentRowsForRunner(studentGroups);
      await writeJsonlAtomic(studentRowsPath, studentRows);
      counts = {
        studentGroups: studentGroups.length,
        studentRows: studentRows.length,
        supervisionRows: 0,
        labelMissingExcluded: 0,
        trainableGroups: 0,
      };

      const supervisionRows = goldRecords.map(record => convertGoldToSupervisionRow(record));
      await writeJsonlAtomic(supervisionRowsPath, supervisionRows);
      const gateRows = dataGateRowsForRunner(studentGroups, supervisionRows, config.route);
      await writeJsonlAtomic(dataGateRowsPath, gateRows);
      dataGate = await validateUnified64SlotTrainingData({
        ...config.dataGate,
        rowsPath: dataGateRowsPath,
      });
      let trainableGroups = 0;
      if (dataGate.status !== "DATA_INVALID") {
        trainableGroups = buildEncodedGroups(studentGroups, supervisionRows).length;
      }
      counts = {
        studentGroups: studentGroups.length,
        studentRows: studentRows.length,
        supervisionRows: supervisionRows.length,
        labelMissingExcluded: dataGate.counts.labelMissingExcluded,
        trainableGroups,
      };
      if (dataGate.status === "DATA_INVALID") {
        const firstViolation = dataGate.firstViolation;
        error = firstViolation !== null && firstViolation.reasonCode === "ALLOWED_NOT_SUBSET"
          ? {
              ...firstViolation,
              message: firstViolation.message.replace("is not in S_g", "is outside S_g"),
            }
          : firstViolation;
        return await finalize("DATA_INVALID", 1);
      }
      return await finalize(dataGate.status === "NO_LEARNED_ROWS" ? "NO_LEARNED_ROWS" : "READY", 0);
    }

    const admissions = await loadUnifiedFamilyAdmissions(corpus.admissionsPath);
    const studentGroups = await loadStudentRowsFile(studentRowsPath);
    const supervisionRows = await loadSupervisionRowsFile(supervisionRowsPath);
    for (const group of studentGroups) {
      requireAdmittedTrainingSource(admissions, group.sourceGroup);
    }
    for (const row of supervisionRows) {
      requireAdmittedTrainingSource(admissions, row.sourceGroup);
    }
    dataGate = await validateUnified64SlotTrainingData(config.dataGate);
    const encodedGroups = dataGate.status === "DATA_INVALID"
      ? []
      : buildEncodedGroups(studentGroups, supervisionRows);
    counts = {
      studentGroups: studentGroups.length,
      studentRows: studentRowsForRunner(studentGroups).length,
      supervisionRows: supervisionRows.length,
      labelMissingExcluded: dataGate.counts.labelMissingExcluded,
      trainableGroups: encodedGroups.length,
    };
    if (dataGate.status === "DATA_INVALID") {
      error = dataGate.firstViolation;
      return await finalize("DATA_INVALID", 1);
    }
    if (dataGate.status === "NO_LEARNED_ROWS") {
      return await finalize("NO_LEARNED_ROWS", 0);
    }
    const nonFiniteInput = findNonFiniteUnifiedInput(encodedGroups);
    if (nonFiniteInput !== null) {
      trainReport = nonFiniteUnifiedTrainReport(encodedGroups.length, nonFiniteInput);
      error = { code: "non_finite", message: nonFiniteInput };
      return await finalize("failed", 1);
    }
    const trainConfig = buildUnifiedTrainConfig(config);
    const result = runUnifiedTraining(encodedGroups, trainConfig);
    trainReport = result.report;
    if (result.report.stopReason !== "epoch_limit_exhausted") {
      error = {
        code: result.report.stopReason,
        message: result.report.violations.join("; ") || `training stopped with ${result.report.stopReason}`,
      };
      return await finalize("failed", 1);
    }
    const savedPackage = await saveUnifiedTrainPackage(packagePath, trainConfig, result.tensors);
    packageReload = await verifyUnifiedPackageReloadInNewProcess(packagePath, savedPackage);
    return await finalize("completed", 0);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    if (caught instanceof UnifiedTrainDataError) {
      error = { code: "DATA_INVALID", message };
      return await finalize("DATA_INVALID", 1);
    }
    error = { code: "RUNNER_ERROR", message };
    return await finalize("failed", 1);
  }
}

const isMainModule = (() => {
  try {
    return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  runStandardRunnerCli(process.argv.slice(2))
    .then(code => {
      process.exitCode = code;
    })
    .catch(err => {
      process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
