import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { runTsJsUnifiedDecision } from "../adapters/tsjs-unified-recursive.js";
import {
  evaluateRelationOracle,
  type GoldDenominator,
  type IndependentOracleSample,
  type OracleJudgement,
  type PerStepEvaluation,
  type RelationOracleGoldSource,
  type RelationOracleReport,
  type RootEvaluation,
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
}

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
  if (config.consumerEntry !== "tsjs-unified-recursive:runTsJsUnifiedDecision") {
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

function rootStateOf(result: "satisfied" | "unsatisfied" | "unknown"): "satisfied" | "unsatisfied" | "unknown" {
  return result;
}

function studentRunOf(
  episode: RelationStepEpisode,
  result: Awaited<ReturnType<typeof runTsJsUnifiedDecision>>,
): {
  readonly run: StudentRelationRun;
  readonly executionEntry: UnifiedEvaluateExecutionEntry;
} {
  const choice = result.candidateChoice;
  const receipt = result.executionReceipt;
  const postState = result.observedPostState;
  if (choice === null) {
    throw new UnifiedRunnerEvaluateError("EXECUTION_RECEIPT_MISSING", `sample ${episode.sampleId} produced no candidate choice`);
  }
  if (receipt === null) {
    throw new UnifiedRunnerEvaluateError("EXECUTION_RECEIPT_MISSING", `sample ${episode.sampleId} produced no execution receipt`);
  }
  if (receipt.outcome !== "success") {
    throw new UnifiedRunnerEvaluateError("EXECUTION_RECEIPT_MISSING", `sample ${episode.sampleId} execution did not succeed`);
  }
  if (postState === null) {
    throw new UnifiedRunnerEvaluateError("POST_STATE_MISSING", `sample ${episode.sampleId} produced no observed post-state`);
  }
  if (result.rootEvaluation.state !== "evaluated" || result.rootEvaluation.evidenceRefs.length === 0) {
    throw new UnifiedRunnerEvaluateError("ROOT_EVIDENCE_MISSING", `sample ${episode.sampleId} has no root evaluation evidence`);
  }

  const root = result.rootEvaluation;
  const rootResult = root.result;
  const isJudgeChoice = choice.optionSemantics.startsWith("judge=");
  if (isJudgeChoice && rootResult !== "satisfied") {
    throw new UnifiedRunnerEvaluateError("ROOT_MODEL_DISAGREEMENT", `sample ${episode.sampleId} selected a terminal judgement but the independent root was ${rootResult}`);
  }
  if (!isJudgeChoice && rootResult === "satisfied") {
    throw new UnifiedRunnerEvaluateError("ROOT_MODEL_DISAGREEMENT", `sample ${episode.sampleId} selected ${choice.optionSemantics} while the independent root was satisfied`);
  }
  const conditionRef = `root:${root.evaluatorId}:${episode.sampleId}`;
  const executionEntry: UnifiedEvaluateExecutionEntry = {
    sampleId: episode.sampleId,
    stepId: episode.stepId,
    candidateRef: choice.candidateRef,
    optionSemantics: choice.optionSemantics,
    score: choice.score,
    executionReceiptRef: `receipt:${receipt.receiptId}`,
    postStateRef: postState.postStateRef,
    newStateRef: postState.stateRef,
    actionRef: receipt.actionRef,
  };
  return {
    run: {
      sampleId: episode.sampleId,
      steps: [{
        stepId: episode.stepId,
        optionSemantics: choice.optionSemantics,
        executionReceiptRef: executionEntry.executionReceiptRef,
        postStateRef: executionEntry.postStateRef,
        evidenceRefs: [...receipt.evidenceRefs, ...postState.observedFacts],
      }],
      rootConditionStates: [{
        conditionRef,
        state: rootStateOf(rootResult),
      }],
      rootGaps: rootResult === "unsatisfied" ? [conditionRef] : [],
      rootSatisfied: rootResult === "satisfied" ? true : rootResult === "unsatisfied" ? false : null,
    },
    executionEntry,
  };
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
    "",
  ];
  if (report.error !== null) {
    lines.push("## Error", "", "```json", JSON.stringify(report.error, null, 2), "```", "");
  }
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
      readonly executionEntries?: readonly UnifiedEvaluateExecutionEntry[];
      readonly evidenceRefs?: readonly string[];
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
      executionEntries: input.executionEntries ?? [],
      overall: oracle.overall,
      unknownRecall: oracle.unknownRecall,
      validUnknown: oracle.validUnknown,
      violations: oracle.violations,
      unassessed: oracle.perStepEvaluation.entries.filter(entry => entry.outcome === "unknown").map(entry => `${entry.sampleId}:${entry.stepId}`),
      missingRun: Array.from({ length: oracle.studentPrediction.missing }, (_, index) => `missing:${index}`),
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
    await assertStudentInputIsolated(familyDir);
    const episodes = await loadStepwiseEpisodeFamily(familyDir);
    const goldRows = await loadGoldFamily(familyDir);
    const manifestOracleRefs = manifest.oracleRefs;
    const oracleRefs = Array.isArray(manifestOracleRefs)
      ? manifestOracleRefs.filter((ref): ref is string => typeof ref === "string")
      : [];
    const samples = mapGoldSamples(goldRows, episodes, oracleRefs);

    const runs: StudentRelationRun[] = [];
    const executionEntries: UnifiedEvaluateExecutionEntry[] = [];
    const evidenceRefs = new Set<string>();
    for (const episode of episodes) {
      const result = await runTsJsUnifiedDecision({
        requestId: `evaluate:${runId}:${episode.sampleId}:${episode.stepId}`,
        packagePath,
        episode,
        grantedEffects: ["read_only"],
      });
      if (
        result.modelBinding.packageRef !== packagePath
        || result.modelBinding.modelId !== loadedPackage.modelId
        || result.modelBinding.version !== loadedPackage.version
      ) {
        throw new UnifiedRunnerEvaluateError("CANDIDATE_INVALID", `sample ${episode.sampleId} did not use the selected candidate package`);
      }
      const mapped = studentRunOf(episode, result);
      runs.push(mapped.run);
      executionEntries.push(mapped.executionEntry);
      result.rootEvaluation.state === "evaluated"
        ? result.rootEvaluation.evidenceRefs.forEach(ref => evidenceRefs.add(ref))
        : undefined;
    }
    const oracle = evaluateRelationOracle(samples, runs);
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
      executionEntries,
      evidenceRefs: [...evidenceRefs],
    });
  } catch (caught) {
    const evaluationSeconds = monotonicSeconds(evaluationStartNs);
    if (caught instanceof UnifiedRunnerEvaluateError) {
      return finalize({
        status: "failed",
        evaluationSeconds,
        error: { code: caught.code, message: caught.message, detail: caught.detail },
      });
    }
    if (caught instanceof UnifiedModelPackageError) {
      const code: UnifiedRunnerEvaluateErrorCode =
        caught.code === "MODEL_NOT_FOUND" ? "CANDIDATE_MISSING" : "CANDIDATE_INVALID";
      return finalize({
        status: "failed",
        evaluationSeconds,
        error: { code, message: caught.message, detail: caught.detail },
      });
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    return finalize({
      status: "failed",
      evaluationSeconds,
      error: { code: "EVALUATION_INVALID", message },
    });
  }
}
