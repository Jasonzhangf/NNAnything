import type { ObservationNode } from "../adapters/browser/observation.js";

// F15 attribute change facts. Compare two observed snapshots of the same object
// for a named attribute. The result is a change statement only: no action
// causality, no side-effect claim, and no goal success. A missing posterior,
// a mismatched object, or an unobserved attribute stays unknown, never
// unchanged.

export interface AttributeChange {
  readonly attribute: string;
  readonly before: string | boolean | null;
  readonly after: string | boolean | null;
  readonly state: "changed" | "unchanged" | "unknown";
  readonly unknownReason: string | null;
}

const COMPARABLE_ATTRIBUTES = [
  "aria-checked", "aria-disabled", "aria-expanded", "aria-hidden",
  "aria-readonly", "aria-selected", "checked", "contenteditable",
  "disabled", "hidden", "open", "readonly", "selected", "tabindex",
] as const;

export type ComparableAttribute = typeof COMPARABLE_ATTRIBUTES[number];

export const ATTRIBUTE_CHANGE_STATES = ["changed", "unchanged", "unknown"] as const;

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
 * Compare one attribute between two observations of the same object. The two
 * node refs must match; identical text rendered again is not assumed to be the
 * same object, so a ref mismatch is unknown rather than unchanged.
 */
export function compareAttributeChange(
  beforeNode: ObservationNode | null,
  afterNode: ObservationNode | null,
  attribute: string,
): AttributeChange {
  if (beforeNode === null || afterNode === null) {
    return { attribute, before: null, after: null, state: "unknown", unknownReason: "observation_missing" };
  }
  if (beforeNode.nodeRef !== afterNode.nodeRef) {
    return { attribute, before: null, after: null, state: "unknown", unknownReason: "object_mismatch" };
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
 * Only observed attributes are reported; unobserved ones stay unknown.
 */
export function compareObservedAttributeChanges(
  beforeNode: ObservationNode | null,
  afterNode: ObservationNode | null,
): readonly AttributeChange[] {
  const attributes = beforeNode === null || afterNode === null
    ? COMPARABLE_ATTRIBUTES
    : COMPARABLE_ATTRIBUTES.filter(attribute => Object.hasOwn(beforeNode.attributes, attribute) || Object.hasOwn(afterNode.attributes, attribute));
  return attributes.map(attribute => compareAttributeChange(beforeNode, afterNode, attribute));
}

export { COMPARABLE_ATTRIBUTES };