// B-A1 custody-gated seen-source diagnostic entry.
//
// This module resolves retained custody records and derives the complete
// projection before it can reach the model. It never accepts a live control
// callback or a caller-authored projection.

import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  BA1_REAL_SITE_DIAGNOSTIC_FAMILY,
  BA1_SEEN_SOURCE_DIAGNOSTIC_MODEL_TRAINING_EXPOSURE,
  persistBA1SeenSourceDiagnosticAccounting,
  type BA1SeenSourceDiagnosticAccountingResult,
  type BA1SeenSourceDiagnosticUnresolvedRow,
} from "./b-a1-seen-source-diagnostic-accounting.js";
import {
  projectBA1RealSiteEvaluationInput,
  type BA1RealSiteEvaluationProjection,
} from "./b-a1-real-site-evaluation.js";
import {
  SEARCH_INPUT_HOST_ROLE,
  validateSearchInputHostCandidate,
  validateSearchInputHostCoverage,
  type SearchInputHostCandidate,
  type SearchInputHostCoverage,
} from "./search-input-host-contract.js";
import type { BA1RealSiteProjectedObservation } from "./b-a1-real-site-browser-projection.js";
import {
  evaluateBA1Sample,
  type BA1EvaluationRow,
  type BA1EvaluationSummary,
  type BA1Identity,
} from "../../training/b-a1-evaluator.js";
import {
  validateBA1EvaluatorGold,
  type BA1EvaluatorGold,
} from "../../training/b-a1-sample-evaluator-skeleton.js";
import {
  loadUnifiedModelPackageFromFile,
} from "../../training/unified-model-package.js";

export const BA1_SEEN_SOURCE_DIAGNOSTIC_ENTRY_SCHEMA =
  "nnanything.b-a1.seen-source-diagnostic-entry.v1" as const;
export const BA1_REAL_SITE_SOURCE_SCHEMA = "nnanything.b-a1.real-site-source.v1" as const;
export const BA1_REAL_SITE_SUPERVISION_SCHEMA =
  "nnanything.b-a1.real-site-supervision.v1" as const;
export const BA1_REAL_SITE_CONTROL_SCOPE_OBSERVATION_SCHEMA =
  "nnanything.b-a1.real-site-control-scope-observation.v1" as const;

export interface BA1SeenSourceDiagnosticDescriptor {
  readonly sourceGroupId: string;
  readonly custodyRef: string;
  readonly sourceRef: string;
  readonly splitDecisionRef: string;
  readonly sourceRun: string;
  readonly controlScopeRef: string;
}

export interface BA1SeenSourceDiagnosticRequest {
  readonly packagePath: string;
  readonly diagnosticGold: BA1EvaluatorGold;
  readonly sampleId: string;
  readonly outputDir: string;
  readonly descriptor: BA1SeenSourceDiagnosticDescriptor;
}

export interface BA1SeenSourceDiagnosticResult {
  readonly schema: typeof BA1_SEEN_SOURCE_DIAGNOSTIC_ENTRY_SCHEMA;
  readonly exposureLabel: typeof BA1_REAL_SITE_DIAGNOSTIC_FAMILY;
  readonly modelTrainingExposure: typeof BA1_SEEN_SOURCE_DIAGNOSTIC_MODEL_TRAINING_EXPOSURE;
  readonly sourceGroupId: string;
  readonly projection: BA1RealSiteEvaluationProjection;
  readonly evaluation: ReturnType<typeof evaluateBA1Sample>;
  readonly evaluationRow: BA1EvaluationRow;
  readonly summary: BA1EvaluationSummary;
  readonly accounting: BA1SeenSourceDiagnosticAccountingResult["accounting"];
  readonly unresolvedRows: readonly BA1SeenSourceDiagnosticUnresolvedRow[];
  readonly artifacts: BA1SeenSourceDiagnosticAccountingResult["artifacts"];
}

interface ParsedRecordRef {
  readonly filePath: string;
  readonly selectorKey: string | null;
  readonly selectorValue: string | null;
}

interface ResolvedRecordRef {
  readonly record: Record<string, unknown>;
  readonly filePath: string;
  readonly selectorKey: string | null;
  readonly selectorValue: string | null;
}

