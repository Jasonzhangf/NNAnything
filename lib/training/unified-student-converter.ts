// Student-side converter: source observation + legal skills -> complete S_g and x[64].
//
// Path A of the launch contract (§4.4.2). It must never read `labels/gold.jsonl`
// or any teacher resolution. The candidate group is the finite typed action set
// generated from the current observation (not gold), so removing gold leaves
// every student row byte-identical.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Candidate,
  CurrentRelationProjection,
  InformationGainValue,
  LocalCandidateCursorProjection,
  Observed,
  PreviousExecutionProjection,
} from "./unified-encoder.js";
import {
  encodeUnifiedCandidateGroup,
  type EncoderMissingMode,
  type FeatureThresholds,
  defaultThresholds,
  UNIFIED_ENCODER_VERSION,
} from "./unified-encoder.js";
import {
  DEFAULT_RELATION_STEP_ID,
  relationStepContext,
  type RelationStepEpisode,
  type RelationStepCoverage,
  type RelationStepLocalFact,
  type RelationStepReceipt,
  type RelationStepSourceContent,
  type TsJsProducerSourceBinding,
} from "./unified-step-context-builder.js";
import { runTsJsSymbolTable } from "../adapters/cli/tsjs-symbol-table-adapter.js";
import { validateTsJsSymbolRequest } from "../filters/tsjs-symbol-table-policy.js";
import type {
  TsJsCoverageRecord,
  TsJsParserRecord,
  TsJsRuntimeSelectorObservation,
  TsJsRuntimeSelectorRoleFact,
  TsJsSymbolTableRequest,
  TsJsSymbolTableResult,
} from "../filters/tsjs-symbol-table-policy.js";

export const UNIFIED_STUDENT_ROW_SCHEMA = "nnanything.unified.student-row.v1" as const;
export const UNIFIED_STUDENT_GROUP_SCHEMA = "nnanything.unified.student-group.v1" as const;
export const STEPWISE_STUDENT_OBSERVATIONS_FILE = "student-observations.jsonl" as const;
export const STEPWISE_STUDENT_OBSERVATION_SCHEMA = "emma-tsjs-student-observation-v2" as const;
// Accepted fixed-generator schema kind. The loader normalizes it into the v2
// shape in one place so the original corpus stays read-only and no second
// schema file is introduced.
export const FIXED_STEPWISE_STUDENT_SCHEMA = "carol-tsjs-fixed-stepwise-student-v1" as const;

export class StepwiseStudentDataError extends Error {
  readonly code = "DATA_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "StepwiseStudentDataError";
  }
}

export type StudentCandidateRejection =
  | "candidateEnumeration"
  | "candidateGroupRef"
  | "goldPresent";

export interface StudentCandidateRow {
  readonly candidateRef: string;
  readonly optionSemantics: string;
  readonly candidateKind: Candidate["candidateKind"];
  readonly input: readonly number[];
  readonly missingMode: readonly EncoderMissingMode[];
}

export interface StudentGroup {
  readonly schema: typeof UNIFIED_STUDENT_GROUP_SCHEMA;
  readonly group_id: string;
  readonly sampleId: string;
  readonly requestRef: string;
  readonly stepId: string;
  readonly targetRef: string;
  readonly pendingRelationRef: string | null;
  readonly sourceGroup: string;
  readonly language: string;
  readonly adapterRef: string;
  readonly derivationFamily: string;
  readonly semanticStratum: string;
  readonly stepContextRef: string;
  readonly candidateGroupRef: string;
  readonly featureSchemaVersion: string;
  readonly encoderVersion: string;
  readonly partition: "TRAIN" | "DEV" | "VERIFICATION";
  readonly candidateEnumeration: "complete" | "truncated" | "enumeration_failed";
  readonly coverageCursorRef: string;
  readonly evidenceRefs: readonly string[];
  readonly failureMode: string | null;
  readonly candidates: readonly StudentCandidateRow[];
}

export interface StudentConversionResult {
  readonly groups: readonly StudentGroup[];
  readonly rejection: readonly StudentCandidateRejection[];
}

export interface TsJsStepwiseBridgeInput {
  readonly sourceGroup: string;
  readonly language: string;
  readonly semanticStratum: string;
  readonly partition: string;
  readonly derivationFamily: string;
  readonly sampleId: string;
  readonly entryFile: string;
  readonly request: {
    readonly requestRef: string;
    readonly requestedDeclaration: NonNullable<RelationStepEpisode["requestedDeclaration"]>;
    readonly relationObligation: {
      readonly requestRef: string;
      readonly pendingRelationRef: string;
      readonly callSiteRef: string;
      readonly calleeName: string | null;
    };
  };
  readonly stepId: string;
  readonly fromStepId: string | null;
  readonly remainingObligations: NonNullable<RelationStepEpisode["remainingObligations"]>;
  readonly localCandidateCursor: LocalCandidateCursorProjection;
  readonly producerRequest: TsJsSymbolTableRequest;
}

export interface TsJsStepwiseBridgeOutcome {
  readonly record: Record<string, unknown> | null;
  readonly reasons: readonly string[];
}

export function studentGroupId(input: {
  readonly sourceGroup: string;
  readonly sampleId: string;
  readonly stepContextRef: string;
  readonly candidateGroupRef: string;
}): string {
  return [input.sourceGroup, input.sampleId, input.stepContextRef, input.candidateGroupRef].join("|");
}

export function partitionOf(raw: string): "TRAIN" | "DEV" | "VERIFICATION" {
  if (raw === "train") return "TRAIN";
  if (raw === "dev") return "DEV";
  if (raw === "verification") return "VERIFICATION";
  throw new TypeError(`unknown partition: ${raw}`);
}

function blockForSlot(slotIndex: number): EncoderMissingMode["block"] {
  return `G${Math.floor(slotIndex / 8)}` as EncoderMissingMode["block"];
}

function deriveMissingMode(
  candidateRef: string,
  vector: readonly number[],
  encodedMissingMode: readonly EncoderMissingMode[],
): readonly EncoderMissingMode[] {
  if (encodedMissingMode.length > 0) return encodedMissingMode;
  return vector.flatMap((value, slotIndex) =>
    value === -1
      ? [{
          block: blockForSlot(slotIndex),
          fieldRef: `${candidateRef}:slot${slotIndex}`,
          reason: "not_requested" as const,
          slotIndex,
          fill: -1 as const,
        }]
      : []
  );
}

export function convertEpisodeToStudentGroup(
  episode: RelationStepEpisode,
  thresholds: FeatureThresholds = defaultThresholds(),
): StudentGroup {
  const context = relationStepContext(episode);
  const encoded = encodeUnifiedCandidateGroup(context, thresholds);
  const candidates = context.candidateGroup.candidates.map((candidate, index) => {
    const result = encoded[index];
    if (result === undefined) throw new TypeError(`encoder missing candidate ${candidate.candidateRef}`);
    return {
      candidateRef: candidate.candidateRef,
      optionSemantics: candidate.optionSemantics,
      candidateKind: candidate.candidateKind,
      input: result.vector,
      missingMode: deriveMissingMode(candidate.candidateRef, result.vector, result.missingMode),
    };
  });
  return {
    schema: UNIFIED_STUDENT_GROUP_SCHEMA,
    group_id: studentGroupId({
      sourceGroup: episode.sourceGroup,
      sampleId: episode.sampleId,
      stepContextRef: context.contextId,
      candidateGroupRef: context.candidateGroup.candidateGroupRef,
    }),
    sampleId: episode.sampleId,
    requestRef: episode.requestId,
    stepId: episode.stepId,
    targetRef: episode.targetRef,
    pendingRelationRef: episode.pendingRelationRef ?? null,
    sourceGroup: episode.sourceGroup,
    language: episode.language,
    adapterRef: episode.adapterRef,
    derivationFamily: episode.derivationFamily,
    semanticStratum: episode.semanticStratum,
    stepContextRef: context.contextId,
    candidateGroupRef: context.candidateGroup.candidateGroupRef,
    featureSchemaVersion: "nnanything.unified.feature.v1",
    encoderVersion: UNIFIED_ENCODER_VERSION,
    partition: partitionOf(episode.partition),
    candidateEnumeration: context.candidateGroup.enumeration,
    coverageCursorRef: `coverage:${episode.sampleId}`,
    evidenceRefs: episode.evidenceRefs,
    failureMode: episode.failureMode,
    candidates,
  };
}

