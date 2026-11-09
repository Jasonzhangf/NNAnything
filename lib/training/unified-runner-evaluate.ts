import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createTsJsFileBackedStepExecutor,
  runTsJsUnifiedMultiStepDecision,
} from "../adapters/tsjs-unified-recursive.js";
import {
  evaluateRelationOracle,
  type GoldDenominator,
  type IndependentOracleSample,
  type OracleJudgement,
  type PerStepEvaluation,
  type RelationOracleGoldSource,
  type RelationOracleReport,
  type RootEvaluation,
  type StepOutcome,
  type StudentRootConditionState,
  type StudentPredictionDenominator,
  type StudentRelationRun,
} from "./relation-oracle-evaluator.js";
import type { RelationStepEpisode } from "./unified-step-context-builder.js";
import { loadStepwiseEpisodeFamily } from "./unified-student-converter.js";
import { loadGoldFamily, type GoldRecord } from "./unified-supervision-converter.js";
import { loadUnifiedModelPackageFromFile, UnifiedModelPackageError } from "./unified-model-package.js";
import { monotonicSeconds } from "./unified-timing.js";

export const UNIFIED_EVALUATE_CONFIG_SCHEMA = "nnanything.unified.evaluate-config.v1" as const;
export const UNIFIED_EVALUATE_REPORT_SCHEMA = "nnanything.unified.evaluate-report.v1" as const;

export interface UnifiedRunnerEvaluateConfig {
  readonly schema: typeof UNIFIED_EVALUATE_CONFIG_SCHEMA;
  readonly candidatePackagePath: string;
  readonly independentFamilyPath: string;
  readonly admissionsPath: string;
  readonly consumerEntry: string;
  readonly runId: string;
}

export type UnifiedRunnerEvaluateErrorCode =
  | "EVALUATION_INVALID"
  | "CANDIDATE_MISSING"
  | "CANDIDATE_INVALID"
  | "ADMISSION_MISSING"
  | "ADMISSION_NOT_INDEPENDENT"
  | "ADMISSION_AMBIGUOUS"
  | "GOLD_INVALID"
  | "GOLD_MISSING"
  | "STUDENT_INPUT_INVALID"
  | "EXECUTION_RECEIPT_MISSING"
  | "POST_STATE_MISSING"
  | "ROOT_EVIDENCE_MISSING"
  | "ROOT_MODEL_DISAGREEMENT"
  | "CONSUMER_ENTRY_UNSUPPORTED";

export class UnifiedRunnerEvaluateError extends Error {
  readonly code: UnifiedRunnerEvaluateErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(code: UnifiedRunnerEvaluateErrorCode, message: string, detail: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "UnifiedRunnerEvaluateError";
    this.code = code;
    this.detail = detail;
  }
}

export interface UnifiedRunnerEvaluateRequest {
  readonly commandStartNs: bigint;
  readonly startedAt: string;
  readonly route: Readonly<{
    readonly domain: string;
    readonly decisionKind: "R" | "D" | "E" | "A";
  }>;
  readonly phase: string;
  readonly encoderVersion: string;
  readonly outputDir: string;
  readonly evaluate: UnifiedRunnerEvaluateConfig | undefined;
}

export interface UnifiedEvaluateExecutionEntry {
  readonly sampleId: string;
  readonly stepId: string;
  readonly candidateRef: string;
  readonly optionSemantics: string;
  readonly score: number;
  readonly executionReceiptRef: string;
  readonly postStateRef: string;
  readonly newStateRef: string;
  readonly actionRef: string;
  readonly outcome: "success" | "failed";
  readonly nextStepId: string | null;
  readonly previousActionRef: string | null;
  readonly failure: Readonly<{
    readonly code: string;
    readonly message: string;
    readonly nativeCode: string | null;
  }> | null;
}

export interface UnifiedEvaluateSampleStepDetail {
  readonly stepId: string;
  readonly optionSemantics: string;
  readonly predicted: OracleJudgement | null;
  readonly gold: OracleJudgement | null;
  readonly outcome: StepOutcome | null;
  readonly executionReceiptRef: string | null;
  readonly postStateRef: string | null;
  readonly evidenceRefs: readonly string[];
}

export interface UnifiedEvaluateSampleDetail {
  readonly sampleId: string;
  readonly partition: string;
  readonly gold: OracleJudgement | null;
  readonly labelMissing: boolean;
  readonly predicted: OracleJudgement | null;
  readonly root: UnifiedRootState;
  readonly rootEvidenceRefs: readonly string[];
  readonly rootConditionStates: readonly StudentRootConditionState[];
  readonly steps: readonly UnifiedEvaluateSampleStepDetail[];
}

export type UnifiedRootState = "satisfied" | "unsatisfied" | "unknown" | "not_evaluated" | "missing";

