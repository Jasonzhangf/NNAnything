import type { ObservationNode } from "../adapters/browser/observation.js";

// F15 attribute change facts. Compare two observed snapshots of the same object
// for a named attribute. The result is a change statement only: no action
// causality, no side-effect claim, and no goal success. A missing posterior,
// a mismatched object, an unverified comparison context, or an unobserved
// attribute stays unknown, never unchanged.

export interface AttributeChange {
  readonly attribute: string;
  readonly before: string | boolean | null;
  readonly after: string | boolean | null;
  readonly state: "changed" | "unchanged" | "unknown";
  readonly unknownReason: string | null;
}

// F14 validated the observation control triple. A stable node ref alone cannot
// prove the same document, the same scope, or a fresh observation: separate
// registries can produce identical ref strings.
export interface ObservedObjectContext {
  readonly documentRef: string;
  readonly scopeRef: string;
  readonly observationId: string;
  readonly revision: number;
}

export interface ComparisonContext {
  readonly before: ObservedObjectContext;
  readonly after: ObservedObjectContext;
}

// A current value is never read from the HTML `value` attribute, which is only
// the initial default. The caller supplies an explicit read of the live value,
// as F07 observeLiveDom produces in LiveDomEvidence.inputValue.
export interface ObservedValue {
  readonly status: "observed" | "unavailable";
  readonly value: string | null;
}

export interface ObservedValueReads {
  readonly before: ObservedValue;
  readonly after: ObservedValue;
}

const COMPARABLE_ATTRIBUTES = [
  "aria-checked", "aria-disabled", "aria-expanded", "aria-hidden",
  "aria-readonly", "aria-selected", "checked", "contenteditable",
  "disabled", "hidden", "open", "readonly", "selected", "tabindex",
] as const;

export type ComparableAttribute = typeof COMPARABLE_ATTRIBUTES[number];

export const ATTRIBUTE_CHANGE_STATES = ["changed", "unchanged", "unknown"] as const;

// The current value is not a comparable attribute of the observation node. It is
// compared under the pseudo-attribute name only from an explicit value read.
const VALUE_ATTRIBUTE = "value";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function readObservedObjectContext(value: unknown, label: string): ObservedObjectContext {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const revision = value.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError(`${label}.revision must be a nonnegative safe integer`);
  }
  return {
    documentRef: nonEmptyString(value.documentRef, `${label}.documentRef`),
    scopeRef: nonEmptyString(value.scopeRef, `${label}.scopeRef`),
    observationId: nonEmptyString(value.observationId, `${label}.observationId`),
    revision,
  };
}

export function readComparisonContext(value: unknown): ComparisonContext {
  if (value === undefined || value === null) {
    throw new TypeError("comparison_context_missing: comparison context is required");
  }
  if (!isRecord(value)) {
    throw new TypeError("comparison context must be an object with before and after sides");
  }
  if (!isRecord(value.before) || !isRecord(value.after)) {
    throw new TypeError("comparison context requires before and after observed object contexts");
  }
  return {
    before: readObservedObjectContext(value.before, "comparison context.before"),
    after: readObservedObjectContext(value.after, "comparison context.after"),
  };
}

function readObservedValue(value: unknown, label: string): ObservedValue {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  if (value.status !== "observed" && value.status !== "unavailable") {
    throw new TypeError(`${label}.status must be observed or unavailable`);
  }
  if (value.value !== null && typeof value.value !== "string") {
    throw new TypeError(`${label}.value must be a string or null`);
  }
  return { status: value.status, value: value.value };
}

function readValueReads(value: unknown): ObservedValueReads | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new TypeError("value reads must be an object with before and after sides");
  }
  if (!isRecord(value.before) || !isRecord(value.after)) {
    throw new TypeError("value reads require before and after observed values");
  }
  return {
    before: readObservedValue(value.before, "value reads.before"),
    after: readObservedValue(value.after, "value reads.after"),
  };
}

function contextRejection(context: ComparisonContext): string | null {
  if (context.before.documentRef !== context.after.documentRef) return "document_mismatch";
  if (context.before.scopeRef !== context.after.scopeRef) return "scope_mismatch";
  if (context.after.revision <= context.before.revision) return "observation_order_invalid";
  if (context.after.observationId === context.before.observationId) return "observation_not_distinct";
  return null;
}

