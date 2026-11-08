// B-A1 route encoder: typed search-input-host observation -> unified 64-slot vector.
//
// Owner of the B-A1 browser/R route input contract (design:
// b-a1-unified-slot-observation-map.md, subject revision 3). It reuses the
// unified 64-slot engine contract but NOT the generic TS/JS step slot
// semantics. The first slice has no optional-unknown feature: every required
// gate and feature must be measured, and a missing value fails before any
// vector is produced. The 16 reserved-constant slots stay fixed 0 and never
// record a missing value or a zero measurement.

export const BA1_ROUTE_DOMAIN = "browser" as const;
export const BA1_ROUTE_DECISION_KIND = "R" as const;
export const BA1_INPUT_SCHEMA = "nnanything.unified-step.v1" as const;
export const BA1_ENCODER_VERSION = "nnanything.browser.b-a1-search-input-host.encoder.v1" as const;
export const BA1_ARCHITECTURE = Object.freeze({
  input: 64,
  hidden: Object.freeze([64, 64] as const),
  output: 1,
  activation: "relu" as const,
});

export type BA1EncoderErrorCode =
  | "ILLEGAL_CANDIDATE"
  | "MISSING_GATE"
  | "MISSING_FEATURE";

export class BA1RouteEncoderError extends Error {
  readonly code: BA1EncoderErrorCode;

  constructor(code: BA1EncoderErrorCode, message: string) {
    super(message);
    this.name = "BA1RouteEncoderError";
    this.code = code;
  }
}

export type BA1Host = "input" | "textarea" | "contenteditable";
export type BA1Type = "text" | "search" | "tel" | "email" | "url" | "number" | "other";
export type BA1DepthBand = "shallow" | "middle" | "deep";
export type BA1TabIndexKind = "negative" | "nonnegative" | "absent" | "invalid";
export type BA1TextLenBand = 0 | 1 | 2;
export type BA1Access = "available" | "login_required" | "challenge" | "unknown";
export type BA1CoverageStatus = "complete" | "partial" | "unverified";

export interface BA1RouteCoverage {
  readonly status: BA1CoverageStatus;
  readonly evaluatedCount: number;
  readonly expectedCount: number;
  readonly unassessedIframeCount: number;
  readonly unassessedObjectCount: number;
  readonly unassessedOpenShadowRootCount: number;
}

export interface BA1RouteGateContext {
  readonly requestedRole: string;
  readonly allowedScopeRef: string;
  readonly coverage: BA1RouteCoverage;
  readonly candidateGroupEnumerationComplete: boolean;
}

export interface BA1RouteCandidateInput {
  readonly candidateRef: string;
  readonly candidateKind: string;
  readonly optionSemantics: string;
  readonly scopeRef: string;
  readonly host: BA1Host | null;
  readonly type: BA1Type | null;
  readonly contentEditable: boolean | null;
  readonly editable: boolean | null;
  readonly disabled: boolean | null;
  readonly readOnly: boolean | null;
  readonly cssHidden: boolean | null;
  readonly intersectsViewport: boolean | null;
  readonly explicitTabIndexKind: BA1TabIndexKind | null;
  readonly tabIndexFocus: boolean | null;
  readonly inForm: boolean | null;
  readonly formRoleSearch: boolean | null;
  readonly nearbySubmit: boolean | null;
  readonly depthBand: BA1DepthBand | null;
  readonly hasLabel: boolean | null;
  readonly hasPlaceholder: boolean | null;
  readonly hasAria: boolean | null;
  readonly markerHit: boolean | null;
  readonly nonSearchMarker: boolean | null;
  readonly textLenBand: BA1TextLenBand | null;
  readonly access: BA1Access | null;
}

export interface BA1RouteGroupInput {
  readonly groupRef: string;
  readonly context: BA1RouteGateContext;
  readonly candidates: readonly BA1RouteCandidateInput[];
  readonly allowedCandidateRefs: readonly string[];
}

export interface BA1EncodedRouteCandidate {
  readonly candidateRef: string;
  readonly candidateKind: "relation";
  readonly optionSemantics: "select";
  readonly input: readonly number[];
}