export interface UnifiedEvaluateReport {
  readonly schema: typeof UNIFIED_EVALUATE_REPORT_SCHEMA;
  readonly runId: string;
  readonly command: "evaluate";
  readonly route: UnifiedRunnerEvaluateRequest["route"];
  readonly phase: string;
  readonly encoderVersion: string;
  readonly status: "completed" | "failed";
  readonly startedAt: string;
  readonly endedAt: string;
  readonly evaluationSeconds: number;
  readonly totalWallSeconds: number;
  readonly candidate: Readonly<{
    readonly packagePath: string | null;
    readonly schema: string | null;
    readonly modelId: string | null;
    readonly version: string | null;
    readonly route: UnifiedRunnerEvaluateRequest["route"] | null;
  }>;
  readonly admission: Readonly<{
    readonly familyPath: string | null;
    readonly sourceGroup: string | null;
    readonly partition: string | null;
    readonly evidence: string | null;
  }>;
  readonly consumerEntry: string | null;
  readonly gold: GoldDenominator;
  readonly studentPrediction: StudentPredictionDenominator;
  readonly perStepEvaluation: PerStepEvaluation;
  readonly rootEvaluation: RootEvaluation;
  readonly sampleDetails: readonly UnifiedEvaluateSampleDetail[];
  readonly executionEntries: readonly UnifiedEvaluateExecutionEntry[];
  readonly overall: RelationOracleReport["overall"];
  readonly unknownRecall: number;
  readonly validUnknown: RelationOracleReport["validUnknown"];
  readonly violations: readonly string[];
  readonly unassessed: readonly string[];
  readonly missingRun: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly candidateOutput: Readonly<{
    readonly emitted: false;
    readonly packagePath: null;
  }>;
  readonly error: Readonly<{
    readonly code: UnifiedRunnerEvaluateErrorCode;
    readonly message: string;
    readonly detail?: Readonly<Record<string, unknown>>;
  }> | null;
  readonly paths: Readonly<{
    readonly outputDir: string;
    readonly reportJsonPath: string;
    readonly reportMdPath: string;
  }>;
}

const EMPTY_ORACLE = evaluateRelationOracle([], []);
const STUDENT_OBSERVATIONS_FILE = "student-observations.jsonl";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new UnifiedRunnerEvaluateError("EVALUATION_INVALID", `${field} must be a non-empty string`);
  }
  return value;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new UnifiedRunnerEvaluateError("EVALUATION_INVALID", `file is missing: ${resolved}`);
  }
  const parsed = JSON.parse(await readFile(resolved, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new UnifiedRunnerEvaluateError("EVALUATION_INVALID", `file must contain a JSON object: ${resolved}`);
  }
  return parsed;
}

function requireEvaluateConfig(config: UnifiedRunnerEvaluateConfig | undefined): UnifiedRunnerEvaluateConfig {
  if (config === undefined) {
    throw new UnifiedRunnerEvaluateError("EVALUATION_INVALID", "evaluate requires config.evaluate");
  }
  if (config.schema !== UNIFIED_EVALUATE_CONFIG_SCHEMA) {
    throw new UnifiedRunnerEvaluateError("EVALUATION_INVALID", "config.evaluate.schema is not supported");
  }
  requireString(config.candidatePackagePath, "config.evaluate.candidatePackagePath");
  requireString(config.independentFamilyPath, "config.evaluate.independentFamilyPath");
  requireString(config.admissionsPath, "config.evaluate.admissionsPath");
  requireString(config.runId, "config.evaluate.runId");
  if (config.consumerEntry !== "tsjs-unified-recursive:runTsJsUnifiedMultiStepDecision") {
    throw new UnifiedRunnerEvaluateError("CONSUMER_ENTRY_UNSUPPORTED", `unsupported evaluate consumer entry: ${String(config.consumerEntry)}`);
  }
  return config;
}

function scanStudentLeakage(value: unknown, path = "student"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanStudentLeakage(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (/^(?:a_g|gold|teacher|oracle|originalLabel|recomputed|goal_met)$/i.test(key)
      || /^(?:future[_-]?receipt)/i.test(key)) {
      throw new UnifiedRunnerEvaluateError("STUDENT_INPUT_INVALID", `${path}.${key} is supervision-only data`);
    }
    scanStudentLeakage(nested, `${path}.${key}`);
  }
}

async function assertStudentInputIsolated(familyDir: string): Promise<void> {
  const path = join(familyDir, STUDENT_OBSERVATIONS_FILE);
  const rows = (await readFile(path, "utf8")).split("\n").flatMap(line => {
    if (line.trim().length === 0) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      throw new UnifiedRunnerEvaluateError("STUDENT_INPUT_INVALID", `${path} contains invalid JSON: ${message}`);
    }
  });
  rows.forEach((row, index) => scanStudentLeakage(row, `student[${index}]`));
}

function goldSourceOf(oracleKind: string): RelationOracleGoldSource {
  const lower = oracleKind.toLowerCase();
  if (lower.includes("typescript-language-service")) return "typescript-language-service";
  if (lower.includes("manual-structural-proof")) return "manual-structural-proof";
  if (lower.includes("tsc")) return "tsc";
  throw new UnifiedRunnerEvaluateError("GOLD_INVALID", `unsupported oracle kind: ${oracleKind}`);
}