function bridgeFailure(reason: string): TsJsStepwiseBridgeOutcome {
  return { record: null, reasons: [reason] };
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function moduleFileFromRef(moduleRef: string | null): string | null {
  if (moduleRef === null || !moduleRef.startsWith("module:")) return null;
  const file = moduleRef.slice("module:".length);
  if (file.length === 0 || file.startsWith("/") || file.includes("..")) return null;
  return file;
}

function successfulProducerFiles(
  request: TsJsSymbolTableRequest,
  coverage: TsJsCoverageRecord,
): readonly string[] {
  const unsuccessful = new Set([
    ...coverage.scopeFilesFailed.map(entry => entry.file),
    ...coverage.skipped.map(entry => entry.file),
    ...coverage.parseErrorFiles.map(entry => entry.file),
  ]);
  return uniqueStrings(request.files).filter(file => !unsuccessful.has(file));
}

function validateProducerObservation(
  observation: TsJsRuntimeSelectorObservation,
  callSiteRef: string,
  successfulFiles: readonly string[],
): readonly string[] {
  const reasons: string[] = [];
  const sourceReadRef = observation.sourceReadRef;
  if (observation.callSiteRef !== callSiteRef) {
    reasons.push("producer observation call-site mismatch");
  }
  if (observation.binding.callSiteRef !== callSiteRef) {
    reasons.push("producer binding call-site mismatch");
  }
  if (
    sourceReadRef.length === 0
    || !observation.binding.evidenceRefs.includes(sourceReadRef)
    || !observation.binding.resolution.evidenceRefs.includes(sourceReadRef)
  ) {
    reasons.push("producer binding does not retain the source-read ref");
  }
  if (
    observation.binding.bindingMode !== "dynamic"
    || observation.binding.resolution.status !== "dynamic"
    || observation.binding.resolution.reason !== "dynamic_undecidable"
    || observation.binding.declarationRefs.length !== 0
    || observation.binding.scopeRef !== null
  ) {
    reasons.push("producer dynamic binding shape mismatch");
  }
  const roleFacts = observation.facts.filter(
    fact => fact.role === "selector_candidate_table"
      || fact.role === "runtime_selector_dependency",
  );
  if (
    roleFacts.length !== 2
    || roleFacts.filter(fact => fact.role === "selector_candidate_table").length !== 1
    || roleFacts.filter(fact => fact.role === "runtime_selector_dependency").length !== 1
  ) {
    reasons.push("producer observation must contain one fact for each accepted role");
  }
  for (const fact of roleFacts) {
    if (fact.state !== "known" || !fact.evidenceRefs.includes(sourceReadRef)) {
      reasons.push(`producer ${fact.role} fact is not source-backed`);
    }
  }
  const receipt = observation.sourceReadReceipt;
  if (
    receipt.receiptId !== sourceReadRef
    || receipt.action !== "read_source"
    || receipt.origin !== "source_observation"
    || receipt.outcome !== "success"
    || !receipt.evidenceRefs.includes(sourceReadRef)
  ) {
    reasons.push("producer source-read receipt identity mismatch");
  }
  if (receipt.result.some(ref => !ref.startsWith("source-read:"))) {
    reasons.push("producer source-read result contains a non-source-read ref");
  }
  for (const module of receipt.modules) {
    if (!successfulFiles.includes(module.file)) {
      reasons.push(`producer observation module ${module.file} is not in the successful read set`);
    }
  }
  return uniqueStrings(reasons);
}

function producerSourceBinding(
  input: TsJsStepwiseBridgeInput,
  result: TsJsSymbolTableResult,
  observation: TsJsRuntimeSelectorObservation,
): TsJsProducerSourceBinding {
  return {
    kind: "nnanything.tsjs.producer-source.v1",
    producerRequest: input.producerRequest,
    parser: result.parser,
    coverage: result.coverage,
    rawObservation: observation,
    sampleId: input.sampleId,
    requestRef: input.request.requestRef,
    stepId: input.stepId,
    fromStepId: input.fromStepId,
    callSiteRef: observation.callSiteRef,
    pendingRelationRef: input.request.relationObligation.pendingRelationRef,
    requestedDeclarationRef: input.request.requestedDeclaration.declarationRef,
    requestedModuleRef: input.request.requestedDeclaration.moduleRef ?? "",
  };
}

function projectTsJsObservationToStepwiseRecord(
  input: TsJsStepwiseBridgeInput,
  result: TsJsSymbolTableResult,
  observation: TsJsRuntimeSelectorObservation,
): Record<string, unknown> {
  const sourceReadRef = observation.sourceReadRef;
  const sourceReadReceipt = observation.sourceReadReceipt;
  const producerSource = producerSourceBinding(input, result, observation);
  const observedLocalFacts: readonly RelationStepLocalFact[] = observation.facts.map(fact => ({
    factRef: fact.factRef,
    ...(fact.role === undefined ? {} : { role: fact.role }),
    state: fact.state,
    value: fact.value,
    evidenceRefs: fact.evidenceRefs,
  }));
  const currentRelation: CurrentRelationProjection = {
    pendingRelationRef: input.request.relationObligation.pendingRelationRef,
    callSiteRef: input.request.relationObligation.callSiteRef,
    binding: {
      state: "known",
      value: {
        symbolRef: observation.binding.symbolRef,
        callSiteRef: observation.binding.callSiteRef,
        role: observation.binding.role,
        bindingMode: observation.binding.bindingMode,
        resolution: {
          status: "dynamic",
          reason: "dynamic_undecidable",
          evidenceRefs: observation.binding.resolution.evidenceRefs,
        },
        declarationRefs: [],
        scopeRef: null,
        evidenceRefs: observation.binding.evidenceRefs,
      },
      evidenceRefs: observation.binding.evidenceRefs,
    },
  };
  const receipt: RelationStepReceipt = {
    receiptId: sourceReadReceipt.receiptId,
    actionRef: sourceReadReceipt.actionRef,
    action: sourceReadReceipt.action,
    target: sourceReadReceipt.targetRef,
    origin: sourceReadReceipt.origin,
    fromStepId: input.fromStepId,
    pendingRelationRef: input.request.relationObligation.pendingRelationRef,
    optionSemantics: "observe",
    outcome: sourceReadReceipt.outcome,
    result: sourceReadReceipt.result,
    evidenceRefs: sourceReadReceipt.evidenceRefs,
    producerSource,
  };
  const previousExecution: Observed<PreviousExecutionProjection | null> = {
    state: "known",
    value: {
      actionRef: sourceReadReceipt.actionRef,
      receiptRef: sourceReadReceipt.receiptId,
      origin: "source_observation",
      fromStepId: input.fromStepId,
      pendingRelationRef: input.request.relationObligation.pendingRelationRef,
      optionSemantics: "observe",
      targetRef: sourceReadReceipt.targetRef,
      outcome: "success",
    },
    evidenceRefs: sourceReadReceipt.evidenceRefs,
  };
  const notReady = result.coverage.partial || result.coverage.truncated;
  return {
    schemaVersion: STEPWISE_STUDENT_OBSERVATION_SCHEMA,
    sampleId: input.sampleId,
    family: input.derivationFamily,
    sourceGroup: input.sourceGroup,
    partition: input.partition,
    language: input.language,
    semanticStratum: input.semanticStratum,
    entryFile: input.entryFile,
    request: input.request,
    steps: [{
      stepId: input.stepId,
      localSyntax: {
        observedBindings: [],
        observedDeclarations: [],
        observedLocalFacts,
        sourceContent: {
          state: "observed",
          resultRefs: sourceReadReceipt.result,
          reason: null,
          evidenceRefs: [sourceReadRef],
        },
        shadowFacts: [],
      },
      currentRelation,
      remainingObligations: input.remainingObligations,
      previousExecution,
      receipts: [receipt],
      localCandidateCursor: input.localCandidateCursor,
      coverage: {
        coveredModules: successfulProducerFiles(input.producerRequest, result.coverage),
        targetModuleReached:
          moduleFileFromRef(input.request.requestedDeclaration.moduleRef ?? null) !== null
          && successfulProducerFiles(input.producerRequest, result.coverage).includes(
            moduleFileFromRef(input.request.requestedDeclaration.moduleRef ?? null)!,
          ),
        note: "runtime_selector_source_observed",
      },
      notReady,
    }],
  };
}

export async function observeTsJsStepwiseRequest(
  input: TsJsStepwiseBridgeInput,
): Promise<TsJsStepwiseBridgeOutcome> {
  if (!Array.isArray(input.remainingObligations)) {
    return bridgeFailure("bridge requires explicit remainingObligations");
  }
  if (!isRecord(input.localCandidateCursor)) {
    return bridgeFailure("bridge requires explicit localCandidateCursor");
  }
  const validation = validateTsJsSymbolRequest(input.producerRequest);
  if (!validation.ok) {
    return bridgeFailure(`producer rejected request: ${validation.error.reasonCode}`);
  }
  const canonicalInput: TsJsStepwiseBridgeInput = {
    ...input,
    producerRequest: validation.request,
  };
  const expectedCallSiteRef = input.request.relationObligation.callSiteRef;
  const requestedModuleFile = moduleFileFromRef(
    input.request.requestedDeclaration.moduleRef ?? null,
  );
  if (requestedModuleFile === null) {
    return bridgeFailure("requestedDeclaration.moduleRef must use module:<repo-relative-file>");
  }
  // The producer already owns the one request validator/normalizer. Re-run it
  // with the raw request so it remains the single execution path; canonicalInput
  // carries the same validator's normalized request for provenance/accounting.
  const producer = await runTsJsSymbolTable(input.producerRequest);
  if (producer.status !== "ok") {
    return bridgeFailure(`producer rejected request: ${producer.reasonCode}`);
  }
  const result = producer.result;
  const matches = result.runtimeSelectorObservations.filter(
    observation =>
      observation.callSiteRef === expectedCallSiteRef
      && observation.binding.callSiteRef === expectedCallSiteRef,
  );
  if (matches.length === 0) {
    return bridgeFailure("producer observation callSiteRef not found");
  }
  if (matches.length > 1) {
    return bridgeFailure("producer observation callSiteRef is ambiguous");
  }
  const observation = matches[0]!;
  const successfulFiles = successfulProducerFiles(canonicalInput.producerRequest, result.coverage);
  const reasons = validateProducerObservation(observation, expectedCallSiteRef, successfulFiles);
  if (reasons.length > 0) {
    return { record: null, reasons };
  }
  return {
    record: projectTsJsObservationToStepwiseRecord(canonicalInput, result, observation),
    reasons: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

export type StepwiseObservedLocalFact = RelationStepLocalFact;

function parseObservedLocalFacts(
  localSyntax: Record<string, unknown>,
  sampleId: string,
  stepId: string,
): readonly StepwiseObservedLocalFact[] {
  const rawFacts = requireArray(
    localSyntax.observedLocalFacts ?? [],
    `sample ${sampleId} ${stepId} observedLocalFacts`,
  );
  return rawFacts.map((rawFact, index) => {
    if (!isRecord(rawFact)) {
      throw new TypeError(
        `sample ${sampleId} ${stepId} observedLocalFacts[${index}] must be an object`,
      );
    }
    const role = rawFact.role;
    if (
      role !== undefined
      && role !== "selector_candidate_table"
      && role !== "runtime_selector_dependency"
    ) {
      throw new TypeError(
        `sample ${sampleId} ${stepId} observedLocalFacts[${index}].role is invalid; expected selector_candidate_table or runtime_selector_dependency`,
      );
    }
    return {
      factRef: requireString(
        rawFact.factRef,
        `sample ${sampleId} ${stepId} observedLocalFacts[${index}].factRef`,
      ),
      ...(role === undefined ? {} : { role }),
      state: requireString(
        rawFact.state,
        `sample ${sampleId} ${stepId} observedLocalFacts[${index}].state`,
      ),
      value: typeof rawFact.value === "string" ? rawFact.value : null,
      evidenceRefs: requireArray(
        rawFact.evidenceRefs ?? [],
        `sample ${sampleId} ${stepId} observedLocalFacts[${index}].evidenceRefs`,
      ).map((ref, refIndex) =>
        requireString(
          ref,
          `sample ${sampleId} ${stepId} observedLocalFacts[${index}].evidenceRefs[${refIndex}]`,
        )),
    };
  });
}

function parseProducerSourceBinding(
  raw: unknown,
  sampleId: string,
  stepId: string,
): TsJsProducerSourceBinding {
  if (!isRecord(raw) || raw.kind !== "nnanything.tsjs.producer-source.v1") {
    throw new TypeError(`sample ${sampleId} ${stepId} receipt.producerSource is invalid`);
  }
  if (!isRecord(raw.producerRequest) || !isRecord(raw.parser) || !isRecord(raw.coverage)) {
    throw new TypeError(`sample ${sampleId} ${stepId} receipt.producerSource fields are incomplete`);
  }
  if (!isRecord(raw.rawObservation)) {
    throw new TypeError(`sample ${sampleId} ${stepId} receipt.producerSource.rawObservation is invalid`);
  }
  const rawObservation = raw.rawObservation;
  if (
    typeof rawObservation.callSiteRef !== "string"
    || typeof rawObservation.sourceReadRef !== "string"
    || !isRecord(rawObservation.binding)
    || !isRecord(rawObservation.sourceReadReceipt)
  ) {
    throw new TypeError(`sample ${sampleId} ${stepId} receipt.producerSource.rawObservation is incomplete`);
  }
  if (raw.fromStepId !== null && typeof raw.fromStepId !== "string") {
    throw new TypeError(`sample ${sampleId} ${stepId} producerSource.fromStepId is invalid`);
  }
  return {
    kind: "nnanything.tsjs.producer-source.v1",
    producerRequest: raw.producerRequest as unknown as TsJsSymbolTableRequest,
    parser: raw.parser as unknown as TsJsParserRecord,
    coverage: raw.coverage as unknown as TsJsCoverageRecord,
    rawObservation: rawObservation as unknown as TsJsRuntimeSelectorObservation,
    sampleId: requireString(raw.sampleId, `sample ${sampleId} ${stepId} producerSource.sampleId`),
    requestRef: requireString(raw.requestRef, `sample ${sampleId} ${stepId} producerSource.requestRef`),
    stepId: requireString(raw.stepId, `sample ${sampleId} ${stepId} producerSource.stepId`),
    fromStepId: raw.fromStepId,
    callSiteRef: requireString(raw.callSiteRef, `sample ${sampleId} ${stepId} producerSource.callSiteRef`),
    pendingRelationRef: requireString(raw.pendingRelationRef, `sample ${sampleId} ${stepId} producerSource.pendingRelationRef`),
    requestedDeclarationRef: requireString(raw.requestedDeclarationRef, `sample ${sampleId} ${stepId} producerSource.requestedDeclarationRef`),
    requestedModuleRef: requireString(raw.requestedModuleRef, `sample ${sampleId} ${stepId} producerSource.requestedModuleRef`),
  };
}

function parseJsonl(text: string, field: string): readonly unknown[] {
  return text.split("\n").flatMap((line, index) => {
    if (line.trim().length === 0) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      throw new TypeError(`${field} line ${index + 1} is invalid JSON: ${message}`);
    }
  });
}

function rejectStudentLeakage(value: unknown, path = "student"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectStudentLeakage(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (/^(?:A_g|gold|teacher|oracle|originalLabel|recomputed)/i.test(key)) {
      throw new TypeError(`${path}.${key} is supervision-only data`);
    }
    rejectStudentLeakage(nested, `${path}.${key}`);
  }
}

function resolveStepwiseEntryFile(
  record: Record<string, unknown>,
  sampleId: string,
): string {
  if (typeof record.entryFile !== "string" || record.entryFile.length === 0) {
    throw new StepwiseStudentDataError(
      `sample ${sampleId} entryFile must be provided as an explicit non-empty top-level field`,
    );
  }
  return record.entryFile;
}

function collectStepEvidence(localSyntax: Record<string, unknown>): readonly string[] {
  const refs = new Set<string>();
  const addRefs = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const ref of value) {
      if (typeof ref === "string" && ref.startsWith("ev:")) refs.add(ref);
    }
  };
  addRefs(isRecord(localSyntax.sourceContent) ? localSyntax.sourceContent.evidenceRefs : undefined);
  for (const edge of Array.isArray(localSyntax.observedBindings) ? localSyntax.observedBindings : []) {
    if (!isRecord(edge)) continue;
    addRefs(edge.evidenceRefs);
    if (isRecord(edge.sourceContent)) addRefs(edge.sourceContent.evidenceRefs);
  }
  for (const declaration of Array.isArray(localSyntax.observedDeclarations) ? localSyntax.observedDeclarations : []) {
    if (isRecord(declaration)) addRefs(declaration.evidenceRefs);
  }
  return [...refs];
}

