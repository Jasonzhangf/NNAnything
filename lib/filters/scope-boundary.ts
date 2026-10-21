import type { ExplorationInputV1, ExplorationRelativeSummary } from "../adapters/browser/exploration-input.js";

// F11 minimal deterministic scope boundary. DOM containment is not ownership:
// a container's own text scope stops at a nested interactive scope, so an outer
// container never swallows the content of a nested button or link, and a button
// never swallows an adjacent button's text. Nothing here infers purpose.

const NESTED_SCOPE_TAGS = new Set(["button", "a", "input", "select", "textarea", "option", "summary"]);
const NESTED_SCOPE_ROLES = new Set([
  "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "option",
  "combobox", "listbox", "textbox", "searchbox", "slider", "spinbutton",
]);

export interface OwnedScopeFacts {
  readonly ownedRefs: readonly string[];
  readonly nestedScopeRefs: readonly string[];
  readonly status: "complete" | "unknown";
  readonly unknownReason: string | null;
}

export const EMPTY_OWNED_SCOPE: OwnedScopeFacts = {
  ownedRefs: [],
  nestedScopeRefs: [],
  status: "unknown",
  unknownReason: "no_descendant_topology",
};

function isNestedScope(summary: ExplorationRelativeSummary): boolean {
  const tag = summary.tag?.toLowerCase() ?? null;
  if (tag !== null && NESTED_SCOPE_TAGS.has(tag)) return true;
  const role = summary.role?.toLowerCase() ?? null;
  return role !== null && NESTED_SCOPE_ROLES.has(role);
}

/**
 * Compute the deterministic text scope of one node from its observed descendant
 * topology. The result is a scope statement, not an ownership or purpose claim.
 * Observed descendants inside a nested interactive scope are reported as
 * boundaries, so an outer container does not swallow their content.
 */
export function deriveOwnedScope(input: ExplorationInputV1): OwnedScopeFacts {
  const boundary = input.containment.descendantBoundary;
  if (boundary !== "complete") {
    return { ownedRefs: [], nestedScopeRefs: [], status: "unknown", unknownReason: `descendant_boundary_${boundary}` };
  }
  const owned: string[] = [];
  const nested: string[] = [];
  for (const edge of input.containment.descendantEdges) {
    if (isNestedScope(edge.target)) nested.push(edge.targetRef);
    else owned.push(edge.targetRef);
  }
  return { ownedRefs: owned, nestedScopeRefs: nested, status: "complete", unknownReason: null };
}

/**
 * Direct text scope only: the observed direct content of a node, excluding any
 * direct child that starts a nested interactive scope. This is what keeps a
 * harness or outer container from swallowing nested scope content.
 */
export function deriveDirectScope(input: ExplorationInputV1): OwnedScopeFacts {
  const status = input.childComposition.directChildrenStatus;
  if (status !== "complete") {
    return { ownedRefs: [], nestedScopeRefs: [], status: "unknown", unknownReason: `direct_children_${status}` };
  }
  const owned: string[] = [];
  const nested: string[] = [];
  for (const child of input.childComposition.children) {
    if (isNestedScope(child)) nested.push(child.nodeRef);
    else owned.push(child.nodeRef);
  }
  return { ownedRefs: owned, nestedScopeRefs: nested, status: "complete", unknownReason: null };
}