function oracleJudgementOf(gold: GoldRecord): OracleJudgement {
  if (!gold.goldAction.startsWith("c:judge:")) {
    throw new UnifiedRunnerEvaluateError("GOLD_INVALID", `sample ${gold.sampleId} has a non-judge gold action`);
  }
  const label = gold.goldAction.slice("c:judge:".length);
  if (label !== "true" && label !== "false" && label !== "unknown") {
    throw new UnifiedRunnerEvaluateError("GOLD_INVALID", `sample ${gold.sampleId} has an invalid gold judgement`);
  }
  return label;
}

async function loadAdmission(
  manifest: Record<string, unknown>,
  admissionsPath: string,
): Promise<{
  readonly sourceGroup: string;
  readonly partition: string;
  readonly evidence: string | null;
}> {
  const sourceGroup = requireString(manifest.sourceGroup, "manifest.sourceGroup");
  const partition = requireString(manifest.partition, "manifest.partition");
  const derivationFamily = manifest.derivationFamily;
  if (
    !isRecord(derivationFamily)
    || derivationFamily.independentVerificationEligible !== true
  ) {
    throw new UnifiedRunnerEvaluateError("ADMISSION_NOT_INDEPENDENT", `family ${sourceGroup} is not independent-verification eligible`);
  }

  const admissions = await readJson(admissionsPath);
  const entries = admissions.familyAdmissions;
  if (!Array.isArray(entries)) {
    throw new UnifiedRunnerEvaluateError("EVALUATION_INVALID", "admissions.familyAdmissions must be an array");
  }
  const matches = entries.filter(entry =>
    isRecord(entry) && entry.sourceGroup === sourceGroup
  );
  if (matches.length === 0) {
    throw new UnifiedRunnerEvaluateError("ADMISSION_MISSING", `family ${sourceGroup} is not declared in admissions`);
  }
  if (matches.length > 1) {
    throw new UnifiedRunnerEvaluateError("ADMISSION_AMBIGUOUS", `family ${sourceGroup} has multiple admissions`);
  }
  const admission = matches[0];
  if (!isRecord(admission)) {
    throw new UnifiedRunnerEvaluateError("EVALUATION_INVALID", "admission must be an object");
  }
  const admittedPartition = requireString(admission.partition, "admission.partition");
  const usable = admission.usableForIndependentVerification === true;
  const partitionMatches = admittedPartition.toLowerCase() === partition.toLowerCase();
  if (!usable || !partitionMatches || partition.toLowerCase() === "train" || partition.toLowerCase() === "dev") {
    throw new UnifiedRunnerEvaluateError("ADMISSION_NOT_INDEPENDENT", `family ${sourceGroup} is not admitted as an independent verification source`);
  }
  const evidence = typeof admission.evidence === "string" ? admission.evidence : null;
  return { sourceGroup, partition, evidence };
}

function mapGoldSamples(
  goldRows: readonly GoldRecord[],
  episodes: readonly RelationStepEpisode[],
  oracleRefs: readonly string[],
): readonly IndependentOracleSample[] {
  const targets = new Map(episodes.map(episode => [episode.sampleId, episode.targetRef]));
  return goldRows.map(gold => {
    const targetRef = targets.get(gold.sampleId);
    if (targetRef === undefined) {
      throw new UnifiedRunnerEvaluateError("GOLD_MISSING", `gold sample ${gold.sampleId} has no student episode`);
    }
    if (gold.labelMissing) {
      return {
        sampleId: gold.sampleId,
        targetRef,
        gold: "unknown",
        goldSource: "tsc",
        goldEvidence: [],
        labelMissing: true,
      };
    }
    if (oracleRefs.length === 0) {
      throw new UnifiedRunnerEvaluateError("GOLD_INVALID", `sample ${gold.sampleId} has no independent oracle evidence`);
    }
    return {
      sampleId: gold.sampleId,
      targetRef,
      gold: oracleJudgementOf(gold),
      goldSource: goldSourceOf(gold.oracleKind),
      goldEvidence: oracleRefs.map(ref => ({ evidenceRef: ref, typeStep: "receipt" as const })),
      labelMissing: false,
    };
  });
}

function mapGoldSamplesForAccounting(
  goldRows: readonly GoldRecord[],
  episodes: readonly RelationStepEpisode[],
  oracleRefs: readonly string[],
): readonly IndependentOracleSample[] {
  const targets = new Map(episodes.map(episode => [episode.sampleId, episode.targetRef]));
  const seen = new Set<string>();
  const rows: IndependentOracleSample[] = [];
  for (const gold of goldRows) {
    if (seen.has(gold.sampleId)) continue;
    seen.add(gold.sampleId);
    const targetRef = targets.get(gold.sampleId) ?? gold.sampleId;
    if (gold.labelMissing || oracleRefs.length === 0) {
      rows.push({
        sampleId: gold.sampleId,
        targetRef,
        gold: "unknown",
        goldSource: "tsc",
        goldEvidence: [],
        labelMissing: true,
      });
      continue;
    }
    rows.push({
      sampleId: gold.sampleId,
      targetRef,
      gold: oracleJudgementOf(gold),
      goldSource: goldSourceOf(gold.oracleKind),
      goldEvidence: oracleRefs.map(ref => ({ evidenceRef: ref, typeStep: "receipt" as const })),
      labelMissing: false,
    });
  }
  return rows;
}

