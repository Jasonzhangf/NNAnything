// Student-side converter: source observation + legal skills -> complete S_g and x[64].
//
// Path A of the launch contract (§4.4.2). It must never read `labels/gold.jsonl`
// or any teacher resolution. The candidate group is the finite typed action set
// generated from the current observation (not gold), so removing gold leaves
// every student row byte-identical.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BindingEdge,
  Candidate,
  CurrentRelationProjection,
  DeclarationIdentity,
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
  type TsJsCompletionWork,
  type TsJsCompletionWorkItem,
  type TsJsCompletionWorkKind,
  type TsJsDynamicProducerSourceBinding,
  type TsJsLexicalProducerSourceBinding,
  type TsJsProducerSourceBinding,
  type TsJsStaticProducerSourceBinding,
  type TsJsTargetMismatchProducerSourceBinding,
} from "./unified-step-context-builder.js";
import { runTsJsSymbolTable } from "../adapters/cli/tsjs-symbol-table-adapter.js";
import {
  canonicalRepoFileFromModuleRef,
  isSafeRepoRelative,
  normalizeRepoRelative,
  spanKey,
  validateTsJsSymbolRequest,
} from "../filters/tsjs-symbol-table-policy.js";
import type {
  TsJsCoverageRecord,
  TsJsInlineCallableIdentity,
  TsJsLexicalCallSiteBindingObservation,
  TsJsParserRecord,
  TsJsReadReceipt,
  TsJsRuntimeSelectorObservation,
  TsJsRuntimeCallableTable,
  TsJsRuntimeSelectorRoleFact,
  TsJsStaticSelectedSelectorObservation,
  TsJsTargetMismatchObservation,
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

const NUL = String.fromCharCode(0);

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
  // Explicit route marker. Only `lexical` consults the lexical call-site
  // binding slot; every other request keeps the dynamic/staticSelected path.
  readonly route?: string;
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

export type TsJsObservationSelection =
  | { readonly kind: "dynamic"; readonly observation: TsJsRuntimeSelectorObservation }
  | { readonly kind: "static_selected"; readonly observation: TsJsStaticSelectedSelectorObservation }
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous" };

export function selectTsJsObservationForCallSite(input: {
  readonly dynamic: readonly TsJsRuntimeSelectorObservation[];
  readonly staticSelected: readonly TsJsStaticSelectedSelectorObservation[];
  readonly callSiteRef: string;
}): TsJsObservationSelection {
  const dynamic = input.dynamic.filter(
    observation =>
      observation.callSiteRef === input.callSiteRef
      && observation.binding.callSiteRef === input.callSiteRef,
  );
  const staticSelected = input.staticSelected.filter(
    observation =>
      observation.callSiteRef === input.callSiteRef
      && observation.binding.callSiteRef === input.callSiteRef,
  );
  if (dynamic.length > 0 && staticSelected.length > 0) return { kind: "ambiguous" };
  if (dynamic.length > 1 || staticSelected.length > 1) return { kind: "ambiguous" };
  if (dynamic.length === 1) {
    return { kind: "dynamic", observation: dynamic[0]! };
  }
  if (staticSelected.length === 1) {
    return { kind: "static_selected", observation: staticSelected[0]! };
  }
  return { kind: "none" };
}

export type TsJsLexicalObservationSelection =
  | { readonly kind: "lexical"; readonly observation: TsJsLexicalCallSiteBindingObservation }
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous" };

// The lexical producer keys a call site on its span-derived ref only. Unlike
// the dynamic/static-selected selector there is no binding.callSiteRef to gate
// on, so the exact span ref is the whole selection key.
export function selectTsJsLexicalBindingForCallSite(input: {
  readonly lexical: readonly TsJsLexicalCallSiteBindingObservation[];
  readonly callSiteRef: string;
}): TsJsLexicalObservationSelection {
  const matches = input.lexical.filter(
    observation => observation.callSiteRef === input.callSiteRef,
  );
  if (matches.length === 0) return { kind: "none" };
  if (matches.length > 1) return { kind: "ambiguous" };
  return { kind: "lexical", observation: matches[0]! };
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
  if (raw === "train" || raw === "TRAIN") return "TRAIN";
  if (raw === "dev" || raw === "DEV") return "DEV";
  if (raw === "verification" || raw === "VERIFICATION") return "VERIFICATION";
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

export function moduleFileFromRef(moduleRef: string | null): string | null {
  if (moduleRef === null || !moduleRef.startsWith("module:")) return null;
  return canonicalRepoFileFromModuleRef(moduleRef);
}

// The single canonical decoder for `module:` and `mod:` refs lives in the
// policy owner. `moduleFileFromRef` remains the module:-only entry used by the
// existing callers.
function canonicalRequestedModuleFile(moduleRef: string | null): string | null {
  return canonicalRepoFileFromModuleRef(moduleRef);
}

export interface TsJsObservedCompletionRequirement {
  readonly kind: TsJsCompletionWorkKind;
  readonly subjectRef: string;
}

export interface TsJsObservedCompletionDerivationGap {
  readonly code:
    | "invalid_requested_module"
    | "invalid_invocation_file"
    | "missing_selected_observation"
    | "missing_callable_table"
    | "invalid_callable_identity"
    | "caller_helper_not_in_invocation"
    | "duplicate_receipt_module"
    | "invalid_target_mismatch_read_set"
    | "invalid_target_mismatch_read";
  readonly subjectRef: string | null;
  readonly reason: string;
}

export interface TsJsObservedCompletionRequirements {
  readonly requirements: readonly TsJsObservedCompletionRequirement[];
  readonly gaps: readonly TsJsObservedCompletionDerivationGap[];
}

function canonicalProducerFile(file: string): boolean {
  if (typeof file !== "string" || file.length === 0) return false;
  if (file.includes(NUL) || file.startsWith("module:") || file.includes("://")) return false;
  if (/^[A-Za-z]:/.test(file)) return false;
  const normalized = normalizeRepoRelative(file);
  return normalized === file && isSafeRepoRelative(normalized);
}

function uniqueCanonicalInvocationFiles(
  request: TsJsSymbolTableRequest,
): readonly string[] {
  return [...new Set(request.files.map(file => normalizeRepoRelative(file)))];
}

function exactCallableDeclarationRef(identity: TsJsInlineCallableIdentity): string {
  return `callable.${identity.syntaxKind}:${identity.moduleRef}@${spanKey(identity.span)}`;
}

function exactCallableInitializerRef(identity: TsJsInlineCallableIdentity): string {
  return `member:${identity.moduleRef}@${spanKey(identity.span)}`;
}

export function isTsJsCallableIdentityExact(
  identity: TsJsInlineCallableIdentity,
  initializerRef: string,
): boolean {
  if (
    !canonicalProducerFile(identity.moduleRef)
    || identity.span.startLine < 1
    || identity.span.startCol < 1
    || identity.span.endLine < 1
    || identity.span.endCol < 1
    || (identity.syntaxKind !== "arrow_function"
      && identity.syntaxKind !== "function_expression")
  ) {
    return false;
  }
  return exactCallableDeclarationRef(identity) === identity.declarationRef
    && exactCallableInitializerRef(identity) === initializerRef;
}

export function deriveTsJsObservedCompletionRequirements(input: {
  readonly requestRef: string;
  readonly pendingRelationRef: string;
  readonly callSiteRef: string;
  readonly requestedDeclarationRef: string;
  readonly requestedModuleRef: string;
  readonly producerRequest: TsJsSymbolTableRequest;
  readonly observation:
    | TsJsRuntimeSelectorObservation
    | TsJsStaticSelectedSelectorObservation;
}): TsJsObservedCompletionRequirements {
  const gaps: TsJsObservedCompletionDerivationGap[] = [];
  const requirements: TsJsObservedCompletionRequirement[] = [];
  const files = uniqueCanonicalInvocationFiles(input.producerRequest);
  if (files.some(file => !canonicalProducerFile(file))) {
    gaps.push({
      code: "invalid_invocation_file",
      subjectRef: null,
      reason: "captured producer request contains a non-canonical invocation file",
    });
  }

  const requestedModuleFile = moduleFileFromRef(input.requestedModuleRef);
  if (requestedModuleFile === null) {
    gaps.push({
      code: "invalid_requested_module",
      subjectRef: input.requestedModuleRef,
      reason: "requestedDeclaration.moduleRef is not a valid module:<file> reference",
    });
  }

  const requiredFiles = new Set(files);
  if (requestedModuleFile !== null) requiredFiles.add(requestedModuleFile);
  for (const file of requiredFiles) {
    requirements.push({ kind: "source_read", subjectRef: file });
  }

  if (input.observation.observationRef.length === 0) {
    gaps.push({
      code: "missing_selected_observation",
      subjectRef: input.callSiteRef,
      reason: "selected observation reference is missing",
    });
  } else {
    requirements.push({
      kind: "selector_structure",
      subjectRef: input.observation.observationRef,
    });
  }

  const table = input.observation.callableTable;
  const rawModules = input.observation.sourceReadReceipt.modules;
  if (rawModules.length === 0 || rawModules.some(module => !canonicalProducerFile(module.file))) {
    gaps.push({
      code: "caller_helper_not_in_invocation",
      subjectRef: input.observation.observationRef,
      reason: "selected observation does not retain canonical caller/helper source modules",
    });
  } else if (rawModules.some(module => !files.includes(module.file))) {
    gaps.push({
      code: "caller_helper_not_in_invocation",
      subjectRef: input.observation.observationRef,
      reason: "selected observation module is not in the captured producer invocation",
    });
  }
  if (new Set(rawModules.map(module => module.file)).size !== rawModules.length) {
    gaps.push({
      code: "duplicate_receipt_module",
      subjectRef: input.observation.observationRef,
      reason: "source-read receipt repeats one module",
    });
  }

  if (table === undefined) {
    gaps.push({
      code: "missing_callable_table",
      subjectRef: input.observation.observationRef,
      reason: "selected observation has no typed callable table",
    });
  } else {
    const tableFiles = new Set(
      table.members
        .filter(member => member.callableIdentity !== null)
        .map(member => member.callableIdentity!.moduleRef),
    );
    if (tableFiles.size > 1) {
      gaps.push({
        code: "invalid_callable_identity",
        subjectRef: table.tableRef,
        reason: "typed callable table spans more than one producer module",
      });
    }
    for (const member of table.members) {
      const identity = member.callableIdentity;
      if (identity !== null && !isTsJsCallableIdentityExact(identity, member.initializerRef)) {
        gaps.push({
          code: "invalid_callable_identity",
          subjectRef: member.initializerRef,
          reason: "callable identity does not reconstruct from its module, span, and syntax kind",
        });
      }
      if (identity !== null && !files.includes(identity.moduleRef)) {
        gaps.push({
          code: "caller_helper_not_in_invocation",
          subjectRef: identity.moduleRef,
          reason: "callable identity module is not in the captured producer invocation",
        });
      }
      requirements.push({
        kind: "callable_identity",
        subjectRef: member.initializerRef,
      });
    }
  }

  requirements.push({
    kind: "requested_target_mapping",
    subjectRef: input.requestedDeclarationRef,
  });
  requirements.push({
    kind: "selector_scope",
    subjectRef: input.callSiteRef,
  });

  return Object.freeze({
    requirements: Object.freeze(requirements),
    gaps: Object.freeze(gaps),
  });
}

export function deriveTsJsStaticSelectedCompletionRequirements(input: {
  readonly requestRef: string;
  readonly pendingRelationRef: string;
  readonly callSiteRef: string;
  readonly requestedDeclarationRef: string;
  readonly requestedModuleRef: string;
  readonly producerRequest: TsJsSymbolTableRequest;
  readonly observation: TsJsStaticSelectedSelectorObservation;
}): TsJsObservedCompletionRequirements {
  const base = deriveTsJsObservedCompletionRequirements(input);
  return Object.freeze({
    requirements: Object.freeze([
      ...base.requirements.filter(requirement => requirement.kind !== "selector_scope"),
      {
        kind: "relation_completion" as const,
        subjectRef: input.callSiteRef,
      },
    ]),
    gaps: base.gaps,
  });
}

export function deriveTsJsTargetMismatchCompletionRequirements(input: {
  readonly observation: TsJsTargetMismatchObservation;
}): TsJsObservedCompletionRequirements {
  const gaps: TsJsObservedCompletionDerivationGap[] = [];
  const requirements: TsJsObservedCompletionRequirement[] = [];
  const receipts = input.observation.sourceReadReceipts;
  const files = receipts.map(receipt => receipt.modules.map(module => module.file));
  if (
    receipts.length !== 3
    || files.some(modules => modules.length !== 1)
    || new Set(files.flat()).size !== 3
  ) {
    gaps.push({
      code: "invalid_target_mismatch_read_set",
      subjectRef: input.observation.observationRef,
      reason: "target-mismatch observation must retain three distinct single-module reads",
    });
  }
  for (const [index, receipt] of receipts.entries()) {
    if (receipt.outcome !== "success" || receipt.action !== "read_source") {
      gaps.push({
        code: "invalid_target_mismatch_read",
        subjectRef: receipt.receiptId,
        reason: `target-mismatch read ${index} is not a successful source read`,
      });
      continue;
    }
    const moduleFile = receipt.modules[0]?.file;
    if (moduleFile === undefined || !canonicalProducerFile(moduleFile)) {
      gaps.push({
        code: "invalid_target_mismatch_read",
        subjectRef: receipt.receiptId,
        reason: `target-mismatch read ${index} has no canonical module file`,
      });
      continue;
    }
    requirements.push({ kind: "source_read", subjectRef: moduleFile });
  }
  requirements.push({
    kind: "callable_identity",
    subjectRef: input.observation.boundDeclaration.declarationRef,
  });
  requirements.push({
    kind: "requested_target_mapping",
    subjectRef: input.observation.requestedDeclaration.declarationRef,
  });
  return Object.freeze({
    requirements: Object.freeze(requirements),
    gaps: Object.freeze(gaps),
  });
}

function rawProducerRequestForValidation(request: unknown): unknown {
  if (!isRecord(request)) return request;
  const raw = { ...request };
  if (raw["symbol"] === null) delete raw["symbol"];
  if (raw["file"] === null) delete raw["file"];
  return raw;
}

export function successfulProducerFiles(
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

function completionKey(
  requirement: TsJsObservedCompletionRequirement,
): string {
  return `${requirement.kind}\u0000${requirement.subjectRef}`;
}

function completionRoleFact(
  observation: TsJsRuntimeSelectorObservation,
  role: "selector_candidate_table" | "runtime_selector_dependency",
): TsJsRuntimeSelectorRoleFact | null {
  const matches = observation.facts.filter(fact => fact.role === role);
  return matches.length === 1 ? matches[0]! : null;
}

function matchingCallableMembers(
  observation:
    | TsJsRuntimeSelectorObservation
    | TsJsStaticSelectedSelectorObservation,
  requestedDeclaration: NonNullable<RelationStepEpisode["requestedDeclaration"]>,
  requireName = false,
): readonly NonNullable<TsJsRuntimeCallableTable["members"][number]>[] {
  const requestedFile = moduleFileFromRef(requestedDeclaration.moduleRef);
  if (
    requestedFile === null
    || requestedDeclaration.kind !== "function"
    || (requestedDeclaration.role !== undefined
      && requestedDeclaration.role !== "member"
      && requestedDeclaration.role !== "unspecified")
  ) {
    return [];
  }
  return (observation.callableTable?.members ?? []).filter(member => {
    const identity = member.callableIdentity;
    return identity !== null
      && isTsJsCallableIdentityExact(identity, member.initializerRef)
      && identity.moduleRef === requestedFile
      && identity.declarationRef === requestedDeclaration.declarationRef
      && (!requireName || member.name === requestedDeclaration.name);
  });
}

export function matchingTsJsStaticCallableMembers(
  observation: TsJsStaticSelectedSelectorObservation,
  requestedDeclaration: NonNullable<RelationStepEpisode["requestedDeclaration"]>,
): readonly NonNullable<TsJsRuntimeCallableTable["members"][number]>[] {
  return matchingCallableMembers(observation, requestedDeclaration, true);
}

export function deriveTsJsStaticRelationCompletionItem(
  observation: TsJsStaticSelectedSelectorObservation,
  requestedDeclaration: NonNullable<RelationStepEpisode["requestedDeclaration"]>,
  sharedReadAvailable: boolean,
): TsJsCompletionWorkItem {
  const table = observation.callableTable;
  const selectedMember = table.members.find(
    member => member.initializerRef === observation.selection.selectedMemberRef,
  );
  const selectedIdentity = selectedMember?.callableIdentity ?? null;
  const requestedMembers = matchingTsJsStaticCallableMembers(observation, requestedDeclaration);
  const requestedMember = requestedMembers.length === 1 ? requestedMembers[0]! : null;
  const requestedModuleFile = moduleFileFromRef(requestedDeclaration.moduleRef ?? null);
  const selectedExact = selectedMember !== undefined
    && selectedMember.name === observation.selection.selectedMemberName
    && selectedIdentity !== null
    && isTsJsCallableIdentityExact(selectedIdentity, selectedMember.initializerRef)
    && selectedIdentity.declarationRef === observation.selection.selectedDeclarationRef
    && selectedIdentity.moduleRef === observation.selection.selectedModuleRef;
  const requestedExact = requestedMember !== null
    && requestedMember.callableIdentity !== null
    && isTsJsCallableIdentityExact(
      requestedMember.callableIdentity,
      requestedMember.initializerRef,
    )
    && requestedModuleFile !== null
    && requestedMember.callableIdentity.moduleRef === requestedModuleFile;
  const sameModule = requestedExact
    && selectedExact
    && requestedModuleFile === selectedIdentity.moduleRef;
  const distinct = sameModule
    && selectedIdentity.declarationRef !== requestedMember.callableIdentity.declarationRef;
  const baseEvidence = [
    observation.observationRef,
    observation.sourceReadRef,
    table.tableRef,
    observation.callSiteRef,
  ].filter(ref => ref.length > 0);

  if (!selectedExact || !requestedExact || !sameModule || !distinct || !sharedReadAvailable) {
    return {
      kind: "relation_completion",
      subjectRef: observation.callSiteRef,
      disposition: {
        state: "unresolved",
        reason: !selectedExact
          ? "selected member identity is not exact"
          : !requestedExact
            ? "requested declaration does not match one typed callable"
            : !sameModule
              ? "selected and requested members are not in the same module"
              : !distinct
                ? "selected and requested declarations are not distinct"
                : "shared source read is unavailable",
        evidenceRefs: uniqueStrings(baseEvidence),
      },
    };
  }

  return {
    kind: "relation_completion",
    subjectRef: observation.callSiteRef,
    disposition: {
      state: "satisfied",
      evidenceRefs: uniqueStrings([
        observation.observationRef,
        observation.sourceReadRef,
        table.tableRef,
        selectedMember.initializerRef,
        selectedIdentity.declarationRef,
        requestedMember.initializerRef,
        requestedDeclaration.declarationRef,
        observation.callSiteRef,
      ]),
    },
  };
}

function completionWorkFor(
  input: TsJsStepwiseBridgeInput,
  result: TsJsSymbolTableResult,
  observation: TsJsRuntimeSelectorObservation,
): TsJsCompletionWork {
  const derivation = deriveTsJsObservedCompletionRequirements({
    requestRef: input.request.requestRef,
    pendingRelationRef: input.request.relationObligation.pendingRelationRef,
    callSiteRef: input.request.relationObligation.callSiteRef,
    requestedDeclarationRef: input.request.requestedDeclaration.declarationRef,
    requestedModuleRef: input.request.requestedDeclaration.moduleRef ?? "",
    producerRequest: input.producerRequest,
    observation,
  });
  const successfulFiles = successfulProducerFiles(input.producerRequest, result.coverage);
  const failedFiles = new Map(result.coverage.scopeFilesFailed.map(entry => [entry.file, entry.reason]));
  const skippedFiles = new Map(result.coverage.skipped.map(entry => [entry.file, entry.reason]));
  const parseErrorFiles = new Set(result.coverage.parseErrorFiles.map(entry => entry.file));
  const sourceReadRef = observation.sourceReadRef;
  const rawReceipt = observation.sourceReadReceipt;
  const tableFact = completionRoleFact(observation, "selector_candidate_table");
  const runtimeFact = completionRoleFact(observation, "runtime_selector_dependency");
  const table = observation.callableTable;
  const matchingMembers = matchingCallableMembers(observation, input.request.requestedDeclaration);

  const items = derivation.requirements.map(
    (requirement): TsJsCompletionWorkItem => {
      if (requirement.kind === "source_read") {
        const file = requirement.subjectRef;
        const moduleResultRef = `${sourceReadRef}:module:${file}`;
        const primaryFiles = new Set(rawReceipt.modules.map(module => module.file));
        if (result.coverage.truncated) {
          return {
            kind: requirement.kind,
            subjectRef: file,
            disposition: {
              state: "unresolved",
              evidenceRefs: [sourceReadRef],
              reason: "producer coverage is truncated",
            },
          };
        }
        const failedReason = failedFiles.get(file);
        if (failedReason !== undefined) {
          return {
            kind: requirement.kind,
            subjectRef: file,
            disposition: {
              state: "failed",
              evidenceRefs: [sourceReadRef],
              reason: failedReason,
            },
          };
        }
        const skippedReason = skippedFiles.get(file);
        if (skippedReason !== undefined || parseErrorFiles.has(file)) {
          return {
            kind: requirement.kind,
            subjectRef: file,
            disposition: {
              state: "unresolved",
              evidenceRefs: [sourceReadRef],
              reason: skippedReason ?? "producer parse failed",
            },
          };
        }
        if (!successfulFiles.includes(file)) {
          return {
            kind: requirement.kind,
            subjectRef: file,
            disposition: {
              state: "unresolved",
              evidenceRefs: [sourceReadRef],
              reason: "required source read is not established by the producer result",
            },
          };
        }
        if (primaryFiles.has(file)) {
          if (!rawReceipt.result.includes(moduleResultRef)) {
            return {
              kind: requirement.kind,
              subjectRef: file,
              disposition: {
                state: "unresolved",
                evidenceRefs: [sourceReadRef],
                reason: "caller/helper source read lacks its shared module result",
              },
            };
          }
          return {
            kind: requirement.kind,
            subjectRef: file,
            disposition: {
              state: "satisfied",
              evidenceRefs: [sourceReadRef, moduleResultRef],
            },
          };
        }
        return {
          kind: requirement.kind,
          subjectRef: file,
          disposition: {
            state: "satisfied",
            evidenceRefs: [sourceReadRef],
          },
        };
      }

      if (requirement.kind === "selector_structure") {
        if (
          table === undefined
          || tableFact === null
          || runtimeFact === null
          || tableFact.state !== "known"
          || runtimeFact.state !== "known"
          || !tableFact.evidenceRefs.includes(sourceReadRef)
          || !runtimeFact.evidenceRefs.includes(sourceReadRef)
        ) {
          return {
            kind: requirement.kind,
            subjectRef: requirement.subjectRef,
            disposition: {
              state: "unresolved",
              evidenceRefs: [observation.observationRef, sourceReadRef],
              reason: "selected helper/table structure is not completely source-backed",
            },
          };
        }
        return {
          kind: requirement.kind,
          subjectRef: requirement.subjectRef,
          disposition: {
            state: "satisfied",
            evidenceRefs: [
              observation.observationRef,
              sourceReadRef,
              tableFact.factRef,
              runtimeFact.factRef,
              table.tableRef,
            ],
          },
        };
      }

      if (requirement.kind === "callable_identity") {
        const member = table?.members.find(entry => entry.initializerRef === requirement.subjectRef);
        const identity = member?.callableIdentity ?? null;
        if (
          member === undefined
          || identity === null
          || !isTsJsCallableIdentityExact(identity, member.initializerRef)
        ) {
          return {
            kind: requirement.kind,
            subjectRef: requirement.subjectRef,
            disposition: {
              state: "unresolved",
              evidenceRefs: [sourceReadRef, table?.tableRef ?? ""].filter(ref => ref.length > 0),
              reason: "exact inline callable identity is absent or does not reconstruct",
            },
          };
        }
        return {
          kind: requirement.kind,
          subjectRef: requirement.subjectRef,
          disposition: {
            state: "satisfied",
            evidenceRefs: [
              member.initializerRef,
              identity.declarationRef,
              sourceReadRef,
              table!.tableRef,
            ],
          },
        };
      }

      if (requirement.kind === "requested_target_mapping") {
        if (matchingMembers.length !== 1) {
          return {
            kind: requirement.kind,
            subjectRef: requirement.subjectRef,
            disposition: {
              state: "unresolved",
              evidenceRefs: [sourceReadRef, table?.tableRef ?? ""].filter(ref => ref.length > 0),
              reason: matchingMembers.length === 0
                ? "requested declaration does not match one typed callable"
                : "requested declaration matches more than one typed callable",
            },
          };
        }
        return {
          kind: requirement.kind,
          subjectRef: requirement.subjectRef,
          disposition: {
            state: "satisfied",
            evidenceRefs: [
              requirement.subjectRef,
              matchingMembers[0]!.initializerRef,
              sourceReadRef,
              table!.tableRef,
            ],
          },
        };
      }

      if (
        observation.binding.bindingMode !== "dynamic"
        || observation.binding.resolution.status !== "dynamic"
        || observation.binding.resolution.reason !== "dynamic_undecidable"
        || tableFact === null
        || runtimeFact === null
      ) {
        return {
          kind: requirement.kind,
          subjectRef: requirement.subjectRef,
          disposition: {
            state: "unresolved",
            evidenceRefs: [observation.observationRef, sourceReadRef],
            reason: "source-local selector scope is not established",
          },
        };
      }
      return {
        kind: requirement.kind,
        subjectRef: requirement.subjectRef,
        disposition: {
          state: "satisfied",
          evidenceRefs: [
            observation.observationRef,
            sourceReadRef,
            runtimeFact.factRef,
            observation.callSiteRef,
          ],
        },
      };
    },
  );

  return Object.freeze({
    contract: "tsjs.observed-dynamic-source-closure.v1",
    scope: "source_local",
    items: Object.freeze(items),
  });
}

function staticSelectedRoleFact(
  observation: TsJsStaticSelectedSelectorObservation,
  role: "selector_candidate_table" | "static_selected_member",
): TsJsRuntimeSelectorRoleFact | null {
  const matches = observation.facts.filter(fact => fact.role === role);
  return matches.length === 1 ? matches[0]! : null;
}

function staticCompletionWorkFor(
  input: TsJsStepwiseBridgeInput,
  result: TsJsSymbolTableResult,
  observation: TsJsStaticSelectedSelectorObservation,
): TsJsCompletionWork {
  const derivation = deriveTsJsStaticSelectedCompletionRequirements({
    requestRef: input.request.requestRef,
    pendingRelationRef: input.request.relationObligation.pendingRelationRef,
    callSiteRef: input.request.relationObligation.callSiteRef,
    requestedDeclarationRef: input.request.requestedDeclaration.declarationRef,
    requestedModuleRef: input.request.requestedDeclaration.moduleRef ?? "",
    producerRequest: input.producerRequest,
    observation,
  });
  const successfulFiles = successfulProducerFiles(input.producerRequest, result.coverage);
  const failedFiles = new Map(result.coverage.scopeFilesFailed.map(entry => [entry.file, entry.reason]));
  const skippedFiles = new Map(result.coverage.skipped.map(entry => [entry.file, entry.reason]));
  const parseErrorFiles = new Set(result.coverage.parseErrorFiles.map(entry => entry.file));
  const sourceReadRef = observation.sourceReadRef;
  const rawReceipt = observation.sourceReadReceipt;
  const tableFact = staticSelectedRoleFact(observation, "selector_candidate_table");
  const selectedFact = staticSelectedRoleFact(observation, "static_selected_member");
  const table = observation.callableTable;
  const matchingMembers = matchingTsJsStaticCallableMembers(
    observation,
    input.request.requestedDeclaration,
  );

  const items = derivation.requirements.map(
    (requirement): TsJsCompletionWorkItem => {
      if (requirement.kind === "source_read") {
        const file = requirement.subjectRef;
        const moduleResultRef = `${sourceReadRef}:module:${file}`;
        const primaryFiles = new Set(rawReceipt.modules.map(module => module.file));
        if (result.coverage.truncated) {
          return {
            kind: requirement.kind,
            subjectRef: file,
            disposition: {
              state: "unresolved",
              evidenceRefs: [sourceReadRef],
              reason: "producer coverage is truncated",
            },
          };
        }
        const failedReason = failedFiles.get(file);
        if (failedReason !== undefined) {
          return {
            kind: requirement.kind,
            subjectRef: file,
            disposition: {
              state: "failed",
              evidenceRefs: [sourceReadRef],
              reason: failedReason,
            },
          };
        }
        const skippedReason = skippedFiles.get(file);
        if (skippedReason !== undefined || parseErrorFiles.has(file)) {
          return {
            kind: requirement.kind,
            subjectRef: file,
            disposition: {
              state: "unresolved",
              evidenceRefs: [sourceReadRef],
              reason: skippedReason ?? "producer parse failed",
            },
          };
        }
        if (!successfulFiles.includes(file)) {
          return {
            kind: requirement.kind,
            subjectRef: file,
            disposition: {
              state: "unresolved",
              evidenceRefs: [sourceReadRef],
              reason: "required source read is not established by the producer result",
            },
          };
        }
        if (primaryFiles.has(file)) {
          if (!rawReceipt.result.includes(moduleResultRef)) {
            return {
              kind: requirement.kind,
              subjectRef: file,
              disposition: {
                state: "unresolved",
                evidenceRefs: [sourceReadRef],
                reason: "caller/helper source read lacks its shared module result",
              },
            };
          }
          return {
            kind: requirement.kind,
            subjectRef: file,
            disposition: {
              state: "satisfied",
              evidenceRefs: [sourceReadRef, moduleResultRef],
            },
          };
        }
        return {
          kind: requirement.kind,
          subjectRef: file,
          disposition: {
            state: "satisfied",
            evidenceRefs: [sourceReadRef],
          },
        };
      }

      if (requirement.kind === "selector_structure") {
        if (
          tableFact === null
          || selectedFact === null
          || tableFact.state !== "known"
          || selectedFact.state !== "known"
          || !tableFact.evidenceRefs.includes(sourceReadRef)
          || !selectedFact.evidenceRefs.includes(sourceReadRef)
        ) {
          return {
            kind: requirement.kind,
            subjectRef: requirement.subjectRef,
            disposition: {
              state: "unresolved",
              evidenceRefs: [observation.observationRef, sourceReadRef],
              reason: "selected helper/table structure is not completely source-backed",
            },
          };
        }
        return {
          kind: requirement.kind,
          subjectRef: requirement.subjectRef,
          disposition: {
            state: "satisfied",
            evidenceRefs: [
              observation.observationRef,
              sourceReadRef,
              tableFact.factRef,
              selectedFact.factRef,
              table.tableRef,
            ],
          },
        };
      }

      if (requirement.kind === "callable_identity") {
        const member = table.members.find(entry => entry.initializerRef === requirement.subjectRef);
        const identity = member?.callableIdentity ?? null;
        if (
          member === undefined
          || identity === null
          || !isTsJsCallableIdentityExact(identity, member.initializerRef)
        ) {
          return {
            kind: requirement.kind,
            subjectRef: requirement.subjectRef,
            disposition: {
              state: "unresolved",
              evidenceRefs: [sourceReadRef, table.tableRef],
              reason: "exact inline callable identity is absent or does not reconstruct",
            },
          };
        }
        return {
          kind: requirement.kind,
          subjectRef: requirement.subjectRef,
          disposition: {
            state: "satisfied",
            evidenceRefs: [
              member.initializerRef,
              identity.declarationRef,
              sourceReadRef,
              table.tableRef,
            ],
          },
        };
      }

      if (requirement.kind === "requested_target_mapping") {
        if (matchingMembers.length !== 1) {
          return {
            kind: requirement.kind,
            subjectRef: requirement.subjectRef,
            disposition: {
              state: "unresolved",
              evidenceRefs: [sourceReadRef, table.tableRef],
              reason: matchingMembers.length === 0
                ? "requested declaration does not match one typed callable"
                : "requested declaration matches more than one typed callable",
            },
          };
        }
        return {
          kind: requirement.kind,
          subjectRef: requirement.subjectRef,
          disposition: {
            state: "satisfied",
            evidenceRefs: [
              requirement.subjectRef,
              matchingMembers[0]!.initializerRef,
              sourceReadRef,
              table.tableRef,
            ],
          },
        };
      }

      return deriveTsJsStaticRelationCompletionItem(
        observation,
        input.request.requestedDeclaration,
        sourceReadRef.length > 0
          && rawReceipt.receiptId === sourceReadRef
          && rawReceipt.action === "read_source"
          && rawReceipt.outcome === "success",
      );
    },
  );

  return Object.freeze({
    contract: "tsjs.observed-static-selected-read.v1",
    scope: "source_local",
    items: Object.freeze(items),
  });
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

function validateStaticProducerObservation(
  observation: TsJsStaticSelectedSelectorObservation,
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
    observation.binding.bindingMode !== "bound"
    || observation.binding.resolution.status !== "resolved"
    || observation.binding.resolution.declarationRef
      !== observation.selection.selectedDeclarationRef
    || observation.binding.resolution.moduleRef !== observation.selection.selectedModuleRef
    || observation.binding.declarationRefs.length !== 1
    || observation.binding.declarationRefs[0] !== observation.selection.selectedDeclarationRef
    || observation.binding.scopeRef !== null
  ) {
    reasons.push("producer static binding shape mismatch");
  }
  const tableFacts = observation.facts.filter(fact => fact.role === "selector_candidate_table");
  const selectedFacts = observation.facts.filter(fact => fact.role === "static_selected_member");
  if (
    observation.facts.length !== 2
    || tableFacts.length !== 1
    || selectedFacts.length !== 1
    || observation.facts.some(fact =>
      fact.state !== "known" || !fact.evidenceRefs.includes(sourceReadRef))
  ) {
    reasons.push("producer observation must contain the static-selected role facts");
  }
  const selectedMember = observation.callableTable.members.find(
    member => member.initializerRef === observation.selection.selectedMemberRef,
  );
  const selectedIdentity = selectedMember?.callableIdentity ?? null;
  if (
    selectedMember === undefined
    || selectedMember.name !== observation.selection.selectedMemberName
    || selectedIdentity === null
    || !isTsJsCallableIdentityExact(selectedIdentity, selectedMember.initializerRef)
    || selectedIdentity.declarationRef !== observation.selection.selectedDeclarationRef
    || selectedIdentity.moduleRef !== observation.selection.selectedModuleRef
  ) {
    reasons.push("producer static selection does not reconstruct from the typed callable table");
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
): TsJsDynamicProducerSourceBinding {
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
    completionWork: completionWorkFor(input, result, observation),
  };
}

function staticProducerSourceBinding(
  input: TsJsStepwiseBridgeInput,
  result: TsJsSymbolTableResult,
  observation: TsJsStaticSelectedSelectorObservation,
): TsJsStaticProducerSourceBinding {
  return {
    kind: "nnanything.tsjs.producer-source.static-selected.v1",
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
    completionWork: staticCompletionWorkFor(input, result, observation),
  };
}

function lexicalProducerSourceBinding(
  input: TsJsStepwiseBridgeInput,
  result: TsJsSymbolTableResult,
  observation: TsJsLexicalCallSiteBindingObservation,
): TsJsLexicalProducerSourceBinding {
  const sourceName = observation.sourceName ?? observation.calleeName;
  const sourceSymbols = observation.sourceModuleFile === null
    ? []
    : result.symbols.filter(symbol =>
        symbol.file === observation.sourceModuleFile && symbol.name === sourceName);
  return {
    kind: "nnanything.tsjs.producer-source.lexical.v1",
    producerRequest: input.producerRequest,
    parser: result.parser,
    coverage: result.coverage,
    rawObservation: observation,
    sourceSymbols,
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

function projectTsJsLexicalBindingToStepwiseRecord(
  input: TsJsStepwiseBridgeInput,
  result: TsJsSymbolTableResult,
  observation: TsJsLexicalCallSiteBindingObservation,
): Record<string, unknown> {
  const producerSource = lexicalProducerSourceBinding(input, result, observation);
  if (observation.bindingKind === "unresolved") {
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
          observedLocalFacts: [],
          sourceContent: {
            state: "observed",
            resultRefs: observation.callerReadReceipt.result,
            reason: null,
            evidenceRefs: [observation.callerReadReceipt.receiptId],
          },
          shadowFacts: [],
        },
        currentRelation: {
          pendingRelationRef: input.request.relationObligation.pendingRelationRef,
          callSiteRef: observation.callSiteRef,
          binding: {
            state: "not_observed",
            reason: "not_requested",
            evidenceRefs: observation.evidenceRefs,
          },
        },
        remainingObligations: input.remainingObligations,
        receipts: [lexicalReceipt(input, observation.callerReadReceipt, producerSource)],
        localCandidateCursor: input.localCandidateCursor,
        coverage: lexicalCoverage(input, result, observation),
        notReady: result.coverage.partial || result.coverage.truncated,
      }],
    };
  }

  const { edge, declaration } = projectTsJsLexicalBindingEdge(result, observation);
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
        observedBindings: edge === null ? [] : [edge],
        observedDeclarations: declaration === null ? [] : [declaration],
        observedLocalFacts: [],
        sourceContent: {
          state: "observed",
          resultRefs: observation.callerReadReceipt.result,
          reason: null,
          evidenceRefs: [observation.callerReadReceipt.receiptId],
        },
        shadowFacts: [],
      },
      currentRelation: {
        pendingRelationRef: input.request.relationObligation.pendingRelationRef,
        callSiteRef: observation.callSiteRef,
        binding: {
          state: "not_observed",
          reason: "not_requested",
          evidenceRefs: observation.evidenceRefs,
        },
      },
      remainingObligations: input.remainingObligations,
      receipts: [lexicalReceipt(input, observation.callerReadReceipt, producerSource)],
      localCandidateCursor: input.localCandidateCursor,
      coverage: lexicalCoverage(input, result, observation),
      notReady: result.coverage.partial || result.coverage.truncated,
    }],
  };
}

