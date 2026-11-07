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
import type { UnifiedRelationFacts } from "../adapters/unified-relation-facts.js";
import { relationFactsSemanticallyEqual } from "../adapters/unified-relation-facts.js";
import type { EncoderResult, FeatureThresholds, StepContext } from "./unified-encoder.js";
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
}

export interface TransferPrerequisites {
  readonly acceptedTsJsPackage: boolean;
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
  };
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
  context: StepContext,
  encoded: readonly EncoderResult[],
  binding: UnifiedModelPackageBinding,
): CandidateChoice {
  const byRef = new Map(
    context.candidateGroup.candidates
      .filter(candidate => candidate.optionSemantics.startsWith("judge="))
      .map(candidate => [candidate.candidateRef, candidate]),
  );
  const scored: CandidateChoice[] = [];
  for (const result of encoded) {
    const candidate = byRef.get(result.candidateRef);
    if (candidate === undefined) continue;
    const score = forwardUnifiedScore(result.vector, binding.tensors);
    scored.push({
      sampleId: episode.sampleId,
      stepId: episode.stepId,
      candidateRef: candidate.candidateRef,
      optionSemantics: candidate.optionSemantics,
      score,
    });
  }
  if (scored.length === 0) {
    throw new UnifiedTransferInputError(`episode ${episode.sampleId} has no judge candidates`);
  }
  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.candidateRef.localeCompare(right.candidateRef);
  });
  return scored[0]!;
}

async function evaluateInference(
  packagePath: string,
  episodes: readonly RelationStepEpisode[],
): Promise<EncodingInferenceConsistencyReport> {
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

  let thresholdsValid = false;
  let missingModeValid = false;
  let thresholds: FeatureThresholds | null = null;
  try {
    thresholds = await loadFeatureThresholdsFromFile(loaded.resolvedResources.thresholdsPath);
    thresholdsValid = true;
  } catch {
    thresholdsValid = false;
  }
  try {
    await loadMissingModeTableFromFile(loaded.resolvedResources.missingModeTablePath);
    missingModeValid = true;
  } catch {
    missingModeValid = false;
  }

  const binding = loaded.bind();
  const choices: CandidateChoice[] = [];
  let encodedCount = 0;
  let truncatedCount = 0;
  let failedCount = 0;
  let cursorClosed = episodes.length > 0;

  for (const episode of episodes) {
    const context = relationStepContext(episode);
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
      continue;
    }
    let encoded: readonly EncoderResult[];
    try {
      encoded = encodeUnifiedCandidateGroup(context, thresholds);
    } catch {
      failedCount += 1;
      continue;
    }
    let episodeFailed = false;
    for (const result of encoded) {
      if (result.vector.length !== 64 || !result.vector.every(Number.isFinite)) {
        episodeFailed = true;
        failedCount += 1;
        continue;
      }
      const score = forwardUnifiedScore(result.vector, binding.tensors);
      if (!Number.isFinite(score)) {
        episodeFailed = true;
        failedCount += 1;
        continue;
      }
      encodedCount += 1;
    }
    if (episodeFailed) continue;
    choices.push(chooseJudge(episode, context, encoded, binding));
  }

  return {
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
  };
}

function studentRuns(
  episodes: readonly RelationStepEpisode[],
  choices: readonly CandidateChoice[],
): readonly StudentRelationRun[] {
  const choiceBySample = new Map(choices.map(choice => [choice.sampleId, choice]));
  return episodes.map(episode => {
    const context = relationStepContext(episode);
    const choice = choiceBySample.get(episode.sampleId);
    const step: StudentRelationStep = {
      stepId: episode.stepId,
      optionSemantics: choice?.optionSemantics ?? "unknown",
      executionReceiptRef: choice === undefined ? null : `evaluator:${choice.candidateRef}`,
      postStateRef: context.state.stateRef,
      evidenceRefs: episode.evidenceRefs,
    };
    return {
      sampleId: episode.sampleId,
      steps: [step],
      rootConditionStates: [],
      rootGaps: context.missingProjections.map(projection =>
        `${projection.fieldRef}:${projection.targetRef}`
      ),
      rootSatisfied: null,
    };
  });
}

export async function evaluateUnifiedTransfer(
  input: UnifiedTransferEvaluationInput,
): Promise<UnifiedTransferEvaluationReport> {
  const verificationPath = input.verificationPath ?? null;
  const oraclePath = input.oraclePath ?? null;
  const verification = await readVerification(verificationPath);
  const oracle = await readOracle(oraclePath);
  const episodes = verification?.episodes ?? [];

  const adapterSemanticAlignment = evaluateAdapterAlignment(
    verification?.tsjsFacts ?? null,
    verification?.rustFacts ?? null,
    episodes,
  );
  const encodingInferenceConsistency = await evaluateInference(input.packagePath, episodes);

  const independentRustVerification = verification !== null;
  const independentOracleSource =
    oracle !== null && INDEPENDENT_ORACLE_SOURCES.has(oracle.source);
  const acceptedTsJsPackage =
    encodingInferenceConsistency.packageLoaded &&
    encodingInferenceConsistency.packageBound &&
    encodingInferenceConsistency.routeCompatible;

  const labelMissingSamples = oracle === null
    ? []
    : oracle.samples
      .filter(sample => sample.labelMissing)
      .map(sample => ({ sampleId: sample.sampleId, targetRef: sample.targetRef }));

  let oracleReport: RelationOracleReport | null = null;
  if (independentRustVerification && independentOracleSource && oracle !== null) {
    oracleReport = evaluateRelationOracle(oracle.samples, studentRuns(episodes, encodingInferenceConsistency.choices));
  }

  const actualTransferCorrectness: ActualTransferCorrectnessReport = {
    status:
      acceptedTsJsPackage &&
      independentRustVerification &&
      independentOracleSource &&
      oracleReport !== null &&
      oracleReport.overall === "pass" &&
      oracleReport.gold.total > 0
        ? "pass"
        : "incomplete",
    prerequisites: {
      acceptedTsJsPackage,
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