export interface BA1EncodedRouteGroup {
  readonly groupRef: string;
  readonly candidates: readonly BA1EncodedRouteCandidate[];
  readonly allowedCandidateRefs: readonly string[];
}

const TYPE_SLOT: Readonly<Record<BA1Type, number>> = Object.freeze({
  text: 17, search: 18, tel: 19, email: 20, url: 21, number: 22, other: 23,
});
const TAB_INDEX_SLOT: Readonly<Record<BA1TabIndexKind, number>> = Object.freeze({
  negative: 27, nonnegative: 28, absent: 29, invalid: 30,
});
const DEPTH_SLOT: Readonly<Record<BA1DepthBand, number>> = Object.freeze({
  shallow: 32, middle: 33, deep: 34,
});
const TEXT_LEN_SLOT: Readonly<Record<BA1TextLenBand, number>> = Object.freeze({
  0: 42, 1: 43, 2: 44,
});
const ACCESS_VALUE: Readonly<Record<Exclude<BA1Access, "unknown">, number>> = Object.freeze({
  available: 1, challenge: 0.5, login_required: 0.25,
});

/** Slots that must always hold the reserved route constant 0 in the first slice. */
export const BA1_RESERVED_SLOTS: readonly number[] = Object.freeze([
  38, 39, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 61, 62, 63,
]);

const BA1_REQUIRED_GATE_SLOTS = Object.freeze({
  0: 1,
  1: 1,
  2: 1,
  3: 1,
  4: 0,
  5: 0,
  6: 0,
  7: 1,
});

function bit(value: boolean): number {
  return value ? 1 : 0;
}

function requireBit(value: boolean | null, fieldRef: string): number {
  if (value === null || value === undefined) {
    throw new BA1RouteEncoderError("MISSING_FEATURE", `required feature ${fieldRef} is not measured`);
  }
  return value ? 1 : 0;
}

function requireFiniteCount(value: number | undefined, fieldRef: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BA1RouteEncoderError("MISSING_GATE", `required gate ${fieldRef} is not measured`);
  }
  return value;
}

function requireNonEmpty(value: string, fieldRef: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BA1RouteEncoderError("MISSING_GATE", `required gate ${fieldRef} is not measured`);
  }
  return value;
}

function assertLegalCandidate(candidate: BA1RouteCandidateInput): void {
  if (candidate.candidateKind !== "relation" || candidate.optionSemantics !== "select") {
    throw new BA1RouteEncoderError(
      "ILLEGAL_CANDIDATE",
      `candidate ${candidate.candidateRef} must be candidateKind=relation/optionSemantics=select, `
      + `got candidateKind=${candidate.candidateKind}/optionSemantics=${candidate.optionSemantics}`,
    );
  }
}

function failVector(candidateRef: string, slot: number, message: string): never {
  throw new BA1RouteEncoderError("ILLEGAL_CANDIDATE", `candidate ${candidateRef} x[${slot}] ${message}`);
}

function assertBooleanSlots(
  input: readonly number[],
  slots: readonly number[],
  candidateRef: string,
): void {
  for (const slot of slots) {
    const value = input[slot];
    if (value !== 0 && value !== 1) {
      failVector(candidateRef, slot, "must be boolean 0/1");
    }
  }
}

function assertOneHotSlots(
  input: readonly number[],
  slots: readonly number[],
  candidateRef: string,
): void {
  assertBooleanSlots(input, slots, candidateRef);
  const activeCount = slots.filter(slot => input[slot] === 1).length;
  if (activeCount !== 1) {
    throw new BA1RouteEncoderError(
      "ILLEGAL_CANDIDATE",
      `candidate ${candidateRef} one-hot slots x${slots[0]}-x${slots[slots.length - 1]} must contain exactly one 1`,
    );
  }
}

/**
 * Validate an already encoded B-A1 student vector. Student rows carry x[64]
 * from the route converter; the fixed training entry still owns the route
 * boundary and must reject reserved-slot drift, missing sentinels, and
 * candidates that did not pass the accepted R1-R5/B1-B3 gates.
 */
