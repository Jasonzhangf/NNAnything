// B-A1 M1 phase 2: search-input-host binder contract.
//
// The numeric unit learns exactly one number per candidate: roleMatch in [-1, 1].
// Everything that decides the four-state outcome is deterministic guard code:
// applicability, missing-measurement detection, coverage, access gating,
// currentness and threshold/uniqueness aggregation.
//
// Feature inputs are restricted to the design table (host type, editability,
// visibility, explicit tabindex, structure, bounded text-cue facts). No raw
// text, site name, account name, class, id, absolute URL or absolute geometry
// is read by this module.

import { expectFiniteNumber, expectNonEmptyString, expectRecord } from "../../core/schema.js";
import type { ExplicitTabIndexKind } from "../../filters/basic-kinds.js";

export const SEARCH_INPUT_HOST_ROLE = "search-input-host";
export const SEARCH_INPUT_HOST_CONTRACT = "browser.search-input-host.v1";

export type SearchInputHostState = "selected" | "none" | "ambiguous" | "insufficient_observation";
export type SearchInputHostRejection =
  | "unsupported_requested_role"
  | "invalid_current_control"
  | "unassessed_scope_content"
  | "unverified_coverage"
  | "candidate_outside_scope"
  | "stale_candidate"
  | "unmeasured_candidate_fields"
  | "access_unknown"
  // The member was enabled and its verdict names a different revision than the
  // live request. It is never ignored to fall back to `none`.
  | "usage_relation_stale"
  // The member was enabled but its evidence does not name this candidate, so the
  // verdict belongs to another object and cannot speak for this one.
  | "usage_relation_unbound"
  // The member was enabled and its verdict conflicts with the non-search cue:
  // a query-action or double-support conflict means the host is not non-search.
  | "usage_relation_conflict"
  // The member was enabled but abstained or found no relation. That is missing
  // relation evidence, not a proof of non-search, so `none` is not justified.
  | "usage_relation_unresolved";

/**
 * θ is a deterministic hyperparameter: 开发集选定后冻结 (selected on the
 * development set, then frozen for this milestone). Do not retune it against
 * validation or held-out cases.
 */
export const SEARCH_INPUT_HOST_THRESHOLD = 0.5;

export const SEARCH_INPUT_HOST_STATES: readonly SearchInputHostState[] = Object.freeze([
  "selected",
  "none",
  "ambiguous",
  "insufficient_observation",
]);

export type SearchInputHostHost = "input" | "textarea" | "contenteditable";
const SEARCH_INPUT_HOST_HOSTS: readonly SearchInputHostHost[] = Object.freeze(["input", "textarea", "contenteditable"]);

export type SearchInputHostType = "text" | "search" | "tel" | "email" | "url" | "number" | "other";
const SEARCH_INPUT_HOST_TYPES: readonly SearchInputHostType[] = Object.freeze([
  "text", "search", "tel", "email", "url", "number", "other",
]);

export type SearchInputHostDepthBand = "shallow" | "middle" | "deep";
const SEARCH_INPUT_HOST_DEPTH_BANDS: readonly SearchInputHostDepthBand[] = Object.freeze([
  "shallow", "middle", "deep",
]);

export type SearchInputHostTextLenBand = 0 | 1 | 2;
export type SearchInputHostTabIndexKind = ExplicitTabIndexKind;
export type SearchInputHostAccess = "available" | "login_required" | "challenge" | "unknown";

/**
 * One measured candidate. A measurement set to null means "not measured": the
 * guard must return insufficient_observation and must never read null as false.
 * The identity triple (documentRef/observationId/revision) is structural and
 * therefore required; a candidate that cannot identify its observation is
 * malformed rather than unmeasured.
 */
