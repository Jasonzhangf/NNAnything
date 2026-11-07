// Read-only TS/JS-to-Rust transfer evaluator.
//
// The report deliberately keeps three layers separate:
// 1. adapter semantic alignment between the two relation-fact projections,
// 2. encoding/inference consistency for the supplied model package,
// 3. actual transfer correctness against an independent Rust verification
//    directory and independent relation oracle.
//
// Layer 3 never calls the student forward path. It consumes choices produced in
// layer 2 and asks only `evaluateRelationOracle`.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { UnifiedRelationFacts } from "../adapters/unified-relation-facts.js";
import { relationFactsSemanticallyEqual } from "../adapters/unified-relation-facts.js";
import type {
  Candidate,
  EncoderResult,
  FeatureThresholds,
  StepContext,
} from "./unified-encoder.js";
import { encodeUnifiedCandidateGroup } from "./unified-encoder.js";
import { forwardUnifiedScore } from "./unified-forward.js";
import {
  MODEL_INCOMPATIBLE,
  UnifiedModelPackageError,
  loadUnifiedModelPackageFromFile,
  type UnifiedModelPackageBinding,
} from "./unified-model-package.js";
import {
  evaluateRelationOracle,
  type IndependentOracleSample,
  type RelationOracleReport,
  type StudentRelationRun,
  type StudentRelationStep,
} from "./relation-oracle-evaluator.js";
import {
  relationStepContext,
  type RelationStepEpisode,
} from "./unified-step-context-builder.js";
import {
  loadFeatureThresholdsFromFile,
  loadMissingModeTableFromFile,
} from "./unified-thresholds.js";

const UNIFIED_RUST_VERIFICATION_SCHEMA =
  "nnanything.unified.rust-verification.v1" as const;
const UNIFIED_TRANSFER_ORACLE_SCHEMA =
  "nnanything.unified.transfer-oracle.v1" as const;
const INDEPENDENT_ORACLE_SOURCES = new Set<string>([
  "tsc",
  "typescript-language-service",
  "manual-structural-proof",
]);

type LayerStatus = "pass" | "incomplete" | "fail";

export interface UnifiedTransferEvaluationInput {
  readonly packagePath: string;
  readonly verificationPath?: string | null;
  readonly oraclePath?: string | null;
  readonly packageAdmission?: TsJsPackageAdmission | null;
  readonly verificationAdmissionsPath?: string | null;
  readonly targetSourceGroup?: string | null;
  readonly goldPath?: string | null;
}

export interface TsJsPackageAdmission {
  readonly packagePath: string;
  readonly modelId: string;
  readonly version: string;
  readonly reviewAccepted: boolean;
  readonly reviewer?: string | null;
  readonly reviewEvidenceRef?: string | null;
}

export interface AdapterSemanticAlignmentReport {
  readonly status: LayerStatus;
  readonly tsjsProjectionSupplied: boolean;
  readonly rustProjectionSupplied: boolean;
  readonly relationFactsEqual: boolean | null;
  readonly relevantMissing: readonly string[];
  readonly relevantUnsupported: readonly string[];
}

export interface CandidateChoice {
  readonly sampleId: string;
  readonly stepId: string;
  readonly candidateRef: string;
  readonly optionSemantics: string;
  readonly score: number;
}

export interface EncodingInferenceError {
  readonly stage: "thresholds" | "missingMode" | "encode" | "forward" | "candidateSelection";
  readonly code: string | null;
  readonly message: string;
  readonly inputRef: string;
}

export interface EncodingInferenceConsistencyReport {
  readonly status: LayerStatus;
  readonly packageLoaded: boolean;
  readonly packageBound: boolean;
  readonly thresholdsValid: boolean;
  readonly missingModeValid: boolean;
  readonly routeCompatible: boolean;
  readonly encodedCount: number;
  readonly truncatedCount: number;
  readonly failedCount: number;
  readonly cursorClosed: boolean;
  readonly choices: readonly CandidateChoice[];
  readonly errors: readonly EncodingInferenceError[];
}

export interface TransferPrerequisites {
  readonly acceptedTsJsPackage: boolean;
  readonly independentTsJsVerification: boolean;
  readonly independentRustVerification: boolean;
  readonly independentOracleSource: boolean;
}

export interface LabelMissingEvidence {
  readonly sampleId: string;
  readonly targetRef: string;
}