interface ParsedControlRecord {
  readonly identity: BA1Identity;
  readonly generation: number;
  readonly scopeRef: string;
  readonly requestedRole: string;
  readonly candidates: readonly SearchInputHostCandidate[];
  readonly outsideScopeRefs: readonly string[];
  readonly coverage: SearchInputHostCoverage;
  readonly eligibleCandidateRefs: readonly string[];
}

interface ParsedCustodyRecord {
  readonly sourceGroupId: string;
  readonly goldValue: string;
  readonly observationBinding: {
    readonly sourceRun: string;
    readonly identity: BA1Identity;
    readonly generation: number;
    readonly candidateRef: string;
    readonly scopeRef: string;
    readonly projectionPhase: string;
    readonly requestedRole: string;
    readonly candidateFacts: readonly SearchInputHostCandidate[] | null;
    readonly outsideScopeRefs: readonly string[] | null;
    readonly coverage: SearchInputHostCoverage | null;
  };
  readonly splitDecisionRef: string;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer`);
  }
  return value;
}

function requireNonnegativeInteger(value: unknown, label: string): number {
  const parsed = requireInteger(value, label);
  if (parsed < 0) throw new TypeError(`${label} must be a nonnegative integer`);
  return parsed;
}

function requireStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return Object.freeze(value.map((entry, index) =>
    requireNonEmptyString(entry, `${label}[${index}]`)));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  const unknown = Object.keys(value).filter(key => !expected.has(key));
  const missing = keys.filter(key => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new TypeError(
      `${label} must contain exactly ${keys.join(", ")}`
      + (unknown.length > 0 ? `; unknown: ${unknown.join(", ")}` : "")
      + (missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""),
    );
  }
}

function parseIdentity(raw: unknown, label: string): BA1Identity {
  const identity = requireRecord(raw, label);
  exactKeys(identity, ["documentRef", "observationId", "revision"], label);
  return Object.freeze({
    documentRef: requireNonEmptyString(identity.documentRef, `${label}.documentRef`),
    observationId: requireNonEmptyString(identity.observationId, `${label}.observationId`),
    revision: requireInteger(identity.revision, `${label}.revision`),
  });
}

function sameIdentity(left: BA1Identity, right: BA1Identity): boolean {
  return left.documentRef === right.documentRef
    && left.observationId === right.observationId
    && left.revision === right.revision;
}

function parseRecordRef(rawRef: string, label: string): ParsedRecordRef {
  const ref = requireNonEmptyString(rawRef, label);
  const hashIndex = ref.indexOf("#");
  if (hashIndex <= 0 || hashIndex === ref.length - 1) {
    throw new TypeError(`${label} must be <path>#<field>=<value>`);
  }
  const filePath = ref.slice(0, hashIndex);
  const fragment = ref.slice(hashIndex + 1);
  const separator = fragment.indexOf("=");
  if (separator <= 0 || separator === fragment.length - 1) {
    throw new TypeError(`${label} fragment must be <field>=<value>`);
  }
  return {
    filePath,
    selectorKey: fragment.slice(0, separator),
    selectorValue: fragment.slice(separator + 1),
  };
}

function parsePlainPath(rawPath: string, label: string): string {
  const value = requireNonEmptyString(rawPath, label);
  if (value.includes("#")) throw new TypeError(`${label} must not contain a fragment`);
  return value;
}

function canonicalRecordRef(rawRef: string, label: string): string {
  const parsed = parseRecordRef(rawRef, label);
  return `${resolve(parsed.filePath)}#${parsed.selectorKey}=${parsed.selectorValue}`;
}

function canonicalPath(rawPath: string, label: string): string {
  return resolve(parsePlainPath(rawPath, label));
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new TypeError(`${label} must contain valid JSON`);
  }
}

function parseJsonLines(text: string, label: string): readonly unknown[] {
  return Object.freeze(text.split(/\r?\n/).flatMap((line, index) => {
    if (line.trim().length === 0) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      throw new TypeError(`${label} line ${index + 1} must contain valid JSON`);
    }
  }));
}