export function assertBA1EncodedRouteVector(
  input: readonly number[],
  candidateRef: string,
): void {
  if (!Array.isArray(input) || input.length !== 64) {
    throw new BA1RouteEncoderError("ILLEGAL_CANDIDATE", `candidate ${candidateRef} must carry x[64]`);
  }
  for (let slot = 0; slot < input.length; slot += 1) {
    const value = input[slot];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new BA1RouteEncoderError(
        "ILLEGAL_CANDIDATE",
        `candidate ${candidateRef} x[${slot}] must be finite`,
      );
    }
    if (value === -1) {
      throw new BA1RouteEncoderError(
        "MISSING_FEATURE",
        `candidate ${candidateRef} x[${slot}] contains an undeclared missing sentinel`,
      );
    }
  }
  if (input[8] !== 1 && input[8] !== 0.5 && input[8] !== 0.25) {
    failVector(candidateRef, 8, "must encode access as 1, 0.5, or 0.25");
  }
  assertOneHotSlots(input, [9, 10, 11], candidateRef);
  assertBooleanSlots(input, [12, 13, 14, 15, 16], candidateRef);
  assertOneHotSlots(input, [17, 18, 19, 20, 21, 22, 23], candidateRef);
  assertBooleanSlots(input, [24, 25, 26], candidateRef);
  assertOneHotSlots(input, [27, 28, 29, 30], candidateRef);
  assertBooleanSlots(input, [31], candidateRef);
  assertOneHotSlots(input, [32, 33, 34], candidateRef);
  assertBooleanSlots(input, [35, 36, 37], candidateRef);
  assertBooleanSlots(input, [40, 41], candidateRef);
  assertOneHotSlots(input, [42, 43, 44], candidateRef);
  for (const [rawSlot, expected] of Object.entries(BA1_REQUIRED_GATE_SLOTS)) {
    const slot = Number(rawSlot);
    if (input[slot] !== expected) {
      throw new BA1RouteEncoderError(
        "MISSING_GATE",
        `candidate ${candidateRef} x[${slot}] must be ${expected} after R1-R5/B1-B3 gates`,
      );
    }
  }
  for (const slot of BA1_RESERVED_SLOTS) {
    if (input[slot] !== 0) {
      throw new BA1RouteEncoderError(
        "ILLEGAL_CANDIDATE",
        `candidate ${candidateRef} reserved slot x[${slot}] must be 0`,
      );
    }
  }
  if (input[56] !== 1 || input[57] !== 1) {
    throw new BA1RouteEncoderError(
      "ILLEGAL_CANDIDATE",
      `candidate ${candidateRef} must stay candidateKind=relation/optionSemantics=select`,
    );
  }
  if (input[58] !== 1) {
    throw new BA1RouteEncoderError(
      "MISSING_GATE",
      `candidate ${candidateRef} candidateGroupEnumerationComplete must be true`,
    );
  }
}

export function assertBA1EncodedRouteGroup(input: {
  readonly groupRef: string;
  readonly candidates: readonly {
    readonly candidateRef: string;
    readonly input: readonly number[];
  }[];
  readonly allowedCandidateRefs: readonly string[];
}): void {
  if (input.candidates.length === 0) {
    throw new BA1RouteEncoderError("MISSING_FEATURE", `group ${input.groupRef} has no candidates`);
  }
  const refs = new Set<string>();
  for (const candidate of input.candidates) {
    assertBA1EncodedRouteVector(candidate.input, candidate.candidateRef);
    if (refs.has(candidate.candidateRef)) {
      throw new BA1RouteEncoderError(
        "ILLEGAL_CANDIDATE",
        `group ${input.groupRef} has duplicate candidate ${candidate.candidateRef}`,
      );
    }
    refs.add(candidate.candidateRef);
    const expected59 = input.candidates.length > 1 ? 1 : 0;
    const expected60 = input.candidates.length === 1 ? 1 : 0;
    if (candidate.input[59] !== expected59 || candidate.input[60] !== expected60) {
      throw new BA1RouteEncoderError(
        "ILLEGAL_CANDIDATE",
        `candidate ${candidate.candidateRef} has inconsistent group cardinality slots`,
      );
    }
  }
  if (input.allowedCandidateRefs.length === 0) {
    throw new BA1RouteEncoderError("ILLEGAL_CANDIDATE", `group ${input.groupRef} has empty A_g`);
  }
  for (const ref of input.allowedCandidateRefs) {
    if (!refs.has(ref)) {
      throw new BA1RouteEncoderError(
        "ILLEGAL_CANDIDATE",
        `A_g ref ${ref} is outside S_g for ${input.groupRef}`,
      );
    }
  }
}