function isTypedInformationGain(value: unknown): value is Observed<InformationGainValue> {
  return isRecord(value)
    && (value.state === "known"
      || value.state === "missing"
      || value.state === "not_observed"
      || value.state === "conflicting"
      || value.state === "unsupported")
    && (value.state !== "known" || value.value === "advances_chain"
      || value.value === "resolves_target"
      || value.value === "none");
}

function parseInformationGain(
  raw: unknown,
  sampleId: string,
  stepId: string,
  obligationIndex: number,
): number | string | Observed<InformationGainValue> {
  if (typeof raw === "number" || typeof raw === "string") return raw;
  if (isTypedInformationGain(raw)) return raw as Observed<InformationGainValue>;
  throw new TypeError(
    `sample ${sampleId} ${stepId} remainingObligations[${obligationIndex}].informationGain is invalid`,
  );
}

function parseObligationArguments(
  raw: unknown,
  sampleId: string,
  stepId: string,
  obligationIndex: number,
): readonly { readonly name: string; readonly type: string; readonly valueRef: string | null }[] {
  if (!Array.isArray(raw)) {
    throw new TypeError(
      `sample ${sampleId} ${stepId} remainingObligations[${obligationIndex}].arguments is invalid`,
    );
  }
  return raw.map((entry, argumentIndex) => {
    if (!isRecord(entry)) {
      throw new TypeError(
        `sample ${sampleId} ${stepId} remainingObligations[${obligationIndex}].arguments[${argumentIndex}] is invalid`,
      );
    }
    const name = requireString(entry.name, `obligation.arguments[${argumentIndex}].name`);
    const type = requireString(entry.type, `obligation.arguments[${argumentIndex}].type`);
    const valueRef = entry.valueRef === null || typeof entry.valueRef === "string"
      ? entry.valueRef
      : null;
    return { name, type, valueRef };
  });
}