// Independent supervision validation: identity, source group and partition.
// Runs before any student-dependent loading so the admitted denominator
// survives a missing or malformed student file.
function assertGoldRowsValid(
  admission: { readonly sourceGroup: string; readonly partition: string },
  goldRows: readonly GoldRecord[],
): void {
  const goldSamples = new Set<string>();
  for (const gold of goldRows) {
    if (goldSamples.has(gold.sampleId)) {
      throw new UnifiedRunnerEvaluateError("GOLD_INVALID", `duplicate gold sample ${gold.sampleId}`);
    }
    goldSamples.add(gold.sampleId);
    if (gold.sourceGroup !== admission.sourceGroup) {
      throw new UnifiedRunnerEvaluateError(
        "GOLD_INVALID",
        `gold sample ${gold.sampleId} source group ${gold.sourceGroup} does not match admitted family ${admission.sourceGroup}`,
      );
    }
    if (gold.partition.toLowerCase() !== admission.partition.toLowerCase()) {
      throw new UnifiedRunnerEvaluateError(
        "GOLD_INVALID",
        `gold sample ${gold.sampleId} partition ${gold.partition} does not match admitted family ${admission.partition}`,
      );
    }
  }
}

function assertGoldStudentMembership(
  goldRows: readonly GoldRecord[],
  episodes: readonly RelationStepEpisode[],
): void {
  const episodeSamples = new Set(episodes.map(episode => episode.sampleId));
  const goldSamples = new Set(goldRows.map(gold => gold.sampleId));
  for (const gold of goldRows) {
    if (!episodeSamples.has(gold.sampleId)) {
      throw new UnifiedRunnerEvaluateError("GOLD_MISSING", `gold sample ${gold.sampleId} has no student episode`);
    }
  }
  for (const episodeSample of episodeSamples) {
    if (!goldSamples.has(episodeSample)) {
      throw new UnifiedRunnerEvaluateError("GOLD_MISSING", `student sample ${episodeSample} has no independent gold supervision`);
    }
  }
}

function judgeOf(optionSemantics: string): OracleJudgement | null {
  if (!optionSemantics.startsWith("judge=")) return null;
  const value = optionSemantics.slice("judge=".length);
  return value === "true" || value === "false" || value === "unknown" ? value : null;
}

interface MultiStepMappingFailure {
  readonly code: UnifiedRunnerEvaluateErrorCode;
  readonly message: string;
  readonly affectedStepId: string | undefined;
  readonly detail: Readonly<Record<string, unknown>>;
}

// A failed step execution is the most specific error. Report it before the
// coarser "no terminal judge" and root-evidence checks so the original
// execution failure (code/message/nativeCode) and failed step id survive.
function failedStepFailureOf(sampleId: string, result: Awaited<ReturnType<typeof runTsJsUnifiedMultiStepDecision>>): MultiStepMappingFailure | null {
  const failedStep = result.steps.find(step => step.executionReceipt.outcome !== "success");
  if (failedStep === undefined) return null;
  const receiptFailure = failedStep.executionReceipt.failure;
  return {
    code: "EXECUTION_RECEIPT_MISSING",
    message: receiptFailure === null || receiptFailure === undefined
      ? `sample ${sampleId} step ${failedStep.stepId} execution failed`
      : `sample ${sampleId} step ${failedStep.stepId} execution failed: ${receiptFailure.code}: ${receiptFailure.message}`,
    affectedStepId: failedStep.stepId,
    detail: {
      affectedStepId: failedStep.stepId,
      executionFailure: receiptFailure ?? null,
      executionReceiptRef: `receipt:${failedStep.executionReceipt.receiptId}`,
      observedPostStateRef: failedStep.observedPostState.postStateRef,
    },
  };
}

function rootEvidenceFailureOf(sampleId: string, result: Awaited<ReturnType<typeof runTsJsUnifiedMultiStepDecision>>): MultiStepMappingFailure | null {
  if (result.rootEvaluation.state !== "evaluated") {
    return {
      code: "ROOT_EVIDENCE_MISSING",
      message: `sample ${sampleId} has no evaluated root`,
      affectedStepId: undefined,
      detail: { rootState: result.rootEvaluation.state },
    };
  }
  if (result.rootEvaluation.evidenceRefs.length === 0) {
    return {
      code: "ROOT_EVIDENCE_MISSING",
      message: `sample ${sampleId} has an evaluated root with no evidence`,
      affectedStepId: undefined,
      detail: { rootState: result.rootEvaluation.state, rootEvidenceRefs: [...result.rootEvaluation.evidenceRefs] },
    };
  }
  return null;
}

