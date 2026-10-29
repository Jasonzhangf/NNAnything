import { posix } from "node:path";
import type { EntryKind, ObservedObjectRef, PathRef } from "../adapters/cli/entry-inspection.js";
import { expectRecord } from "../core/schema.js";

/**
 * P3 B-2/B-3 candidate-entry relation unit: a four-parameter linear model over
 * [1, name_equal, type_equal, parent_equal].
 *
 * This module is pure inference. It reads no filesystem, builds no shell text,
 * and never issues an ObservedObjectRef. The three exact comparisons only build
 * the four input wires; the numeric profile alone decides match/no-match. A
 * missing comparison stays null and is never coerced to 0.
 */

export const ENTRY_SELECT_WIRES = Object.freeze([
  "bias",
  "name_equal",
  "type_equal",
  "parent_equal",
] as const);

export type EntrySelectWire = (typeof ENTRY_SELECT_WIRES)[number];
export type EntrySelectFeatures = readonly [1, 0 | 1, 0 | 1, 0 | 1];

export type EntrySelectTargetType = "directory" | "regular";

export type EntrySelectProfileContract =
  | "cli.directory-select-relation.v1"
  | "cli.file-select-relation.v1";

export type EntrySelectProfile = Readonly<{
  contract: EntrySelectProfileContract;
  targetType: EntrySelectTargetType;
  wires: readonly ["bias", "name_equal", "type_equal", "parent_equal"];
  weights: readonly [number, number, number, number];
  threshold: number;
  calibration: "uncalibrated";
  adoption: "not_applied";
}>;

export type EntrySelectRef = ObservedObjectRef | PathRef | string;

/**
 * One observed directory entry offered to the relation unit. Raw observations
 * are kept as observed: "file" is the legacy M0 alias for "regular", while
 * "unknown" and null are missing measurements.
 */
export type ObservedCandidateInput = Readonly<{
  ref: EntrySelectRef;
  path: string;
  name: string | null;
  type: EntryKind | "file" | "unknown" | null;
  parent: string | null;
}>;

export type EntrySelectSelector = Readonly<{
  name: string;
  type: EntrySelectTargetType;
  parent: string;
}>;

export type EntrySelectRelation = "matches_selector" | "does_not_match_selector";

export type EntrySelectCandidatePrediction = Readonly<{
  ref: EntrySelectRef;
  status: "judged" | "unknown";
  features: EntrySelectFeatures | null;
  logit: number | null;
  score: number | null;
  relation: EntrySelectRelation | null;
}>;

export type EntrySelectSetOutcome =
  | "selected"
  | "not_found"
  | "insufficient_evidence"
  | "invalid_input"
  | "conflict";

export type EntrySelectSetReason =
  | "unique_match"
  | "not_found"
  | "coverage_partial"
  | "unknown_comparison"
  | "duplicate_ref"
  | "duplicate_entity"
  | "path_mismatch"
  | "multiple_matches_in_single_parent";

export type EntrySelectSetResolution = Readonly<{
  outcome: EntrySelectSetOutcome;
  status: "achieved" | "unmet" | "unknown" | "rejected";
  satisfaction: 100 | 0 | null;
  ref: EntrySelectRef | null;
  reason: EntrySelectSetReason;
  predictions: readonly EntrySelectCandidatePrediction[];
}>;

const ENTRY_KIND_VALUES: readonly string[] = Object.freeze([
  "regular",
  "directory",
  "symlink",
  "character_device",
  "block_device",
  "fifo",
  "socket",
  "other",
]);

const CANDIDATE_TYPE_VALUES: readonly string[] = Object.freeze([
  ...ENTRY_KIND_VALUES,
  "file",
  "unknown",
]);

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function selectorName(value: unknown, label: string): string {
  const name = nonEmptyString(value, label);
  if (name.includes("\0") || name.includes("/") || name === "." || name === "..") {
    throw new TypeError(`${label} must be a single path segment without NUL`);
  }
  return name;
}

function absoluteParent(value: unknown, label: string): string {
  const parent = nonEmptyString(value, label);
  if (parent.includes("\0") || !posix.isAbsolute(parent)) {
    throw new TypeError(`${label} must be an absolute POSIX path without NUL`);
  }
  return parent;
}

function isEntrySelectRef(value: unknown): value is EntrySelectRef {
  if (typeof value === "string") return value.length > 0;
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && typeof (value as { readonly kind?: unknown }).kind === "string";
}