async function resolveRecordRef(rawRef: string, label: string): Promise<ResolvedRecordRef> {
  const parsed = parseRecordRef(rawRef, label);
  const filePath = resolve(parsed.filePath);
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    throw new TypeError(`${label} is unreadable: ${filePath}`);
  }
  const records = extname(filePath) === ".jsonl"
    ? parseJsonLines(text, label)
    : (() => {
        const parsedJson = parseJson(text, label);
        return Array.isArray(parsedJson) ? parsedJson : [parsedJson];
      })();
  const matches = records.filter(entry =>
    typeof entry === "object"
    && entry !== null
    && !Array.isArray(entry)
    && (
      (entry as Record<string, unknown>)[parsed.selectorKey!] === parsed.selectorValue
      || (
        parsed.selectorKey === "id"
        && (entry as Record<string, unknown>).recordId === parsed.selectorValue
      )
    ));
  if (matches.length !== 1) {
    throw new TypeError(
      `${label} must resolve exactly one record, found ${matches.length}`,
    );
  }
  return Object.freeze({
    record: matches[0] as Record<string, unknown>,
    filePath,
    selectorKey: parsed.selectorKey,
    selectorValue: parsed.selectorValue,
  });
}

async function resolveSourceRecordRef(
  rawRef: string,
  sourceGroupId: string,
): Promise<ResolvedRecordRef> {
  if (rawRef.includes("#")) return resolveRecordRef(rawRef, "descriptor.sourceRef");
  const filePath = resolve(parsePlainPath(rawRef, "descriptor.sourceRef"));
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    throw new TypeError(`descriptor.sourceRef is unreadable: ${filePath}`);
  }
  const value = parseJson(text, "descriptor.sourceRef");
  const records = Array.isArray(value) ? value : [value];
  const matches = records.filter(entry =>
    typeof entry === "object"
    && entry !== null
    && !Array.isArray(entry)
    && (entry as Record<string, unknown>).sourceGroupId === sourceGroupId);
  if (matches.length !== 1) {
    throw new TypeError(
      `descriptor.sourceRef must resolve exactly one sourceGroupId ${sourceGroupId}, found ${matches.length}`,
    );
  }
  return Object.freeze({
    record: matches[0] as Record<string, unknown>,
    filePath,
    selectorKey: "sourceGroupId",
    selectorValue: sourceGroupId,
  });
}

async function resolvePlainJson(rawRef: string, label: string): Promise<Record<string, unknown>> {
  const filePath = canonicalPath(rawRef, label);
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    throw new TypeError(`${label} is unreadable: ${filePath}`);
  }
  const value = parseJson(text, label);
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new TypeError(`${label} must contain exactly one object`);
    return requireRecord(value[0], label);
  }
  return requireRecord(value, label);
}

