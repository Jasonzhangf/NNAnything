import type { ExplorationContainmentEdge, ExplorationInputV1, ExplorationRelativeSummary } from "./exploration-input.js";

export interface BasicKindContentRelations {
  readonly shallowStructuralPeerRatio: number | null;
  readonly coincidentChildPairRatio: number | null;
  readonly graphicDescendantPresent: boolean | null;
}

const MATERIAL_FIELDS = [
  "nonFormatDirectTextPresent",
  "beforeContentPresent",
  "afterContentPresent",
  "backgroundImagePresent",
  "maskImagePresent",
] as const;

function rectKnown(rect: ExplorationRelativeSummary["rect"]): boolean {
  return rect !== null && Number.isFinite(rect.x) && Number.isFinite(rect.y)
    && Number.isFinite(rect.width) && Number.isFinite(rect.height)
    && rect.width >= 0 && rect.height >= 0;
}

function positive(rect: ExplorationRelativeSummary["rect"]): boolean {
  return rect !== null && rect.width > 0 && rect.height > 0;
}

function withinTwoPixels(left: ExplorationRelativeSummary["rect"], right: ExplorationRelativeSummary["rect"]): boolean {
  return left !== null && right !== null
    && Math.abs(left.x - right.x) <= 2
    && Math.abs(left.y - right.y) <= 2
    && Math.abs(left.width - right.width) <= 2
    && Math.abs(left.height - right.height) <= 2;
}

// descendantEdges are DFS order. Reconstruct the hop parent from the last
// preceding shallower node. Only hop 2 contributes the direct-grandchild tags.
function directGrandchildren(input: ExplorationInputV1): ReadonlyMap<string, readonly ExplorationContainmentEdge[]> | null {
  const directRefs = new Set(input.containment.childRefs);
  const lastAtHop: (string | null)[] = [input.nodeRef];
  const result = new Map<string, ExplorationContainmentEdge[]>();
  const seen = new Set<string>();
  for (const edge of input.containment.descendantEdges) {
    if (seen.has(edge.targetRef) || edge.relativeHops > input.containment.maxRelationHops) return null;
    seen.add(edge.targetRef);
    const parentRef = edge.relativeHops === 1 ? input.nodeRef : lastAtHop[edge.relativeHops - 1] ?? null;
    if (parentRef === null) return null;
    if (edge.relativeHops === 1 && directRefs.has(edge.targetRef)) result.set(edge.targetRef, []);
    if (edge.relativeHops === 2 && directRefs.has(parentRef)) {
      const rows = result.get(parentRef) ?? [];
      rows.push(edge);
      result.set(parentRef, rows);
    }
    lastAtHop[edge.relativeHops] = edge.targetRef;
    for (let hop = edge.relativeHops + 1; hop < lastAtHop.length; hop++) lastAtHop[hop] = null;
  }
  return [...directRefs].every(ref => seen.has(ref)) ? result : null;
}