export interface ActualTransferCorrectnessReport {
  readonly status: LayerStatus;
  readonly prerequisites: TransferPrerequisites;
  readonly oracle: RelationOracleReport | null;
  readonly labelMissingSamples: readonly LabelMissingEvidence[];
}

export interface UnifiedTransferEvaluationReport {
  readonly adapterSemanticAlignment: AdapterSemanticAlignmentReport;
  readonly encodingInferenceConsistency: EncodingInferenceConsistencyReport;
  readonly actualTransferCorrectness: ActualTransferCorrectnessReport;
  readonly overall: LayerStatus;
}

interface VerificationData {
  readonly schema: typeof UNIFIED_RUST_VERIFICATION_SCHEMA;
  readonly tsjsFacts: UnifiedRelationFacts;
  readonly rustFacts: UnifiedRelationFacts;
  readonly episodes: readonly RelationStepEpisode[];
}

interface OracleData {
  readonly schema: typeof UNIFIED_TRANSFER_ORACLE_SCHEMA;
  readonly source: string;
  readonly samples: readonly IndependentOracleSample[];
  readonly rawSamples: readonly Record<string, unknown>[];
}

interface CorpusFamilyAdmission {
  readonly sourceGroup: string;
  readonly partition: string;
  readonly usableForIndependentVerification: boolean;
}

interface CorpusAdmissions {
  readonly schemaVersion: string;
  readonly familyAdmissions: readonly CorpusFamilyAdmission[];
}

interface GoldRecord {
  readonly sampleId: string;
  readonly sourceGroup: string;
  readonly partition: string;
  readonly label: "true" | "false" | "unknown";
  readonly labelAuthority: string;
  readonly oracleKind: string;
  readonly labelMissing: boolean;
}

interface EncodingInferenceResult {
  readonly report: EncodingInferenceConsistencyReport;
  readonly binding: UnifiedModelPackageBinding;
}