function studentRunOfMultiStep(
  episodes: readonly RelationStepEpisode[],
  result: Awaited<ReturnType<typeof runTsJsUnifiedMultiStepDecision>>,
): {
  readonly run: StudentRelationRun;
  readonly executionEntries: readonly UnifiedEvaluateExecutionEntry[];
  readonly failure: MultiStepMappingFailure | null;
} {
  const sampleId = episodes[0]!.sampleId;
  if (episodes.some(episode => episode.sampleId !== sampleId)) {
    throw new UnifiedRunnerEvaluateError("EVALUATION_INVALID", `multi-step episodes must belong to one sample: ${sampleId}`);
  }
  if (result.recursiveGoal.kind !== "run_result") {
    throw new UnifiedRunnerEvaluateError("EXECUTION_RECEIPT_MISSING", `sample ${sampleId} did not produce a completed recursive-goal run`);
  }
  if (result.steps.length === 0) {
    throw new UnifiedRunnerEvaluateError("EXECUTION_RECEIPT_MISSING", `sample ${sampleId} produced no executed steps`);
  }

  const root = result.rootEvaluation;
  const evaluatedRoot = root.state === "evaluated" ? root : null;
  const conditionRef = evaluatedRoot === null ? `root:${sampleId}` : `root:${evaluatedRoot.evaluatorId}:${sampleId}`;
  const rootResult = evaluatedRoot?.result ?? null;
  const rootSatisfied = evaluatedRoot === null
    ? null
    : evaluatedRoot.result === "satisfied" ? true : evaluatedRoot.result === "unsatisfied" ? false : null;
  const rootGaps = evaluatedRoot?.result === "unsatisfied" ? [conditionRef] : [];
  const rootConditionStates: StudentRootConditionState[] = evaluatedRoot === null
    ? []
    : [{ conditionRef, state: evaluatedRoot.result }];
  const rootEvidenceRefs = evaluatedRoot === null ? [] : [...evaluatedRoot.evidenceRefs];
  const executionEntries: UnifiedEvaluateExecutionEntry[] = [];
  const steps: StudentRelationRun["steps"] = result.steps.map(step => {
    const choice = step.candidateChoice;
    const receipt = step.executionReceipt;
    const postState = step.observedPostState;
    const executionEntry: UnifiedEvaluateExecutionEntry = {
      sampleId,
      stepId: step.stepId,
      candidateRef: choice.candidateRef,
      optionSemantics: choice.optionSemantics,
      score: choice.score,
      executionReceiptRef: `receipt:${receipt.receiptId}`,
      postStateRef: postState.postStateRef,
      newStateRef: postState.stateRef,
      actionRef: receipt.actionRef,
      outcome: receipt.outcome,
      nextStepId: step.nextStepId,
      previousActionRef: step.previousActionRef,
      failure: receipt.failure ?? null,
    };
    executionEntries.push(executionEntry);
    return {
      stepId: step.stepId,
      optionSemantics: choice.optionSemantics,
      executionReceiptRef: executionEntry.executionReceiptRef,
      postStateRef: executionEntry.postStateRef,
      // Failure diagnostics stay in the typed failure and error.detail;
      // evidenceRefs carry only real receipt and observation evidence.
      evidenceRefs: [...receipt.evidenceRefs, ...postState.observedFacts],
    };
  });
  const run: StudentRelationRun = {
    sampleId,
    steps,
    rootConditionStates,
    rootGaps,
    rootEvidenceRefs,
    rootEvaluationState: root.state === "evaluated" ? "evaluated" : "not_evaluated",
    rootSatisfied,
  };
  const stepFailure = failedStepFailureOf(sampleId, result);
  if (stepFailure !== null) {
    return { run, executionEntries, failure: stepFailure };
  }
  if (!steps.some(step => judgeOf(step.optionSemantics) !== null)) {
    return {
      run,
      executionEntries,
      failure: {
        code: "EXECUTION_RECEIPT_MISSING",
        message: `sample ${sampleId} produced no terminal judge step`,
        affectedStepId: undefined,
        detail: { stepIds: result.steps.map(step => step.stepId) },
      },
    };
  }
  return {
    run,
    executionEntries,
    failure: rootEvidenceFailureOf(sampleId, result),
  };
}

function rootStateOf(run: StudentRelationRun | undefined): UnifiedRootState {
  if (run === undefined) return "missing";
  // Availability comes from the engine's explicit root evaluation state, never
  // from a null result. The completed-run path currently reports "evaluated";
  // "not_evaluated" is retained for an engine-reported unevaluated root.
  if (run.rootEvaluationState === "not_evaluated") return "not_evaluated";
  if (run.rootSatisfied === null) return "unknown";
  return run.rootSatisfied ? "satisfied" : "unsatisfied";
}