function accessSlot(candidate: BA1RouteCandidateInput): number {
  const access = candidate.access;
  if (access === null || access === undefined || access === "unknown") {
    throw new BA1RouteEncoderError(
      "MISSING_FEATURE",
      `required feature access is not measured for ${candidate.candidateRef}`,
    );
  }
  return ACCESS_VALUE[access];
}

/**
 * Encode one B-A1 candidate into the 64-slot vector. x59/x60 (group cardinality)
 * stay 0 here; `encodeBA1RouteGroup` backfills them once the scorable count is
 * known. Callers must already have applied the B-A1 fixed gates (R1-R5 / B1-B3);
 * this encoder only rejects illegal candidate shapes and missing required values.
 */
export function encodeBA1RouteCandidate(
  context: BA1RouteGateContext,
  candidate: BA1RouteCandidateInput,
): readonly number[] {
  assertLegalCandidate(candidate);

  const requestedRole = requireNonEmpty(context.requestedRole, "goal.requestedRole");
  const allowedScopeRef = requireNonEmpty(context.allowedScopeRef, "goal.allowedScopeRef");
  const coverage = context.coverage;
  const evaluatedCount = requireFiniteCount(coverage?.evaluatedCount, "coverage.evaluatedCount");
  const expectedCount = requireFiniteCount(coverage?.expectedCount, "coverage.expectedCount");
  const unassessedIframeCount = requireFiniteCount(coverage?.unassessedIframeCount, "coverage.unassessedIframeCount");
  const unassessedObjectCount = requireFiniteCount(coverage?.unassessedObjectCount, "coverage.unassessedObjectCount");
  const unassessedShadowRootCount = requireFiniteCount(coverage?.unassessedOpenShadowRootCount, "coverage.unassessedOpenShadowRootCount");
  const coverageStatus = coverage?.status;
  if (coverageStatus !== "complete" && coverageStatus !== "partial" && coverageStatus !== "unverified") {
    throw new BA1RouteEncoderError("MISSING_GATE", "required gate coverage.status is not measured");
  }
  if (typeof context.candidateGroupEnumerationComplete !== "boolean") {
    throw new BA1RouteEncoderError("MISSING_GATE", "required gate candidateGroupEnumerationComplete is not measured");
  }
  const candidateScopeRef = requireNonEmpty(candidate.scopeRef, "candidate.scopeRef");

  const x = new Array<number>(64).fill(0);

  // B0 gate constants (x0-x7).
  x[0] = requestedRole === "search-input-host" ? 1 : 0;
  x[1] = allowedScopeRef.length > 0 ? 1 : 0;
  x[2] = coverageStatus === "complete" ? 1 : 0;
  x[3] = evaluatedCount === expectedCount ? 1 : 0;
  x[4] = unassessedIframeCount === 0 ? 0 : 1;
  x[5] = unassessedObjectCount === 0 ? 0 : 1;
  x[6] = unassessedShadowRootCount === 0 ? 0 : 1;
  x[7] = candidateScopeRef === allowedScopeRef ? 1 : 0;

  // B1 access / host (x8-x15).
  x[8] = accessSlot(candidate);
  if (candidate.host === null || candidate.host === undefined) {
    throw new BA1RouteEncoderError("MISSING_FEATURE", `required feature host is not measured for ${candidate.candidateRef}`);
  }
  x[9] = bit(candidate.host === "input");
  x[10] = bit(candidate.host === "textarea");
  x[11] = bit(candidate.host === "contenteditable");
  x[12] = requireBit(candidate.editable, "editable");
  x[13] = requireBit(candidate.disabled, "disabled");
  x[14] = requireBit(candidate.readOnly, "readOnly");
  x[15] = requireBit(candidate.cssHidden, "cssHidden");

  // B2 visibility / input type (x16-x23).
  x[16] = requireBit(candidate.intersectsViewport, "intersectsViewport");
  if (candidate.type === null || candidate.type === undefined) {
    throw new BA1RouteEncoderError("MISSING_FEATURE", "required feature type is not measured");
  }
  x[TYPE_SLOT[candidate.type]] = 1;

  // B3 structure / tab order (x24-x31).
  x[24] = requireBit(candidate.inForm, "inForm");
  x[25] = requireBit(candidate.formRoleSearch, "formRoleSearch");
  x[26] = requireBit(candidate.nearbySubmit, "nearbySubmit");
  if (candidate.explicitTabIndexKind === null || candidate.explicitTabIndexKind === undefined) {
    throw new BA1RouteEncoderError("MISSING_FEATURE", "required feature explicitTabIndexKind is not measured");
  }
  x[TAB_INDEX_SLOT[candidate.explicitTabIndexKind]] = 1;
  x[31] = requireBit(candidate.tabIndexFocus, "tabIndexFocus");

  // B4 depth / name channel (x32-x39). x38/x39 are reserved constants.
  if (candidate.depthBand === null || candidate.depthBand === undefined) {
    throw new BA1RouteEncoderError("MISSING_FEATURE", "required feature depthBand is not measured");
  }
  x[DEPTH_SLOT[candidate.depthBand]] = 1;
  x[35] = requireBit(candidate.hasLabel, "hasLabel");
  x[36] = requireBit(candidate.hasPlaceholder, "hasPlaceholder");
  x[37] = requireBit(candidate.hasAria, "hasAria");

  // B5 token / text length (x40-x47). x45-x47 are reserved constants.
  x[40] = requireBit(candidate.markerHit, "markerHit");
  x[41] = requireBit(candidate.nonSearchMarker, "nonSearchMarker");
  if (candidate.textLenBand === null || candidate.textLenBand === undefined) {
    throw new BA1RouteEncoderError("MISSING_FEATURE", "required feature textLenBand is not measured");
  }
  x[TEXT_LEN_SLOT[candidate.textLenBand]] = 1;

  // B6 local relation (x48-x55): reserved constants in the first slice.
  // B7 candidate semantics / route control (x56-x63).
  x[56] = 1; // candidateKind == relation (enforced above)
  x[57] = 1; // optionSemantics == select (enforced above)
  x[58] = bit(context.candidateGroupEnumerationComplete);
  // x59/x60 (scorable cardinality) are backfilled by encodeBA1RouteGroup.

  for (const slot of BA1_RESERVED_SLOTS) {
    x[slot] = 0;
  }
  return x;
}

