// Request-aware admission for an accepted TS/JS source family.
//
// This module binds accepted producer observations to a declared request, step,
// call site, pending relation and observed-source completion contract through
// the existing bridge, retains the admitted stepwise DEV output, and writes the
// existing family-admission input for the non-fitting stepwise consumer. It is
// read-only with respect to source families: it never fits, scores, adopts,
// trains, or rewrites sources.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { runTsJsSymbolTable } from "../adapters/cli/tsjs-symbol-table-adapter.js";
import {
  admitInitialEvidence,
  assessTsJsObservedDynamicCompletion,
  type TsJsInitialEvidenceRecord,
  type TsJsObservedDynamicCompletionAssessment,
} from "../adapters/tsjs-unified-recursive.js";
import type { TsJsSymbolTableRequest } from "../filters/tsjs-symbol-table-policy.js";
import type { LocalCandidateCursorProjection } from "./unified-encoder.js";
import type { RelationStepEpisode } from "./unified-step-context-builder.js";
import { relationStepContext } from "./unified-step-context-builder.js";
import {
  loadStepwiseEpisodeFamily,
  observeTsJsStepwiseRequest,
} from "./unified-student-converter.js";

export const TSJS_REQUEST_AWARE_ADMISSION_CONFIG_SCHEMA =
  "nnanything.tsjs.request-aware-admission-config.v1" as const;
export const TSJS_REQUEST_AWARE_ADMISSION_RECEIPT_SCHEMA =
  "nnanything.tsjs.request-aware-admission-receipt.v1" as const;
export const TSJS_REQUEST_AWARE_FAMILY_ADMISSIONS_SCHEMA =
  "nnanything.tsjs.request-aware-admission.family-admissions.v1" as const;
export const TSJS_REQUEST_AWARE_CONSUMER_INPUTS_SCHEMA =
  "nnanything.tsjs.request-aware-admission.consumer-inputs.v1" as const;
export const TSJS_OBSERVED_SOURCE_CLOSURE_CONTRACT =
  "tsjs.observed-dynamic-source-closure.v1" as const;
export const TSJS_STEPWISE_CONSUMER_ENTRY =
  "loadStepwiseEpisodeFamily" as const;

type RelationRemainingObligations = NonNullable<RelationStepEpisode["remainingObligations"]>;

export type TsJsRequestAwareAdmissionRejectionCode =
  | "family_unreadable"
  | "request_not_accepted"
  | "producer_rejected"
  | "call_site_mismatch"
  | "source_read_mismatch"
  | "requested_member_missing"
  | "bridge_rejected"
  | "request_mismatch"
  | "step_mismatch"
  | "pending_relation_mismatch"
  | "coverage_mismatch"
  | "role_mismatch"
  | "work_state_missing"
  | "work_state_open"
  | "admission_rejected";

export interface TsJsRequestAwareWorkState {
  /** Why this finite work set is the truthful state for the unit. */
  readonly basis: string;
  readonly remainingObligations: RelationRemainingObligations;
  readonly localCandidateCursor: LocalCandidateCursorProjection;
}

export interface TsJsRequestAwareAdmissionCaseConfig {
  readonly caseId: string;
  readonly entryFile: string;
  readonly files: readonly string[];
  readonly requestRef: string;
  readonly pendingRelationRef: string;
  readonly callSiteRef: string;
  readonly sourceReadRef: string;
  readonly calleeName: string;
  readonly requestedMemberName: string;
  readonly requestedRole: string;
  // Explicit route. Only `lexical` consults `lexicalCallSiteBindings`; the
  // default dynamic path is unchanged. The lexical route requires an explicit
  // requested declaration identity, supplied independently of the producer.
  readonly route?: "lexical";
  readonly requestedDeclarationRef?: string;
  readonly requestedModuleRef?: string;
  readonly stepId: string;
  readonly coverageContract: string;
  readonly workState: TsJsRequestAwareWorkState | null;
}

export interface TsJsRequestAwareAdmissionFamilyConfig {
  readonly familyRoot: string;
  readonly derivedOutputDir: string | null;
  readonly sourceGroup: string;
  readonly derivedSourceGroup: string;
  readonly partition: string;
  readonly acceptedFamily: string;
  readonly acceptedRequestRefs: readonly string[];
}