function buildSampleDetails(
  samples: readonly IndependentOracleSample[],
  episodes: readonly RelationStepEpisode[],
  runs: readonly StudentRelationRun[],
): readonly UnifiedEvaluateSampleDetail[] {
  const runsBySample = new Map(runs.map(run => [run.sampleId, run]));
  const partitions = new Map(episodes.map(episode => [episode.sampleId, episode.partition]));
  return samples.map(sample => {
    const run = runsBySample.get(sample.sampleId);
    const gold = sample.labelMissing ? null : sample.gold;
    const steps = (run?.steps ?? []).map(step => {
      const predicted = judgeOf(step.optionSemantics);
      const outcome = gold === null || predicted === null
        ? null
        : (predicted === gold ? "correct" : predicted === "unknown" ? "unknown" : "incorrect") as StepOutcome;
      return {
        stepId: step.stepId,
        optionSemantics: step.optionSemantics,
        predicted,
        gold,
        outcome,
        executionReceiptRef: step.executionReceiptRef,
        postStateRef: step.postStateRef,
        evidenceRefs: [...step.evidenceRefs],
      };
    });
    const predicted = [...steps].reverse().find(step => step.predicted !== null)?.predicted ?? null;
    return {
      sampleId: sample.sampleId,
      partition: partitions.get(sample.sampleId) ?? "unknown",
      gold,
      labelMissing: sample.labelMissing,
      predicted,
      root: rootStateOf(run),
      rootEvidenceRefs: [...(run?.rootEvidenceRefs ?? [])],
      rootConditionStates: [...(run?.rootConditionStates ?? [])],
      steps,
    };
  });
}

function missingRunOf(
  samples: readonly IndependentOracleSample[],
  runs: readonly StudentRelationRun[],
): readonly string[] {
  const runSamples = new Set(runs.map(run => run.sampleId));
  return samples
    .filter(sample => !sample.labelMissing && !runSamples.has(sample.sampleId))
    .map(sample => sample.sampleId);
}

function emptyEvidenceRefs(report: RelationOracleReport): readonly string[] {
  return [
    ...report.rootEvaluation.entries.flatMap(entry => entry.gaps),
    ...report.perStepEvaluation.entries.map(entry => `${entry.sampleId}:${entry.stepId}`),
  ];
}