export function encodeBA1RouteGroup(input: BA1RouteGroupInput): BA1EncodedRouteGroup {
  if (input.candidates.length === 0) {
    throw new BA1RouteEncoderError("MISSING_FEATURE", `group ${input.groupRef} has no candidates`);
  }
  const encoded = input.candidates.map(candidate => ({
    candidateRef: candidate.candidateRef,
    candidateKind: "relation" as const,
    optionSemantics: "select" as const,
    input: [...encodeBA1RouteCandidate(input.context, candidate)],
  }));
  const refs = new Set(encoded.map(entry => entry.candidateRef));
  if (refs.size !== encoded.length) {
    throw new BA1RouteEncoderError("ILLEGAL_CANDIDATE", `group ${input.groupRef} has duplicate candidate refs`);
  }
  for (const ref of input.allowedCandidateRefs) {
    if (!refs.has(ref)) {
      throw new BA1RouteEncoderError("ILLEGAL_CANDIDATE", `A_g ref ${ref} is outside S_g for ${input.groupRef}`);
    }
  }
  const scorableCount = encoded.length;
  for (const entry of encoded) {
    entry.input[59] = scorableCount > 1 ? 1 : 0;
    entry.input[60] = scorableCount === 1 ? 1 : 0;
  }
  return {
    groupRef: input.groupRef,
    candidates: encoded,
    allowedCandidateRefs: [...input.allowedCandidateRefs],
  };
}