export interface TsJsRequestAwareAdmissionConfig {
  readonly schema: typeof TSJS_REQUEST_AWARE_ADMISSION_CONFIG_SCHEMA;
  readonly family: TsJsRequestAwareAdmissionFamilyConfig;
  readonly cases: readonly TsJsRequestAwareAdmissionCaseConfig[];
}

export interface TsJsRequestAwareAdmissionRejection {
  readonly code: TsJsRequestAwareAdmissionRejectionCode;
  readonly reasons: readonly string[];
}

export interface TsJsRequestAwareWorkStateSummary {
  readonly basis: string | null;
  readonly remainingObligationCount: number;
  readonly cursorState: string | null;
}

export interface TsJsRequestAwareAdmissionCaseReceipt {
  readonly caseId: string;
  readonly admitted: boolean;
  readonly requestRef: string;
  readonly stepId: string;
  readonly callSiteRef: string;
  readonly sourceReadRef: string;
  readonly pendingRelationRef: string;
  readonly coverageContract: string;
  readonly workState: TsJsRequestAwareWorkStateSummary | null;
  readonly admittedEvidenceRefs: readonly string[];
  readonly rejection: TsJsRequestAwareAdmissionRejection | null;
}

export interface TsJsRequestAwareDerivedOutput {
  readonly dir: string;
  readonly manifestPath: string;
  readonly studentObservationsPath: string;
  readonly admissionsPath: string;
  readonly consumerInputsPath: string;
  readonly recordCount: number;
  readonly admittedCaseIds: readonly string[];
}

export interface TsJsRequestAwareAdmissionReceipt {
  readonly schema: typeof TSJS_REQUEST_AWARE_ADMISSION_RECEIPT_SCHEMA;
  readonly family: TsJsRequestAwareAdmissionFamilyConfig;
  readonly cases: readonly TsJsRequestAwareAdmissionCaseReceipt[];
  readonly derivedOutput: TsJsRequestAwareDerivedOutput | null;
  readonly admitted: boolean;
}

export class TsJsRequestAwareAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TsJsRequestAwareAdmissionError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TsJsRequestAwareAdmissionError(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requireStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== "string" || entry.length === 0)) {
    throw new TsJsRequestAwareAdmissionError(`${field} must be an array of non-empty strings`);
  }
  return value as readonly string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function resolveFromConfig(configPath: string, declared: string): string {
  return isAbsolute(declared) ? declared : resolve(dirname(configPath), declared);
}

function parseWorkState(raw: unknown, label: string): TsJsRequestAwareWorkState | null {
  if (raw === undefined) return null;
  if (!isRecord(raw)) {
    throw new TsJsRequestAwareAdmissionError(`${label} must be an object`);
  }
  const obligations = raw.remainingObligations;
  if (!Array.isArray(obligations)) {
    throw new TsJsRequestAwareAdmissionError(`${label}.remainingObligations must be an array`);
  }
  const cursor = asRecord(raw.localCandidateCursor);
  if (cursor === null) {
    throw new TsJsRequestAwareAdmissionError(`${label}.localCandidateCursor must be an object`);
  }
  const state = cursor.state;
  if (state !== "closed" && state !== "open" && state !== "failed") {
    throw new TsJsRequestAwareAdmissionError(`${label}.localCandidateCursor.state is invalid`);
  }
  return Object.freeze({
    basis: requireString(raw.basis, `${label}.basis`),
    remainingObligations: Object.freeze(obligations) as RelationRemainingObligations,
    localCandidateCursor: Object.freeze({
      pendingRelationRef: requireString(cursor.pendingRelationRef, `${label}.localCandidateCursor.pendingRelationRef`),
      state,
      evidenceRefs: Object.freeze(
        cursor.evidenceRefs === undefined
          ? []
          : requireStringArray(cursor.evidenceRefs, `${label}.localCandidateCursor.evidenceRefs`),
      ),
    }),
  });
}

/**
 * Load a request-aware admission recipe/config. `family.familyRoot` and
 * `family.derivedOutputDir` are absolute or resolved relative to the config
 * file's directory.
 */