function formatMarkdown(report: UnifiedEvaluateReport): string {
  const lines = [
    `# Unified Runner Evaluate Report (${report.runId})`,
    "",
    `- Command: \`${report.command}\``,
    `- Status: \`${report.status}\``,
    `- Route: \`${report.route.domain}/${report.route.decisionKind}\``,
    `- Candidate Package: \`${String(report.candidate.packagePath)}\``,
    `- Family: \`${String(report.admission.familyPath)}\``,
    `- Consumer Entry: \`${String(report.consumerEntry)}\``,
    `- Candidate Output Emitted: \`${String(report.candidateOutput.emitted)}\``,
    `- Gold: \`${report.gold.total}\``,
    `- Student Predictions: \`${report.studentPrediction.total}\``,
    `- Per-Step: \`${report.perStepEvaluation.correct}/${report.perStepEvaluation.unknown}/${report.perStepEvaluation.incorrect}\``,
    `- Root: \`${report.rootEvaluation.evaluated}/${report.rootEvaluation.satisfied}/${report.rootEvaluation.unsatisfied}/${report.rootEvaluation.unknown}\``,
    `- Unknown Recall: \`${report.unknownRecall.toFixed(4)}\``,
    `- Valid Unknown: \`correct=${report.validUnknown.correct}, missed=${report.validUnknown.missed}, wrong=${report.validUnknown.wrongTrueOrFalse}, final=${report.validUnknown.finalUnknown}\``,
    `- Overall: \`${report.overall}\``,
    `- Violations: \`${report.violations.length}\``,
    `- Evaluation Seconds: \`${report.evaluationSeconds.toFixed(6)}\``,
    `- Total Wall Seconds: \`${report.totalWallSeconds.toFixed(6)}\``,
    `- Machine Detail: \`${report.paths.reportJsonPath}\``,
    "",
  ];
  if (report.error !== null) {
    lines.push("## Error", "", "```json", JSON.stringify(report.error, null, 2), "```", "");
  }
  if (report.violations.length > 0) {
    lines.push("## Violations", "");
    for (const violation of report.violations) lines.push(`- ${violation}`);
    lines.push("");
  }
  if (report.missingRun.length > 0) {
    lines.push("## Missing Runs", "");
    for (const sampleId of report.missingRun) lines.push(`- ${sampleId}`);
    lines.push("");
  }
  lines.push("## Sample Details", "");
  for (const sample of report.sampleDetails) {
    lines.push(
      `- ${sample.sampleId}: gold=${String(sample.gold)} predicted=${String(sample.predicted)} root=${String(sample.root)} rootEvidence=${sample.rootEvidenceRefs.join(",")} labelMissing=${String(sample.labelMissing)}`,
    );
    for (const condition of sample.rootConditionStates) {
      lines.push(`  - rootCondition: ${condition.conditionRef} ${condition.state}`);
    }
    for (const step of sample.steps) {
      lines.push(
        `  - ${step.stepId}: ${step.optionSemantics} outcome=${String(step.outcome)} receipt=${step.executionReceiptRef} postState=${step.postStateRef} evidence=${step.evidenceRefs.join(",")}`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

export async function runUnifiedRunnerEvaluate(
  request: UnifiedRunnerEvaluateRequest,
): Promise<{
  readonly exitCode: number;
  readonly report: UnifiedEvaluateReport;
  readonly markdown: string;
}> {
  const startedAt = request.startedAt;
  const outputDir = resolve(request.outputDir);
  const evaluate = request.evaluate;
  const runId = evaluate?.runId ?? `evaluate-${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const reportPaths = {
    outputDir,
    reportJsonPath: join(outputDir, "runs", runId, "run-report.json"),
    reportMdPath: join(outputDir, "runs", runId, "run-report.md"),
  };
  const baselineCandidate = {
    packagePath: evaluate?.candidatePackagePath ?? null,
    schema: null,
    modelId: null,
    version: null,
    route: null,
  };
  const baselineAdmission = {
    familyPath: evaluate?.independentFamilyPath ?? null,
    sourceGroup: null,
    partition: null,
    evidence: null,
  };

  const finalize = (
    input: {
      readonly status: UnifiedEvaluateReport["status"];
      readonly evaluationSeconds: number;
      readonly candidate?: UnifiedEvaluateReport["candidate"];
      readonly admission?: UnifiedEvaluateReport["admission"];
      readonly consumerEntry?: string | null;
      readonly oracle?: RelationOracleReport;
      readonly sampleDetails?: readonly UnifiedEvaluateSampleDetail[];
      readonly executionEntries?: readonly UnifiedEvaluateExecutionEntry[];
      readonly evidenceRefs?: readonly string[];
      readonly missingRun?: readonly string[];
      readonly error?: UnifiedEvaluateReport["error"];
    },
  ): {
    readonly exitCode: number;
    readonly report: UnifiedEvaluateReport;
    readonly markdown: string;
  } => {
    const oracle = input.oracle ?? EMPTY_ORACLE;
    const evidenceRefs = input.evidenceRefs ?? emptyEvidenceRefs(oracle);
    const report: UnifiedEvaluateReport = {
      schema: UNIFIED_EVALUATE_REPORT_SCHEMA,
      runId,
      command: "evaluate",
      route: request.route,
      phase: request.phase,
      encoderVersion: request.encoderVersion,
      status: input.status,
      startedAt,
      endedAt: new Date().toISOString(),
      evaluationSeconds: input.evaluationSeconds,
      totalWallSeconds: monotonicSeconds(request.commandStartNs),
      candidate: input.candidate ?? baselineCandidate,
      admission: input.admission ?? baselineAdmission,
      consumerEntry: input.consumerEntry ?? null,
      gold: oracle.gold,
      studentPrediction: oracle.studentPrediction,
      perStepEvaluation: oracle.perStepEvaluation,
      rootEvaluation: oracle.rootEvaluation,
      sampleDetails: input.sampleDetails ?? [],
      executionEntries: input.executionEntries ?? [],
      overall: oracle.overall,
      unknownRecall: oracle.unknownRecall,
      validUnknown: oracle.validUnknown,
      violations: oracle.violations,
      unassessed: oracle.perStepEvaluation.entries.filter(entry => entry.outcome === "unknown").map(entry => `${entry.sampleId}:${entry.stepId}`),
      missingRun: input.missingRun ?? [],
      evidenceRefs,
      candidateOutput: { emitted: false, packagePath: null },
      error: input.error ?? null,
      paths: reportPaths,
    };
    return {
      exitCode: input.status === "completed" ? 0 : 1,
      report,
      markdown: formatMarkdown(report),
    };
  };

  const evaluationStartNs = process.hrtime.bigint();
  let samples: readonly IndependentOracleSample[] = [];
  let episodes: readonly RelationStepEpisode[] = [];
  let goldRowsForAccounting: readonly GoldRecord[] = [];
  let oracleRefsForAccounting: readonly string[] = [];
  const runs: StudentRelationRun[] = [];
  const executionEntries: UnifiedEvaluateExecutionEntry[] = [];
  const evidenceRefs = new Set<string>();
  let affectedSampleId: string | undefined;
  let affectedStepId: string | undefined;

  const partialFailureState = () => {
    let oracle: RelationOracleReport = EMPTY_ORACLE;
    let sampleDetails: readonly UnifiedEvaluateSampleDetail[] = [];
    let missingRun: readonly string[] = [];
    const accountingSamples = samples.length > 0
      ? samples
      : mapGoldSamplesForAccounting(goldRowsForAccounting, episodes, oracleRefsForAccounting);
    if (accountingSamples.length > 0) {
      try {
        oracle = evaluateRelationOracle(accountingSamples, runs);
        sampleDetails = buildSampleDetails(accountingSamples, episodes, runs);
        missingRun = missingRunOf(accountingSamples, runs);
      } catch {
        // Keep the original execution error; partial accounting is best effort.
      }
    }
    return { oracle, sampleDetails, missingRun };
  };

  try {
    const config = requireEvaluateConfig(evaluate);
    const packagePath = resolve(config.candidatePackagePath);
    const loaded = await loadUnifiedModelPackageFromFile(packagePath);
    const loadedPackage = loaded.package;
    if (
      loadedPackage.route.domain !== request.route.domain
      || loadedPackage.route.decisionKind !== request.route.decisionKind
      || loadedPackage.encoderVersion !== request.encoderVersion
    ) {
      throw new UnifiedRunnerEvaluateError("CANDIDATE_INVALID", "candidate package route or encoder version does not match the evaluate config");
    }

    const familyDir = resolve(config.independentFamilyPath);
    const manifest = await readJson(join(familyDir, "manifest.json"));
    const admission = await loadAdmission(manifest, config.admissionsPath);
    // Load and validate independent supervision first. If the student file is
    // absent or malformed, partial accounting keeps the admitted gold
    // denominator and sample identities instead of reporting an empty set.
    const goldRows = await loadGoldFamily(familyDir);
    assertGoldRowsValid(admission, goldRows);
    goldRowsForAccounting = goldRows;
    const manifestOracleRefs = manifest.oracleRefs;
    const oracleRefs = Array.isArray(manifestOracleRefs)
      ? manifestOracleRefs.filter((ref): ref is string => typeof ref === "string")
      : [];
    oracleRefsForAccounting = oracleRefs;
    await assertStudentInputIsolated(familyDir);
    episodes = await loadStepwiseEpisodeFamily(familyDir);
    assertGoldStudentMembership(goldRows, episodes);
    samples = mapGoldSamples(goldRows, episodes, oracleRefs);

    const episodesBySample = new Map<string, RelationStepEpisode[]>();
    for (const episode of episodes) {
      const group = episodesBySample.get(episode.sampleId) ?? [];
      group.push(episode);
      episodesBySample.set(episode.sampleId, group);
    }
    const executor = createTsJsFileBackedStepExecutor({ sourceRoot: familyDir });
    for (const sampleEpisodes of episodesBySample.values()) {
      const sampleId = sampleEpisodes[0]!.sampleId;
      affectedSampleId = sampleId;
      affectedStepId = undefined;
      const result = await runTsJsUnifiedMultiStepDecision({
        requestId: `evaluate:${runId}:${sampleId}`,
        packagePath,
        episodes: sampleEpisodes,
        grantedEffects: ["read_only"],
        executor,
      });
      if (
        result.modelBinding.packageRef !== packagePath
        || result.modelBinding.modelId !== loadedPackage.modelId
        || result.modelBinding.version !== loadedPackage.version
      ) {
        throw new UnifiedRunnerEvaluateError("CANDIDATE_INVALID", `sample ${sampleId} did not use the selected candidate package`);
      }
      const mapped = studentRunOfMultiStep(sampleEpisodes, result);
      runs.push(mapped.run);
      executionEntries.push(...mapped.executionEntries);
      if (result.rootEvaluation.state === "evaluated") {
        result.rootEvaluation.evidenceRefs.forEach(ref => evidenceRefs.add(ref));
      }
      if (mapped.failure !== null) {
        affectedStepId = mapped.failure.affectedStepId;
        throw new UnifiedRunnerEvaluateError(
          mapped.failure.code,
          mapped.failure.message,
          mapped.failure.detail,
        );
      }
    }
    const oracle = evaluateRelationOracle(samples, runs);
    const sampleDetails = buildSampleDetails(samples, episodes, runs);
    const evaluationSeconds = monotonicSeconds(evaluationStartNs);
    return finalize({
      status: "completed",
      evaluationSeconds,
      candidate: {
        packagePath,
        schema: loadedPackage.schema,
        modelId: loadedPackage.modelId,
        version: loadedPackage.version,
        route: loadedPackage.route,
      },
      admission: {
        familyPath: familyDir,
        sourceGroup: admission.sourceGroup,
        partition: admission.partition,
        evidence: admission.evidence,
      },
      consumerEntry: config.consumerEntry,
      oracle,
      sampleDetails,
      executionEntries,
      evidenceRefs: [...evidenceRefs],
      missingRun: missingRunOf(samples, runs),
    });
  } catch (caught) {
    const evaluationSeconds = monotonicSeconds(evaluationStartNs);
    const partial = partialFailureState();
    if (caught instanceof UnifiedRunnerEvaluateError) {
      const detail: Readonly<Record<string, unknown>> = {
        ...caught.detail,
        ...(affectedSampleId === undefined ? {} : { affectedSampleId }),
        ...(affectedStepId === undefined ? {} : { affectedStepId }),
      };
      return finalize({
        status: "failed",
        evaluationSeconds,
        oracle: partial.oracle,
        sampleDetails: partial.sampleDetails,
        executionEntries,
        evidenceRefs: [...evidenceRefs],
        missingRun: partial.missingRun,
        error: { code: caught.code, message: caught.message, detail },
      });
    }
    if (caught instanceof UnifiedModelPackageError) {
      const code: UnifiedRunnerEvaluateErrorCode =
        caught.code === "MODEL_NOT_FOUND" ? "CANDIDATE_MISSING" : "CANDIDATE_INVALID";
      return finalize({
        status: "failed",
        evaluationSeconds,
        oracle: partial.oracle,
        sampleDetails: partial.sampleDetails,
        executionEntries,
        evidenceRefs: [...evidenceRefs],
        missingRun: partial.missingRun,
        error: { code, message: caught.message, detail: caught.detail },
      });
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    return finalize({
      status: "failed",
      evaluationSeconds,
      oracle: partial.oracle,
      sampleDetails: partial.sampleDetails,
      executionEntries,
      evidenceRefs: [...evidenceRefs],
      missingRun: partial.missingRun,
      error: { code: "EVALUATION_INVALID", message },
    });
  }
}