function validateCandidateType(value: unknown, label: string): ObservedCandidateInput["type"] {
  if (value === null) return null;
  if (typeof value !== "string" || !CANDIDATE_TYPE_VALUES.includes(value)) {
    throw new TypeError(`${label} must be a registered entry type, file, unknown or null`);
  }
  return value as ObservedCandidateInput["type"];
}

export function validateEntrySelectSelector(value: unknown): EntrySelectSelector {
  const selector = expectRecord(value, "Entry select selector");
  exactKeys(selector, ["name", "type", "parent"], "Entry select selector");
  const type = selector.type;
  if (type !== "regular" && type !== "directory") {
    throw new TypeError("Entry select selector type must be regular or directory");
  }
  return Object.freeze({
    name: selectorName(selector.name, "Entry select selector name"),
    type,
    parent: absoluteParent(selector.parent, "Entry select selector parent"),
  });
}

export function zeroEntrySelectProfile(
  targetType: EntrySelectTargetType,
  threshold = 0.5,
): EntrySelectProfile {
  if (targetType !== "directory" && targetType !== "regular") {
    throw new TypeError("Entry select profile targetType must be directory or regular");
  }
  const validatedThreshold = finiteNumber(threshold, "Entry select profile threshold");
  if (!(validatedThreshold > 0 && validatedThreshold < 1)) {
    throw new TypeError("Entry select profile threshold must be strictly between 0 and 1");
  }
  return Object.freeze({
    contract: targetType === "directory"
      ? "cli.directory-select-relation.v1"
      : "cli.file-select-relation.v1",
    targetType,
    wires: Object.freeze([...ENTRY_SELECT_WIRES] as ["bias", "name_equal", "type_equal", "parent_equal"]),
    weights: Object.freeze([0, 0, 0, 0] as [number, number, number, number]),
    threshold: validatedThreshold,
    calibration: "uncalibrated" as const,
    adoption: "not_applied" as const,
  });
}

export function validateEntrySelectProfile(value: unknown): EntrySelectProfile {
  const profile = expectRecord(value, "Entry select profile");
  exactKeys(
    profile,
    ["contract", "targetType", "wires", "weights", "threshold", "calibration", "adoption"],
    "Entry select profile",
  );

  const contractValue = profile.contract;
  if (contractValue !== "cli.directory-select-relation.v1"
    && contractValue !== "cli.file-select-relation.v1") {
    throw new TypeError(
      "Entry select profile contract must be cli.directory-select-relation.v1 or cli.file-select-relation.v1",
    );
  }
  const contract: EntrySelectProfileContract = contractValue;

  const targetTypeValue = profile.targetType;
  if (targetTypeValue !== "directory" && targetTypeValue !== "regular") {
    throw new TypeError("Entry select profile targetType must be directory or regular");
  }
  const targetType: EntrySelectTargetType = targetTypeValue;
  const expectedTarget: EntrySelectTargetType = contract === "cli.directory-select-relation.v1"
    ? "directory"
    : "regular";
  if (targetType !== expectedTarget) {
    throw new TypeError(`Entry select profile ${contract} requires targetType ${expectedTarget}`);
  }

  const wires = profile.wires;
  if (!Array.isArray(wires)
    || wires.length !== ENTRY_SELECT_WIRES.length
    || wires.some((wire, index) => wire !== ENTRY_SELECT_WIRES[index])) {
    throw new TypeError("Entry select profile wires must be [bias, name_equal, type_equal, parent_equal]");
  }

  const rawWeights = profile.weights;
  if (!Array.isArray(rawWeights) || rawWeights.length !== 4) {
    throw new TypeError("Entry select profile weights must contain four values");
  }
  const weights = rawWeights.map((weight, index) =>
    finiteNumber(weight, `Entry select profile weight ${index}`)) as [number, number, number, number];

  const threshold = finiteNumber(profile.threshold, "Entry select profile threshold");
  if (!(threshold > 0 && threshold < 1)) {
    throw new TypeError("Entry select profile threshold must be strictly between 0 and 1");
  }
  if (profile.calibration !== "uncalibrated") {
    throw new TypeError("Entry select profile calibration must be uncalibrated");
  }
  if (profile.adoption !== "not_applied") {
    throw new TypeError("Entry select profile adoption must be not_applied");
  }

  return Object.freeze({
    contract,
    targetType,
    wires: Object.freeze([...ENTRY_SELECT_WIRES] as ["bias", "name_equal", "type_equal", "parent_equal"]),
    weights: Object.freeze([...weights] as [number, number, number, number]),
    threshold,
    calibration: "uncalibrated" as const,
    adoption: "not_applied" as const,
  });
}