function parseCurrentRelation(
  raw: unknown,
  sampleId: string,
  stepId: string,
): CurrentRelationProjection | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) throw new TypeError(`sample ${sampleId} ${stepId} currentRelation is invalid`);
  const pendingRelationRef = requireString(
    raw.pendingRelationRef,
    `sample ${sampleId} ${stepId} currentRelation.pendingRelationRef`,
  );
  const callSiteRef = requireString(
    raw.callSiteRef,
    `sample ${sampleId} ${stepId} currentRelation.callSiteRef`,
  );
  const binding = raw.binding;
  if (!isRecord(binding) || !isRecord(binding.value)) {
    throw new TypeError(`sample ${sampleId} ${stepId} currentRelation.binding is invalid`);
  }
  const state = binding.state;
  if (state !== "known" && state !== "missing" && state !== "not_observed" && state !== "conflicting" && state !== "unsupported") {
    throw new TypeError(`sample ${sampleId} ${stepId} currentRelation.binding.state is invalid`);
  }
  return {
    pendingRelationRef,
    callSiteRef,
    binding: {
      state,
      ...(state === "known" ? { value: binding.value as unknown as CurrentRelationProjection["binding"]["value"] } : {}),
      ...(typeof binding.reason === "string" ? { reason: binding.reason as CurrentRelationProjection["binding"]["reason"] } : {}),
      evidenceRefs: requireArray(
        binding.evidenceRefs ?? [],
        `sample ${sampleId} ${stepId} currentRelation.binding.evidenceRefs`,
      ).map((ref, index) => requireString(ref, `currentRelation.binding.evidenceRefs[${index}]`)),
    } as CurrentRelationProjection["binding"],
  } as CurrentRelationProjection;
}

function parsePreviousExecution(
  raw: unknown,
  sampleId: string,
  stepId: string,
): Observed<PreviousExecutionProjection | null> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new TypeError(`sample ${sampleId} ${stepId} previousExecution is invalid`);
  if (raw.state === "not_observed" || raw.state === "missing" || raw.state === "conflicting" || raw.state === "unsupported") {
    return {
      state: raw.state,
      ...(typeof raw.reason === "string" ? { reason: raw.reason as Observed<PreviousExecutionProjection | null>["reason"] } : {}),
      evidenceRefs: requireArray(
        raw.evidenceRefs ?? [],
        `sample ${sampleId} ${stepId} previousExecution.evidenceRefs`,
      ).map((ref, index) => requireString(ref, `previousExecution.evidenceRefs[${index}]`)),
    } as Observed<PreviousExecutionProjection | null>;
  }
  if (raw.state !== "known") {
    throw new TypeError(`sample ${sampleId} ${stepId} previousExecution.state is invalid`);
  }
  if (raw.value === null) {
    return {
      state: "known",
      value: null,
      evidenceRefs: requireArray(
        raw.evidenceRefs ?? [],
        `sample ${sampleId} ${stepId} previousExecution.evidenceRefs`,
      ).map((ref, index) => requireString(ref, `previousExecution.evidenceRefs[${index}]`)),
    };
  }
  if (!isRecord(raw.value)) {
    throw new TypeError(`sample ${sampleId} ${stepId} previousExecution.value is invalid`);
  }
  const outcome = raw.value.outcome;
  if (outcome !== "success" && outcome !== "partial" && outcome !== "failed" && outcome !== "unknown") {
    throw new TypeError(`sample ${sampleId} ${stepId} previousExecution.outcome is invalid`);
  }
  return {
    state: "known",
    value: {
      actionRef: requireString(raw.value.actionRef, `sample ${sampleId} ${stepId} previousExecution.actionRef`),
      receiptRef: raw.value.receiptRef === null || typeof raw.value.receiptRef === "string"
        ? raw.value.receiptRef
        : null,
      origin: raw.value.origin === "source_observation" || raw.value.origin === "model_execution"
        ? raw.value.origin
        : "source_observation",
      fromStepId: raw.value.fromStepId === null || typeof raw.value.fromStepId === "string"
        ? raw.value.fromStepId
        : null,
      pendingRelationRef: requireString(
        raw.value.pendingRelationRef,
        `sample ${sampleId} ${stepId} previousExecution.pendingRelationRef`,
      ),
      optionSemantics: raw.value.optionSemantics === "advance" ? "advance" : "observe",
      targetRef: requireString(raw.value.targetRef, `sample ${sampleId} ${stepId} previousExecution.targetRef`),
      outcome,
    },
    evidenceRefs: requireArray(
      raw.evidenceRefs ?? [],
      `sample ${sampleId} ${stepId} previousExecution.evidenceRefs`,
    ).map((ref, index) => requireString(ref, `previousExecution.evidenceRefs[${index}]`)),
  } as Observed<PreviousExecutionProjection>;
}

function parseLocalCandidateCursor(
  raw: unknown,
  sampleId: string,
  stepId: string,
): LocalCandidateCursorProjection | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new TypeError(`sample ${sampleId} ${stepId} localCandidateCursor is invalid`);
  const state = raw.state;
  if (state !== "closed" && state !== "open" && state !== "failed") {
    throw new TypeError(`sample ${sampleId} ${stepId} localCandidateCursor.state is invalid`);
  }
  return {
    pendingRelationRef: requireString(
      raw.pendingRelationRef,
      `sample ${sampleId} ${stepId} localCandidateCursor.pendingRelationRef`,
    ),
    state,
    evidenceRefs: requireArray(
      raw.evidenceRefs ?? [],
      `sample ${sampleId} ${stepId} localCandidateCursor.evidenceRefs`,
    ).map((ref, index) => requireString(ref, `localCandidateCursor.evidenceRefs[${index}]`)),
  };
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function validateReceiptsAndPreviousExecution(
  sampleId: string,
  stepId: string,
  pendingRelationRef: string,
  receipts: readonly RelationStepReceipt[],
  previous: Observed<PreviousExecutionProjection | null> | undefined,
): void {
  if (previous === undefined || previous.state !== "known") return;
  const previousValue = previous.value;
  if (previousValue === null || previousValue === undefined) return;
  if (previousValue.receiptRef !== null) {
    const receipt = receipts.find(entry => entry.receiptId === previousValue.receiptRef);
    if (receipt === undefined) {
      throw new StepwiseStudentDataError(
        `sample ${sampleId} ${stepId} previousExecution receipt ${previousValue.receiptRef} is missing from this step`,
      );
    }
    // v2 receipts carry an optional opaque `actionRef`; the fixed generator's
    // receipts always carry it. Fall back to the semantic `action` verb only
    // when no opaque ref is present, so the previous-execution identity check
    // stays meaningful for both shapes.
    const receiptActionIdentity = receipt.actionRef ?? receipt.action;
    if (receiptActionIdentity !== previousValue.actionRef) {
      throw new StepwiseStudentDataError(
        `sample ${sampleId} ${stepId} receipt ${previousValue.receiptRef} action mismatch`,
      );
    }
    if (
      receipt.pendingRelationRef !== undefined
      && receipt.pendingRelationRef !== pendingRelationRef
    ) {
      throw new StepwiseStudentDataError(
        `sample ${sampleId} ${stepId} receipt ${previousValue.receiptRef} relation mismatch`,
      );
    }
    if (receipt.optionSemantics !== undefined && receipt.optionSemantics !== previousValue.optionSemantics) {
      throw new StepwiseStudentDataError(
        `sample ${sampleId} ${stepId} receipt ${previousValue.receiptRef} optionSemantics mismatch`,
      );
    }
    if (receipt.fromStepId !== undefined && receipt.fromStepId !== previousValue.fromStepId) {
      throw new StepwiseStudentDataError(
        `sample ${sampleId} ${stepId} receipt ${previousValue.receiptRef} fromStepId mismatch`,
      );
    }
    if (receipt.target !== undefined && receipt.target !== previousValue.targetRef) {
      throw new StepwiseStudentDataError(
        `sample ${sampleId} ${stepId} receipt ${previousValue.receiptRef} target mismatch`,
      );
    }
    if (receipt.outcome !== undefined && receipt.outcome !== previousValue.outcome) {
      throw new StepwiseStudentDataError(
        `sample ${sampleId} ${stepId} receipt ${previousValue.receiptRef} outcome mismatch`,
      );
    }
  }
  const pending = new Set<string>();
  for (const receipt of receipts) {
    if (receipt.receiptId === previousValue.receiptRef) continue;
    const key = `${receipt.action}\u0000${receipt.fromEdgeRef ?? receipt.target ?? ""}`;
    if (pending.has(key)) {
      throw new StepwiseStudentDataError(
        `sample ${sampleId} ${stepId} multiple unbound predecessor receipts for previous action`,
      );
    }
    pending.add(key);
  }
}