function projectTsJsLexicalBindingEdge(
  result: TsJsSymbolTableResult,
  observation: TsJsLexicalCallSiteBindingObservation,
): { edge: BindingEdge | null; declaration: DeclarationIdentity | null } {
  if (observation.bindingKind === "unresolved") {
    return { edge: null, declaration: null };
  }
  const sourceModuleRef =
    observation.bindingKind === "import" ? observation.sourceModuleRef : null;
  const sourceModuleReadReceipt = observation.sourceModuleReadReceipt;
  const sourceObserved =
    observation.bindingKind === "import"
    && observation.sourceModuleFile !== null
    && sourceModuleRef !== null
    && sourceModuleReadReceipt !== null
    && sourceModuleReadReceipt.outcome === "success"
    && sourceModuleReadReceipt.modules.some(
      module => module.file === observation.sourceModuleFile,
    );
  const sourceContent: BindingEdge["sourceContent"] = sourceObserved
    ? {
        state: "observed",
        resultRefs: [sourceModuleReadReceipt!.receiptId],
        reason: null,
        evidenceRefs: sourceModuleReadReceipt!.evidenceRefs,
      }
    : { state: "not_requested", resultRefs: [], reason: null, evidenceRefs: [] };
  const visibility: BindingEdge["visibility"] =
    observation.bindingKind === "import"
      ? { state: "known", value: "reachable", evidenceRefs: observation.evidenceRefs }
      : observation.bindingKind === "shadow"
        ? { state: "known", value: "shadowed", evidenceRefs: observation.evidenceRefs }
        : { state: "known", value: "unknown", evidenceRefs: observation.evidenceRefs };
  const edge: BindingEdge = {
    edgeRef: `edge:${observation.callSiteRef}:${observation.bindingKind}`,
    callSiteRef: observation.callSiteRef,
    fromNodeRef: observation.callerModuleRef,
    edgeKind: observation.bindingKind,
    sourceName: observation.sourceName ?? observation.calleeName,
    sourceModule: sourceModuleRef === null
      ? { state: "not_observed", reason: "not_requested", evidenceRefs: observation.evidenceRefs }
      : { state: "known", value: sourceModuleRef, evidenceRefs: observation.evidenceRefs },
    targetName: observation.targetName ?? observation.calleeName,
    targetModule: { state: "known", value: observation.callerModuleRef, evidenceRefs: observation.evidenceRefs },
    moduleSpecifierRaw: observation.moduleSpecifierRaw,
    sourceContent,
    visibility,
    hopDepth: observation.bindingKind === "import" ? 1 : 0,
    evidenceRefs: observation.evidenceRefs,
  };
  if (!sourceObserved || observation.sourceModuleFile === null) {
    return { edge, declaration: null };
  }
  const sourceName = observation.sourceName ?? observation.calleeName;
  const matches = result.symbols.filter(
    symbol => symbol.file === observation.sourceModuleFile && symbol.name === sourceName,
  );
  if (matches.length !== 1) {
    return { edge, declaration: null };
  }
  const symbol = matches[0]!;
  // Adapt proven top-level declaration structure to the shared request identity.
  // Raw span identities remain in producer output and in declaration evidence.
  const isTopLevelFunction = symbol.kind === "function"
    && symbol.declaredIn === "file"
    && symbol.lexicalScope.length === 0
    && symbol.ownerType === null
    && symbol.ownerKind === null;
  const declaration: DeclarationIdentity = {
    declarationRef: isTopLevelFunction
      ? `decl:${symbol.file}#top:${symbol.name}`
      : symbol.symbolId,
    moduleRef: `module:${observation.sourceModuleFile}`,
    name: sourceName,
    role: "import",
    kind: symbol.kind,
    evidenceRefs: [...observation.evidenceRefs, symbol.symbolId],
  };
  return { edge, declaration };
}