export function validateObservedCandidateInput(value: unknown): ObservedCandidateInput {
  const candidate = expectRecord(value, "Entry select candidate");
  exactKeys(candidate, ["ref", "path", "name", "type", "parent"], "Entry select candidate");

  const ref = candidate.ref;
  if (!isEntrySelectRef(ref)) {
    throw new TypeError("Entry select candidate ref must be a non-empty string or an object reference");
  }

  const path = nonEmptyString(candidate.path, "Entry select candidate path");
  if (path.includes("\0")) throw new TypeError("Entry select candidate path must not contain NUL");

  const name = candidate.name === null
    ? null
    : nonEmptyString(candidate.name, "Entry select candidate name");
  const parent = candidate.parent === null
    ? null
    : nonEmptyString(candidate.parent, "Entry select candidate parent");
  const type = validateCandidateType(candidate.type, "Entry select candidate type");

  return Object.freeze({ ref, path, name, type, parent });
}

function typeComparison(
  candidateType: ObservedCandidateInput["type"],
  targetType: EntrySelectTargetType,
): 0 | 1 | null {
  if (candidateType === null || candidateType === "unknown") return null;
  const normalized: EntryKind = candidateType === "file" ? "regular" : candidateType;
  return normalized === targetType ? 1 : 0;
}

function featuresOf(
  selector: EntrySelectSelector,
  candidate: ObservedCandidateInput,
): EntrySelectFeatures | null {
  const nameEqual = candidate.name === null
    ? null
    : candidate.name === selector.name ? 1 : 0;
  const typeEqual = typeComparison(candidate.type, selector.type);
  const parentEqual = candidate.parent === null
    ? null
    : candidate.parent === selector.parent ? 1 : 0;
  if (nameEqual === null || typeEqual === null || parentEqual === null) return null;
  return Object.freeze([1, nameEqual, typeEqual, parentEqual] as const);
}

export function entrySelectFeatures(
  selector: EntrySelectSelector,
  candidate: ObservedCandidateInput,
): EntrySelectFeatures | null {
  return featuresOf(validateEntrySelectSelector(selector), validateObservedCandidateInput(candidate));
}

export function entrySelectSigmoid(logit: number): number {
  const z = finiteNumber(logit, "Entry select logit");
  if (z >= 0) {
    const exponential = Math.exp(-z);
    return 1 / (1 + exponential);
  }
  const exponential = Math.exp(z);
  return exponential / (1 + exponential);
}

function assertProfileMatchesSelector(
  profile: EntrySelectProfile,
  selector: EntrySelectSelector,
): void {
  if (profile.targetType !== selector.type) {
    throw new TypeError(
      `Entry select profile ${profile.contract} has targetType ${profile.targetType} but selector type is ${selector.type}`,
    );
  }
}

function predictValidated(
  selector: EntrySelectSelector,
  candidate: ObservedCandidateInput,
  profile: EntrySelectProfile,
): EntrySelectCandidatePrediction {
  const features = featuresOf(selector, candidate);
  if (features === null) {
    return Object.freeze({
      ref: candidate.ref,
      status: "unknown" as const,
      features: null,
      logit: null,
      score: null,
      relation: null,
    });
  }
  const [bias, nameWeight, typeWeight, parentWeight] = profile.weights;
  const logit = bias
    + nameWeight * features[1]
    + typeWeight * features[2]
    + parentWeight * features[3];
  const score = entrySelectSigmoid(logit);
  return Object.freeze({
    ref: candidate.ref,
    status: "judged" as const,
    features,
    logit,
    score,
    relation: score >= profile.threshold ? "matches_selector" as const : "does_not_match_selector" as const,
  });
}

export function predictEntrySelectRelation(
  selector: EntrySelectSelector,
  candidate: ObservedCandidateInput,
  profile: EntrySelectProfile,
): EntrySelectCandidatePrediction {
  const validatedSelector = validateEntrySelectSelector(selector);
  const validatedProfile = validateEntrySelectProfile(profile);
  assertProfileMatchesSelector(validatedProfile, validatedSelector);
  return predictValidated(
    validatedSelector,
    validateObservedCandidateInput(candidate),
    validatedProfile,
  );
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalValue(record[key])}`)
      .join(",")}}`;
  }
  return `${typeof value}:${String(value)}`;
}