export interface SearchInputHostCandidate {
  readonly ref: string;
  readonly scopeRef: string;
  readonly documentRef: string;
  readonly observationId: string;
  readonly revision: number;
  readonly host: SearchInputHostHost | null;
  readonly type: SearchInputHostType | null;
  readonly contentEditable: boolean | null;
  readonly editable: boolean | null;
  readonly disabled: boolean | null;
  readonly readOnly: boolean | null;
  readonly cssHidden: boolean | null;
  readonly intersectsViewport: boolean | null;
  readonly explicitTabIndexKind: SearchInputHostTabIndexKind | null;
  readonly tabIndexFocus: boolean | null;
  readonly inForm: boolean | null;
  readonly formRoleSearch: boolean | null;
  readonly nearbySubmit: boolean | null;
  readonly depthBand: SearchInputHostDepthBand | null;
  readonly hasLabel: boolean | null;
  readonly hasPlaceholder: boolean | null;
  readonly hasAria: boolean | null;
  readonly markerHit: boolean | null;
  readonly nonSearchMarker: boolean | null;
  readonly textLenBand: SearchInputHostTextLenBand | null;
  readonly access: SearchInputHostAccess | null;
  /**
   * Support scores of the usage-relation member for the same control, in
   * (-1, 1), or null when the member abstained. Null is "no relation evidence",
   * never a zero score: a real neutral score and a missing one must not be
   * confused, because the binder's exclusion rule reads them differently.
   */
  readonly usageQuerySupport?: number | null;
  readonly usageFieldSupport?: number | null;
  /**
   * Typed relation verdict of the usage-relation member for this same control,
   * passed through explicitly by the production composition entry.
   *
   * This is a structured pass-through of `UsageRelationInference`, not a second
   * classifier: state and reason are the member's own four-state result, and
   * observedRevision/evidenceRefs carry their provenance so the binder can prove
   * the verdict belongs to this object at this revision. Absent means the member
   * was never enabled for this call; the binder must not treat an absent verdict
   * like a stale one.
   */
  readonly memberVerdict?: SearchInputHostMemberVerdict;
}

/** Structured, provenance-carrying copy of the member's typed verdict. */
export interface SearchInputHostMemberVerdict {
  readonly state: "query_action" | "field_description" | "ambiguous" | "unmeasured";
  readonly reason: "conflicting_support" | "unsupported_relation" | null;
  readonly observedRevision: number;
  readonly evidenceRefs: readonly string[];
}

/** A candidate after the deterministic missing-measurement guard. */
export interface MeasuredSearchInputHostCandidate extends SearchInputHostCandidate {
  readonly host: SearchInputHostHost;
  readonly type: SearchInputHostType;
  readonly contentEditable: boolean;
  readonly editable: boolean;
  readonly disabled: boolean;
  readonly readOnly: boolean;
  readonly cssHidden: boolean;
  readonly intersectsViewport: boolean;
  readonly explicitTabIndexKind: SearchInputHostTabIndexKind;
  readonly tabIndexFocus: boolean;
  readonly inForm: boolean;
  readonly formRoleSearch: boolean;
  readonly nearbySubmit: boolean;
  readonly depthBand: SearchInputHostDepthBand;
  readonly hasLabel: boolean;
  readonly hasPlaceholder: boolean;
  readonly hasAria: boolean;
  readonly markerHit: boolean;
  readonly nonSearchMarker: boolean;
  readonly textLenBand: SearchInputHostTextLenBand;
  readonly access: SearchInputHostAccess;
}

export interface SearchInputHostGoal {
  readonly requestedRole: string;
  readonly allowedScopeRef: string;
}

/**
 * Coverage facts projected from the production LiveCaptureCoverage. The
 * declared candidate count is a self-consistency check only; it is never
 * accepted as proof that the scope was fully observed. Unread iframe, object
 * and open shadow-root counts are the coverage proof.
 */
export interface SearchInputHostCoverage {
  readonly scopeRef: string;
  readonly observedCandidateCount: number;
  readonly unassessedIframeCount: number;
  readonly unassessedObjectCount: number;
  readonly unassessedOpenShadowRootCount: number;
  readonly excluded: readonly string[];
}

export interface SearchInputHostControl {
  readonly documentRef: string;
  readonly observationId: string;
  readonly revision: number;
}

export interface SearchInputHostInferInput {
  readonly goal: SearchInputHostGoal;
  readonly candidates: readonly SearchInputHostCandidate[];
  readonly coverage: SearchInputHostCoverage;
  readonly currentControl: SearchInputHostControl;
}

export interface SearchInputHostResult {
  readonly state: SearchInputHostState;
  readonly selectedRef: string | null;
  readonly evidenceRefs: readonly string[];
  readonly observedRevision: number | null;
  readonly rejection?: SearchInputHostRejection;
}