export async function loadTsJsRequestAwareAdmissionConfig(
  configPath: string,
): Promise<TsJsRequestAwareAdmissionConfig> {
  const resolvedPath = resolve(configPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolvedPath, "utf8")) as unknown;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    throw new TsJsRequestAwareAdmissionError(`cannot load config ${resolvedPath}: ${message}`);
  }
  if (!isRecord(parsed) || parsed.schema !== TSJS_REQUEST_AWARE_ADMISSION_CONFIG_SCHEMA) {
    throw new TsJsRequestAwareAdmissionError(
      `config ${resolvedPath} must declare schema ${TSJS_REQUEST_AWARE_ADMISSION_CONFIG_SCHEMA}`,
    );
  }
  const family = asRecord(parsed.family);
  if (family === null) {
    throw new TsJsRequestAwareAdmissionError(`config ${resolvedPath} must declare family`);
  }
  const declaredFamilyRoot = requireString(family.familyRoot, "family.familyRoot");
  const declaredDerivedDir = family.derivedOutputDir === undefined
    ? null
    : requireString(family.derivedOutputDir, "family.derivedOutputDir");
  const cases = parsed.cases;
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new TsJsRequestAwareAdmissionError(`config ${resolvedPath} must declare a non-empty cases[]`);
  }
  return Object.freeze({
    schema: TSJS_REQUEST_AWARE_ADMISSION_CONFIG_SCHEMA,
    family: Object.freeze({
      familyRoot: resolveFromConfig(resolvedPath, declaredFamilyRoot),
      derivedOutputDir: declaredDerivedDir === null
        ? null
        : resolveFromConfig(resolvedPath, declaredDerivedDir),
      sourceGroup: requireString(family.sourceGroup, "family.sourceGroup"),
      derivedSourceGroup: requireString(family.derivedSourceGroup, "family.derivedSourceGroup"),
      partition: requireString(family.partition, "family.partition"),
      acceptedFamily: requireString(family.acceptedFamily, "family.acceptedFamily"),
      acceptedRequestRefs: Object.freeze(
        requireStringArray(family.acceptedRequestRefs, "family.acceptedRequestRefs"),
      ),
    }),
    cases: Object.freeze(cases.map((raw, index) => parseCase(raw, resolvedPath, index))),
  });
}

function parseCase(
  raw: unknown,
  resolvedPath: string,
  index: number,
): TsJsRequestAwareAdmissionCaseConfig {
  if (!isRecord(raw)) {
    throw new TsJsRequestAwareAdmissionError(`config ${resolvedPath} cases[${index}] must be an object`);
  }
  const label = `config ${resolvedPath} cases[${index}]`;
  return Object.freeze({
    caseId: requireString(raw.caseId, `${label}.caseId`),
    entryFile: requireString(raw.entryFile, `${label}.entryFile`),
    files: Object.freeze(requireStringArray(raw.files, `${label}.files`)),
    requestRef: requireString(raw.requestRef, `${label}.requestRef`),
    pendingRelationRef: requireString(raw.pendingRelationRef, `${label}.pendingRelationRef`),
    callSiteRef: requireString(raw.callSiteRef, `${label}.callSiteRef`),
    sourceReadRef: requireString(raw.sourceReadRef, `${label}.sourceReadRef`),
    calleeName: requireString(raw.calleeName, `${label}.calleeName`),
    requestedMemberName: requireString(raw.requestedMemberName, `${label}.requestedMemberName`),
    requestedRole: requireString(raw.requestedRole, `${label}.requestedRole`),
    ...(raw.route === "lexical"
      ? {
          route: "lexical" as const,
          requestedDeclarationRef: requireString(
            raw.requestedDeclarationRef,
            `${label}.requestedDeclarationRef`,
          ),
          requestedModuleRef: requireString(
            raw.requestedModuleRef,
            `${label}.requestedModuleRef`,
          ),
        }
      : {}),
    stepId: requireString(raw.stepId, `${label}.stepId`),
    coverageContract: requireString(raw.coverageContract, `${label}.coverageContract`),
    workState: parseWorkState(raw.workState, `${label}.workState`),
  });
}