function lexicalReceipt(
  input: TsJsStepwiseBridgeInput,
  receipt: TsJsReadReceipt,
  producerSource: TsJsLexicalProducerSourceBinding,
): RelationStepReceipt {
  return {
    receiptId: receipt.receiptId,
    actionRef: receipt.actionRef,
    action: receipt.action,
    target: receipt.targetRef,
    origin: receipt.origin,
    fromStepId: input.fromStepId,
    pendingRelationRef: input.request.relationObligation.pendingRelationRef,
    optionSemantics: "observe",
    outcome: receipt.outcome,
    result: receipt.result,
    evidenceRefs: receipt.evidenceRefs,
    producerSource,
  };
}

function lexicalCoverage(
  input: TsJsStepwiseBridgeInput,
  result: TsJsSymbolTableResult,
  observation: TsJsLexicalCallSiteBindingObservation,
): {
  coveredModules: readonly string[];
  targetModuleReached: boolean;
  note: string;
} {
  const coveredModules = successfulProducerFiles(input.producerRequest, result.coverage);
  const sourceModuleFile = observation.sourceModuleFile;
  return {
    coveredModules,
    targetModuleReached:
      sourceModuleFile !== null && coveredModules.includes(sourceModuleFile),
    note: "lexical_call_site_binding_source_observed",
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

function projectTsJsStaticSelectedObservationToStepwiseRecord(
  input: TsJsStepwiseBridgeInput,
  result: TsJsSymbolTableResult,
  observation: TsJsStaticSelectedSelectorObservation,
): Record<string, unknown> {
  const sourceReadRef = observation.sourceReadRef;
  const sourceReadReceipt = observation.sourceReadReceipt;
  const selectedDeclaration: DeclarationIdentity = {
    declarationRef: observation.selection.selectedDeclarationRef,
    moduleRef: `module:${observation.selection.selectedModuleRef}`,
    name: observation.selection.selectedMemberName,
    role: "member",
    kind: "function",
    evidenceRefs: [
      sourceReadRef,
      observation.selection.selectedMemberRef,
    ],
  };
  const producerSource = staticProducerSourceBinding(input, result, observation);
  const observedLocalFacts: readonly RelationStepLocalFact[] = observation.facts.map(fact => ({
    factRef: fact.factRef,
    role: fact.role,
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
          status: "resolved",
          declarationRef: observation.binding.resolution.declarationRef,
          moduleRef: selectedDeclaration.moduleRef,
          evidenceRefs: observation.binding.resolution.evidenceRefs,
        },
        declarationRefs: [selectedDeclaration],
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
  const successfulFiles = successfulProducerFiles(input.producerRequest, result.coverage);
  const requestedModuleFile = moduleFileFromRef(input.request.requestedDeclaration.moduleRef ?? null);
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
        observedDeclarations: [selectedDeclaration],
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
        coveredModules: successfulFiles,
        targetModuleReached:
          requestedModuleFile !== null
          && successfulFiles.includes(requestedModuleFile),
        note: "static_selected_source_observed",
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
  const rawProducerRequest = rawProducerRequestForValidation(input.producerRequest);
  const validation = validateTsJsSymbolRequest(rawProducerRequest);
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
  const producer = await runTsJsSymbolTable(rawProducerRequest);
  if (producer.status !== "ok") {
    return bridgeFailure(`producer rejected request: ${producer.reasonCode}`);
  }
  const result = producer.result;
  if (input.route === "lexical") {
    const lexicalSelection = selectTsJsLexicalBindingForCallSite({
      lexical: result.lexicalCallSiteBindings,
      callSiteRef: expectedCallSiteRef,
    });
    if (lexicalSelection.kind === "none") {
      return bridgeFailure("lexical call-site binding observation not found");
    }
    if (lexicalSelection.kind === "ambiguous") {
      return bridgeFailure("lexical call-site binding observation is ambiguous");
    }
    return {
      record: projectTsJsLexicalBindingToStepwiseRecord(
        canonicalInput,
        result,
        lexicalSelection.observation,
      ),
      reasons: [],
    };
  }
  const selection = selectTsJsObservationForCallSite({
    dynamic: result.runtimeSelectorObservations,
    staticSelected: result.staticSelectedSelectorObservations,
    callSiteRef: expectedCallSiteRef,
  });
  if (selection.kind === "none") {
    return bridgeFailure("producer observation callSiteRef not found");
  }
  if (selection.kind === "ambiguous") {
    return bridgeFailure("producer observation callSiteRef is ambiguous");
  }
  const successfulFiles = successfulProducerFiles(canonicalInput.producerRequest, result.coverage);
  if (selection.kind === "dynamic") {
    const observation = selection.observation;
    const reasons = validateProducerObservation(observation, expectedCallSiteRef, successfulFiles);
    if (reasons.length > 0) {
      return { record: null, reasons };
    }
    const completionRequirements = deriveTsJsObservedCompletionRequirements({
      requestRef: canonicalInput.request.requestRef,
      pendingRelationRef: canonicalInput.request.relationObligation.pendingRelationRef,
      callSiteRef: canonicalInput.request.relationObligation.callSiteRef,
      requestedDeclarationRef: canonicalInput.request.requestedDeclaration.declarationRef,
      requestedModuleRef: canonicalInput.request.requestedDeclaration.moduleRef ?? "",
      producerRequest: canonicalInput.producerRequest,
      observation,
    });
    if (completionRequirements.gaps.length > 0) {
      return {
        record: null,
        reasons: completionRequirements.gaps.map(
          gap => `completion requirement derivation failed: ${gap.reason}`,
        ),
      };
    }
    return {
      record: projectTsJsObservationToStepwiseRecord(canonicalInput, result, observation),
      reasons: [],
    };
  }

  const observation = selection.observation;
  const reasons = validateStaticProducerObservation(
    observation,
    expectedCallSiteRef,
    successfulFiles,
  );
  if (reasons.length > 0) {
    return { record: null, reasons };
  }
  const completionRequirements = deriveTsJsStaticSelectedCompletionRequirements({
    requestRef: canonicalInput.request.requestRef,
    pendingRelationRef: canonicalInput.request.relationObligation.pendingRelationRef,
    callSiteRef: canonicalInput.request.relationObligation.callSiteRef,
    requestedDeclarationRef: canonicalInput.request.requestedDeclaration.declarationRef,
    requestedModuleRef: canonicalInput.request.requestedDeclaration.moduleRef ?? "",
    producerRequest: canonicalInput.producerRequest,
    observation,
  });
  if (completionRequirements.gaps.length > 0) {
    return {
      record: null,
      reasons: completionRequirements.gaps.map(
        gap => `completion requirement derivation failed: ${gap.reason}`,
      ),
    };
  }
  return {
    record: projectTsJsStaticSelectedObservationToStepwiseRecord(
      canonicalInput,
      result,
      observation,
    ),
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
      && role !== "static_selected_member"
    ) {
      throw new TypeError(
        `sample ${sampleId} ${stepId} observedLocalFacts[${index}].role is invalid; expected selector_candidate_table, runtime_selector_dependency, or static_selected_member`,
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

function parseCompletionWork(
  raw: unknown,
  sampleId: string,
  stepId: string,
): TsJsCompletionWork {
  if (!isRecord(raw)) {
    throw new TypeError(`sample ${sampleId} ${stepId} producerSource.completionWork is invalid`);
  }
  const contract = raw.contract;
  if (
    contract !== "tsjs.observed-dynamic-source-closure.v1"
    && contract !== "tsjs.observed-static-selected-read.v1"
    && contract !== "tsjs.observed-target-mismatch-read.v1"
  ) {
    throw new TypeError(`sample ${sampleId} ${stepId} producerSource.completionWork is invalid`);
  }
  if (raw.scope !== "source_local") {
    throw new TypeError(`sample ${sampleId} ${stepId} completionWork.scope is invalid`);
  }
  const rawItems = requireArray(
    raw.items,
    `sample ${sampleId} ${stepId} completionWork.items`,
  );
  return {
    contract,
    scope: "source_local",
    items: rawItems.map((rawItem, index) => {
      if (!isRecord(rawItem)) {
        throw new TypeError(
          `sample ${sampleId} ${stepId} completionWork.items[${index}] is invalid`,
        );
      }
      const kind = rawItem.kind;
      if (
        kind !== "source_read"
        && kind !== "selector_structure"
        && kind !== "callable_identity"
        && kind !== "requested_target_mapping"
        && kind !== "selector_scope"
        && kind !== "relation_completion"
      ) {
        throw new TypeError(
          `sample ${sampleId} ${stepId} completionWork.items[${index}].kind is invalid`,
        );
      }
      const disposition = rawItem.disposition;
      if (!isRecord(disposition)) {
        throw new TypeError(
          `sample ${sampleId} ${stepId} completionWork.items[${index}].disposition is invalid`,
        );
      }
      const state = disposition.state;
      if (
        state !== "satisfied"
        && state !== "failed"
        && state !== "unsupported"
        && state !== "unresolved"
      ) {
        throw new TypeError(
          `sample ${sampleId} ${stepId} completionWork.items[${index}].disposition.state is invalid`,
        );
      }
      const evidenceRefs = requireArray(
        disposition.evidenceRefs ?? [],
        `sample ${sampleId} ${stepId} completionWork.items[${index}].disposition.evidenceRefs`,
      ).map((ref, refIndex) =>
        requireString(
          ref,
          `sample ${sampleId} ${stepId} completionWork.items[${index}].disposition.evidenceRefs[${refIndex}]`,
        ));
      if (state === "satisfied") {
        return {
          kind,
          subjectRef: requireString(
            rawItem.subjectRef,
            `sample ${sampleId} ${stepId} completionWork.items[${index}].subjectRef`,
          ),
          disposition: {
            state,
            evidenceRefs,
          },
        };
      }
      return {
        kind,
        subjectRef: requireString(
          rawItem.subjectRef,
          `sample ${sampleId} ${stepId} completionWork.items[${index}].subjectRef`,
        ),
        disposition: {
          state,
          evidenceRefs,
          reason: requireString(
            disposition.reason,
            `sample ${sampleId} ${stepId} completionWork.items[${index}].disposition.reason`,
          ),
        },
      };
    }),
  };
}

function parseProducerSourceBinding(
  raw: unknown,
  sampleId: string,
  stepId: string,
): TsJsProducerSourceBinding {
  if (
    !isRecord(raw)
    || (
      raw.kind !== "nnanything.tsjs.producer-source.v1"
      && raw.kind !== "nnanything.tsjs.producer-source.static-selected.v1"
      && raw.kind !== "nnanything.tsjs.target-mismatch-source.v1"
      && raw.kind !== "nnanything.tsjs.producer-source.lexical.v1"
    )
  ) {
    throw new TypeError(`sample ${sampleId} ${stepId} receipt.producerSource is invalid`);
  }
  if (raw.kind === "nnanything.tsjs.producer-source.lexical.v1") {
    if (
      !isRecord(raw.producerRequest)
      || !isRecord(raw.parser)
      || !isRecord(raw.coverage)
      || !isRecord(raw.rawObservation)
      || !Array.isArray(raw.sourceSymbols)
    ) {
      throw new TypeError(
        `sample ${sampleId} ${stepId} lexical producerSource fields are incomplete`,
      );
    }
    const rawObservation = raw.rawObservation;
    if (
      rawObservation.schemaVersion !== "nnanything.tsjs.lexical-call-site-binding.v1"
      || typeof rawObservation.callSiteRef !== "string"
      || typeof rawObservation.callerFile !== "string"
      || typeof rawObservation.bindingKind !== "string"
      || !isRecord(rawObservation.callerReadReceipt)
    ) {
      throw new TypeError(
        `sample ${sampleId} ${stepId} lexical producerSource.rawObservation is incomplete`,
      );
    }
    if (
      raw.sourceSymbols.some(symbol =>
        !isRecord(symbol)
        || typeof symbol.symbolId !== "string"
        || typeof symbol.file !== "string"
        || typeof symbol.name !== "string"
        || typeof symbol.kind !== "string"
        || !Array.isArray(symbol.lexicalScope))
    ) {
      throw new TypeError(
        `sample ${sampleId} ${stepId} lexical producerSource.sourceSymbols is invalid`,
      );
    }
    if (raw.fromStepId !== null && typeof raw.fromStepId !== "string") {
      throw new TypeError(`sample ${sampleId} ${stepId} producerSource.fromStepId is invalid`);
    }
    return {
      kind: "nnanything.tsjs.producer-source.lexical.v1",
      producerRequest: raw.producerRequest as unknown as TsJsSymbolTableRequest,
      parser: raw.parser as unknown as TsJsParserRecord,
      coverage: raw.coverage as unknown as TsJsCoverageRecord,
      rawObservation: rawObservation as unknown as TsJsLexicalCallSiteBindingObservation,
      sourceSymbols: raw.sourceSymbols as unknown as TsJsLexicalProducerSourceBinding["sourceSymbols"],
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
  if (raw.kind === "nnanything.tsjs.target-mismatch-source.v1") {
    if (!isRecord(raw.rawObservation)) {
      throw new TypeError(`sample ${sampleId} ${stepId} receipt.producerSource.rawObservation is invalid`);
    }
    const mismatchObservation = raw.rawObservation;
    if (
      typeof mismatchObservation.callSiteRef !== "string"
      || !isRecord(mismatchObservation.requestedDeclaration)
      || !isRecord(mismatchObservation.boundDeclaration)
      || !isRecord(mismatchObservation.callSiteBinding)
      || !isRecord(mismatchObservation.importEdge)
      || !Array.isArray(mismatchObservation.sourceReadReceipts)
    ) {
      throw new TypeError(`sample ${sampleId} ${stepId} target-mismatch rawObservation is incomplete`);
    }
    if (raw.fromStepId !== null && typeof raw.fromStepId !== "string") {
      throw new TypeError(`sample ${sampleId} ${stepId} producerSource.fromStepId is invalid`);
    }
    return {
      kind: "nnanything.tsjs.target-mismatch-source.v1",
      rawObservation: mismatchObservation as unknown as TsJsTargetMismatchObservation,
      sampleId: requireString(raw.sampleId, `sample ${sampleId} ${stepId} producerSource.sampleId`),
      requestRef: requireString(raw.requestRef, `sample ${sampleId} ${stepId} producerSource.requestRef`),
      stepId: requireString(raw.stepId, `sample ${sampleId} ${stepId} producerSource.stepId`),
      fromStepId: raw.fromStepId,
      callSiteRef: requireString(raw.callSiteRef, `sample ${sampleId} ${stepId} producerSource.callSiteRef`),
      pendingRelationRef: requireString(raw.pendingRelationRef, `sample ${sampleId} ${stepId} producerSource.pendingRelationRef`),
      requestedDeclarationRef: requireString(raw.requestedDeclarationRef, `sample ${sampleId} ${stepId} producerSource.requestedDeclarationRef`),
      requestedModuleRef: requireString(raw.requestedModuleRef, `sample ${sampleId} ${stepId} producerSource.requestedModuleRef`),
      ...(raw.completionWork === undefined
        ? {}
        : { completionWork: parseCompletionWork(raw.completionWork, sampleId, stepId) }),
    };
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
  const producerSourceKind = raw.kind;
  if (producerSourceKind === "nnanything.tsjs.producer-source.static-selected.v1") {
    return {
      kind: producerSourceKind,
      producerRequest: raw.producerRequest as unknown as TsJsSymbolTableRequest,
      parser: raw.parser as unknown as TsJsParserRecord,
      coverage: raw.coverage as unknown as TsJsCoverageRecord,
      rawObservation: rawObservation as unknown as TsJsStaticSelectedSelectorObservation,
      sampleId: requireString(raw.sampleId, `sample ${sampleId} ${stepId} producerSource.sampleId`),
      requestRef: requireString(raw.requestRef, `sample ${sampleId} ${stepId} producerSource.requestRef`),
      stepId: requireString(raw.stepId, `sample ${sampleId} ${stepId} producerSource.stepId`),
      fromStepId: raw.fromStepId,
      callSiteRef: requireString(raw.callSiteRef, `sample ${sampleId} ${stepId} producerSource.callSiteRef`),
      pendingRelationRef: requireString(raw.pendingRelationRef, `sample ${sampleId} ${stepId} producerSource.pendingRelationRef`),
      requestedDeclarationRef: requireString(raw.requestedDeclarationRef, `sample ${sampleId} ${stepId} producerSource.requestedDeclarationRef`),
      requestedModuleRef: requireString(raw.requestedModuleRef, `sample ${sampleId} ${stepId} producerSource.requestedModuleRef`),
      ...(raw.completionWork === undefined
        ? {}
        : { completionWork: parseCompletionWork(raw.completionWork, sampleId, stepId) }),
    };
  }
  return {
    kind: producerSourceKind,
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
    ...(raw.completionWork === undefined
      ? {}
      : { completionWork: parseCompletionWork(raw.completionWork, sampleId, stepId) }),
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
  if (!isRecord(binding)) {
    throw new TypeError(`sample ${sampleId} ${stepId} currentRelation.binding is invalid`);
  }
  const state = binding.state;
  if (state !== "known" && state !== "missing" && state !== "not_observed" && state !== "conflicting" && state !== "unsupported") {
    throw new TypeError(`sample ${sampleId} ${stepId} currentRelation.binding.state is invalid`);
  }
  if (state === "known" && !isRecord(binding.value)) {
    throw new TypeError(`sample ${sampleId} ${stepId} currentRelation.binding is invalid`);
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

function validateTsJsCompletionWork(
  source: TsJsProducerSourceBinding,
  fail: (reason: string) => never,
): void {
  if (source.kind === "nnanything.tsjs.target-mismatch-source.v1") {
    return validateTsJsTargetMismatchCompletionWork(source, fail);
  }
  if (source.kind === "nnanything.tsjs.producer-source.lexical.v1") {
    return;
  }
  if (source.completionWork !== undefined
    && source.completionWork.contract !== "tsjs.observed-dynamic-source-closure.v1") {
    fail("dynamic completion contract mismatch");
  }
  const completionWork = source.completionWork;
  if (completionWork === undefined) return;
  const derivation = deriveTsJsObservedCompletionRequirements({
    requestRef: source.requestRef,
    pendingRelationRef: source.pendingRelationRef,
    callSiteRef: source.callSiteRef,
    requestedDeclarationRef: source.requestedDeclarationRef,
    requestedModuleRef: source.requestedModuleRef,
    producerRequest: source.producerRequest,
    observation: source.rawObservation,
  });
  if (derivation.gaps.length > 0) {
    fail(`completion derivation failed: ${derivation.gaps[0]!.reason}`);
  }
  const actual = new Map<string, TsJsCompletionWorkItem>();
  for (const item of completionWork.items) {
    const key = `${item.kind}\u0000${item.subjectRef}`;
    if (actual.has(key)) fail(`duplicate completion-work key ${key}`);
    actual.set(key, item);
  }
  const expected = new Map(
    derivation.requirements.map(requirement => [
      `${requirement.kind}\u0000${requirement.subjectRef}`,
      requirement,
    ]),
  );
  if (actual.size !== expected.size) {
    fail("completion-work item set does not equal the derived required set");
  }
  for (const [key, requirement] of expected) {
    if (!actual.has(key)) {
      fail(`completion-work omits required item ${requirement.kind}:${requirement.subjectRef}`);
    }
  }
  for (const item of completionWork.items) {
    if (item.kind === "callable_identity") {
      const member = source.rawObservation.callableTable?.members.find(
        entry => entry.initializerRef === item.subjectRef,
      );
      if (
        member === undefined
        || member.callableIdentity === null
        || !isTsJsCallableIdentityExact(member.callableIdentity, member.initializerRef)
      ) {
        fail(`callable identity ${item.subjectRef} is not a valid typed identity`);
      }
    }
  }
}

function validateTsJsStaticCompletionWork(
  source: TsJsStaticProducerSourceBinding,
  requestedDeclaration: NonNullable<RelationStepEpisode["requestedDeclaration"]>,
  fail: (reason: string) => never,
): void {
  const completionWork = source.completionWork;
  if (completionWork === undefined) {
    return fail("static completionWork missing");
  }
  if (completionWork.contract !== "tsjs.observed-static-selected-read.v1") {
    return fail("static completion contract mismatch");
  }
  const derivation = deriveTsJsStaticSelectedCompletionRequirements({
    requestRef: source.requestRef,
    pendingRelationRef: source.pendingRelationRef,
    callSiteRef: source.callSiteRef,
    requestedDeclarationRef: source.requestedDeclarationRef,
    requestedModuleRef: source.requestedModuleRef,
    producerRequest: source.producerRequest,
    observation: source.rawObservation,
  });
  if (derivation.gaps.length > 0) {
    fail(`completion derivation failed: ${derivation.gaps[0]!.reason}`);
  }
  const actual = new Map<string, TsJsCompletionWorkItem>();
  for (const item of completionWork.items) {
    const key = `${item.kind}\u0000${item.subjectRef}`;
    if (actual.has(key)) fail(`duplicate completion-work key ${key}`);
    actual.set(key, item);
  }
  const expected = new Map(
    derivation.requirements.map(requirement => [
      `${requirement.kind}\u0000${requirement.subjectRef}`,
      requirement,
    ]),
  );
  if (actual.size !== expected.size) {
    fail("static completion-work item set does not equal the derived required set");
  }
  for (const [key, requirement] of expected) {
    if (!actual.has(key)) {
      fail(`static completion-work omits required item ${requirement.kind}:${requirement.subjectRef}`);
    }
  }
  for (const item of completionWork.items) {
    if (item.kind === "callable_identity") {
      const member = source.rawObservation.callableTable.members.find(
        entry => entry.initializerRef === item.subjectRef,
      );
      if (
        member === undefined
        || member.callableIdentity === null
        || !isTsJsCallableIdentityExact(member.callableIdentity, member.initializerRef)
      ) {
        fail(`callable identity ${item.subjectRef} is not a valid typed identity`);
      }
    }
    if (item.kind === "relation_completion") {
      if (item.disposition.state === "unsupported") {
        if (
          item.disposition.reason
            !== "static-selected completion witness is not yet reviewed"
        ) {
          fail("legacy static relation completion reason is invalid");
        }
        continue;
      }
      const expectedRelation = deriveTsJsStaticRelationCompletionItem(
        source.rawObservation,
        requestedDeclaration,
        source.rawObservation.sourceReadRef.length > 0
          && source.rawObservation.sourceReadReceipt.receiptId
            === source.rawObservation.sourceReadRef
          && source.rawObservation.sourceReadReceipt.action === "read_source"
          && source.rawObservation.sourceReadReceipt.outcome === "success",
      );
      if (
        item.disposition.state !== expectedRelation.disposition.state
        || !sameStringArray(
          item.disposition.evidenceRefs,
          expectedRelation.disposition.evidenceRefs,
        )
      ) {
        fail("static relation completion disposition or evidence is invalid");
      }
    } else if (item.disposition.state !== "satisfied") {
      fail(`static completion item ${item.kind}:${item.subjectRef} is not satisfied`);
    }
  }
}

function validateTsJsTargetMismatchCompletionWork(
  source: TsJsTargetMismatchProducerSourceBinding,
  fail: (reason: string) => never,
): void {
  const completionWork = source.completionWork;
  if (completionWork === undefined) {
    return fail("target-mismatch completionWork missing");
  }
  if (completionWork.contract !== "tsjs.observed-target-mismatch-read.v1") {
    return fail("target-mismatch completion contract mismatch");
  }
  const derivation = deriveTsJsTargetMismatchCompletionRequirements({
    observation: source.rawObservation,
  });
  if (derivation.gaps.length > 0) {
    return fail(`completion derivation failed: ${derivation.gaps[0]!.reason}`);
  }
  const actual = new Map<string, TsJsCompletionWorkItem>();
  for (const item of completionWork.items) {
    const key = `${item.kind}\u0000${item.subjectRef}`;
    if (actual.has(key)) fail(`duplicate completion-work key ${key}`);
    actual.set(key, item);
  }
  const expected = new Map(
    derivation.requirements.map(requirement => [
      `${requirement.kind}\u0000${requirement.subjectRef}`,
      requirement,
    ]),
  );
  if (actual.size !== expected.size) {
    return fail("target-mismatch completion-work item set does not equal the derived required set");
  }
  for (const [key, requirement] of expected) {
    if (!actual.has(key)) {
      return fail(
        `target-mismatch completionWork omits required item ${requirement.kind}:${requirement.subjectRef}`,
      );
    }
  }
  for (const [key, item] of actual) {
    if (!expected.has(key)) {
      return fail(`target-mismatch completionWork contains unexpected item ${key}`);
    }
  }
  const boundIdentity = actual.get(
    `callable_identity\u0000${source.rawObservation.boundDeclaration.declarationRef}`,
  );
  const targetMapping = actual.get(
    `requested_target_mapping\u0000${source.rawObservation.requestedDeclaration.declarationRef}`,
  );
  if (
    boundIdentity === undefined
    || boundIdentity.disposition.state !== "satisfied"
    || !boundIdentity.disposition.evidenceRefs.includes(
      source.rawObservation.boundDeclaration.readRef,
    )
  ) {
    fail("target-mismatch callable identity is not satisfied by the admitted bound read");
  }
  if (
    targetMapping === undefined
    || targetMapping.disposition.state !== "satisfied"
    || !targetMapping.disposition.evidenceRefs.includes(
      source.rawObservation.requestedDeclaration.readRef,
    )
  ) {
    fail("target-mismatch requested target mapping is not satisfied by the admitted target read");
  }
}

function validateTsJsLexicalProducerSourceBinding(
  input: Parameters<typeof validateTsJsProducerSourceBinding>[0],
  source: TsJsLexicalProducerSourceBinding,
  fail: (reason: string) => never,
): void {
  const raw = source.rawObservation;
  const callerReceipt = raw.callerReadReceipt;
  const sourceReceipt = raw.sourceModuleReadReceipt;
  if (source.sampleId !== input.sampleId) fail("lexical sampleId mismatch");
  if (source.stepId !== input.stepId) fail("lexical stepId mismatch");
  if (source.requestRef !== input.requestRef) fail("lexical requestRef mismatch");
  if (source.pendingRelationRef !== input.pendingRelationRef) {
    fail("lexical pendingRelationRef mismatch");
  }
  if (source.callSiteRef !== input.callSiteRef || raw.callSiteRef !== input.callSiteRef) {
    fail("lexical callSiteRef mismatch");
  }
  if (source.requestedDeclarationRef !== input.requestedDeclarationRef) {
    fail("lexical requestedDeclarationRef mismatch");
  }
  if (source.requestedModuleRef !== input.requestedModuleRef) {
    fail("lexical requestedModuleRef mismatch");
  }
  if (source.fromStepId !== (input.receipt.fromStepId ?? null)) {
    fail("lexical fromStepId mismatch");
  }
  if (source.parser.semanticBinding !== false) {
    fail("lexical parser.semanticBinding must remain false");
  }
  if (raw.requestRef !== null || raw.callerModuleRef !== `module:${raw.callerFile}`) {
    fail("lexical raw request or caller identity mismatch");
  }
  if (
    input.receipt.receiptId !== callerReceipt.receiptId
    || input.receipt.actionRef !== callerReceipt.actionRef
    || input.receipt.action !== callerReceipt.action
    || input.receipt.target !== callerReceipt.targetRef
    || input.receipt.origin !== callerReceipt.origin
    || input.receipt.outcome !== callerReceipt.outcome
    || !sameStringArray(
      Array.isArray(input.receipt.result)
        ? input.receipt.result as readonly string[]
        : [],
      callerReceipt.result,
    )
    || !sameStringArray(input.receipt.evidenceRefs, callerReceipt.evidenceRefs)
  ) {
    fail("lexical caller receipt projection mismatch");
  }
  if (
    callerReceipt.action !== "read_source"
    || callerReceipt.origin !== "source_observation"
    || callerReceipt.outcome !== "success"
    || callerReceipt.targetRef !== raw.callerModuleRef
    || !sameStringArray(callerReceipt.modules.map(module => module.file), [raw.callerFile])
    || !sameStringArray(
      callerReceipt.result,
      [`source-read:${raw.callerFile}:module:${raw.callerFile}`],
    )
    || !callerReceipt.evidenceRefs.includes(callerReceipt.receiptId)
    || input.sourceContent?.state !== "observed"
    || !sameStringArray(input.sourceContent.resultRefs, callerReceipt.result)
    || !sameStringArray(input.sourceContent.evidenceRefs, [callerReceipt.receiptId])
  ) {
    fail("lexical caller source content mismatch");
  }
  if (
    input.currentRelation?.binding.state !== "not_observed"
    || input.currentRelation.binding.reason !== "not_requested"
    || !sameStringArray(input.currentRelation.binding.evidenceRefs, raw.evidenceRefs)
  ) {
    fail("lexical currentRelation must remain not_observed/not_requested");
  }
  if (input.observedLocalFacts.length !== 0) {
    fail("lexical observedLocalFacts must remain empty");
  }
  const successfulFiles = successfulProducerFiles(source.producerRequest, source.coverage);
  if (
    input.coverage === null
    || !sameStringArray(input.coverage.coveredModules ?? [], successfulFiles)
    || input.coverage.note !== "lexical_call_site_binding_source_observed"
    || input.coverage.targetModuleReached !== (raw.sourceModuleFile !== null
      && successfulFiles.includes(raw.sourceModuleFile))
  ) {
    fail("lexical coverage projection mismatch");
  }

  if (raw.bindingKind !== "import") {
    if (sourceReceipt !== null || source.sourceSymbols.length !== 0) {
      fail("lexical non-import source evidence mismatch");
    }
    if (
      raw.bindingKind === "unresolved"
      && (
        input.observedBindings.length !== 0
        || input.observedDeclarations.length !== 0
      )
    ) {
      fail("unresolved lexical binding must not project an edge or declaration");
    }
    if (
      raw.bindingKind !== "unresolved"
      && (
        input.observedBindings.length !== 1
        || input.observedBindings[0]?.edgeKind !== raw.bindingKind
        || input.observedDeclarations.length !== 0
      )
    ) {
      fail("non-import lexical binding projection mismatch");
    }
    return;
  }

  if (
    raw.sourceName === null
    || raw.targetName === null
    || raw.moduleSpecifierRaw === null
    || raw.sourceModuleFile === null
    || raw.sourceModuleRef === null
    || raw.targetModuleRef === null
    || raw.importDeclarationRef === null
    || sourceReceipt === null
  ) {
    fail("lexical import identity is incomplete");
  }
  if (
    raw.sourceName !== input.requestedDeclaration.name
    || raw.sourceModuleRef !== `module:${raw.sourceModuleFile}`
    || raw.targetModuleRef !== raw.callerModuleRef
    || !successfulFiles.includes(raw.callerFile)
    || !successfulFiles.includes(raw.sourceModuleFile)
    || source.coverage.parseErrorFiles.some(entry =>
      entry.file === raw.callerFile || entry.file === raw.sourceModuleFile)
  ) {
    fail("lexical import target or read coverage mismatch");
  }
  if (
    sourceReceipt.action !== "read_source"
    || sourceReceipt.origin !== "source_observation"
    || sourceReceipt.outcome !== "success"
    || sourceReceipt.targetRef !== raw.sourceModuleRef
    || !sameStringArray(
      sourceReceipt.modules.map(module => module.file),
      [raw.sourceModuleFile],
    )
    || !sameStringArray(
      sourceReceipt.result,
      [`source-read:${raw.sourceModuleFile}:module:${raw.sourceModuleFile}`],
    )
    || !sourceReceipt.evidenceRefs.includes(sourceReceipt.receiptId)
  ) {
    fail("lexical source-module receipt mismatch");
  }
  if (
    source.sourceSymbols.length === 0
    || new Set(source.sourceSymbols.map(symbol => symbol.symbolId)).size
      !== source.sourceSymbols.length
    || source.sourceSymbols.some(symbol =>
      symbol.file !== raw.sourceModuleFile || symbol.name !== raw.sourceName)
  ) {
    fail("lexical source symbols mismatch");
  }
  const edge = input.observedBindings.length === 1 ? input.observedBindings[0]! : null;
  if (
    edge === null
    || edge.edgeRef !== `edge:${raw.callSiteRef}:import`
    || edge.callSiteRef !== raw.callSiteRef
    || edge.fromNodeRef !== raw.callerModuleRef
    || edge.edgeKind !== "import"
    || edge.sourceName !== raw.sourceName
    || edge.targetName !== raw.targetName
    || edge.sourceModule.state !== "known"
    || edge.sourceModule.value !== raw.sourceModuleRef
    || edge.targetModule.state !== "known"
    || edge.targetModule.value !== raw.targetModuleRef
    || edge.moduleSpecifierRaw !== raw.moduleSpecifierRaw
    || edge.sourceContent.state !== "observed"
    || !sameStringArray(edge.sourceContent.resultRefs, [sourceReceipt.receiptId])
    || !sameStringArray(edge.sourceContent.evidenceRefs, sourceReceipt.evidenceRefs)
    || !sameStringArray(edge.evidenceRefs, raw.evidenceRefs)
    || !edge.evidenceRefs.includes(raw.importDeclarationRef)
    || !edge.evidenceRefs.includes(sourceReceipt.receiptId)
  ) {
    fail("lexical import edge projection mismatch");
  }
  if (source.sourceSymbols.length === 1) {
    const symbol = source.sourceSymbols[0]!;
    const topLevel = symbol.kind === "function"
      && symbol.declaredIn === "file"
      && symbol.lexicalScope.length === 0
      && symbol.ownerType === null
      && symbol.ownerKind === null;
    const expectedRef = topLevel
      ? `decl:${symbol.file}#top:${symbol.name}`
      : symbol.symbolId;
    const declaration = input.observedDeclarations.length === 1
      ? input.observedDeclarations[0]!
      : null;
    if (
      declaration === null
      || declaration.declarationRef !== expectedRef
      || declaration.moduleRef !== raw.sourceModuleRef
      || declaration.name !== raw.sourceName
      || declaration.role !== "import"
      || declaration.kind !== symbol.kind
      || !declaration.evidenceRefs.includes(symbol.symbolId)
    ) {
      fail("lexical declaration projection mismatch");
    }
  } else if (input.observedDeclarations.length !== 0) {
    fail("ambiguous lexical symbols must not project a declaration");
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
  readonly requestedDeclaration: NonNullable<RelationStepEpisode["requestedDeclaration"]>;
  readonly coverage: RelationStepCoverage | null;
  readonly sourceContent: RelationStepSourceContent | null;
  readonly currentRelation: CurrentRelationProjection | null;
  readonly observedLocalFacts: readonly StepwiseObservedLocalFact[];
  readonly observedBindings: readonly BindingEdge[];
  readonly observedDeclarations: readonly DeclarationIdentity[];
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
  if (source.kind === "nnanything.tsjs.producer-source.static-selected.v1") {
    return validateTsJsStaticProducerSourceBinding(input, source, fail);
  }
  if (source.kind === "nnanything.tsjs.target-mismatch-source.v1") {
    return validateTsJsTargetMismatchProducerSourceBinding(input, source, fail);
  }
  if (source.kind === "nnanything.tsjs.producer-source.lexical.v1") {
    return validateTsJsLexicalProducerSourceBinding({
      ...input,
      observedBindings: input.observedBindings ?? [],
      observedDeclarations: input.observedDeclarations ?? [],
    }, source, fail);
  }
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
  validateTsJsCompletionWork(source, fail);
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
  const producerRequestValidation = validateTsJsSymbolRequest(
    rawProducerRequestForValidation(source.producerRequest),
  );
  const validatedProducerRequest = (() => {
    if (producerRequestValidation.ok) return producerRequestValidation.request;
    return fail(
      `captured producer request is invalid: ${producerRequestValidation.error.reasonCode}`,
    );
  })();
  const successfulFiles = successfulProducerFiles(
    validatedProducerRequest,
    source.coverage,
  );
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

function validateTsJsStaticProducerSourceBinding(
  input: Parameters<typeof validateTsJsProducerSourceBinding>[0],
  source: TsJsStaticProducerSourceBinding,
  fail: (reason: string) => never,
): void {
  if (source.sampleId !== input.sampleId) fail("sampleId mismatch");
  if (source.stepId !== input.stepId) fail("stepId mismatch");
  if (source.requestRef !== input.requestRef) fail("requestRef mismatch");
  if (source.pendingRelationRef !== input.pendingRelationRef) fail("pendingRelationRef mismatch");
  if (source.callSiteRef !== input.callSiteRef) fail("callSiteRef mismatch");
  if (source.requestedDeclarationRef !== input.requestedDeclarationRef) {
    fail("requestedDeclarationRef mismatch");
  }
  if (source.requestedModuleRef !== input.requestedModuleRef) fail("requestedModuleRef mismatch");
  validateTsJsStaticCompletionWork(source, input.requestedDeclaration, fail);
  if (source.fromStepId !== (input.receipt.fromStepId ?? null)) fail("fromStepId mismatch");
  if (source.parser.semanticBinding !== false) fail("parser.semanticBinding must remain false");
  const raw = source.rawObservation;
  if (raw.callSiteRef !== input.callSiteRef) fail("raw callSiteRef mismatch");
  if (raw.binding.callSiteRef !== input.callSiteRef) fail("raw binding callSiteRef mismatch");

  const sourceReadRef = raw.sourceReadRef;
  if (sourceReadRef.length === 0) fail("missing raw sourceReadRef");
  const rawReceipt = raw.sourceReadReceipt;
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

  const selectedMember = raw.callableTable.members.find(
    member => member.initializerRef === raw.selection.selectedMemberRef,
  );
  const selectedIdentity = selectedMember?.callableIdentity ?? null;
  if (
    selectedMember === undefined
    || selectedMember.name !== raw.selection.selectedMemberName
    || selectedIdentity === null
    || !isTsJsCallableIdentityExact(selectedIdentity, selectedMember.initializerRef)
    || selectedIdentity.declarationRef !== raw.selection.selectedDeclarationRef
    || selectedIdentity.moduleRef !== raw.selection.selectedModuleRef
  ) {
    fail("static selected identity mismatch");
  }

  if (
    !raw.binding.evidenceRefs.includes(sourceReadRef)
    || !raw.binding.resolution.evidenceRefs.includes(sourceReadRef)
    || raw.binding.bindingMode !== "bound"
    || raw.binding.resolution.status !== "resolved"
    || raw.binding.resolution.declarationRef !== raw.selection.selectedDeclarationRef
    || raw.binding.resolution.moduleRef !== raw.selection.selectedModuleRef
    || raw.binding.declarationRefs.length !== 1
    || raw.binding.declarationRefs[0] !== raw.selection.selectedDeclarationRef
    || raw.binding.scopeRef !== null
  ) {
    fail("raw static binding mismatch");
  }

  const roleFacts = raw.facts;
  if (
    roleFacts.length !== 2
    || roleFacts.filter(fact => fact.role === "selector_candidate_table").length !== 1
    || roleFacts.filter(fact => fact.role === "static_selected_member").length !== 1
    || roleFacts.some(fact =>
      fact.state !== "known" || !fact.evidenceRefs.includes(sourceReadRef))
  ) {
    fail("raw static role facts mismatch");
  }

  const projection = input.currentRelation?.binding.state === "known"
    ? input.currentRelation.binding.value
    : undefined;
  if (projection === undefined) fail("currentRelation binding value missing");
  const selectedDeclaration = projection.declarationRefs.find(
    declaration => declaration.declarationRef === raw.selection.selectedDeclarationRef,
  );
  if (
    selectedDeclaration === undefined
    || selectedDeclaration.moduleRef !== `module:${raw.selection.selectedModuleRef}`
    || selectedDeclaration.name !== raw.selection.selectedMemberName
    || selectedDeclaration.role !== "member"
    || selectedDeclaration.kind !== "function"
    || projection.symbolRef !== raw.binding.symbolRef
    || projection.callSiteRef !== raw.binding.callSiteRef
    || projection.role !== raw.binding.role
    || projection.bindingMode !== raw.binding.bindingMode
    || !sameStringArray(projection.evidenceRefs, raw.binding.evidenceRefs)
    || projection.scopeRef !== null
    || projection.resolution.status !== "resolved"
    || projection.resolution.declarationRef !== raw.binding.resolution.declarationRef
    || projection.resolution.moduleRef !== projection.declarationRefs[0]?.moduleRef
    || !sameStringArray(
      projection.resolution.evidenceRefs,
      raw.binding.resolution.evidenceRefs,
    )
  ) {
    fail("currentRelation static projection mismatch");
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
  const producerRequestValidation = validateTsJsSymbolRequest(
    rawProducerRequestForValidation(source.producerRequest),
  );
  const validatedProducerRequest = (() => {
    if (producerRequestValidation.ok) return producerRequestValidation.request;
    return fail(
      `captured producer request is invalid: ${producerRequestValidation.error.reasonCode}`,
    );
  })();
  const successfulFiles = successfulProducerFiles(
    validatedProducerRequest,
    source.coverage,
  );
  if (moduleFiles.some(file => !successfulFiles.includes(file))) {
    fail("raw observation modules are not in the producer read set");
  }
  const requestedModuleFile = moduleFileFromRef(source.requestedModuleRef);
  if (requestedModuleFile === null) fail("requested moduleRef is invalid");
  if (
    input.coverage === null
    || !sameStringArray(input.coverage.coveredModules ?? [], successfulFiles)
    || input.coverage.targetModuleReached !== successfulFiles.includes(requestedModuleFile)
  ) {
    fail("coverage projection mismatch");
  }
}

function validateTsJsTargetMismatchProducerSourceBinding(
  input: Parameters<typeof validateTsJsProducerSourceBinding>[0],
  source: TsJsTargetMismatchProducerSourceBinding,
  fail: (reason: string) => never,
): void {
  const raw = source.rawObservation;
  if (source.sampleId !== input.sampleId) fail("sampleId mismatch");
  if (source.stepId !== input.stepId) fail("stepId mismatch");
  if (source.requestRef !== input.requestRef) fail("requestRef mismatch");
  if (source.pendingRelationRef !== input.pendingRelationRef) fail("pendingRelationRef mismatch");
  if (source.callSiteRef !== input.callSiteRef) fail("callSiteRef mismatch");
  if (source.requestedDeclarationRef !== input.requestedDeclarationRef) {
    fail("requestedDeclarationRef mismatch");
  }
  if (source.requestedModuleRef !== input.requestedModuleRef) fail("requestedModuleRef mismatch");
  validateTsJsTargetMismatchCompletionWork(source, fail);
  if (source.fromStepId !== (input.receipt.fromStepId ?? null)) fail("fromStepId mismatch");
  if (raw.kind !== "resolved_target_mismatch") fail("raw observation kind mismatch");
  if (raw.sampleId !== input.sampleId) fail("raw sampleId mismatch");
  if (raw.stepId !== input.stepId) fail("raw stepId mismatch");
  if (raw.fromStepId !== source.fromStepId) fail("raw fromStepId mismatch");
  if (raw.requestRef !== source.requestRef) fail("raw requestRef mismatch");
  if (raw.callSiteRef !== input.callSiteRef) fail("raw callSiteRef mismatch");
  if (raw.pendingRelationRef !== source.pendingRelationRef) fail("raw pendingRelationRef mismatch");

  const requested = raw.requestedDeclaration;
  const bound = raw.boundDeclaration;
  if (
    requested.declarationRef !== source.requestedDeclarationRef
    || requested.moduleRef !== source.requestedModuleRef
  ) {
    fail("requested declaration does not match the request tuple");
  }
  const boundModuleFile = canonicalRequestedModuleFile(bound.moduleRef);
  const requestedDeclarationModuleFile = canonicalRequestedModuleFile(requested.moduleRef);
  if (
    boundModuleFile === null
    || requestedDeclarationModuleFile === null
    || boundModuleFile === requestedDeclarationModuleFile
    || bound.name !== requested.name
    || bound.declarationRef === requested.declarationRef
  ) {
    fail("same-name different-module target mismatch is not established");
  }
  const binding = raw.callSiteBinding;
  if (
    binding.bindingMode !== "bound"
    || binding.resolution.status !== "resolved"
    || binding.resolution.declarationRef !== bound.declarationRef
    || binding.resolution.moduleRef !== bound.moduleRef
    || binding.callSiteRef !== source.callSiteRef
  ) {
    fail("call-site binding does not resolve to the bound declaration");
  }

  const edge = raw.importEdge;
  if (edge.edgeKind !== "import" || edge.targetName !== requested.name) {
    fail("import edge does not join the requested call site");
  }
  if (edge.sourceModuleRef !== bound.moduleRef) fail("import edge source module mismatch");

  const receipts = raw.sourceReadReceipts;
  if (receipts.length !== 3) fail("target-mismatch observation requires three source reads");
  const [entryReceipt, boundReceipt, targetReceipt] = receipts;
  if (
    entryReceipt === undefined
    || boundReceipt === undefined
    || targetReceipt === undefined
  ) {
    fail("target-mismatch source reads are incomplete");
  }
  const requestedModuleFile = canonicalRequestedModuleFile(source.requestedModuleRef);
  if (requestedModuleFile === null) fail("requested moduleRef is invalid");
  const entryModuleFile = canonicalRequestedModuleFile(edge.targetModuleRef);
  if (entryModuleFile === null) fail("import edge target module is invalid");
  if (
    targetReceipt.targetRef !== source.requestedModuleRef
    || targetReceipt.receiptId !== requested.readRef
  ) {
    fail("target read does not back the requested declaration");
  }
  if (
    boundReceipt.targetRef !== bound.moduleRef
    || boundReceipt.receiptId !== bound.readRef
  ) {
    fail("bound read does not back the bound declaration");
  }
  for (const receipt of receipts) {
    if (receipt.pendingRelationRef !== source.pendingRelationRef) {
      fail("source read pendingRelationRef mismatch");
    }
    if (receipt.modules.length !== 1 || !canonicalProducerFile(receipt.modules[0]!.file)) {
      fail("source read module file is invalid");
    }
  }
  if (boundReceipt.modules[0]!.file !== boundModuleFile) {
    fail("bound read does not back the bound declaration module");
  }
  if (edge.targetModuleRef !== entryReceipt.targetRef) fail("import edge entry module mismatch");
  if (entryReceipt.modules[0]!.file !== entryModuleFile) {
    fail("entry read does not back the import edge target module");
  }
  if (targetReceipt.modules[0]!.file !== requestedModuleFile) {
    fail("target read does not back the requested target module");
  }

  const projected = input.currentRelation?.binding.state === "known"
    ? input.currentRelation.binding.value
    : undefined;
  if (projected === undefined) fail("currentRelation binding value missing");
  if (
    projected.bindingMode !== "bound"
    || projected.resolution.status !== "resolved"
    || projected.resolution.declarationRef !== bound.declarationRef
    || projected.resolution.moduleRef !== bound.moduleRef
    || !projected.declarationRefs.some(
      declaration => declaration.declarationRef === bound.declarationRef)
  ) {
    fail("currentRelation projection does not resolve to the bound declaration");
  }
  if (
    input.sourceContent === null
    || input.sourceContent.state !== "observed"
    || !sameStringArray(input.sourceContent.resultRefs, targetReceipt.result)
    || !input.sourceContent.evidenceRefs.includes(targetReceipt.receiptId)
  ) {
    fail("sourceContent projection does not match the target read");
  }
  const previous = input.previous?.state === "known" ? input.previous.value : null;
  if (
    previous === null
    || previous === undefined
    || previous.actionRef !== targetReceipt.actionRef
    || previous.receiptRef !== targetReceipt.receiptId
    || previous.targetRef !== targetReceipt.targetRef
    || previous.fromStepId !== source.fromStepId
    || previous.pendingRelationRef !== source.pendingRelationRef
    || previous.outcome !== "success"
  ) {
    fail("previousExecution mismatch");
  }
  if (
    input.receipt.receiptId !== targetReceipt.receiptId
    || input.receipt.actionRef !== targetReceipt.actionRef
    || input.receipt.target !== targetReceipt.targetRef
    || input.receipt.outcome !== targetReceipt.outcome
  ) {
    fail("receipt projection mismatch");
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
          requestedDeclaration:
            requestedDeclaration as unknown as NonNullable<
              RelationStepEpisode["requestedDeclaration"]
            >,
          coverage,
          sourceContent,
          currentRelation,
          observedLocalFacts,
          observedBindings: localSyntax.observedBindings as readonly BindingEdge[],
          observedDeclarations: localSyntax.observedDeclarations as readonly DeclarationIdentity[],
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
