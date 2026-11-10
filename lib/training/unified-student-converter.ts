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
  type RelationStepReceipt,
  type RelationStepSourceContent,
} from "./unified-step-context-builder.js";

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

export interface StepwiseObservedLocalFact {
  readonly factRef: string;
  readonly role?: "selector_candidate_table" | "runtime_selector_dependency";
  readonly state: string;
  readonly value: string | null;
  readonly evidenceRefs: readonly string[];
}

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
      const remainingObligations = requireArray(
        rawStep.remainingObligations ?? [],
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