function parseControlRecord(raw: unknown, expectedPhase: string): ParsedControlRecord {
  const record = requireRecord(raw, "control-scope record");
  if (record.schema !== BA1_REAL_SITE_CONTROL_SCOPE_OBSERVATION_SCHEMA) {
    throw new TypeError("control-scope record schema is invalid");
  }
  if (record.phase !== expectedPhase) {
    throw new TypeError("control-scope record phase does not match custody");
  }
  if (record.recordType !== "projection") {
    throw new TypeError("control-scope record must be a projection record");
  }
  if (record.error !== null && record.error !== undefined) {
    throw new TypeError("control-scope record must not contain an observation error");
  }

  const identity = parseIdentity(record.projectionIdentity, "control-scope record.projectionIdentity");
  const operationControl = requireRecord(
    record.operationControl,
    "control-scope record.operationControl",
  );
  const operationIdentity = parseIdentity(
    operationControl.identity,
    "control-scope record.operationControl.identity",
  );
  const generation = requireNonnegativeInteger(
    operationControl.generation,
    "control-scope record.operationControl.generation",
  );
  if (!sameIdentity(identity, operationIdentity)) {
    throw new TypeError("control-scope operation identity must match projectionIdentity");
  }

  const scopeRef = requireNonEmptyString(record.scopeRef, "control-scope record.scopeRef");
  const requestedRole = requireNonEmptyString(
    record.requestedRole,
    "control-scope record.requestedRole",
  );
  if (requestedRole !== SEARCH_INPUT_HOST_ROLE) {
    throw new TypeError(`control-scope requestedRole must be ${SEARCH_INPUT_HOST_ROLE}`);
  }
  if (!Array.isArray(record.candidateFacts)) {
    throw new TypeError("control-scope record.candidateFacts must be an array");
  }
  const candidates = Object.freeze(record.candidateFacts.map((candidate, index) =>
    validateSearchInputHostCandidate(
      candidate,
      `control-scope record.candidateFacts[${index}]`,
    )));
  if (record.candidateCount !== undefined) {
    const candidateCount = requireNonnegativeInteger(
      record.candidateCount,
      "control-scope record.candidateCount",
    );
    if (candidateCount !== candidates.length) {
      throw new TypeError("control-scope candidateCount must equal candidateFacts length");
    }
  }
  const candidateRefs = new Set<string>();
  for (const candidate of candidates) {
    if (candidateRefs.has(candidate.ref)) {
      throw new TypeError(`control-scope candidate ref ${candidate.ref} appears twice`);
    }
    candidateRefs.add(candidate.ref);
    if (candidate.scopeRef !== scopeRef || !sameIdentity(candidate, identity)) {
      throw new TypeError("control-scope candidate facts must match projectionIdentity and scopeRef");
    }
  }

  const outsideScopeRefs = requireStringArray(
    record.outsideScopeRefs,
    "control-scope record.outsideScopeRefs",
  );
  for (const ref of outsideScopeRefs) {
    if (!candidateRefs.has(ref)) {
      throw new TypeError(`control-scope outsideScopeRefs contains unknown ref ${ref}`);
    }
  }

  const coverage = validateSearchInputHostCoverage(record.coverage);
  if (coverage.scopeRef !== scopeRef || coverage.observedCandidateCount !== candidates.length) {
    throw new TypeError("control-scope coverage must match scopeRef and candidateFacts");
  }

  const eligibleCandidateCount = requireNonnegativeInteger(
    record.eligibleCandidateCount,
    "control-scope record.eligibleCandidateCount",
  );
  const eligibleCandidateRefs = requireStringArray(
    record.eligibleCandidateRefs,
    "control-scope record.eligibleCandidateRefs",
  );
  if (eligibleCandidateCount !== 1 || eligibleCandidateRefs.length !== 1) {
    throw new TypeError("control-scope record must have exactly one eligible candidate");
  }
  const eligibleCandidateRef = eligibleCandidateRefs[0]!;
  if (!candidateRefs.has(eligibleCandidateRef) || outsideScopeRefs.includes(eligibleCandidateRef)) {
    throw new TypeError("control-scope eligible candidate must be one in-scope candidate fact");
  }

  return Object.freeze({
    identity,
    generation,
    scopeRef,
    requestedRole,
    candidates,
    outsideScopeRefs,
    coverage,
    eligibleCandidateRefs,
  });
}