function validateTsJsProducerSourceBinding(input: {
  readonly sampleId: string;
  readonly stepId: string;
  readonly requestRef: string;
  readonly pendingRelationRef: string;
  readonly callSiteRef: string;
  readonly requestedDeclarationRef: string;
  readonly requestedModuleRef: string;
  readonly coverage: RelationStepCoverage | null;
  readonly sourceContent: RelationStepSourceContent | null;
  readonly currentRelation: CurrentRelationProjection | null;
  readonly observedLocalFacts: readonly StepwiseObservedLocalFact[];
  readonly receipt: RelationStepReceipt;
  readonly previous: Observed<PreviousExecutionProjection | null> | undefined;
}): void {
  const source = input.receipt.producerSource;
  if (source === undefined) return;
  const fail = (reason: string): never => {
    throw new StepwiseStudentDataError(
      `sample ${input.sampleId} ${input.stepId} producer bridge ${reason}`,
    );
  };
  if (source.kind !== "nnanything.tsjs.producer-source.v1") fail("kind mismatch");
  if (source.sampleId !== input.sampleId) fail("sampleId mismatch");
  if (source.stepId !== input.stepId) fail("stepId mismatch");
  if (source.requestRef !== input.requestRef) fail("requestRef mismatch");
  if (source.pendingRelationRef !== input.pendingRelationRef) fail("pendingRelationRef mismatch");
  if (source.callSiteRef !== input.callSiteRef) fail("callSiteRef mismatch");
  if (source.requestedDeclarationRef !== input.requestedDeclarationRef) {
    fail("requestedDeclarationRef mismatch");
  }
  if (source.requestedModuleRef !== input.requestedModuleRef) fail("requestedModuleRef mismatch");
  if (source.fromStepId !== (input.receipt.fromStepId ?? null)) fail("fromStepId mismatch");
  if (source.parser.semanticBinding !== false) fail("parser.semanticBinding must remain false");
  if (source.rawObservation.callSiteRef !== input.callSiteRef) fail("raw callSiteRef mismatch");
  if (source.rawObservation.binding.callSiteRef !== input.callSiteRef) {
    fail("raw binding callSiteRef mismatch");
  }
  const sourceReadRef = source.rawObservation.sourceReadRef;
  if (sourceReadRef.length === 0) fail("missing raw sourceReadRef");
  const rawReceipt = source.rawObservation.sourceReadReceipt;
  if (
    input.receipt.receiptId !== rawReceipt.receiptId
    || input.receipt.actionRef !== rawReceipt.actionRef
    || input.receipt.action !== rawReceipt.action
    || input.receipt.target !== rawReceipt.targetRef
    || input.receipt.origin !== rawReceipt.origin
    || input.receipt.outcome !== rawReceipt.outcome
    || !sameStringArray(
      Array.isArray(input.receipt.result) ? input.receipt.result as readonly string[] : [],
      rawReceipt.result,
    )
    || !sameStringArray(input.receipt.evidenceRefs, rawReceipt.evidenceRefs)
  ) {
    fail("receipt projection mismatch");
  }
  if (rawReceipt.result.some(ref => !ref.startsWith("source-read:"))) {
    fail("raw receipt contains a non-source-read result");
  }
  if (!rawReceipt.evidenceRefs.includes(sourceReadRef)) {
    fail("raw receipt does not retain sourceReadRef");
  }
  const rawBinding = source.rawObservation.binding;
  if (
    !rawBinding.evidenceRefs.includes(sourceReadRef)
    || !rawBinding.resolution.evidenceRefs.includes(sourceReadRef)
    || rawBinding.bindingMode !== "dynamic"
    || rawBinding.resolution.status !== "dynamic"
    || rawBinding.resolution.reason !== "dynamic_undecidable"
    || rawBinding.declarationRefs.length !== 0
    || rawBinding.scopeRef !== null
  ) {
    fail("raw binding mismatch");
  }
  const roleFacts = source.rawObservation.facts;
  if (
    roleFacts.length !== 2
    || roleFacts.filter(fact => fact.role === "selector_candidate_table").length !== 1
    || roleFacts.filter(fact => fact.role === "runtime_selector_dependency").length !== 1
    || roleFacts.some(fact => fact.state !== "known" || !fact.evidenceRefs.includes(sourceReadRef))
  ) {
    fail("raw role facts mismatch");
  }
  const projection = input.currentRelation?.binding.state === "known"
    ? input.currentRelation.binding.value
    : undefined;
  if (projection === undefined) return fail("currentRelation binding value missing");
  if (
    projection.symbolRef !== rawBinding.symbolRef
    || projection.callSiteRef !== rawBinding.callSiteRef
    || projection.role !== rawBinding.role
    || projection.bindingMode !== rawBinding.bindingMode
    || !sameStringArray(projection.evidenceRefs, rawBinding.evidenceRefs)
    || projection.declarationRefs.length !== 0
    || projection.scopeRef !== null
    || projection.resolution.status !== "dynamic"
    || projection.resolution.reason !== "dynamic_undecidable"
    || !sameStringArray(projection.resolution.evidenceRefs, rawBinding.resolution.evidenceRefs)
  ) {
    fail("currentRelation projection mismatch");
  }
  if (input.observedLocalFacts.length !== roleFacts.length) fail("role fact count mismatch");
  for (const [index, fact] of roleFacts.entries()) {
    const projected = input.observedLocalFacts[index];
    if (
      projected === undefined
      || projected.factRef !== fact.factRef
      || projected.role !== fact.role
      || projected.state !== fact.state
      || projected.value !== fact.value
      || !sameStringArray(projected.evidenceRefs, fact.evidenceRefs)
    ) {
      fail(`role fact ${index} projection mismatch`);
    }
  }
  if (
    input.sourceContent === null
    || input.sourceContent.state !== "observed"
    || !sameStringArray(input.sourceContent.resultRefs, rawReceipt.result)
    || !input.sourceContent.evidenceRefs.includes(sourceReadRef)
  ) {
    fail("sourceContent projection mismatch");
  }
  const previous = input.previous?.state === "known" ? input.previous.value : null;
  if (
    previous === null
    || previous === undefined
    || previous.receiptRef !== rawReceipt.receiptId
    || previous.actionRef !== rawReceipt.actionRef
    || previous.targetRef !== rawReceipt.targetRef
    || previous.fromStepId !== source.fromStepId
    || previous.pendingRelationRef !== source.pendingRelationRef
    || previous.outcome !== "success"
  ) {
    fail("previousExecution mismatch");
  }
  const moduleFiles = rawReceipt.modules.map(module => module.file);
  const successfulFiles = successfulProducerFiles(source.producerRequest, source.coverage);
  if (moduleFiles.some(file => !successfulFiles.includes(file))) {
    fail("raw observation modules are not in the producer read set");
  }
  const requestedModuleFile = moduleFileFromRef(source.requestedModuleRef);
  if (requestedModuleFile === null) return fail("requested moduleRef is invalid");
  if (
    input.coverage === null
    || !sameStringArray(input.coverage.coveredModules ?? [], successfulFiles)
    || input.coverage.targetModuleReached !== successfulFiles.includes(requestedModuleFile)
  ) {
    fail("coverage projection mismatch");
  }
}