function workStateSummary(
  workState: TsJsRequestAwareWorkState | null | undefined,
): TsJsRequestAwareWorkStateSummary | null {
  if (workState === null || workState === undefined) return null;
  return Object.freeze({
    basis: workState.basis,
    remainingObligationCount: workState.remainingObligations.length,
    cursorState: workState.localCandidateCursor.state,
  });
}

function rejected(
  kase: TsJsRequestAwareAdmissionCaseConfig,
  code: TsJsRequestAwareAdmissionRejectionCode,
  reasons: readonly string[],
): TsJsRequestAwareAdmissionCaseReceipt {
  return Object.freeze({
    caseId: kase.caseId,
    admitted: false,
    requestRef: kase.requestRef,
    stepId: kase.stepId,
    callSiteRef: kase.callSiteRef,
    sourceReadRef: kase.sourceReadRef,
    pendingRelationRef: kase.pendingRelationRef,
    coverageContract: kase.coverageContract,
    workState: workStateSummary(kase.workState),
    admittedEvidenceRefs: Object.freeze([]),
    rejection: Object.freeze({ code, reasons: Object.freeze([...reasons]) }),
  });
}

function producerRequestFor(
  familyRoot: string,
  kase: TsJsRequestAwareAdmissionCaseConfig,
): TsJsSymbolTableRequest {
  return {
    repo: familyRoot,
    language: "typescript",
    scope: ["src"],
    files: [...kase.files],
  } as unknown as TsJsSymbolTableRequest;
}

async function loadAdmittedEpisodes(
  record: Record<string, unknown>,
): Promise<readonly RelationStepEpisode[]> {
  const familyDir = await mkdtempTmpFamily();
  try {
    await writeFile(
      join(familyDir, "manifest.json"),
      JSON.stringify({
        sourceGroup: record.sourceGroup,
        language: record.language,
        semanticStratum: record.semanticStratum,
        partition: record.partition,
        derivationFamily: { familyId: record.family },
      }),
    );
    await writeFile(
      join(familyDir, "student-observations.jsonl"),
      `${JSON.stringify(record)}\n`,
    );
    return await loadStepwiseEpisodeFamily(familyDir);
  } finally {
    await rm(familyDir, { recursive: true, force: true });
  }
}

async function mkdtempTmpFamily(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tsjs-request-aware-admission-"));
  await mkdir(dir, { recursive: true });
  return dir;
}

function completionAssessmentGapCodes(
  assessment: TsJsObservedDynamicCompletionAssessment,
): readonly string[] {
  return assessment.gaps.map(gap => gap.code);
}

function admittedEvidenceRefs(
  evidence: readonly TsJsInitialEvidenceRecord[],
): readonly string[] {
  return evidence
    .map(entry => optionalString((entry as { id?: unknown }).id))
    .filter((ref): ref is string => ref !== null);
}

function preservationOutcome(
  gaps: readonly string[],
): TsJsRequestAwareAdmissionRejectionCode | null {
  if (gaps.includes("work_state_open") || gaps.includes("enumeration_not_closed")) {
    return "work_state_open";
  }
  if (gaps.includes("requested_target_mapping_invalid")) {
    return "role_mismatch";
  }
  return null;
}

