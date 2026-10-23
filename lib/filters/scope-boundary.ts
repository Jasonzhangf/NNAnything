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
  readonly excludedNestedDescendantRefs: readonly string[];
  readonly status: "complete" | "unknown";
  readonly unknownReason: string | null;
}

export const EMPTY_OWNED_SCOPE: OwnedScopeFacts = {
  ownedRefs: [],
  nestedScopeRefs: [],
  excludedNestedDescendantRefs: [],
  status: "unknown",
  unknownReason: "no_descendant_topology",
};

function isNestedScope(summary: ExplorationRelativeSummary): boolean {
  const tag = summary.tag?.toLowerCase() ?? null;
  if (tag !== null && NESTED_SCOPE_TAGS.has(tag)) return true;
  const role = summary.role?.toLowerCase() ?? null;
  return role !== null && NESTED_SCOPE_ROLES.has(role);
}

const DESCENDANT_EDGE_ORDER_INCONSISTENT = "descendant_edge_order_inconsistent";

interface DescendantTopology {
  readonly ownedRefs: readonly string[];
  readonly nestedScopeRefs: readonly string[];
  readonly excludedNestedDescendantRefs: readonly string[];
  readonly excludedRefsByNestedRoot: ReadonlyMap<string, readonly string[]>;
}

interface DescendantTopologyResult {
  readonly topology: DescendantTopology | null;
  readonly unknownReason: string | null;
}

function unknownScope(reason: string): OwnedScopeFacts {
  return {
    ownedRefs: [],
    nestedScopeRefs: [],
    excludedNestedDescendantRefs: [],
    status: "unknown",
    unknownReason: reason,
  };
}

// buildExplorationInputs emits descendant edges in preorder DFS. relativeHops
// lets us rebuild that path; a missing hop or duplicate target means the edge
// sequence is not trustworthy, so the scope stays unknown.
function projectDescendantTopology(input: ExplorationInputV1): DescendantTopologyResult {
  const owned: string[] = [];
  const nested: string[] = [];
  const excluded: string[] = [];
  const excludedRefsByNestedRoot = new Map<string, string[]>();
  const path: { readonly nestedRoot: string | null }[] = [];
  const seen = new Set<string>([input.nodeRef]);
  for (const edge of input.containment.descendantEdges) {
    const hops = edge.relativeHops;
    if (!Number.isInteger(hops) || hops < 1 || hops > input.containment.maxRelationHops
      || seen.has(edge.targetRef) || hops > path.length + 1) {
      return { topology: null, unknownReason: DESCENDANT_EDGE_ORDER_INCONSISTENT };
    }
    path.length = hops - 1;
    seen.add(edge.targetRef);
    const inheritedNestedRoot = path.length === 0 ? null : path[path.length - 1]!.nestedRoot;
    const targetIsNested = isNestedScope(edge.target);
    let nestedRoot: string | null;
    if (inheritedNestedRoot !== null) {
      excluded.push(edge.targetRef);
      const refs = excludedRefsByNestedRoot.get(inheritedNestedRoot) ?? [];
      refs.push(edge.targetRef);
      excludedRefsByNestedRoot.set(inheritedNestedRoot, refs);
      nestedRoot = inheritedNestedRoot;
    } else if (targetIsNested) {
      nested.push(edge.targetRef);
      excludedRefsByNestedRoot.set(edge.targetRef, []);
      nestedRoot = edge.targetRef;
    } else {
      owned.push(edge.targetRef);
      nestedRoot = null;
    }
    path.push({ nestedRoot });
  }
  return {
    topology: { ownedRefs: owned, nestedScopeRefs: nested, excludedNestedDescendantRefs: excluded, excludedRefsByNestedRoot },
    unknownReason: null,
  };
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
    return unknownScope(`descendant_boundary_${boundary}`);
  }
  const { topology, unknownReason } = projectDescendantTopology(input);
  if (topology === null) {
    return unknownScope(unknownReason ?? DESCENDANT_EDGE_ORDER_INCONSISTENT);
  }
  return {
    ownedRefs: topology.ownedRefs,
    nestedScopeRefs: topology.nestedScopeRefs,
    excludedNestedDescendantRefs: topology.excludedNestedDescendantRefs,
    status: "complete",
    unknownReason: null,
  };
}

/**
 * Direct text scope only: the observed direct content of a node, excluding any
 * direct child that starts a nested interactive scope. This is what keeps a
 * harness or outer container from swallowing nested scope content.
 */
export function deriveDirectScope(input: ExplorationInputV1): OwnedScopeFacts {
  const status = input.childComposition.directChildrenStatus;
  if (status !== "complete") {
    return unknownScope(`direct_children_${status}`);
  }
  const { topology, unknownReason } = projectDescendantTopology(input);
  const owned: string[] = [];
  const nested: string[] = [];
  for (const child of input.childComposition.children) {
    if (isNestedScope(child)) nested.push(child.nodeRef);
    else owned.push(child.nodeRef);
  }
  // Descendant topology is only needed to exclude a nested direct child's own
  // subtree. With no nested direct child the direct scope stands on its own.
  if (nested.length > 0 && topology === null) {
    return unknownScope(unknownReason ?? DESCENDANT_EDGE_ORDER_INCONSISTENT);
  }
  const excluded: string[] = [];
  for (const ref of nested) excluded.push(...(topology?.excludedRefsByNestedRoot.get(ref) ?? []));
  return {
    ownedRefs: owned,
    nestedScopeRefs: nested,
    excludedNestedDescendantRefs: excluded,
    status: "complete",
    unknownReason: null,
  };
}