export async function loadStepwiseFamilyManifest(familyDir: string): Promise<{
  readonly sourceGroup: string;
  readonly language: string;
  readonly semanticStratum: string;
  readonly partition: string;
  readonly derivationFamily: string;
}> {
  const manifest = JSON.parse(await readFile(join(familyDir, "manifest.json"), "utf8")) as unknown;
  if (!isRecord(manifest)) throw new TypeError(`${familyDir}/manifest.json must contain an object`);
  return {
    sourceGroup: requireString(manifest.sourceGroup, "manifest.sourceGroup"),
    language: requireString(manifest.language, "manifest.language"),
    semanticStratum: requireString(manifest.semanticStratum, "manifest.semanticStratum"),
    partition: requireString(manifest.partition, "manifest.partition"),
    derivationFamily: isRecord(manifest.derivationFamily)
      ? requireString(manifest.derivationFamily.familyId, "manifest.derivationFamily.familyId")
      : requireString(manifest.sourceGroup, "manifest.sourceGroup"),
  };
}

// Typed state must be respected: only a known string value is usable. An
// unknown/missing/not_requested/conflicting field with a residual string is not
// known, so it must never leak as one. A plain `{ value: string }` object with
// no `state` field is accepted as a legacy compatibility input (treated as a
// known value), so this helper is not a strict known-only guard; only a field
// whose `state` is an explicit non-known value is rejected.
const TYPED_FIELD_KNOWN_STATE = "known" as const;
const TYPED_FIELD_NON_KNOWN_STATE = "not known (unknown/missing/conflicting/not_requested/unsupported)" as const;

function isTypedFieldNotKnown(field: Readonly<{ readonly state?: unknown }>): boolean {
  return typeof field.state === "string" && field.state !== TYPED_FIELD_KNOWN_STATE;
}

function typedFieldToString(field: unknown): string | null {
  if (typeof field === "string") return field;
  if (isRecord(field)) {
    if (isTypedFieldNotKnown(field)) return null;
    if (
      field.state === TYPED_FIELD_KNOWN_STATE
      || field.state === undefined
    ) {
      if (typeof field.value === "string" && field.value.length > 0) return field.value;
      return null;
    }
    return null;
  }
  return null;
}

function normalizeFixedStudentReceipt(entry: unknown): unknown {
  if (!isRecord(entry)) return entry;
  const receiptId = entry.receiptId ?? entry.receiptRef;
  const target = entry.target ?? entry.targetRef;
  const result = entry.result ?? entry.resultRefs;
  return {
    ...entry,
    ...(typeof receiptId === "string" ? { receiptId } : {}),
    ...(typeof target === "string" ? { target } : {}),
    ...(result === undefined ? {} : { result }),
  };
}

function normalizeFixedStudentSteps(
  steps: unknown,
  pendingRelationRef: string,
): unknown {
  if (!Array.isArray(steps)) return steps;
  return steps.map(step => {
    if (!isRecord(step)) return step;
    const receipts = Array.isArray(step.receipts)
      ? step.receipts.map(normalizeFixedStudentReceipt)
      : step.receipts;
    const cursor = isRecord(step.localCandidateCursor)
      && step.localCandidateCursor.pendingRelationRef === undefined
      ? { ...step.localCandidateCursor, pendingRelationRef }
      : step.localCandidateCursor;
    return { ...step, receipts, localCandidateCursor: cursor };
  });
}

function normalizeFixedStudentRequest(
  rawRecord: Record<string, unknown>,
  sampleId: string,
  recordIndex: number,
): Record<string, unknown> {
  const request = isRecord(rawRecord.request) ? rawRecord.request : null;
  if (request === null) {
    throw new TypeError(`student record ${recordIndex + 1} is missing request`);
  }
  const requestedDeclaration = isRecord(request.requestedDeclaration)
    ? request.requestedDeclaration
    : null;
  if (requestedDeclaration === null) {
    throw new TypeError(`sample ${sampleId} is missing request.requestedDeclaration`);
  }
  const relationObligation = isRecord(request.relationObligation)
    ? request.relationObligation
    : null;
  if (relationObligation === null) {
    throw new TypeError(`sample ${sampleId} is missing request.relationObligation`);
  }
  const requestRef = requireString(request.requestRef, `sample ${sampleId} request.requestRef`);
  // Preserve the inner relationObligation.requestRef. It must match the outer
  // requestRef when explicitly present; a silent overwrite would hide an
  // inner/outer identity conflict from downstream validation.
  const innerRequestRef = relationObligation.requestRef;
  if (typeof innerRequestRef === "string" && innerRequestRef !== requestRef) {
    throw new StepwiseStudentDataError(
      `sample ${sampleId} relationObligation.requestRef ${innerRequestRef} conflicts with request.requestRef ${requestRef}`,
    );
  }
  const declarationRef = typedFieldToString(requestedDeclaration.declarationRef);
  if (declarationRef === null) {
    throw new TypeError(
      `sample ${sampleId} requestedDeclaration.declarationRef must be a known string`,
    );
  }
  const pendingRelationRef = requireString(
    relationObligation.pendingRelationRef,
    `sample ${sampleId} relationObligation.pendingRelationRef`,
  );
  const moduleRef = typedFieldToString(requestedDeclaration.moduleRef);
  const name = typedFieldToString(requestedDeclaration.name);
  const kind = typedFieldToString(requestedDeclaration.kind);
  const sourceTargetRef = typeof requestedDeclaration.sourceTargetRef === "string"
    ? requestedDeclaration.sourceTargetRef
    : null;
  return {
    schemaVersion: STEPWISE_STUDENT_OBSERVATION_SCHEMA,
    sampleId,
    family: rawRecord.family,
    sourceGroup: rawRecord.sourceGroup,
    partition: rawRecord.partition,
    language: rawRecord.language,
    semanticStratum: rawRecord.semanticStratum,
    entryFile: rawRecord.entryFile,
    request: {
      requestRef,
      requestedDeclaration: {
        declarationRef,
        moduleRef,
        name,
        kind,
        sourceTargetRef,
      },
      relationObligation: {
        requestRef,
        callSiteRef: requireString(
          relationObligation.callSiteRef,
          `sample ${sampleId} relationObligation.callSiteRef`,
        ),
        calleeName: typeof relationObligation.calleeName === "string"
          ? relationObligation.calleeName
          : null,
        pendingRelationRef,
      },
    },
    steps: normalizeFixedStudentSteps(rawRecord.steps, pendingRelationRef),
  };
}