function parseCustodyRecord(raw: unknown): ParsedCustodyRecord {
  const record = requireRecord(raw, "custody record");
  if (record.schema !== BA1_REAL_SITE_SUPERVISION_SCHEMA) {
    throw new TypeError("custody record schema is invalid");
  }
  if (record.reviewStatus !== "approved") {
    throw new TypeError("custody reviewStatus must be approved");
  }
  if (record.approvedGold !== true) {
    throw new TypeError("custody approvedGold must be true");
  }
  if (record.approvalStatus !== "approved") {
    throw new TypeError("custody approvalStatus must be approved");
  }
  const approvalEvidence = requireStringArray(
    record.approvalEvidence,
    "custody record.approvalEvidence",
  );
  if (approvalEvidence.length === 0) {
    throw new TypeError("custody approvalEvidence must be non-empty");
  }

  const binding = requireRecord(record.observationBinding, "custody record.observationBinding");
  const requestedRole = binding.requestedRole === undefined
    ? requireNonEmptyString(
        binding.bindingRole,
        "custody record.observationBinding.bindingRole",
      )
    : requireNonEmptyString(
        binding.requestedRole,
        "custody record.observationBinding.requestedRole",
      );
  if (
    binding.requestedRole !== undefined
    && binding.bindingRole !== undefined
    && binding.requestedRole !== binding.bindingRole
  ) {
    throw new TypeError("custody observationBinding requestedRole must equal bindingRole");
  }
  const candidateFacts = binding.candidateFacts === undefined
    ? null
    : (() => {
        if (!Array.isArray(binding.candidateFacts)) {
          throw new TypeError("custody observationBinding.candidateFacts must be an array");
        }
        return Object.freeze(binding.candidateFacts.map((candidate, index) =>
          validateSearchInputHostCandidate(
            candidate,
            `custody record.observationBinding.candidateFacts[${index}]`,
          )));
      })();
  const outsideScopeRefs = binding.outsideScopeRefs === undefined
    ? null
    : requireStringArray(
        binding.outsideScopeRefs,
        "custody record.observationBinding.outsideScopeRefs",
      );
  const coverage = binding.coverage === undefined
    ? null
    : validateSearchInputHostCoverage(binding.coverage);
  return Object.freeze({
    sourceGroupId: requireNonEmptyString(
      record.sourceGroupId,
      "custody record.sourceGroupId",
    ),
    goldValue: requireNonEmptyString(record.goldValue, "custody record.goldValue"),
    observationBinding: Object.freeze({
      sourceRun: requireNonEmptyString(
        binding.sourceRun,
        "custody record.observationBinding.sourceRun",
      ),
      identity: parseIdentity(
        {
          documentRef: binding.documentRef,
          observationId: binding.observationId,
          revision: binding.revision,
        },
        "custody record.observationBinding.identity",
      ),
      generation: requireNonnegativeInteger(
        binding.generation,
        "custody record.observationBinding.generation",
      ),
      candidateRef: requireNonEmptyString(
        binding.candidateRef,
        "custody record.observationBinding.candidateRef",
      ),
      scopeRef: requireNonEmptyString(
        binding.scopeRef,
        "custody record.observationBinding.scopeRef",
      ),
      projectionPhase: requireNonEmptyString(
        binding.projectionPhase,
        "custody record.observationBinding.projectionPhase",
      ),
      requestedRole,
      candidateFacts,
      outsideScopeRefs,
      coverage,
    }),
    splitDecisionRef: requireNonEmptyString(
      record.splitDecisionRef,
      "custody record.splitDecisionRef",
    ),
  });
}

function parseSourceRecord(raw: unknown): {
  readonly sourceGroupId: string;
  readonly splitDecisionRef: string;
} {
  const record = requireRecord(raw, "source record");
  if (record.schema !== BA1_REAL_SITE_SOURCE_SCHEMA) {
    throw new TypeError("source record schema is invalid");
  }
  return Object.freeze({
    sourceGroupId: requireNonEmptyString(record.sourceGroupId, "source record.sourceGroupId"),
    splitDecisionRef: requireNonEmptyString(
      record.splitDecisionRef,
      "source record.splitDecisionRef",
    ),
  });
}

function parseSplitDecision(raw: unknown): {
  readonly sourceGroupId: string;
  readonly exposureLabel: string;
} {
  const record = requireRecord(raw, "split decision");
  return Object.freeze({
    sourceGroupId: requireNonEmptyString(
      record.sourceGroupId,
      "split decision.sourceGroupId",
    ),
    exposureLabel: requireNonEmptyString(record.decision, "split decision.decision"),
  });
}

function assertControlMatchesCustody(
  control: ParsedControlRecord,
  custody: ParsedCustodyRecord,
): SearchInputHostCandidate {
  const binding = custody.observationBinding;
  if (!sameIdentity(control.identity, binding.identity)) {
    throw new TypeError("control-scope identity does not match accepted custody binding");
  }
  if (control.generation !== binding.generation) {
    throw new TypeError("control-scope generation does not match accepted custody binding");
  }
  if (control.scopeRef !== binding.scopeRef) {
    throw new TypeError("control-scope scopeRef does not match accepted custody binding");
  }
  if (control.requestedRole !== binding.requestedRole) {
    throw new TypeError("control-scope requestedRole does not match accepted custody binding");
  }
  if (
    control.eligibleCandidateRefs.length !== 1
    || control.eligibleCandidateRefs[0] !== binding.candidateRef
  ) {
    throw new TypeError("control-scope eligibleCandidateRefs do not match accepted custody binding");
  }
  const candidate = control.candidates.find(entry => entry.ref === binding.candidateRef);
  if (candidate === undefined) {
    throw new TypeError("control-scope candidateFacts do not contain accepted custody candidateRef");
  }
  if (candidate.scopeRef !== binding.scopeRef || !sameIdentity(candidate, binding.identity)) {
    throw new TypeError("control-scope candidateFacts do not match accepted custody binding");
  }
  if (control.coverage.scopeRef !== binding.scopeRef) {
    throw new TypeError("control-scope coverage does not match accepted custody binding");
  }
  if (binding.candidateFacts !== null && !isDeepStrictEqual(control.candidates, binding.candidateFacts)) {
    throw new TypeError("control-scope candidateFacts do not match accepted custody snapshot");
  }
  if (
    binding.outsideScopeRefs !== null
    && !isDeepStrictEqual(control.outsideScopeRefs, binding.outsideScopeRefs)
  ) {
    throw new TypeError("control-scope outsideScopeRefs do not match accepted custody snapshot");
  }
  if (binding.coverage !== null && !isDeepStrictEqual(control.coverage, binding.coverage)) {
    throw new TypeError("control-scope coverage does not match accepted custody snapshot");
  }
  return candidate;
}