function refKey(ref: EntrySelectRef): string {
  return typeof ref === "string" ? `string:${ref}` : `object:${canonicalValue(ref)}`;
}

function detectContradiction(
  candidates: readonly ObservedCandidateInput[],
): "duplicate_ref" | "duplicate_entity" | "path_mismatch" | null {
  const refs = new Set<string>();
  for (const candidate of candidates) {
    const key = refKey(candidate.ref);
    if (refs.has(key)) return "duplicate_ref";
    refs.add(key);
  }

  const entities = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.parent === null || candidate.name === null) continue;
    const key = `${candidate.parent}\u0000${candidate.name}`;
    if (entities.has(key)) return "duplicate_entity";
    entities.add(key);
  }

  for (const candidate of candidates) {
    if (candidate.parent === null || candidate.name === null) continue;
    if (candidate.path !== posix.join(candidate.parent, candidate.name)) return "path_mismatch";
  }

  return null;
}

function selectedResolution(
  ref: EntrySelectRef,
  predictions: readonly EntrySelectCandidatePrediction[],
): EntrySelectSetResolution {
  return Object.freeze({
    outcome: "selected" as const,
    status: "achieved" as const,
    satisfaction: 100 as const,
    ref,
    reason: "unique_match" as const,
    predictions,
  });
}

function notFoundResolution(
  predictions: readonly EntrySelectCandidatePrediction[],
): EntrySelectSetResolution {
  return Object.freeze({
    outcome: "not_found" as const,
    status: "unmet" as const,
    satisfaction: 0 as const,
    ref: null,
    reason: "not_found" as const,
    predictions,
  });
}

function insufficientEvidenceResolution(
  reason: "coverage_partial" | "unknown_comparison",
  predictions: readonly EntrySelectCandidatePrediction[],
): EntrySelectSetResolution {
  return Object.freeze({
    outcome: "insufficient_evidence" as const,
    status: "unknown" as const,
    satisfaction: null,
    ref: null,
    reason,
    predictions,
  });
}

function invalidInputResolution(
  reason: "duplicate_ref" | "duplicate_entity" | "path_mismatch",
): EntrySelectSetResolution {
  return Object.freeze({
    outcome: "invalid_input" as const,
    status: "rejected" as const,
    satisfaction: 0 as const,
    ref: null,
    reason,
    predictions: Object.freeze([]),
  });
}

function conflictResolution(
  predictions: readonly EntrySelectCandidatePrediction[],
): EntrySelectSetResolution {
  return Object.freeze({
    outcome: "conflict" as const,
    status: "unknown" as const,
    satisfaction: null,
    ref: null,
    reason: "multiple_matches_in_single_parent" as const,
    predictions,
  });
}

export function resolveEntrySelectSet(
  selector: EntrySelectSelector,
  candidates: readonly ObservedCandidateInput[],
  coverage: "complete" | "partial",
  profile: EntrySelectProfile,
): EntrySelectSetResolution {
  const validatedSelector = validateEntrySelectSelector(selector);
  const validatedProfile = validateEntrySelectProfile(profile);
  assertProfileMatchesSelector(validatedProfile, validatedSelector);
  if (coverage !== "complete" && coverage !== "partial") {
    throw new TypeError("Entry select coverage must be complete or partial");
  }
  if (!Array.isArray(candidates)) {
    throw new TypeError("Entry select candidates must be an array");
  }
  const validatedCandidates = candidates.map((candidate, index) => {
    try {
      return validateObservedCandidateInput(candidate);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TypeError(`Entry select candidates[${index}]: ${message}`);
    }
  });

  const contradiction = detectContradiction(validatedCandidates);
  if (contradiction !== null) return invalidInputResolution(contradiction);

  const predictions = Object.freeze(validatedCandidates.map(candidate =>
    predictValidated(validatedSelector, candidate, validatedProfile)));

  if (coverage === "partial") {
    return insufficientEvidenceResolution("coverage_partial", predictions);
  }
  if (predictions.some(prediction => prediction.status !== "judged")) {
    return insufficientEvidenceResolution("unknown_comparison", predictions);
  }

  const matches = predictions.filter(prediction => prediction.relation === "matches_selector");
  if (matches.length === 0) return notFoundResolution(predictions);
  if (matches.length > 1) return conflictResolution(predictions);
  return selectedResolution(matches[0]!.ref, predictions);
}