export async function loadStepwiseEpisodeFamily(
  familyDir: string,
): Promise<readonly RelationStepEpisode[]> {
  const manifest = await loadStepwiseFamilyManifest(familyDir);
  const observationsPath = join(familyDir, STEPWISE_STUDENT_OBSERVATIONS_FILE);
  const records = parseJsonl(await readFile(observationsPath, "utf8"), observationsPath);
  const episodes: RelationStepEpisode[] = [];
  const seenSamples = new Set<string>();
  const seenSteps = new Set<string>();
  for (const [sampleIndex, rawRecord] of records.entries()) {
    if (!isRecord(rawRecord)) throw new TypeError(`student record ${sampleIndex + 1} must be an object`);
    rejectStudentLeakage(rawRecord, `student[${sampleIndex}]`);
    const isFixedSchema = rawRecord.schemaVersion === FIXED_STEPWISE_STUDENT_SCHEMA;
    if (
      rawRecord.schemaVersion !== STEPWISE_STUDENT_OBSERVATION_SCHEMA
      && !isFixedSchema
    ) {
      throw new TypeError(`student record ${sampleIndex + 1} has an unsupported schemaVersion`);
    }
    const sampleId = requireString(rawRecord.sampleId, "student.sampleId");
    if (seenSamples.has(sampleId)) throw new TypeError(`duplicate stepwise sample ${sampleId}`);
    seenSamples.add(sampleId);
    const normalizedRecord = isFixedSchema
      ? normalizeFixedStudentRequest(rawRecord, sampleId, sampleIndex)
      : rawRecord;
    if (normalizedRecord.partition !== manifest.partition) {
      throw new TypeError(
        `sample ${sampleId} partition ${String(normalizedRecord.partition)} does not match manifest partition ${manifest.partition}`,
      );
    }
    if (normalizedRecord.language !== manifest.language) {
      throw new TypeError(
        `sample ${sampleId} language ${String(normalizedRecord.language)} does not match manifest language ${manifest.language}`,
      );
    }
    const request = isRecord(normalizedRecord.request) ? normalizedRecord.request : null;
    if (request === null) throw new TypeError(`sample ${sampleId} is missing request`);
    const requestRef = requireString(request.requestRef, `sample ${sampleId} request.requestRef`);
    const relationObligation = isRecord(request.relationObligation) ? request.relationObligation : null;
    if (relationObligation === null) {
      throw new TypeError(`sample ${sampleId} is missing request.relationObligation`);
    }
    const requestedDeclaration = isRecord(request.requestedDeclaration)
      ? request.requestedDeclaration
      : null;
    if (requestedDeclaration === null) {
      throw new TypeError(`sample ${sampleId} is missing request.requestedDeclaration`);
    }
    const targetRef = requireString(
      requestedDeclaration.declarationRef,
      `sample ${sampleId} requestedDeclaration.declarationRef`,
    );
    const callSiteRef = requireString(
      relationObligation.callSiteRef,
      `sample ${sampleId} relationObligation.callSiteRef`,
    );
    const pendingRelationRef = requireString(
      relationObligation.pendingRelationRef,
      `sample ${sampleId} relationObligation.pendingRelationRef`,
    );
    const innerRequestRef = relationObligation.requestRef;
    if (typeof innerRequestRef === "string" && innerRequestRef !== requestRef) {
      throw new StepwiseStudentDataError(
        `sample ${sampleId} relationObligation.requestRef ${innerRequestRef} conflicts with request.requestRef ${requestRef}`,
      );
    }
    const steps = requireArray(normalizedRecord.steps, `sample ${sampleId} steps`);
    const entryFile = resolveStepwiseEntryFile(normalizedRecord, sampleId);
    for (const [stepIndex, rawStep] of steps.entries()) {
      if (!isRecord(rawStep)) throw new TypeError(`sample ${sampleId} step ${stepIndex + 1} must be an object`);
      const stepId = requireString(rawStep.stepId, `sample ${sampleId} stepId`);
      const stepKey = `${sampleId}|${stepId}`;
      if (seenSteps.has(stepKey)) throw new TypeError(`duplicate stepwise step ${stepKey}`);
      seenSteps.add(stepKey);
      const localSyntax = isRecord(rawStep.localSyntax) ? rawStep.localSyntax : null;
      if (localSyntax === null) throw new TypeError(`sample ${sampleId} ${stepId} is missing localSyntax`);
      const receipts = requireArray(rawStep.receipts ?? [], `sample ${sampleId} ${stepId} receipts`)
        .map((entry, receiptIndex): RelationStepReceipt => {
          if (!isRecord(entry)) {
            throw new TypeError(`sample ${sampleId} ${stepId} receipt ${receiptIndex + 1} must be an object`);
          }
          return {
            receiptId: requireString(entry.receiptId, `sample ${sampleId} ${stepId} receiptId`),
            ...(typeof entry.actionRef === "string" ? { actionRef: entry.actionRef } : {}),
            action: requireString(entry.action, `sample ${sampleId} ${stepId} receipt action`),
            ...(typeof entry.target === "string"
              ? { target: entry.target }
              : typeof entry.targetRef === "string"
                ? { target: entry.targetRef }
                : {}),
            ...(typeof entry.fromEdgeRef === "string" ? { fromEdgeRef: entry.fromEdgeRef } : {}),
            ...(entry.origin === "source_observation" || entry.origin === "model_execution"
              ? { origin: entry.origin }
              : {}),
            ...(entry.fromStepId === null || typeof entry.fromStepId === "string"
              ? { fromStepId: entry.fromStepId }
              : {}),
            ...(typeof entry.pendingRelationRef === "string"
              ? { pendingRelationRef: entry.pendingRelationRef }
              : {}),
            ...(entry.optionSemantics === "observe" || entry.optionSemantics === "advance"
              ? { optionSemantics: entry.optionSemantics }
              : {}),
            ...(entry.outcome === "success"
              || entry.outcome === "partial"
              || entry.outcome === "failed"
              || entry.outcome === "unknown"
              ? { outcome: entry.outcome }
              : {}),
            result: entry.result,
            evidenceRefs: requireArray(
              entry.evidenceRefs ?? [],
              `sample ${sampleId} ${stepId} receipt evidenceRefs`,
            ).map((ref, index) => requireString(ref, `receipt evidenceRefs[${index}]`)),
            ...(entry.producerSource === undefined
              ? {}
              : {
                  producerSource: parseProducerSourceBinding(
                    entry.producerSource,
                    sampleId,
                    stepId,
                  ),
                }),
          };
        });
      const sourceContentRaw = isRecord(localSyntax.sourceContent)
        ? localSyntax.sourceContent
        : null;
      const sourceContent: RelationStepSourceContent | null = sourceContentRaw === null
        ? null
        : {
            state: requireString(sourceContentRaw.state, "localSyntax.sourceContent.state") as RelationStepSourceContent["state"],
            resultRefs: requireArray(
              sourceContentRaw.resultRefs ?? [],
              "localSyntax.sourceContent.resultRefs",
            ).map((ref, index) => requireString(ref, `sourceContent.resultRefs[${index}]`)),
            reason: typeof sourceContentRaw.reason === "string" ? sourceContentRaw.reason : null,
            evidenceRefs: requireArray(
              sourceContentRaw.evidenceRefs ?? [],
              "localSyntax.sourceContent.evidenceRefs",
            ).map((ref, index) => requireString(ref, `sourceContent.evidenceRefs[${index}]`)),
          };
      const coverageRaw = isRecord(rawStep.coverage) ? rawStep.coverage : null;
      const coverage: RelationStepCoverage | null = coverageRaw === null
        ? null
        : {
            ...(Array.isArray(coverageRaw.coveredModules)
              ? {
                  coveredModules: coverageRaw.coveredModules.map((ref, index) =>
                    requireString(ref, `coverage.coveredModules[${index}]`)
                  ),
                }
              : {}),
            ...(typeof coverageRaw.targetModuleReached === "boolean"
              ? { targetModuleReached: coverageRaw.targetModuleReached }
              : {}),
            ...(typeof coverageRaw.note === "string" ? { note: coverageRaw.note } : {}),
          };
      const producerBacked = receipts.some(receipt => receipt.producerSource !== undefined);
      if (
        producerBacked
        && (!Object.hasOwn(rawStep, "remainingObligations")
          || !Array.isArray(rawStep.remainingObligations))
      ) {
        throw new StepwiseStudentDataError(
          `sample ${sampleId} ${stepId} producer-backed step requires explicit remainingObligations`,
        );
      }
      if (
        producerBacked
        && (!Object.hasOwn(rawStep, "localCandidateCursor")
          || !isRecord(rawStep.localCandidateCursor))
      ) {
        throw new StepwiseStudentDataError(
          `sample ${sampleId} ${stepId} producer-backed step requires explicit localCandidateCursor`,
        );
      }
      const remainingObligations = requireArray(
        Object.hasOwn(rawStep, "remainingObligations") ? rawStep.remainingObligations : [],
        `sample ${sampleId} ${stepId} remainingObligations`,
      ).map((entry, index) => {
        if (!isRecord(entry) || (entry.kind !== "observe" && entry.kind !== "advance")) {
          throw new TypeError(`sample ${sampleId} ${stepId} remainingObligations[${index}] is invalid`);
        }
        if (entry.pendingRelationRef === undefined || entry.pendingRelationRef === null) {
          throw new StepwiseStudentDataError(
            `sample ${sampleId} ${stepId} remainingObligations[${index}].pendingRelationRef must be explicit`,
          );
        }
        const pending = requireString(
          entry.pendingRelationRef,
          `sample ${sampleId} ${stepId} remainingObligations[${index}].pendingRelationRef`,
        );
        if (pending !== pendingRelationRef) {
          throw new StepwiseStudentDataError(
            `sample ${sampleId} ${stepId} remainingObligations[${index}] pendingRelationRef mismatch`,
          );
        }
        return {
          kind: entry.kind as "observe" | "advance",
          ref: requireString(entry.ref, `sample ${sampleId} ${stepId} obligation ref`),
          pendingRelationRef: pending,
          ...(typeof entry.skillRef === "string" ? { skillRef: entry.skillRef } : {}),
          ...(entry.arguments === undefined
            ? {}
            : { arguments: parseObligationArguments(entry.arguments, sampleId, stepId, index) }),
          informationGain: parseInformationGain(entry.informationGain, sampleId, stepId, index),
          ...(typeof entry.informationGainExplanation === "string"
            ? { informationGainExplanation: entry.informationGainExplanation }
            : {}),
          ...(entry.evidenceRefs === undefined
            ? {}
            : {
                evidenceRefs: stringArray(entry.evidenceRefs),
              }),
        };
      });
      const sourceCandidateRefs = rawStep.S_g === undefined
        ? undefined
        : requireArray(
            rawStep.S_g,
            `sample ${sampleId} ${stepId} S_g`,
          ).map((ref, index) => requireString(ref, `sample ${sampleId} ${stepId} S_g[${index}]`));
      const currentRelation = parseCurrentRelation(rawStep.currentRelation, sampleId, stepId);
      const previousExecution = parsePreviousExecution(rawStep.previousExecution, sampleId, stepId);
      const localCandidateCursor = parseLocalCandidateCursor(rawStep.localCandidateCursor, sampleId, stepId);
      if (currentRelation !== null && currentRelation.pendingRelationRef !== pendingRelationRef) {
        throw new StepwiseStudentDataError(
          `sample ${sampleId} ${stepId} currentRelation.pendingRelationRef mismatch`,
        );
      }
      if (
        currentRelation?.binding.state === "known"
        && currentRelation.binding.value !== undefined
        && currentRelation.binding.value.resolution.status === "resolved"
      ) {
        const resolution = currentRelation.binding.value.resolution;
        const declarations = Array.isArray(localSyntax.observedDeclarations)
          ? localSyntax.observedDeclarations
          : [];
        const matches = declarations.filter((declaration) =>
          isRecord(declaration) && declaration.declarationRef === resolution.declarationRef
        );
        if (matches.length !== 1) {
          throw new StepwiseStudentDataError(
            `sample ${sampleId} ${stepId} resolved declarationRef ${resolution.declarationRef} must match one observed declaration`,
          );
        }
        const declaration = matches[0];
        if (
          isRecord(declaration)
          && resolution.moduleRef !== null
          && typeof declaration.moduleRef === "string"
          && resolution.moduleRef !== declaration.moduleRef
        ) {
          throw new StepwiseStudentDataError(
            `sample ${sampleId} ${stepId} resolved moduleRef conflicts with observed declaration`,
          );
        }
      }
      validateReceiptsAndPreviousExecution(
        sampleId,
        stepId,
        pendingRelationRef,
        receipts,
        previousExecution,
      );
      const localEvidence = collectStepEvidence(localSyntax);
      const observedLocalFacts = parseObservedLocalFacts(localSyntax, sampleId, stepId);
      const requestedModuleRef = typeof requestedDeclaration.moduleRef === "string"
        ? requestedDeclaration.moduleRef
        : null;
      for (const receipt of receipts) {
        if (receipt.producerSource === undefined) continue;
        if (requestedModuleRef === null) {
          throw new StepwiseStudentDataError(
            `sample ${sampleId} ${stepId} producer bridge requires requestedDeclaration.moduleRef`,
          );
        }
        validateTsJsProducerSourceBinding({
          sampleId,
          stepId,
          requestRef,
          pendingRelationRef,
          callSiteRef,
          requestedDeclarationRef: targetRef,
          requestedModuleRef,
          coverage,
          sourceContent,
          currentRelation,
          observedLocalFacts,
          receipt,
          previous: previousExecution,
        });
      }
      const evidenceRefs = [...new Set([
        ...localEvidence,
        ...receipts.flatMap(receipt => receipt.evidenceRefs),
        ...remainingObligations.flatMap(obligation => obligation.evidenceRefs ?? []),
        ...(currentRelation?.binding.evidenceRefs ?? []),
        ...(previousExecution?.evidenceRefs ?? []),
        ...(localCandidateCursor?.evidenceRefs ?? []),
      ])];
      const episode = {
        sampleId,
        stepId,
        requestId: requestRef,
        sourceGroup: manifest.sourceGroup,
        language: manifest.language,
        semanticStratum: manifest.semanticStratum,
        partition: manifest.partition,
        entryFile,
        targetRef,
        observedFacts: localEvidence,
        pendingRelationRef,
        callSiteRef,
        calleeName: typeof relationObligation.calleeName === "string"
          ? relationObligation.calleeName
          : null,
        requestedDeclaration:
          requestedDeclaration as unknown as NonNullable<RelationStepEpisode["requestedDeclaration"]>,
        currentRelation,
        ...(previousExecution === undefined ? {} : { previousExecution }),
        ...(localCandidateCursor === undefined ? {} : { localCandidateCursor }),
        observedBindings: requireArray(
          localSyntax.observedBindings ?? [],
          `sample ${sampleId} ${stepId} observedBindings`,
        ) as NonNullable<RelationStepEpisode["observedBindings"]>,
        observedDeclarations: requireArray(
          localSyntax.observedDeclarations ?? [],
          `sample ${sampleId} ${stepId} observedDeclarations`,
        ) as NonNullable<RelationStepEpisode["observedDeclarations"]>,
        sourceContent,
        shadowFacts: requireArray(
          localSyntax.shadowFacts ?? [],
          `sample ${sampleId} ${stepId} shadowFacts`,
        ) as NonNullable<RelationStepEpisode["shadowFacts"]>,
        remainingObligations,
        receipts,
        coverage,
        notReady: rawStep.notReady === true,
        ...(sourceCandidateRefs === undefined ? {} : { sourceCandidateRefs }),
        cursorOpen: localCandidateCursor?.state === "open",
        enumerationFailure: localCandidateCursor?.state === "failed",
        evidenceRefs,
        failureMode: rawStep.notReady === true
          ? coverage?.note ?? "step_not_ready"
          : null,
        derivationFamily: manifest.derivationFamily,
        adapterRef: `tsjs-unified-adapter:${manifest.language}`,
        observedLocalFacts,
      };
      episodes.push(episode as unknown as RelationStepEpisode);
    }
  }
  if (episodes.length === 0) throw new TypeError(`stepwise student corpus ${observationsPath} has no steps`);
  return episodes;
}

