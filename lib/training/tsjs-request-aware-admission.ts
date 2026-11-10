// Request-aware admission for an accepted TS/JS source family.
//
// This module binds accepted producer observations to a declared request, step,
// call site, pending relation and observed-source completion contract through
// the existing bridge, then records the admitted initial evidence. It is
// read-only with respect to source families: it runs the public producer,
// bridge and admission entries and rejects any request that does not match the
// accepted evidence. It does not fit, score, adopt, train, or rewrite sources.

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { runTsJsSymbolTable } from "../adapters/cli/tsjs-symbol-table-adapter.js";
import {
  admitInitialEvidence,
  assessTsJsObservedDynamicCompletion,
  type TsJsObservedDynamicCompletionAssessment,
} from "../adapters/tsjs-unified-recursive.js";
import type { TsJsSymbolTableRequest } from "../filters/tsjs-symbol-table-policy.js";
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
export const TSJS_OBSERVED_SOURCE_CLOSURE_CONTRACT =
  "tsjs.observed-dynamic-source-closure.v1" as const;

export type TsJsRequestAwareAdmissionRejectionCode =
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
  | "admission_rejected";

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
  readonly stepId: string;
  readonly coverageContract: string;
}

export interface TsJsRequestAwareAdmissionFamilyConfig {
  readonly familyRoot: string;
  readonly sourceGroup: string;
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

export interface TsJsRequestAwareAdmissionCaseReceipt {
  readonly caseId: string;
  readonly admitted: boolean;
  readonly requestRef: string;
  readonly stepId: string;
  readonly callSiteRef: string;
  readonly sourceReadRef: string;
  readonly pendingRelationRef: string;
  readonly coverageContract: string;
  readonly admittedEvidenceRefs: readonly string[];
  readonly rejection: TsJsRequestAwareAdmissionRejection | null;
}

export interface TsJsRequestAwareAdmissionReceipt {
  readonly schema: typeof TSJS_REQUEST_AWARE_ADMISSION_RECEIPT_SCHEMA;
  readonly family: TsJsRequestAwareAdmissionFamilyConfig;
  readonly cases: readonly TsJsRequestAwareAdmissionCaseReceipt[];
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

function requireStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== "string" || entry.length === 0)) {
    throw new TsJsRequestAwareAdmissionError(`${field} must be an array of non-empty strings`);
  }
  return value as readonly string[];
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/**
 * Load a request-aware admission recipe/config. `family.familyRoot` is an
 * absolute path or is resolved relative to the config file's directory.
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
  const resolvedFamilyRoot = isAbsolute(declaredFamilyRoot)
    ? declaredFamilyRoot
    : resolve(dirname(resolvedPath), declaredFamilyRoot);
  const cases = parsed.cases;
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new TsJsRequestAwareAdmissionError(`config ${resolvedPath} must declare a non-empty cases[]`);
  }
  return Object.freeze({
    schema: TSJS_REQUEST_AWARE_ADMISSION_CONFIG_SCHEMA,
    family: Object.freeze({
      familyRoot: resolvedFamilyRoot,
      sourceGroup: requireString(family.sourceGroup, "family.sourceGroup"),
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
    stepId: requireString(raw.stepId, `${label}.stepId`),
    coverageContract: requireString(raw.coverageContract, `${label}.coverageContract`),
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
    admittedEvidenceRefs: Object.freeze([]),
    rejection: Object.freeze({ code, reasons: Object.freeze([...reasons]) }),
  });
}

function admitted(
  kase: TsJsRequestAwareAdmissionCaseConfig,
  evidenceRefs: readonly string[],
): TsJsRequestAwareAdmissionCaseReceipt {
  return Object.freeze({
    caseId: kase.caseId,
    admitted: true,
    requestRef: kase.requestRef,
    stepId: kase.stepId,
    callSiteRef: kase.callSiteRef,
    sourceReadRef: kase.sourceReadRef,
    pendingRelationRef: kase.pendingRelationRef,
    coverageContract: kase.coverageContract,
    admittedEvidenceRefs: Object.freeze([...evidenceRefs]),
    rejection: null,
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
  const familyDir = await mkdtemp(join(tmpdir(), "tsjs-request-aware-admission-"));
  try {
    await mkdir(familyDir, { recursive: true });
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

function completionAssessmentGapCodes(
  assessment: TsJsObservedDynamicCompletionAssessment,
): readonly string[] {
  return assessment.gaps.map(gap => gap.code);
}

async function admitCase(
  family: TsJsRequestAwareAdmissionFamilyConfig,
  kase: TsJsRequestAwareAdmissionCaseConfig,
): Promise<TsJsRequestAwareAdmissionCaseReceipt> {
  if (!family.acceptedRequestRefs.includes(kase.requestRef)) {
    return rejected(kase, "request_not_accepted", [
      `request ${kase.requestRef} is not in the accepted request set for ${family.acceptedFamily}`,
    ]);
  }
  const producerRequest = producerRequestFor(family.familyRoot, kase);
  const producer = await runTsJsSymbolTable(producerRequest);
  if (producer.status !== "ok") {
    return rejected(kase, "producer_rejected", [producer.message]);
  }
  const observation = producer.result.runtimeSelectorObservations.find(
    candidate => candidate.callSiteRef === kase.callSiteRef,
  );
  if (observation === undefined) {
    return rejected(kase, "call_site_mismatch", [
      `no producer observation for call site ${kase.callSiteRef}`,
    ]);
  }
  if (observation.sourceReadRef !== kase.sourceReadRef) {
    return rejected(kase, "source_read_mismatch", [
      `observation source read ${observation.sourceReadRef} does not match ${kase.sourceReadRef}`,
    ]);
  }
  const member = observation.callableTable?.members.find(
    candidate => candidate.name === kase.requestedMemberName,
  );
  const identity = member?.callableIdentity ?? null;
  if (member === undefined || identity === null) {
    return rejected(kase, "requested_member_missing", [
      `no typed callable member ${kase.requestedMemberName} on call site ${kase.callSiteRef}`,
    ]);
  }
  const bridge = await observeTsJsStepwiseRequest({
    sourceGroup: family.sourceGroup,
    language: "typescript",
    semanticStratum: "module_export",
    partition: family.partition,
    derivationFamily: family.acceptedFamily,
    sampleId: kase.caseId,
    entryFile: kase.entryFile,
    request: {
      requestRef: kase.requestRef,
      requestedDeclaration: {
        declarationRef: identity.declarationRef,
        moduleRef: `module:${identity.moduleRef}`,
        name: member.name,
        role: kase.requestedRole as NonNullable<RelationStepEpisode["requestedDeclaration"]>["role"],
        kind: "function",
        evidenceRefs: [],
      },
      relationObligation: {
        requestRef: kase.requestRef,
        pendingRelationRef: kase.pendingRelationRef,
        callSiteRef: kase.callSiteRef,
        calleeName: kase.calleeName,
      },
    },
    stepId: kase.stepId,
    fromStepId: null,
    remainingObligations: [],
    localCandidateCursor: {
      pendingRelationRef: kase.pendingRelationRef,
      state: "closed",
      evidenceRefs: [],
    },
    producerRequest,
  });
  if (bridge.record === null) {
    return rejected(kase, "bridge_rejected", bridge.reasons.length > 0
      ? bridge.reasons
      : ["bridge returned no record"]);
  }
  const steps = bridge.record.steps;
  const firstStep = Array.isArray(steps) ? asRecord(steps[0]) : null;
  const receipts = firstStep?.receipts;
  const firstReceipt = Array.isArray(receipts) ? asRecord(receipts[0]) : null;
  const producerSource = asRecord(firstReceipt?.producerSource);
  if (producerSource === null) {
    return rejected(kase, "bridge_rejected", ["bridge record has no producerSource receipt"]);
  }
  if (optionalString(producerSource.requestRef) !== kase.requestRef) {
    return rejected(kase, "request_mismatch", [
      `record request ${String(producerSource.requestRef)} does not match ${kase.requestRef}`,
    ]);
  }
  if (optionalString(producerSource.stepId) !== kase.stepId) {
    return rejected(kase, "step_mismatch", [
      `record step ${String(producerSource.stepId)} does not match ${kase.stepId}`,
    ]);
  }
  if (optionalString(producerSource.pendingRelationRef) !== kase.pendingRelationRef) {
    return rejected(kase, "pending_relation_mismatch", [
      `record pending relation ${String(producerSource.pendingRelationRef)} does not match ${kase.pendingRelationRef}`,
    ]);
  }
  if (optionalString(producerSource.callSiteRef) !== kase.callSiteRef) {
    return rejected(kase, "call_site_mismatch", [
      `record call site ${String(producerSource.callSiteRef)} does not match ${kase.callSiteRef}`,
    ]);
  }
  const completionWork = asRecord(producerSource.completionWork);
  if (optionalString(completionWork?.contract) !== kase.coverageContract) {
    return rejected(kase, "coverage_mismatch", [
      `completion contract ${String(completionWork?.contract)} does not match ${kase.coverageContract}`,
    ]);
  }
  const episodes = await loadAdmittedEpisodes(bridge.record);
  const startEpisode = episodes[0];
  if (startEpisode === undefined) {
    return rejected(kase, "admission_rejected", ["stepwise family produced no episode"]);
  }
  const admission = admitInitialEvidence(startEpisode.requestId, episodes);
  if (admission.invalidReasons.length > 0) {
    return rejected(kase, "admission_rejected", admission.invalidReasons);
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
    const code: TsJsRequestAwareAdmissionRejectionCode = gaps.includes("requested_target_mapping_invalid")
      ? "role_mismatch"
      : "coverage_mismatch";
    return rejected(kase, code, gaps.length > 0 ? gaps : [`completion status ${assessment.status}`]);
  }
  const evidenceRefs = (admission.initialObservation?.evidence ?? [])
    .map(entry => optionalString((entry as { id?: unknown }).id))
    .filter((ref): ref is string => ref !== null);
  return admitted(kase, evidenceRefs);
}

export async function runTsJsRequestAwareAdmission(
  config: TsJsRequestAwareAdmissionConfig,
): Promise<TsJsRequestAwareAdmissionReceipt> {
  const cases: TsJsRequestAwareAdmissionCaseReceipt[] = [];
  for (const kase of config.cases) {
    cases.push(await admitCase(config.family, kase));
  }
  return Object.freeze({
    schema: TSJS_REQUEST_AWARE_ADMISSION_RECEIPT_SCHEMA,
    family: config.family,
    cases: Object.freeze(cases),
    admitted: cases.every(entry => entry.admitted),
  });
}