async function admitCase(
  family: TsJsRequestAwareAdmissionFamilyConfig,
  kase: TsJsRequestAwareAdmissionCaseConfig,
): Promise<{ readonly receipt: TsJsRequestAwareAdmissionCaseReceipt; readonly record: Record<string, unknown> | null }> {
  const workState = kase.workState ?? null;
  if (workState === null) {
    return {
      receipt: rejected(kase, "work_state_missing", [
        "recipe must carry explicit workState; missing state is not closed by default",
      ]),
      record: null,
    };
  }
  if (!family.acceptedRequestRefs.includes(kase.requestRef)) {
    return {
      receipt: rejected(kase, "request_not_accepted", [
        `request ${kase.requestRef} is not in the accepted request set for ${family.acceptedFamily}`,
      ]),
      record: null,
    };
  }
  const producerRequest = producerRequestFor(family.familyRoot, kase);
  const producer = await runTsJsSymbolTable(producerRequest);
  if (producer.status !== "ok") {
    return { receipt: rejected(kase, "producer_rejected", [producer.message]), record: null };
  }
  let requestedDeclaration: NonNullable<RelationStepEpisode["requestedDeclaration"]>;
  if (kase.route === "lexical") {
    const observations = producer.result.lexicalCallSiteBindings.filter(
      candidate => candidate.callSiteRef === kase.callSiteRef,
    );
    if (observations.length !== 1) {
      return {
        receipt: rejected(kase, "call_site_mismatch", [
          observations.length === 0
            ? `no lexical producer observation for observed call site ${kase.callSiteRef}`
            : `multiple lexical producer observations for observed call site ${kase.callSiteRef}`,
        ]),
        record: null,
      };
    }
    const lexical = observations[0]!;
    if (lexical.bindingKind === "unresolved") {
      return {
        receipt: rejected(kase, "role_mismatch", [
          `lexical producer reports ${lexical.unresolvedReason ?? "unresolved"} for ${kase.callSiteRef}`,
        ]),
        record: null,
      };
    }
    requestedDeclaration = {
      declarationRef: requireString(
        kase.requestedDeclarationRef,
        `${kase.caseId}.requestedDeclarationRef`,
      ),
      moduleRef: requireString(
        kase.requestedModuleRef,
        `${kase.caseId}.requestedModuleRef`,
      ),
      name: kase.requestedMemberName,
      role: kase.requestedRole as NonNullable<RelationStepEpisode["requestedDeclaration"]>["role"],
      kind: "function",
      evidenceRefs: [],
    };
  } else {
    const observation = producer.result.runtimeSelectorObservations.find(
      candidate => candidate.callSiteRef === kase.callSiteRef,
    );
    if (observation === undefined) {
      return {
        receipt: rejected(kase, "call_site_mismatch", [
          `no producer observation for call site ${kase.callSiteRef}`,
        ]),
        record: null,
      };
    }
    if (observation.sourceReadRef !== kase.sourceReadRef) {
      return {
        receipt: rejected(kase, "source_read_mismatch", [
          `observation source read ${observation.sourceReadRef} does not match ${kase.sourceReadRef}`,
        ]),
        record: null,
      };
    }
    const member = observation.callableTable?.members.find(
      candidate => candidate.name === kase.requestedMemberName,
    );
    const identity = member?.callableIdentity ?? null;
    if (member === undefined || identity === null) {
      return {
        receipt: rejected(kase, "requested_member_missing", [
          `no typed callable member ${kase.requestedMemberName} on call site ${kase.callSiteRef}`,
        ]),
        record: null,
      };
    }
    requestedDeclaration = {
      declarationRef: identity.declarationRef,
      moduleRef: `module:${identity.moduleRef}`,
      name: member.name,
      role: kase.requestedRole as NonNullable<RelationStepEpisode["requestedDeclaration"]>["role"],
      kind: "function",
      evidenceRefs: [],
    };
  }
  const bridge = await observeTsJsStepwiseRequest({
    sourceGroup: family.sourceGroup,
    language: "typescript",
    semanticStratum: "module_export",
    partition: family.partition,
    derivationFamily: family.acceptedFamily,
    sampleId: kase.caseId,
    entryFile: kase.entryFile,
    ...(kase.route === undefined ? {} : { route: kase.route }),
    request: {
      requestRef: kase.requestRef,
      requestedDeclaration,
      relationObligation: {
        requestRef: kase.requestRef,
        pendingRelationRef: kase.pendingRelationRef,
        callSiteRef: kase.callSiteRef,
        calleeName: kase.calleeName,
      },
    },
    stepId: kase.stepId,
    fromStepId: null,
    remainingObligations: workState.remainingObligations,
    localCandidateCursor: workState.localCandidateCursor,
    producerRequest,
  });
  if (bridge.record === null) {
    return {
      receipt: rejected(kase, "bridge_rejected", bridge.reasons.length > 0
        ? bridge.reasons
        : ["bridge returned no record"]),
      record: null,
    };
  }
  if (kase.route === "lexical") {
    const lexicalEpisodes = await loadAdmittedEpisodes(bridge.record);
    const lexicalStart = lexicalEpisodes[0];
    if (lexicalStart === undefined) {
      return {
        receipt: rejected(kase, "admission_rejected", ["stepwise family produced no episode"]),
        record: null,
      };
    }
    const lexicalContext = relationStepContext(lexicalStart);
    const judges = lexicalContext.candidateGroup.candidates.filter(candidate =>
      candidate.optionSemantics.startsWith("judge=")
    );
    const resolved = judges.map(candidate => candidate.bindingProjection)
      .filter(projection => projection !== null
        && projection.resolution.status === "resolved");
    if (judges.length !== 3 || resolved.length !== 3) {
      return {
        receipt: rejected(kase, "admission_rejected", [
          "lexical route did not produce three resolved judge-candidate projections",
        ]),
        record: null,
      };
    }
    return {
      receipt: Object.freeze({
        caseId: kase.caseId,
        admitted: true,
        requestRef: kase.requestRef,
        stepId: kase.stepId,
        callSiteRef: kase.callSiteRef,
        sourceReadRef: kase.sourceReadRef,
        pendingRelationRef: kase.pendingRelationRef,
        coverageContract: kase.coverageContract,
        workState: workStateSummary(kase.workState),
        admittedEvidenceRefs: Object.freeze([
          ...lexicalStart.evidenceRefs,
        ]),
        rejection: null,
      }),
      record: bridge.record,
    };
  }
  const steps = bridge.record.steps;
  const firstStep = Array.isArray(steps) ? asRecord(steps[0]) : null;
  const receipts = firstStep?.receipts;
  const firstReceipt = Array.isArray(receipts) ? asRecord(receipts[0]) : null;
  const producerSource = asRecord(firstReceipt?.producerSource);
  if (producerSource === null) {
    return { receipt: rejected(kase, "bridge_rejected", ["bridge record has no producerSource receipt"]), record: null };
  }
  if (optionalString(producerSource.requestRef) !== kase.requestRef) {
    return {
      receipt: rejected(kase, "request_mismatch", [
        `record request ${String(producerSource.requestRef)} does not match ${kase.requestRef}`,
      ]),
      record: null,
    };
  }
  if (optionalString(producerSource.stepId) !== kase.stepId) {
    return {
      receipt: rejected(kase, "step_mismatch", [
        `record step ${String(producerSource.stepId)} does not match ${kase.stepId}`,
      ]),
      record: null,
    };
  }
  if (optionalString(producerSource.pendingRelationRef) !== kase.pendingRelationRef) {
    return {
      receipt: rejected(kase, "pending_relation_mismatch", [
        `record pending relation ${String(producerSource.pendingRelationRef)} does not match ${kase.pendingRelationRef}`,
      ]),
      record: null,
    };
  }
  if (optionalString(producerSource.callSiteRef) !== kase.callSiteRef) {
    return {
      receipt: rejected(kase, "call_site_mismatch", [
        `record call site ${String(producerSource.callSiteRef)} does not match ${kase.callSiteRef}`,
      ]),
      record: null,
    };
  }
  const completionWork = asRecord(producerSource.completionWork);
  if (optionalString(completionWork?.contract) !== kase.coverageContract) {
    return {
      receipt: rejected(kase, "coverage_mismatch", [
        `completion contract ${String(completionWork?.contract)} does not match ${kase.coverageContract}`,
      ]),
      record: null,
    };
  }
  const episodes = await loadAdmittedEpisodes(bridge.record);
  const startEpisode = episodes[0];
  if (startEpisode === undefined) {
    return { receipt: rejected(kase, "admission_rejected", ["stepwise family produced no episode"]), record: null };
  }
  const admission = admitInitialEvidence(startEpisode.requestId, episodes);
  if (admission.invalidReasons.length > 0) {
    return { receipt: rejected(kase, "admission_rejected", admission.invalidReasons), record: null };
  }
  const assessment = assessTsJsObservedDynamicCompletion(
    episodes,
    {
      stepSequence: [startEpisode.stepId],
      context: relationStepContext(startEpisode),
      terminal: true,
      terminalKind: "judge",
      terminalJudgement: "judge=unknown",
    },
    admission.initialObservation?.evidence ?? [],
  );
  if (assessment.status !== "supported") {
    const gaps = completionAssessmentGapCodes(assessment);
    const preservation = preservationOutcome(gaps);
    return {
      receipt: rejected(kase, preservation ?? "coverage_mismatch", gaps.length > 0
        ? gaps
        : [`completion status ${assessment.status}`]),
      record: null,
    };
  }
  return {
    receipt: Object.freeze({
      caseId: kase.caseId,
      admitted: true,
      requestRef: kase.requestRef,
      stepId: kase.stepId,
      callSiteRef: kase.callSiteRef,
      sourceReadRef: kase.sourceReadRef,
      pendingRelationRef: kase.pendingRelationRef,
      coverageContract: kase.coverageContract,
      workState: workStateSummary(kase.workState),
      admittedEvidenceRefs: Object.freeze(admittedEvidenceRefs(admission.initialObservation?.evidence ?? [])),
      rejection: null,
    }),
    record: bridge.record,
  };
}