export async function loadEpisodeFamily(familyDir: string): Promise<readonly RelationStepEpisode[]> {
  const manifestText = await readFile(join(familyDir, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText) as {
    readonly sourceGroup: string;
    readonly language: string;
    readonly semanticStratum: string;
    readonly partition: string;
    readonly derivationFamily?: { readonly familyId: string };
  };
  const preStateLines = (await readFile(join(familyDir, "evidence", "pre-state.jsonl"), "utf8"))
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as {
      readonly sampleId: string;
      readonly stepId?: string;
      readonly observedFacts: readonly string[];
      readonly pendingRelationRef?: string | null;
      readonly callSiteRef?: string | null;
      readonly calleeName?: string | null;
      readonly requestedDeclaration?: RelationStepEpisode["requestedDeclaration"];
      readonly observedBindings?: RelationStepEpisode["observedBindings"];
      readonly observedDeclarations?: RelationStepEpisode["observedDeclarations"];
      readonly remainingObligations?: RelationStepEpisode["remainingObligations"];
      readonly cursorOpen?: boolean;
      readonly enumerationFailure?: boolean;
    });
  const preState = new Map(
    preStateLines.map(record => [
      `${record.sampleId}|${record.stepId ?? DEFAULT_RELATION_STEP_ID}`,
      record,
    ]),
  );
  const files = (await readdir(familyDir)).filter(name => name.startsWith("episode-") && name.endsWith(".jsonl"));
  files.sort();
  const episodes: RelationStepEpisode[] = [];
  const seenSteps = new Set<string>();
  for (const file of files) {
    for (const line of (await readFile(join(familyDir, file), "utf8")).split("\n")) {
      if (line.trim().length === 0) continue;
      const raw = JSON.parse(line) as {
        readonly sampleId: string;
        readonly stepId?: string;
        readonly requestId: string;
        readonly sourceGroup: string;
        readonly language: string;
        readonly semanticStratum: string;
        readonly partition: string;
        readonly entryFile: string;
        readonly goal: { readonly targetRef: string };
        readonly failureMode: string | null;
        readonly evidenceRefs: readonly string[];
      };
      const stepId = raw.stepId ?? DEFAULT_RELATION_STEP_ID;
      const stepKey = `${raw.sampleId}|${stepId}`;
      if (seenSteps.has(stepKey)) throw new TypeError(`duplicate episode step ${stepKey}`);
      seenSteps.add(stepKey);
      const state = preState.get(stepKey);
      if (!state) throw new TypeError(`missing pre-state for ${stepKey}`);
      episodes.push({
        sampleId: raw.sampleId,
        stepId,
        requestId: raw.requestId,
        sourceGroup: raw.sourceGroup,
        language: raw.language,
        semanticStratum: raw.semanticStratum,
        partition: raw.partition,
        entryFile: raw.entryFile,
        targetRef: raw.goal.targetRef,
        observedFacts: state.observedFacts,
        pendingRelationRef: state.pendingRelationRef ?? null,
        callSiteRef: state.callSiteRef ?? null,
        calleeName: state.calleeName ?? null,
        requestedDeclaration: state.requestedDeclaration ?? null,
        observedBindings: state.observedBindings ?? [],
        observedDeclarations: state.observedDeclarations ?? [],
        remainingObligations: state.remainingObligations ?? [],
        cursorOpen: state.cursorOpen === true,
        enumerationFailure: state.enumerationFailure === true,
        evidenceRefs: raw.evidenceRefs,
        failureMode: raw.failureMode,
        derivationFamily: manifest.derivationFamily?.familyId ?? manifest.sourceGroup,
        adapterRef: `tsjs-unified-adapter:${manifest.language}`,
      });
    }
  }
  return episodes;
}