export interface SearchInputHostScoredCandidate {
  readonly ref: string;
  readonly roleMatch: number;
}

/**
 * Wire order for the single learned scalar. Every entry is one of the features
 * in the design table; there is no bias wire, so a candidate with no measured
 * cue scores exactly zero and falls below θ instead of drifting to a default.
 */
export const SEARCH_INPUT_HOST_WIRES = Object.freeze([
  "type.text",
  "type.search",
  "type.tel",
  "type.email",
  "type.url",
  "type.number",
  "type.other",
  "contentEditable",
  "tag.input",
  "tag.textarea",
  "editable",
  "disabled",
  "readOnly",
  "cssHidden",
  "intersectsViewport",
  "explicitTabIndex.negative",
  "explicitTabIndex.nonnegative",
  "explicitTabIndex.absent",
  "explicitTabIndex.invalid",
  "tabIndexFocus",
  "inForm",
  "formRoleSearch",
  "nearbySubmit",
  "depth.shallow",
  "depth.middle",
  "depth.deep",
  "hasLabel",
  "hasPlaceholder",
  "hasAria",
  "markerHit",
  "nonSearchMarker",
  "textLenBand.empty",
  "textLenBand.short",
  "textLenBand.long",
  // Relation-member support scores, appended by ruling 1 (2026-10-24). These
  // are the two real `infer` outputs of `browser.search-input-usage-relation.v1`
  // and carry no execution permission: a high score is evidence, not consent.
  "usage.query_support",
  "usage.field_support",
] as const);

export type SearchInputHostWire = (typeof SEARCH_INPUT_HOST_WIRES)[number];

/**
 * Wires appended after the delivered 34. These are the only wires a delivered
 * profile may lack, so they are the only ones migration is allowed to pad with
 * zero. Keeping the list explicit stops a future wire from being silently
 * zero-filled when an old profile is loaded.
 */
export const SEARCH_INPUT_HOST_APPENDED_WIRES = Object.freeze([
  "usage.query_support",
  "usage.field_support",
] as const);

export interface SearchInputHostProfile {
  readonly contract: typeof SEARCH_INPUT_HOST_CONTRACT;
  readonly role: typeof SEARCH_INPUT_HOST_ROLE;
  readonly wires: readonly string[];
  readonly weights: readonly number[];
  readonly threshold: number;
  readonly calibration: "uncalibrated";
  readonly adoption: "not_applied";
}

/**
 * Reject unknown keys and missing required ones.
 *
 * `optional` names keys that may be present but need not be. They exist for
 * fields added after the delivered shape, so an older record stays valid while
 * a typo or an unlisted field is still rejected.
 */
function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const allowed = new Set<string>([...keys, ...optional]);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  const missing = keys.filter(key => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`
      + (optional.length > 0 ? ` (optional: ${optional.join(", ")})` : "")
      + (unknown.length > 0 ? `; unknown: ${unknown.join(", ")}` : "")
      + (missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""));
  }
}

function nonEmpty(value: unknown, label: string): string {
  return expectNonEmptyString(value, label);
}

/**
 * A member support score is a tanh output, so it lives in (-1, 1). Null means the
 * member abstained, which is not the same fact as a neutral score of zero.
 */
function nullableSupport(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number or null`);
  }
  if (value <= -1 || value >= 1) {
    throw new TypeError(`${label} must lie strictly inside (-1, 1)`);
  }
  return value;
}