function assertDiagnosticGold(
  gold: BA1EvaluatorGold,
  custody: ParsedCustodyRecord,
  sourceGroupId: string,
): void {
  validateBA1EvaluatorGold(gold);
  if (gold.family !== BA1_REAL_SITE_DIAGNOSTIC_FAMILY) {
    throw new TypeError(`diagnosticGold.family must be ${BA1_REAL_SITE_DIAGNOSTIC_FAMILY}`);
  }
  if (gold.kind !== "bound" || gold.state !== "selected") {
    throw new TypeError("diagnosticGold must be bound selected");
  }
  if (gold.selectedRef !== custody.goldValue) {
    throw new TypeError("diagnosticGold.selectedRef must equal accepted custody goldValue");
  }
  if (gold.group !== sourceGroupId) {
    throw new TypeError("diagnosticGold.group must equal descriptor.sourceGroupId");
  }
}

/**
 * Run one offline seen-source diagnostic sample through the retained custody
 * chain. The function has no live-control input and persists only after all
 * custody, split, and gold checks pass.
 */
export async function runBA1SeenSourceDiagnosticAccounting(
  rawRequest: BA1SeenSourceDiagnosticRequest,
): Promise<BA1SeenSourceDiagnosticResult> {
  const request = requireRecord(rawRequest, "request");
  exactKeys(
    request,
    ["packagePath", "diagnosticGold", "sampleId", "outputDir", "descriptor"],
    "request",
  );
  const descriptor = requireRecord(request.descriptor, "descriptor");
  exactKeys(
    descriptor,
    ["sourceGroupId", "custodyRef", "sourceRef", "splitDecisionRef", "sourceRun", "controlScopeRef"],
    "descriptor",
  );
  const packagePath = resolve(requireNonEmptyString(request.packagePath, "packagePath"));
  const sampleId = requireNonEmptyString(request.sampleId, "sampleId");
  const outputDir = resolve(requireNonEmptyString(request.outputDir, "outputDir"));
  const sourceGroupId = requireNonEmptyString(
    descriptor.sourceGroupId,
    "descriptor.sourceGroupId",
  );
  const sourceRun = canonicalPath(
    requireNonEmptyString(descriptor.sourceRun, "descriptor.sourceRun"),
    "descriptor.sourceRun",
  );

  const custodyResolved = await resolveRecordRef(
    requireNonEmptyString(descriptor.custodyRef, "descriptor.custodyRef"),
    "descriptor.custodyRef",
  );
  const custody = parseCustodyRecord(custodyResolved.record);
  if (custody.sourceGroupId !== sourceGroupId) {
    throw new TypeError("custody sourceGroupId must equal descriptor.sourceGroupId");
  }
  if (canonicalPath(
    custody.observationBinding.sourceRun,
    "custody observationBinding.sourceRun",
  ) !== sourceRun) {
    throw new TypeError("descriptor.sourceRun must equal custody observationBinding.sourceRun");
  }

  const sourceResolved = await resolveSourceRecordRef(
    requireNonEmptyString(descriptor.sourceRef, "descriptor.sourceRef"),
    sourceGroupId,
  );
  const source = parseSourceRecord(sourceResolved.record);
  if (source.sourceGroupId !== sourceGroupId) {
    throw new TypeError("source sourceGroupId must equal descriptor.sourceGroupId");
  }
  if (canonicalPath(
    source.splitDecisionRef,
    "source record.splitDecisionRef",
  ) !== canonicalPath(
    requireNonEmptyString(descriptor.splitDecisionRef, "descriptor.splitDecisionRef"),
    "descriptor.splitDecisionRef",
  )) {
    throw new TypeError("descriptor.splitDecisionRef must equal source record.splitDecisionRef");
  }
  if (canonicalPath(
    custody.splitDecisionRef,
    "custody record.splitDecisionRef",
  ) !== canonicalPath(
    requireNonEmptyString(descriptor.splitDecisionRef, "descriptor.splitDecisionRef"),
    "descriptor.splitDecisionRef",
  )) {
    throw new TypeError("descriptor.splitDecisionRef must equal custody record.splitDecisionRef");
  }

  const splitDecision = parseSplitDecision(
    await resolvePlainJson(
      requireNonEmptyString(descriptor.splitDecisionRef, "descriptor.splitDecisionRef"),
      "descriptor.splitDecisionRef",
    ),
  );
  if (splitDecision.sourceGroupId !== sourceGroupId) {
    throw new TypeError("split decision sourceGroupId must equal descriptor.sourceGroupId");
  }
  if (splitDecision.exposureLabel !== BA1_REAL_SITE_DIAGNOSTIC_FAMILY) {
    throw new TypeError(
      `split decision is not admitted: ${splitDecision.exposureLabel}`,
    );
  }

  const expectedControlScopeRef =
    `${resolve(sourceRun, "control-scope-observations.jsonl")}#phase=${custody.observationBinding.projectionPhase}`;
  if (canonicalRecordRef(
    requireNonEmptyString(descriptor.controlScopeRef, "descriptor.controlScopeRef"),
    "descriptor.controlScopeRef",
  ) !== canonicalRecordRef(expectedControlScopeRef, "expected controlScopeRef")) {
    throw new TypeError("descriptor.controlScopeRef must belong to descriptor.sourceRun and custody projectionPhase");
  }

  const control = parseControlRecord(
    (await resolveRecordRef(
      requireNonEmptyString(descriptor.controlScopeRef, "descriptor.controlScopeRef"),
      "descriptor.controlScopeRef",
    )).record,
    custody.observationBinding.projectionPhase,
  );
  assertControlMatchesCustody(control, custody);

  const diagnosticGold = request.diagnosticGold as BA1EvaluatorGold;
  assertDiagnosticGold(diagnosticGold, custody, sourceGroupId);

  const observation: BA1RealSiteProjectedObservation = Object.freeze({
    identity: control.identity,
    scopeRef: control.scopeRef,
    requestedRole: control.requestedRole,
    candidates: control.candidates,
    outsideScopeRefs: control.outsideScopeRefs,
    coverage: control.coverage,
  });
  const loaded = await loadUnifiedModelPackageFromFile(packagePath);
  const projection = projectBA1RealSiteEvaluationInput({
    observation,
    modelPackage: loaded.package,
    currentControl: control.identity,
  });
  const evaluationRow: BA1EvaluationRow = {
    sampleId,
    sampleKind: "model-semantic",
    family: BA1_REAL_SITE_DIAGNOSTIC_FAMILY,
    group: sourceGroupId,
    gold: diagnosticGold,
    output: projection.output,
    allowedScopeRef: projection.allowedScopeRef,
    candidates: projection.candidates,
    coverage: projection.coverage,
    currentControl: projection.currentControl,
    evidenceRecords: projection.evidenceRecords,
  };
  const evaluation = evaluateBA1Sample(evaluationRow);
  const accounting = await persistBA1SeenSourceDiagnosticAccounting({
    outputDir,
    evaluationRows: [evaluationRow],
    unresolvedRows: [],
  });

  return Object.freeze({
    schema: BA1_SEEN_SOURCE_DIAGNOSTIC_ENTRY_SCHEMA,
    exposureLabel: BA1_REAL_SITE_DIAGNOSTIC_FAMILY,
    modelTrainingExposure: BA1_SEEN_SOURCE_DIAGNOSTIC_MODEL_TRAINING_EXPOSURE,
    sourceGroupId,
    projection,
    evaluation,
    evaluationRow,
    summary: accounting.summary,
    accounting: accounting.accounting,
    unresolvedRows: accounting.unresolvedRows,
    artifacts: accounting.artifacts,
  });
}