async function writeDerivedOutput(
  family: TsJsRequestAwareAdmissionFamilyConfig,
  records: readonly { readonly caseId: string; readonly record: Record<string, unknown> }[],
): Promise<TsJsRequestAwareDerivedOutput> {
  const dir = family.derivedOutputDir!;
  await mkdir(dir, { recursive: true });
  const manifestPath = join(dir, "manifest.json");
  const studentObservationsPath = join(dir, "student-observations.jsonl");
  const admissionsPath = join(dir, "familyAdmissions.json");
  const consumerInputsPath = join(dir, "consumer-inputs.json");
  await writeFile(manifestPath, `${JSON.stringify({
    sourceGroup: family.derivedSourceGroup,
    language: "typescript",
    semanticStratum: "module_export",
    partition: family.partition,
    derivationFamily: { familyId: family.acceptedFamily },
  }, null, 2)}\n`);
  await writeFile(
    studentObservationsPath,
    `${records.map(entry => JSON.stringify(entry.record)).join("\n")}\n`,
  );
  await writeFile(admissionsPath, `${JSON.stringify({
    schema: TSJS_REQUEST_AWARE_FAMILY_ADMISSIONS_SCHEMA,
    familyAdmissions: [{
      sourceGroup: family.derivedSourceGroup,
      partition: family.partition,
      usableForTrainingSupervision: false,
    }],
  }, null, 2)}\n`);
  await writeFile(consumerInputsPath, `${JSON.stringify({
    schema: TSJS_REQUEST_AWARE_CONSUMER_INPUTS_SCHEMA,
    consumerEntry: TSJS_STEPWISE_CONSUMER_ENTRY,
    devFamilyPath: dir,
    manifestPath,
    studentObservationsPath,
    admissionsPath,
    partition: family.partition,
    sourceGroup: family.derivedSourceGroup,
    sourceFamily: family.acceptedFamily,
    usableForTrainingSupervision: false,
  }, null, 2)}\n`);
  return Object.freeze({
    dir,
    manifestPath,
    studentObservationsPath,
    admissionsPath,
    consumerInputsPath,
    recordCount: records.length,
    admittedCaseIds: Object.freeze(records.map(entry => entry.caseId)),
  });
}

export async function runTsJsRequestAwareAdmission(
  config: TsJsRequestAwareAdmissionConfig,
): Promise<TsJsRequestAwareAdmissionReceipt> {
  const cases: TsJsRequestAwareAdmissionCaseReceipt[] = [];
  const records: { caseId: string; record: Record<string, unknown> }[] = [];
  for (const kase of config.cases) {
    const outcome = await admitCase(config.family, kase);
    cases.push(outcome.receipt);
    if (outcome.receipt.admitted && outcome.record !== null) {
      records.push({ caseId: kase.caseId, record: outcome.record });
    }
  }
  const admitted = cases.every(entry => entry.admitted);
  const derivedOutput = admitted && config.family.derivedOutputDir !== null
    ? await writeDerivedOutput(config.family, records)
    : null;
  return Object.freeze({
    schema: TSJS_REQUEST_AWARE_ADMISSION_RECEIPT_SCHEMA,
    family: config.family,
    cases: Object.freeze(cases),
    derivedOutput,
    admitted,
  });
}