function nullableBoolean(value: unknown, label: string): boolean | null {
  if (value === null) return null;
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean or null`);
  return value;
}

function nullableEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T | null {
  if (value === null) return null;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new TypeError(`${label} must be null or one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function nullableTextLenBand(value: unknown, label: string): SearchInputHostTextLenBand | null {
  if (value === null) return null;
  if (value !== 0 && value !== 1 && value !== 2) throw new TypeError(`${label} must be null, 0, 1 or 2`);
  return value;
}

function count(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative integer`);
  }
  return value;
}

const CANDIDATE_KEYS = [
  "ref", "scopeRef", "documentRef", "observationId", "revision",
  "host", "type", "contentEditable", "editable", "disabled", "readOnly",
  "cssHidden", "intersectsViewport", "explicitTabIndexKind", "tabIndexFocus",
  "inForm", "formRoleSearch", "nearbySubmit", "depthBand",
  "hasLabel", "hasPlaceholder", "hasAria", "markerHit", "nonSearchMarker",
  "textLenBand", "access",
] as const;

/** Added after the delivered shape, so they stay optional on old records. */
const CANDIDATE_OPTIONAL_KEYS = ["usageQuerySupport", "usageFieldSupport", "memberVerdict"] as const;

const MEMBER_VERDICT_STATES = ["query_action", "field_description", "ambiguous", "unmeasured"] as const;
const MEMBER_VERDICT_REASONS = ["conflicting_support", "unsupported_relation"] as const;

/**
 * Validate the structured member verdict and bind it to its provenance.
 *
 * This is structure and origin checking, not a second opinion on the member:
 * the state must be one of the four relation states, the reason must be the
 * member's own reason (null exactly when the member reported null), the revision
 * must be a real integer, and the evidence must name at least one ref. Nothing
 * here re-derives the relation or trusts a caller-declared verdict as authority;
 * the binder still re-checks revision/object identity against the live request.
 */
function memberVerdict(value: unknown, label: string): SearchInputHostMemberVerdict {
  const raw = expectRecord(value, label);
  exactKeys(raw, ["state", "reason", "observedRevision", "evidenceRefs"], label);
  const state = nullableEnum(raw.state, MEMBER_VERDICT_STATES, `${label}.state`);
  if (state === null) throw new TypeError(`${label}.state must be one of ${MEMBER_VERDICT_STATES.join(", ")}`);
  const reason = raw.reason === null
    ? null
    : nullableEnum(raw.reason, MEMBER_VERDICT_REASONS, `${label}.reason`);
  // The member's own four-state table fixes which reasons each state may carry
  // (`inferUsageRelation` returns reason=null for the two decisive states and
  // one of the two conflict reasons for ambiguous). A mismatch is a malformed
  // verdict, not a new state, so it fails here instead of being reinterpreted.
  const reasonsAllowed = state === "ambiguous"
    ? MEMBER_VERDICT_REASONS
    : [null] as const;
  if (!(reasonsAllowed as readonly (string | null)[]).includes(reason)) {
    throw new TypeError(`${label}.reason must be one of ${reasonsAllowed.join(", ")} for state ${state}`);
  }
  const observedRevision = expectFiniteNumber(raw.observedRevision, `${label}.observedRevision`);
  if (!Number.isInteger(observedRevision)) throw new TypeError(`${label}.observedRevision must be an integer`);
  if (!Array.isArray(raw.evidenceRefs) || raw.evidenceRefs.length === 0) {
    throw new TypeError(`${label}.evidenceRefs must be a non-empty array`);
  }
  const evidenceRefs = Object.freeze(raw.evidenceRefs.map((entry, index) =>
    expectNonEmptyString(entry, `${label}.evidenceRefs[${index}]`)));
  return Object.freeze({ state, reason, observedRevision, evidenceRefs });
}

export function validateSearchInputHostCandidate(value: unknown, label = "search input host candidate"): SearchInputHostCandidate {
  const candidate = expectRecord(value, label);
  exactKeys(candidate, CANDIDATE_KEYS, label, CANDIDATE_OPTIONAL_KEYS);
  const revision = expectFiniteNumber(candidate.revision, `${label}.revision`);
  if (!Number.isInteger(revision)) throw new TypeError(`${label}.revision must be an integer`);
  return Object.freeze({
    ref: nonEmpty(candidate.ref, `${label}.ref`),
    scopeRef: nonEmpty(candidate.scopeRef, `${label}.scopeRef`),
    documentRef: nonEmpty(candidate.documentRef, `${label}.documentRef`),
    observationId: nonEmpty(candidate.observationId, `${label}.observationId`),
    revision,
    host: nullableEnum(candidate.host, SEARCH_INPUT_HOST_HOSTS, `${label}.host`),
    type: nullableEnum(candidate.type, SEARCH_INPUT_HOST_TYPES, `${label}.type`),
    contentEditable: nullableBoolean(candidate.contentEditable, `${label}.contentEditable`),
    editable: nullableBoolean(candidate.editable, `${label}.editable`),
    disabled: nullableBoolean(candidate.disabled, `${label}.disabled`),
    readOnly: nullableBoolean(candidate.readOnly, `${label}.readOnly`),
    cssHidden: nullableBoolean(candidate.cssHidden, `${label}.cssHidden`),
    intersectsViewport: nullableBoolean(candidate.intersectsViewport, `${label}.intersectsViewport`),
    explicitTabIndexKind: nullableEnum(
      candidate.explicitTabIndexKind,
      ["absent", "negative", "nonnegative", "invalid"] as const,
      `${label}.explicitTabIndexKind`,
    ),
    tabIndexFocus: nullableBoolean(candidate.tabIndexFocus, `${label}.tabIndexFocus`),
    inForm: nullableBoolean(candidate.inForm, `${label}.inForm`),
    formRoleSearch: nullableBoolean(candidate.formRoleSearch, `${label}.formRoleSearch`),
    nearbySubmit: nullableBoolean(candidate.nearbySubmit, `${label}.nearbySubmit`),
    depthBand: nullableEnum(candidate.depthBand, SEARCH_INPUT_HOST_DEPTH_BANDS, `${label}.depthBand`),
    hasLabel: nullableBoolean(candidate.hasLabel, `${label}.hasLabel`),
    hasPlaceholder: nullableBoolean(candidate.hasPlaceholder, `${label}.hasPlaceholder`),
    hasAria: nullableBoolean(candidate.hasAria, `${label}.hasAria`),
    markerHit: nullableBoolean(candidate.markerHit, `${label}.markerHit`),
    nonSearchMarker: nullableBoolean(candidate.nonSearchMarker, `${label}.nonSearchMarker`),
    textLenBand: nullableTextLenBand(candidate.textLenBand, `${label}.textLenBand`),
    access: nullableEnum(
      candidate.access,
      ["available", "login_required", "challenge", "unknown"] as const,
      `${label}.access`,
    ),
    ...(candidate.usageQuerySupport === undefined
      ? {}
      : { usageQuerySupport: nullableSupport(candidate.usageQuerySupport, `${label}.usageQuerySupport`) }),
    ...(candidate.usageFieldSupport === undefined
      ? {}
      : { usageFieldSupport: nullableSupport(candidate.usageFieldSupport, `${label}.usageFieldSupport`) }),
    ...(candidate.memberVerdict === undefined
      ? {}
      : { memberVerdict: memberVerdict(candidate.memberVerdict, `${label}.memberVerdict`) }),
  });
}

const MEASURED_FIELDS = [
  "host", "type", "contentEditable", "editable", "disabled", "readOnly",
  "cssHidden", "intersectsViewport", "explicitTabIndexKind", "tabIndexFocus",
  "inForm", "formRoleSearch", "nearbySubmit", "depthBand",
  "hasLabel", "hasPlaceholder", "hasAria", "markerHit", "nonSearchMarker",
  "textLenBand", "access",
] as const;

/**
 * Deterministic missing-measurement guard for the structural facts.
 *
 * The two member supports are deliberately not in this list. Whether a missing
 * support is a problem depends on the loaded profile: a profile that reads the
 * wire has a real dependency, and an all-zero profile does not. This guard has
 * no profile, so it must not invent that dependency for every caller (Alice
 * ruling 2026-10-24: 旧零系数不凭空增加依赖). The profile-aware check lives in
 * `inferSearchInputHostBinding`, which rejects a missing support only when the
 * profile's weight on that wire is non-zero.
 */
export function isMeasuredSearchInputHostCandidate(
  candidate: SearchInputHostCandidate,
): candidate is MeasuredSearchInputHostCandidate {
  return MEASURED_FIELDS.every(field => candidate[field] !== null);
}

export function validateSearchInputHostGoal(value: unknown): SearchInputHostGoal {
  const goal = expectRecord(value, "search input host goal");
  exactKeys(goal, ["requestedRole", "allowedScopeRef"], "search input host goal");
  return Object.freeze({
    requestedRole: nonEmpty(goal.requestedRole, "search input host goal.requestedRole"),
    allowedScopeRef: nonEmpty(goal.allowedScopeRef, "search input host goal.allowedScopeRef"),
  });
}

export function validateSearchInputHostCoverage(value: unknown): SearchInputHostCoverage {
  const coverage = expectRecord(value, "search input host coverage");
  exactKeys(
    coverage,
    [
      "scopeRef", "observedCandidateCount", "unassessedIframeCount", "unassessedObjectCount",
      "unassessedOpenShadowRootCount", "excluded",
    ],
    "search input host coverage",
  );
  if (!Array.isArray(coverage.excluded)) {
    throw new TypeError("search input host coverage.excluded must be an array of reference strings");
  }
  return Object.freeze({
    scopeRef: nonEmpty(coverage.scopeRef, "search input host coverage.scopeRef"),
    observedCandidateCount: count(coverage.observedCandidateCount, "search input host coverage.observedCandidateCount"),
    unassessedIframeCount: count(coverage.unassessedIframeCount, "search input host coverage.unassessedIframeCount"),
    unassessedObjectCount: count(coverage.unassessedObjectCount, "search input host coverage.unassessedObjectCount"),
    unassessedOpenShadowRootCount: count(
      coverage.unassessedOpenShadowRootCount,
      "search input host coverage.unassessedOpenShadowRootCount",
    ),
    excluded: Object.freeze(
      coverage.excluded.map((entry, index) => nonEmpty(entry, `search input host coverage.excluded[${index}]`)),
    ),
  });
}

export function validateSearchInputHostControl(value: unknown): SearchInputHostControl {
  const control = expectRecord(value, "search input host current control");
  exactKeys(control, ["documentRef", "observationId", "revision"], "search input host current control");
  const revision = expectFiniteNumber(control.revision, "search input host current control.revision");
  if (!Number.isInteger(revision)) throw new TypeError("search input host current control.revision must be an integer");
  return Object.freeze({
    documentRef: nonEmpty(control.documentRef, "search input host current control.documentRef"),
    observationId: nonEmpty(control.observationId, "search input host current control.observationId"),
    revision,
  });
}

export interface ValidatedSearchInputHostInferInput {
  readonly goal: SearchInputHostGoal;
  readonly candidates: readonly SearchInputHostCandidate[];
  readonly coverage: SearchInputHostCoverage;
  readonly currentControl: SearchInputHostControl;
}

export function validateSearchInputHostInferInput(value: unknown): ValidatedSearchInputHostInferInput {
  const input = expectRecord(value, "search input host infer input");
  exactKeys(input, ["goal", "candidates", "coverage", "currentControl"], "search input host infer input");
  if (!Array.isArray(input.candidates)) throw new TypeError("search input host infer input.candidates must be an array");
  const refs = new Set<string>();
  const candidates = input.candidates.map((raw, index) => {
    const candidate = validateSearchInputHostCandidate(raw, `search input host infer input.candidates[${index}]`);
    if (refs.has(candidate.ref)) {
      throw new TypeError(`search input host candidate ref ${candidate.ref} appears twice in one batch`);
    }
    refs.add(candidate.ref);
    return candidate;
  });
  return Object.freeze({
    goal: validateSearchInputHostGoal(input.goal),
    candidates: Object.freeze(candidates),
    coverage: validateSearchInputHostCoverage(input.coverage),
    currentControl: validateSearchInputHostControl(input.currentControl),
  });
}

export function validateSearchInputHostProfile(value: unknown): SearchInputHostProfile {
  const profile = expectRecord(value, "search input host profile");
  exactKeys(
    profile,
    ["contract", "role", "wires", "weights", "threshold", "calibration", "adoption"],
    "search input host profile",
  );
  if (profile.contract !== SEARCH_INPUT_HOST_CONTRACT) {
    throw new TypeError(`search input host profile contract must be ${SEARCH_INPUT_HOST_CONTRACT}`);
  }
  if (profile.role !== SEARCH_INPUT_HOST_ROLE) {
    throw new TypeError(`search input host profile role must be ${SEARCH_INPUT_HOST_ROLE}`);
  }
  if (!Array.isArray(profile.wires) || profile.wires.length !== SEARCH_INPUT_HOST_WIRES.length
    || profile.wires.some((wire, index) => wire !== SEARCH_INPUT_HOST_WIRES[index])) {
    throw new TypeError("search input host profile wires must match the declared wire order");
  }
  if (!Array.isArray(profile.weights) || profile.weights.length !== SEARCH_INPUT_HOST_WIRES.length) {
    throw new TypeError(`search input host profile weights must have ${SEARCH_INPUT_HOST_WIRES.length} values`);
  }
  const weights = profile.weights.map((weight, index) => {
    if (typeof weight !== "number" || !Number.isFinite(weight)) {
      throw new TypeError(`search input host weight ${index} must be finite`);
    }
    return weight;
  });
  if (typeof profile.threshold !== "number" || !Number.isFinite(profile.threshold)) {
    throw new TypeError("search input host profile threshold must be finite");
  }
  if (profile.threshold !== SEARCH_INPUT_HOST_THRESHOLD) {
    throw new TypeError(`search input host threshold is frozen at ${SEARCH_INPUT_HOST_THRESHOLD}`);
  }
  if (profile.calibration !== "uncalibrated") throw new TypeError("search input host calibration must be uncalibrated");
  if (profile.adoption !== "not_applied") throw new TypeError("search input host adoption must be not_applied");
  return Object.freeze({
    contract: SEARCH_INPUT_HOST_CONTRACT,
    role: SEARCH_INPUT_HOST_ROLE,
    wires: Object.freeze([...SEARCH_INPUT_HOST_WIRES]),
    weights: Object.freeze(weights),
    threshold: SEARCH_INPUT_HOST_THRESHOLD,
    calibration: "uncalibrated",
    adoption: "not_applied",
  });
}

/**
 * Migrate a delivered profile forward to the current wire list.
 *
 * Weights are a positional array, so a profile saved before the wire list grew
 * cannot be read positionally: once any wire is inserted anywhere but the tail,
 * every coefficient after it would shift silently. The delivered profile carries
 * its own `wires` name array, so migration aligns by NAME.
 *
 * Only the wires appended after delivery may start at zero. A delivered wire
 * that cannot be found is a corrupt profile, and zero-filling it would erase a
 * learned coefficient while looking like a successful migration.
 *
 * Migration is separate from training (ruling 6): this function only re-shapes
 * the vector. No weight is fitted, retuned or given a signed prior here.
 */
export function migrateSearchInputHostProfile(raw: unknown): SearchInputHostProfile {
  const input = expectRecord(raw, "search input host profile");
  const rawWires = input.wires;
  const rawWeights = input.weights;
  if (!Array.isArray(rawWires)) throw new TypeError("search input host profile wires must be an array");
  if (!Array.isArray(rawWeights)) throw new TypeError("search input host profile weights must be an array");
  if (rawWires.length !== rawWeights.length) {
    throw new TypeError("search input host profile wires and weights must have equal length");
  }
  const weightByName = new Map<string, number>();
  rawWires.forEach((wire, index) => {
    if (typeof wire !== "string") throw new TypeError(`search input host wire ${index} must be a string`);
    const weight = rawWeights[index];
    if (typeof weight !== "number" || !Number.isFinite(weight)) {
      throw new TypeError(`search input host weight for ${wire} must be finite`);
    }
    weightByName.set(wire, weight);
  });

  const appended = new Set<string>(SEARCH_INPUT_HOST_APPENDED_WIRES);
  const weights = SEARCH_INPUT_HOST_WIRES.map(wire => {
    const weight = weightByName.get(wire);
    if (weight !== undefined) return weight;
    if (appended.has(wire)) return 0;
    throw new TypeError(`search input host profile is missing delivered wire ${wire}`);
  });

  return validateSearchInputHostProfile({
    ...input,
    wires: [...SEARCH_INPUT_HOST_WIRES],
    weights,
  });
}

/** Neutral start: every weight is zero, so the fit decides every value. */
export function neutralSearchInputHostProfile(): SearchInputHostProfile {  return validateSearchInputHostProfile({
    contract: SEARCH_INPUT_HOST_CONTRACT,
    role: SEARCH_INPUT_HOST_ROLE,
    wires: [...SEARCH_INPUT_HOST_WIRES],
    weights: SEARCH_INPUT_HOST_WIRES.map(() => 0),
    threshold: SEARCH_INPUT_HOST_THRESHOLD,
    calibration: "uncalibrated",
    adoption: "not_applied",
  });
}