export class UnifiedTransferInputError extends Error {
  readonly code = "UNIFIED_TRANSFER_INPUT_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "UnifiedTransferInputError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnifiedRelationFacts(value: unknown): value is UnifiedRelationFacts {
  return (
    isRecord(value) &&
    value.schema === "nnanything.unified.relation-facts.v1" &&
    value.languageAgnostic === true &&
    Array.isArray(value.symbols) &&
    Array.isArray(value.imports) &&
    Array.isArray(value.callSites) &&
    Array.isArray(value.missing) &&
    Array.isArray(value.unsupported)
  );
}

function readEpisodes(value: unknown): readonly RelationStepEpisode[] {
  if (!Array.isArray(value)) throw new UnifiedTransferInputError("verification episodes must be an array");
  return value as readonly RelationStepEpisode[];
}

function readVerificationData(value: unknown): VerificationData {
  if (!isRecord(value) || value.schema !== UNIFIED_RUST_VERIFICATION_SCHEMA) {
    throw new UnifiedTransferInputError(`verification schema must be ${UNIFIED_RUST_VERIFICATION_SCHEMA}`);
  }
  if (!isUnifiedRelationFacts(value.tsjsFacts)) {
    throw new UnifiedTransferInputError("verification.tsjsFacts is not a unified relation-fact projection");
  }
  if (!isUnifiedRelationFacts(value.rustFacts)) {
    throw new UnifiedTransferInputError("verification.rustFacts is not a unified relation-fact projection");
  }
  return {
    schema: UNIFIED_RUST_VERIFICATION_SCHEMA,
    tsjsFacts: value.tsjsFacts,
    rustFacts: value.rustFacts,
    episodes: readEpisodes(value.episodes),
  };
}

function readOracleSamples(value: unknown): readonly IndependentOracleSample[] {
  if (!Array.isArray(value)) throw new UnifiedTransferInputError("oracle samples must be an array");
  return value as readonly IndependentOracleSample[];
}

function readOracleData(value: unknown): OracleData {
  if (!isRecord(value) || value.schema !== UNIFIED_TRANSFER_ORACLE_SCHEMA) {
    throw new UnifiedTransferInputError(`oracle schema must be ${UNIFIED_TRANSFER_ORACLE_SCHEMA}`);
  }
  if (typeof value.source !== "string" || value.source.length === 0) {
    throw new UnifiedTransferInputError("oracle source must be a non-empty string");
  }
  return {
    schema: UNIFIED_TRANSFER_ORACLE_SCHEMA,
    source: value.source,
    samples: readOracleSamples(value.samples),
    rawSamples: readOracleSamples(value.samples) as unknown as readonly Record<string, unknown>[],
  };
}

function readCorpusAdmissions(value: unknown): CorpusAdmissions {
  if (!isRecord(value) || value.schemaVersion !== "neural-cli-corpus-admissions-v1") {
    throw new UnifiedTransferInputError("corpus admissions schema must be neural-cli-corpus-admissions-v1");
  }
  if (!Array.isArray(value.familyAdmissions)) {
    throw new UnifiedTransferInputError("corpus familyAdmissions must be an array");
  }
  return {
    schemaVersion: value.schemaVersion,
    familyAdmissions: value.familyAdmissions,
  };
}

async function readCorpusAdmissionsFile(path: string | null | undefined): Promise<CorpusAdmissions | null> {
  const raw = await readJsonFile(path);
  if (raw === null) return null;
  return readCorpusAdmissions(raw);
}

async function readGoldRecords(path: string | null | undefined): Promise<readonly GoldRecord[] | null> {
  if (path === null || path === undefined) return null;
  try {
    const text = await readFile(path, "utf8");
    const records = text.split("\n").filter(line => line.length > 0).map(line => JSON.parse(line));
    if (!Array.isArray(records)) {
      throw new UnifiedTransferInputError(`gold path ${path} must be a JSONL array of records`);
    }
    return records as readonly GoldRecord[];
  } catch (error) {
    if (error instanceof UnifiedTransferInputError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new UnifiedTransferInputError(`gold path ${path} is unreadable: ${reason}`);
  }
}

function admittedFamily(
  admissions: CorpusAdmissions | null,
  targetSourceGroup: string | null,
): CorpusFamilyAdmission | null {
  if (admissions === null || targetSourceGroup === null) return null;
  const family = admissions.familyAdmissions.find(
    item => item.sourceGroup === targetSourceGroup,
  );
  if (family === undefined) return null;
  if (!family.usableForIndependentVerification || family.partition !== "verification") return null;
  return family;
}

function independentTsJsVerificationAdmission(
  admissions: CorpusAdmissions | null,
  targetSourceGroup: string | null,
  episodes: readonly RelationStepEpisode[],
): boolean {
  const family = admittedFamily(admissions, targetSourceGroup);
  if (family === null || episodes.length === 0) return false;
  return episodes.every(
    episode => episode.sourceGroup === family.sourceGroup && episode.partition === "verification",
  );
}

function independentOracleAdmission(
  admissions: CorpusAdmissions | null,
  targetSourceGroup: string | null,
  goldRecords: readonly GoldRecord[] | null,
  oracle: OracleData | null,
  episodes: readonly RelationStepEpisode[],
): boolean {
  const family = admittedFamily(admissions, targetSourceGroup);
  if (family === null || goldRecords === null || oracle === null) return false;
  const goldById = new Map(goldRecords.map(record => [record.sampleId, record]));
  const episodeSampleIds = new Set(episodes.map(episode => episode.sampleId));
  return oracle.samples.every((sample, index) => {
    const gold = goldById.get(sample.sampleId);
    const raw = oracle.rawSamples[index];
    if (gold === undefined || raw === undefined) return false;
    if (!episodeSampleIds.has(sample.sampleId)) return false;
    if (raw.sourceGroup !== family.sourceGroup || raw.partition !== family.partition) return false;
    return gold.sourceGroup === family.sourceGroup
      && gold.partition === family.partition
      && gold.label === sample.gold
      && gold.labelMissing === sample.labelMissing
      && gold.labelAuthority === raw.labelAuthority
      && gold.oracleKind === raw.oracleKind;
  });
}

function acceptedTsJsPackageAdmission(
  admission: TsJsPackageAdmission | null | undefined,
  packagePath: string,
  binding: UnifiedModelPackageBinding,
): boolean {
  if (admission === null || admission === undefined) return false;
  if (!admission.reviewAccepted) return false;
  if (typeof admission.reviewEvidenceRef !== "string" || admission.reviewEvidenceRef.length === 0) return false;
  if (resolve(admission.packagePath) !== resolve(packagePath)) return false;
  return admission.modelId === binding.modelId && admission.version === binding.version;
}

async function readJsonFile(path: string | null | undefined): Promise<unknown | null> {
  if (path === null || path === undefined) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function readVerification(path: string | null | undefined): Promise<VerificationData | null> {
  const raw = await readJsonFile(path === null || path === undefined ? undefined : `${path.replace(/\/$/, "")}/verification.json`);
  if (raw === null) return null;
  return readVerificationData(raw);
}

async function readOracle(path: string | null | undefined): Promise<OracleData | null> {
  const raw = await readJsonFile(path);
  if (raw === null) return null;
  return readOracleData(raw);
}

function relationRefs(episodes: readonly RelationStepEpisode[]): readonly string[] {
  const refs = new Set<string>();
  for (const episode of episodes) {
    refs.add(episode.sampleId);
    refs.add(episode.requestId);
    refs.add(episode.targetRef);
    if (episode.pendingRelationRef) refs.add(episode.pendingRelationRef);
    refs.add(episode.entryFile);
  }
  return [...refs].filter(ref => ref.length > 0);
}

function entryRef(entry: { readonly targetRef?: string; readonly patternRef?: string }): string {
  return entry.targetRef ?? entry.patternRef ?? "";
}

function relevantEntries(
  facts: UnifiedRelationFacts,
  refs: readonly string[],
): { readonly missing: readonly string[]; readonly unsupported: readonly string[] } {
  const missing = facts.missing
    .filter(entry => refs.some(ref => entry.targetRef.includes(ref)))
    .map(entry => `${entry.fieldRef}:${entry.targetRef}`);
  const unsupported = facts.unsupported
    .filter(entry => refs.some(ref => entryRef(entry).includes(ref)))
    .map(entry => `${entry.reason}:${entryRef(entry)}`);
  return { missing, unsupported };
}

function evaluateAdapterAlignment(
  tsjs: UnifiedRelationFacts | null,
  rust: UnifiedRelationFacts | null,
  episodes: readonly RelationStepEpisode[],
): AdapterSemanticAlignmentReport {
  if (tsjs === null || rust === null) {
    return {
      status: "incomplete",
      tsjsProjectionSupplied: tsjs !== null,
      rustProjectionSupplied: rust !== null,
      relationFactsEqual: null,
      relevantMissing: [],
      relevantUnsupported: [],
    };
  }
  const refs = relationRefs(episodes);
  const tsjsEntries = relevantEntries(tsjs, refs);
  const rustEntries = relevantEntries(rust, refs);
  const relevantMissing = [...tsjsEntries.missing, ...rustEntries.missing];
  const relevantUnsupported = [...tsjsEntries.unsupported, ...rustEntries.unsupported];
  const equal = relationFactsSemanticallyEqual(tsjs, rust);
  const conflicts = tsjs.conflicts.length + rust.conflicts.length;
  const status: LayerStatus =
    !equal || conflicts > 0
      ? "fail"
      : relevantMissing.length > 0 || relevantUnsupported.length > 0
        ? "incomplete"
        : "pass";
  return {
    status,
    tsjsProjectionSupplied: true,
    rustProjectionSupplied: true,
    relationFactsEqual: equal,
    relevantMissing,
    relevantUnsupported,
  };
}

function chooseJudge(
  episode: RelationStepEpisode,
  scored: readonly { readonly candidateRef: string; readonly score: number }[],
  candidatesByRef: ReadonlyMap<string, Candidate>,
): CandidateChoice | null {
  const judgeScores = scored.flatMap(({ candidateRef, score }) => {
    const candidate = candidatesByRef.get(candidateRef);
    if (candidate === undefined || !candidate.optionSemantics.startsWith("judge=")) return [];
    return [{
      sampleId: episode.sampleId,
      stepId: episode.stepId,
      candidateRef,
      optionSemantics: candidate.optionSemantics,
      score,
    }];
  });
  if (judgeScores.length === 0) return null;
  const choices = judgeScores;
  choices.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.candidateRef.localeCompare(right.candidateRef);
  });
  return choices[0]!;
}

function encodingError(
  stage: EncodingInferenceError["stage"],
  inputRef: string,
  error: unknown,
): EncodingInferenceError {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return {
    stage,
    code: typeof code === "string" ? code : null,
    message: error instanceof Error ? error.message : String(error),
    inputRef,
  };
}

async function evaluateInference(
  packagePath: string,
  episodes: readonly RelationStepEpisode[],
): Promise<EncodingInferenceResult> {
  const loaded = await loadUnifiedModelPackageFromFile(packagePath);
  const routeCompatible =
    loaded.package.route.domain === "tsjs" && loaded.package.route.decisionKind === "R";
  if (!routeCompatible) {
    throw new UnifiedModelPackageError(
      MODEL_INCOMPATIBLE,
      "transfer evaluator requires a tsjs/R model package",
      { route: loaded.package.route },
    );
  }

  const errors: EncodingInferenceError[] = [];
  let thresholdsValid = false;
  let missingModeValid = false;
  let thresholds: FeatureThresholds | null = null;
  try {
    thresholds = await loadFeatureThresholdsFromFile(loaded.resolvedResources.thresholdsPath);
    thresholdsValid = true;
  } catch (error) {
    thresholdsValid = false;
    errors.push(encodingError(
      "thresholds",
      loaded.resolvedResources.thresholdsPath,
      error,
    ));
  }
  try {
    await loadMissingModeTableFromFile(loaded.resolvedResources.missingModeTablePath);
    missingModeValid = true;
  } catch (error) {
    missingModeValid = false;
    errors.push(encodingError(
      "missingMode",
      loaded.resolvedResources.missingModeTablePath,
      error,
    ));
  }

  const binding = loaded.bind();
  const choices: CandidateChoice[] = [];
  let encodedCount = 0;
  let truncatedCount = 0;
  let failedCount = 0;
  let cursorClosed = episodes.length > 0;

  for (const episode of episodes) {
    const context = relationStepContext(episode);
    const inputRef = `${episode.sampleId}:${episode.stepId}`;
    const candidatesByRef = new Map(
      context.candidateGroup.candidates.map(candidate => [candidate.candidateRef, candidate]),
    );
    if (context.candidateGroup.enumeration !== "complete") {
      truncatedCount += 1;
      failedCount += 1;
      cursorClosed = false;
      continue;
    }
    if (context.localCandidateCursor !== undefined && context.localCandidateCursor.state !== "closed") {
      cursorClosed = false;
    }
    if (thresholds === null) {
      failedCount += 1;
      errors.push(encodingError(
        "encode",
        inputRef,
        new UnifiedTransferInputError("thresholds are unavailable"),
      ));
      continue;
    }
    let encoded: readonly EncoderResult[];
    try {
      encoded = encodeUnifiedCandidateGroup(context, thresholds);
    } catch (error) {
      failedCount += 1;
      errors.push(encodingError("encode", inputRef, error));
      continue;
    }
    let episodeFailed = false;
    const scored: { readonly candidateRef: string; readonly score: number }[] = [];
    for (const result of encoded) {
      if (result.vector.length !== 64 || !result.vector.every(Number.isFinite)) {
        episodeFailed = true;
        failedCount += 1;
        errors.push(encodingError(
          "encode",
          `${inputRef}:${result.candidateRef}`,
          new UnifiedTransferInputError("encoded vector must have 64 finite entries"),
        ));
        continue;
      }
      const score = forwardUnifiedScore(result.vector, binding.tensors);
      if (!Number.isFinite(score)) {
        episodeFailed = true;
        failedCount += 1;
        errors.push(encodingError(
          "forward",
          `${inputRef}:${result.candidateRef}`,
          new UnifiedTransferInputError("forward score is not finite"),
        ));
        continue;
      }
      encodedCount += 1;
      scored.push({ candidateRef: result.candidateRef, score });
    }
    if (episodeFailed) continue;
    const choice = chooseJudge(episode, scored, candidatesByRef);
    if (choice === null) {
      failedCount += 1;
      errors.push(encodingError(
        "candidateSelection",
        inputRef,
        new UnifiedTransferInputError(`episode ${episode.sampleId} has no judge candidates`),
      ));
      continue;
    }
    choices.push(choice);
  }

  return {
    report: {
      status:
        routeCompatible &&
        thresholdsValid &&
        missingModeValid &&
        failedCount === 0 &&
        encodedCount > 0
          ? "pass"
          : "incomplete",
      packageLoaded: true,
      packageBound: true,
      thresholdsValid,
      missingModeValid,
      routeCompatible,
      encodedCount,
      truncatedCount,
      failedCount,
      cursorClosed,
      choices,
      errors,
    },
    binding,
  };
}

function studentRuns(
  episodes: readonly RelationStepEpisode[],
  choices: readonly CandidateChoice[],
): readonly StudentRelationRun[] {
  const choicesByStep = new Map(
    choices.map(choice => [`${choice.sampleId}\0${choice.stepId}`, choice]),
  );
  const runsBySample = new Map<string, {
    steps: StudentRelationStep[];
    rootGaps: string[];
  }>();
  for (const episode of episodes) {
    const context = relationStepContext(episode);
    const run = runsBySample.get(episode.sampleId) ?? {
      steps: [],
      rootGaps: [],
    };
    const choice = choicesByStep.get(`${episode.sampleId}\0${episode.stepId}`);
    const step: StudentRelationStep = {
      stepId: episode.stepId,
      optionSemantics: choice?.optionSemantics ?? "unknown",
      executionReceiptRef: null,
      postStateRef: null,
      evidenceRefs: episode.evidenceRefs,
    };
    run.steps.push(step);
    for (const projection of context.missingProjections) {
      const gap = `${projection.fieldRef}:${projection.targetRef}`;
      if (!run.rootGaps.includes(gap)) run.rootGaps.push(gap);
    }
    runsBySample.set(episode.sampleId, run);
  }
  return [...runsBySample].map(([sampleId, { steps, rootGaps }]) => ({
    sampleId,
    steps,
    // A transfer evaluator only sees model choices, never execution receipts or
    // post-states. Structural closure must therefore stay unknown here.
    rootConditionStates: [{
      conditionRef: "root.structural_closure",
      state: "unknown",
    }],
    rootGaps,
    rootSatisfied: null,
  }));
}

export async function evaluateUnifiedTransfer(
  input: UnifiedTransferEvaluationInput,
): Promise<UnifiedTransferEvaluationReport> {
  const verificationPath = input.verificationPath ?? null;
  const oraclePath = input.oraclePath ?? null;
  const verification = await readVerification(verificationPath);
  const oracle = await readOracle(oraclePath);
  const episodes = verification?.episodes ?? [];
  const corpusAdmissions = await readCorpusAdmissionsFile(input.verificationAdmissionsPath);
  const goldRecords = await readGoldRecords(input.goldPath);
  const targetSourceGroup = input.targetSourceGroup ?? null;

  const adapterSemanticAlignment = evaluateAdapterAlignment(
    verification?.tsjsFacts ?? null,
    verification?.rustFacts ?? null,
    episodes,
  );
  const inference = await evaluateInference(input.packagePath, episodes);
  const encodingInferenceConsistency = inference.report;

  // Admission requires typed resources, not loadability or directory presence.
  const independentRustVerification = false;
  const independentTsJsVerification = independentTsJsVerificationAdmission(
    corpusAdmissions,
    targetSourceGroup,
    episodes,
  );
  const independentOracleSource = independentOracleAdmission(
    corpusAdmissions,
    targetSourceGroup,
    goldRecords,
    oracle,
    episodes,
  );
  const acceptedTsJsPackage = acceptedTsJsPackageAdmission(
    input.packageAdmission,
    input.packagePath,
    inference.binding,
  );

  const labelMissingSamples = oracle === null
    ? []
    : oracle.samples
      .filter(sample => sample.labelMissing)
      .map(sample => ({ sampleId: sample.sampleId, targetRef: sample.targetRef }));

  let oracleReport: RelationOracleReport | null = null;
  if (verification !== null && oracle !== null && INDEPENDENT_ORACLE_SOURCES.has(oracle.source)) {
    oracleReport = evaluateRelationOracle(oracle.samples, studentRuns(episodes, encodingInferenceConsistency.choices));
  }

  const actualTransferCorrectness: ActualTransferCorrectnessReport = {
    status:
      acceptedTsJsPackage &&
      independentTsJsVerification &&
      independentRustVerification &&
      independentOracleSource &&
      oracleReport !== null &&
      oracleReport.overall === "pass" &&
      oracleReport.gold.total > 0
        ? "pass"
        : "incomplete",
    prerequisites: {
      acceptedTsJsPackage,
      independentTsJsVerification,
      independentRustVerification,
      independentOracleSource,
    },
    oracle: oracleReport,
    labelMissingSamples,
  };

  const overall: LayerStatus =
    adapterSemanticAlignment.status === "fail" ||
    encodingInferenceConsistency.status === "fail" ||
    actualTransferCorrectness.status === "fail"
      ? "fail"
      : adapterSemanticAlignment.status === "pass" &&
          encodingInferenceConsistency.status === "pass" &&
          actualTransferCorrectness.status === "pass"
        ? "pass"
        : "incomplete";

  return {
    adapterSemanticAlignment,
    encodingInferenceConsistency,
    actualTransferCorrectness,
    overall,
  };
}