function normalizedRole(role: string | null): string {
  return role === null ? "none" : role.trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

function relativeCoveragePresent(child: ExplorationRelativeSummary): boolean {
  return child.childElementCount !== undefined
    || child.directChildrenStatus !== undefined
    || child.unassessedInterior !== undefined;
}

function boundedTopologyComplete(input: ExplorationInputV1, child: ExplorationRelativeSummary, grandchildren: readonly ExplorationContainmentEdge[]): boolean {
  if (input.childComposition.directChildrenStatus !== "complete" || input.containment.maxRelationHops < 2) return false;
  const complete = relativeCoveragePresent(child)
    ? typeof child.childElementCount === "number"
      && child.directChildrenStatus === "complete"
      && child.unassessedInterior?.length === 0
      && child.childElementCount === grandchildren.length
    : input.containment.descendantBoundary === "complete" || input.containment.descendantBoundary === "hop_limit_reached";
  return complete && grandchildren.every(entry => entry.target.tag !== null
    && entry.target.positiveArea !== null && rectKnown(entry.target.rect));
}

function shallowSignature(
  input: ExplorationInputV1,
  child: ExplorationRelativeSummary,
  grandchildren: readonly ExplorationContainmentEdge[],
): string | null {
  if (child.tag === null || child.directTextPresent === null) return null;
  if (!boundedTopologyComplete(input, child, grandchildren)) return null;
  const material = MATERIAL_FIELDS.map(field => child[field]);
  if (material.some(value => value == null)) return null;
  const tags = grandchildren.filter(entry => positive(entry.target.rect))
    .map(entry => entry.target.tag!.trim().toLowerCase())
    .sort()
    .join(",");
  return [child.tag.trim().toLowerCase(), normalizedRole(child.role), child.directTextPresent, ...material, tags].join("|");
}

function distinctRectSlots(rects: readonly NonNullable<ExplorationRelativeSummary["rect"]>[]): number {
  const slots: NonNullable<ExplorationRelativeSummary["rect"]>[] = [];
  for (const rect of rects) {
    if (!slots.some(slot => withinTwoPixels(slot, rect))) slots.push(rect);
  }
  return slots.length;
}

function coincidentPairKnown(input: ExplorationInputV1): boolean {
  if (input.geometry.rect === null || !rectKnown(input.geometry.rect)) return false;
  if (input.measurementCoverage.positiveAreaChildCount !== "measured" || input.childComposition.directChildrenStatus !== "complete") return false;
  if (input.containment.positiveAreaChildRefs === null) return false;
  return input.childComposition.children.every(child => child.positiveArea !== null && rectKnown(child.rect));
}

const GRAPHIC_TAGS = new Set(["img", "picture", "svg", "canvas"]);

function graphicFact(target: ExplorationRelativeSummary): boolean {
  const tag = target.tag?.trim().toLowerCase() ?? null;
  const roles = target.role?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  return (tag !== null && GRAPHIC_TAGS.has(tag))
    || roles.includes("img")
    || target.backgroundImagePresent === true
    || target.maskImagePresent === true;
}

function graphicDescendantPresent(input: ExplorationInputV1): boolean | null {
  const edges = input.containment.descendantEdges.filter(edge => edge.relativeHops <= 2);
  if (edges.some(edge => graphicFact(edge.target))) return true;
  if (input.childComposition.directChildrenStatus !== "complete"
    || input.measurementCoverage.unassessedInterior.length > 0
    || input.containment.maxRelationHops < 2) return null;
  const grandchildren = directGrandchildren(input);
  if (grandchildren === null) return null;
  if (edges.some(edge => edge.target.tag === null
    || edge.target.backgroundImagePresent == null
    || edge.target.maskImagePresent == null)) return null;
  return input.childComposition.children.every(child => boundedTopologyComplete(input, child, grandchildren.get(child.nodeRef) ?? [])) ? false : null;
}

export function deriveBasicKindContentRelations(input: ExplorationInputV1): BasicKindContentRelations {
  const graphic = graphicDescendantPresent(input);
  const directKnown = input.childComposition.directChildrenStatus === "complete"
    && input.measurementCoverage.positiveAreaChildCount === "measured"
    && input.containment.positiveAreaChildRefs !== null
    && input.childComposition.children.every(child => child.positiveArea !== null && rectKnown(child.rect));
  if (!directKnown) return { shallowStructuralPeerRatio: null, coincidentChildPairRatio: null, graphicDescendantPresent: graphic };
  const positiveChildren = input.childComposition.children.filter(child => child.positiveArea === true);
  const grandchildren = directGrandchildren(input);
  let shallowStructuralPeerRatio: number | null = null;
  if (positiveChildren.length < 2) shallowStructuralPeerRatio = 0;
  else if (grandchildren !== null) {
    const rows = positiveChildren.map(child => {
      const edges = grandchildren.get(child.nodeRef) ?? [];
      return shallowSignature(input, child, edges);
    });
    if (rows.every((signature): signature is string => signature !== null)) {
      const groups = new Map<string, NonNullable<ExplorationRelativeSummary["rect"]>[]>();
      for (let index = 0; index < rows.length; index++) {
        const signature = rows[index]!;
        const group = groups.get(signature) ?? [];
        group.push(positiveChildren[index]!.rect!);
        groups.set(signature, group);
      }
      let modal = 0;
      for (const rects of groups.values()) {
        const slots = distinctRectSlots(rects);
        if (slots >= 2) modal = Math.max(modal, slots);
      }
      shallowStructuralPeerRatio = modal / positiveChildren.length;
    }
  }

  let coincidentChildPairRatio: number | null = null;
  if (positiveChildren.length < 2) coincidentChildPairRatio = 0;
  else if (coincidentPairKnown(input)) {
    const parent = input.geometry.rect;
    const matching = positiveChildren.filter(child => withinTwoPixels(child.rect, parent)
      && positiveChildren.some(other => other.nodeRef !== child.nodeRef && withinTwoPixels(child.rect, other.rect))).length;
    coincidentChildPairRatio = matching / positiveChildren.length;
  }
  return { shallowStructuralPeerRatio, coincidentChildPairRatio, graphicDescendantPresent: graphic };
}