function readValue(node: ObservationNode, attribute: string): string | boolean | null {
  const value = node.attributes[attribute];
  if (value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return String(value);
  return null;
}

function readObservation(node: ObservationNode, attribute: string): { present: boolean; value: string | boolean | null } {
  return { present: Object.hasOwn(node.attributes, attribute), value: readValue(node, attribute) };
}

/**
 * Compare one attribute between two observations of the same object.
 *
 * The caller must pass the F14-verified comparison context. The two node refs
 * must match; identical text or an identical ref string from another registry is
 * not assumed to be the same object. The context proves one document, one scope
 * and a strictly newer observation before any comparison runs.
 *
 * The pseudo-attribute `value` uses the explicit current value reads only. It
 * never falls back to the HTML `value` attribute, which is the initial default.
 */
export function compareAttributeChange(
  beforeNode: ObservationNode | null,
  afterNode: ObservationNode | null,
  attribute: string,
  context: ComparisonContext,
  valueReads?: ObservedValueReads,
): AttributeChange {
  const comparisonContext = readComparisonContext(context);
  const reads = readValueReads(valueReads);
  if (beforeNode === null || afterNode === null) {
    return { attribute, before: null, after: null, state: "unknown", unknownReason: "observation_missing" };
  }
  const contextRejectionReason = contextRejection(comparisonContext);
  if (contextRejectionReason !== null) {
    return { attribute, before: null, after: null, state: "unknown", unknownReason: contextRejectionReason };
  }
  if (beforeNode.nodeRef !== afterNode.nodeRef) {
    return { attribute, before: null, after: null, state: "unknown", unknownReason: "object_mismatch" };
  }
  if (attribute === VALUE_ATTRIBUTE) {
    if (reads === undefined) {
      return { attribute, before: null, after: null, state: "unknown", unknownReason: "value_read_not_supplied" };
    }
    const beforeValue = reads.before.status === "observed" ? reads.before.value : null;
    const afterValue = reads.after.status === "observed" ? reads.after.value : null;
    if (reads.before.status !== "observed" || reads.after.status !== "observed") {
      return { attribute, before: beforeValue, after: afterValue, state: "unknown", unknownReason: "value_unavailable" };
    }
    if (beforeValue === afterValue) {
      return { attribute, before: beforeValue, after: afterValue, state: "unchanged", unknownReason: null };
    }
    return { attribute, before: beforeValue, after: afterValue, state: "changed", unknownReason: null };
  }
  const before = readObservation(beforeNode, attribute);
  const after = readObservation(afterNode, attribute);
  if (!before.present || !after.present) {
    return { attribute, before: before.value, after: after.value, state: "unknown", unknownReason: "attribute_unobserved" };
  }
  if (before.value === after.value) {
    return { attribute, before: before.value, after: after.value, state: "unchanged", unknownReason: null };
  }
  return { attribute, before: before.value, after: after.value, state: "changed", unknownReason: null };
}

/**
 * Compare every comparable attribute between two observations of one object.
 * Only observed attributes are reported; unobserved ones stay unknown. The
 * pseudo-attribute `value` is added only when the caller supplies explicit
 * current value reads, so a value is never claimed as compared unobserved.
 */
export function compareObservedAttributeChanges(
  beforeNode: ObservationNode | null,
  afterNode: ObservationNode | null,
  context: ComparisonContext,
  valueReads?: ObservedValueReads,
): readonly AttributeChange[] {
  const comparisonContext = readComparisonContext(context);
  const reads = readValueReads(valueReads);
  const observedAttributes = beforeNode === null || afterNode === null
    ? COMPARABLE_ATTRIBUTES
    : COMPARABLE_ATTRIBUTES.filter(
      attribute => Object.hasOwn(beforeNode.attributes, attribute) || Object.hasOwn(afterNode.attributes, attribute),
    );
  const attributes = reads === undefined
    ? observedAttributes
    : [...observedAttributes, VALUE_ATTRIBUTE];
  return attributes.map(attribute => compareAttributeChange(beforeNode, afterNode, attribute, comparisonContext, reads));
}

export { COMPARABLE_ATTRIBUTES };
