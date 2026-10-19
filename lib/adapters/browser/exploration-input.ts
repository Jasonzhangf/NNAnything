import { expectRecord, expectNonEmptyString } from "../../core/schema.js";
import type { BasicKindMeasurements } from "../../filters/basic-kinds.js";
import type { ObservationNode, PageObservation, Rect } from "./observation.js";

export type MeasurementStatus = "measured" | "unmeasured" | "not_applicable";
export type DirectChildrenCoverage = "complete" | "incomplete" | "unknown";
type Boundary = "complete" | "hop_limit_reached" | "incomplete_observation" | "unknown";
export interface ExplorationRelativeSummary {
  readonly nodeRef: string; readonly tag: string | null; readonly role: string | null;
  readonly rect: Rect | null; readonly positiveArea: boolean | null; readonly directTextPresent: boolean | null;
  readonly nonFormatDirectTextPresent?: boolean | null; readonly beforeContentPresent?: boolean | null;
  readonly afterContentPresent?: boolean | null; readonly backgroundImagePresent?: boolean | null; readonly maskImagePresent?: boolean | null;
  readonly childElementCount?: number | null; readonly directChildrenStatus?: DirectChildrenCoverage | null;
  readonly unassessedInterior?: readonly ("iframe" | "shadow_root")[] | null;
}
export interface ExplorationContainmentEdge {
  readonly relation: "contained_by" | "contains"; readonly relativeHops: number;
  readonly targetRef: string; readonly target: ExplorationRelativeSummary;
}
const appearanceFields = ["nonFormatDirectTextPresent", "beforeContentPresent", "afterContentPresent", "backgroundImagePresent", "maskImagePresent"] as const;
const interactionFields = ["pointerCursor", "parentPointerCursor", "tabIndexFocus", "activeElementFocus", "borderPresent", "aspectRatio", "descendantTextPresent", "directListChildPresent", "singleChildTag", "singleChildSameRect", "withinControlAncestor", "inSvgAncestor"] as const;
const coverageFields = ["role", "inputType", "hrefPresent", "contentEditable", "directTextPresent", ...appearanceFields, "childElementCount", "positiveAreaChildCount", "repeatedChildGeometry", "inVerifiedListParent", "svgGraphicChildren", ...interactionFields, "ownLabelPresent", "graphicDescendantPresent", "shallowStructuralPeerRatio", "coincidentChildPairRatio", "clippedRect"] as const;
export interface ExplorationInputV1 {
  readonly schemaVersion: 1; readonly nodeRef: string;
  readonly containment: {
    readonly maxRelationHops: number; readonly parentRef: string | null;
    readonly parentStatus: "root" | "observed" | "missing_parent_observation" | "unknown";
    readonly childRefs: readonly string[]; readonly positiveAreaChildRefs: readonly string[] | null;
    readonly ancestorEdges: readonly ExplorationContainmentEdge[]; readonly descendantEdges: readonly ExplorationContainmentEdge[];
    readonly ancestorBoundary: Boundary; readonly descendantBoundary: Boundary;
  };
  readonly childComposition: {
    readonly directChildrenStatus: DirectChildrenCoverage; readonly children: readonly ExplorationRelativeSummary[];
    readonly childTagCounts: Readonly<Record<string, number>> | null;
    readonly positiveAreaChildTagCounts: Readonly<Record<string, number>> | null;
  };
  readonly geometry: { readonly rect: Rect | null; readonly clippedRect: Rect | null; readonly parentRect: Rect | null };
  readonly measurementCoverage: Readonly<Record<typeof coverageFields[number], MeasurementStatus>> & {
    readonly directChildren: DirectChildrenCoverage; readonly unassessedInterior: readonly ("iframe" | "shadow_root")[];
  };
}
const own = (x: Record<string, unknown>, keys: readonly string[]) => {
  for (const key of Object.keys(x)) if (!keys.includes(key)) throw new TypeError(`unsupported exploration field ${key}`);
};
function record(x: unknown, keys: readonly string[]): Record<string, unknown> { const r = expectRecord(x, "exploration"); own(r, keys); return r; }
function choice<T extends string>(x: unknown, values: readonly T[]): T { if (!values.includes(x as T)) throw new TypeError(`invalid exploration value ${String(x)}`); return x as T; }
function integer(x: unknown, min = 0): number { if (typeof x !== "number" || !Number.isInteger(x) || x < min) throw new TypeError("exploration count/hops must be a nonnegative integer"); return x; }
const text = (x: unknown): string | null => x === null ? null : expectNonEmptyString(x, "exploration text");
const array = (x: unknown): unknown[] => { if (!Array.isArray(x)) throw new TypeError("exploration array required"); return x; };
const refs = (x: unknown) => array(x).map(v => expectNonEmptyString(v, "nodeRef"));
function rectangle(x: unknown): Rect | null {
  if (x === null) return null;
  const r = record(x, ["x", "y", "width", "height"]);
  for (const k of ["x", "y", "width", "height"]) if (typeof r[k] !== "number" || !Number.isFinite(r[k])) throw new TypeError("finite exploration rectangle required");
  if ((r.width as number) < 0 || (r.height as number) < 0) throw new TypeError("negative rectangle size");
  return { x: r.x as number, y: r.y as number, width: r.width as number, height: r.height as number };
}
function relative(x: unknown): ExplorationRelativeSummary {
  const r = record(x, ["nodeRef", "tag", "role", "rect", "positiveArea", "directTextPresent", ...appearanceFields, "childElementCount", "directChildrenStatus", "unassessedInterior"]);
  for (const key of ["positiveArea", "directTextPresent"]) if (r[key] !== null && typeof r[key] !== "boolean") throw new TypeError("nullable exploration boolean required");
  for (const key of appearanceFields) if (r[key] !== undefined && r[key] !== null && typeof r[key] !== "boolean") throw new TypeError("nullable exploration boolean required");
  const row: ExplorationRelativeSummary = { nodeRef: expectNonEmptyString(r.nodeRef, "nodeRef"), tag: text(r.tag), role: text(r.role), rect: rectangle(r.rect), positiveArea: r.positiveArea as boolean | null, directTextPresent: r.directTextPresent as boolean | null,
    nonFormatDirectTextPresent: (r.nonFormatDirectTextPresent ?? null) as boolean | null, beforeContentPresent: (r.beforeContentPresent ?? null) as boolean | null, afterContentPresent: (r.afterContentPresent ?? null) as boolean | null, backgroundImagePresent: (r.backgroundImagePresent ?? null) as boolean | null, maskImagePresent: (r.maskImagePresent ?? null) as boolean | null };
  const childElementCount = r.childElementCount === undefined ? undefined : r.childElementCount === null ? null : integer(r.childElementCount);
  const directChildrenStatus = r.directChildrenStatus === undefined ? undefined : r.directChildrenStatus === null ? null : choice(r.directChildrenStatus, ["complete", "incomplete", "unknown"] as const);
  const unassessedInterior = r.unassessedInterior === undefined ? undefined : r.unassessedInterior === null ? null : array(r.unassessedInterior).map(v => choice(v, ["iframe", "shadow_root"] as const));
  return { ...row,
    ...(childElementCount === undefined ? {} : { childElementCount }),
    ...(directChildrenStatus === undefined ? {} : { directChildrenStatus }),
    ...(unassessedInterior === undefined ? {} : { unassessedInterior }),
  };
}
function counts(x: unknown): Record<string, number> | null {
  if (x === null) return null;
  return Object.fromEntries(Object.entries(expectRecord(x, "tag counts")).map(([k, v]) => [expectNonEmptyString(k, "tag"), integer(v)]));
}
export function validateExplorationInput(value: unknown): ExplorationInputV1 {
  const r = record(value, ["schemaVersion", "nodeRef", "containment", "childComposition", "geometry", "measurementCoverage"]);
  if (r.schemaVersion !== 1) throw new TypeError("exploration schemaVersion must be 1");
  const c = record(r.containment, ["maxRelationHops", "parentRef", "parentStatus", "childRefs", "positiveAreaChildRefs", "ancestorEdges", "descendantEdges", "ancestorBoundary", "descendantBoundary"]);
  const maxRelationHops = integer(c.maxRelationHops, 1);
  const edges = (x: unknown, direction: "contains" | "contained_by") => array(x).map(v => {
    const edge = record(v, ["relation", "relativeHops", "targetRef", "target"]);
    const relativeHops = integer(edge.relativeHops, 1), target = relative(edge.target), targetRef = expectNonEmptyString(edge.targetRef, "targetRef");
    if (relativeHops > maxRelationHops || target.nodeRef !== targetRef || targetRef === r.nodeRef) throw new TypeError("invalid exploration relation target/hops");
    return { relation: choice(edge.relation, [direction]), relativeHops, targetRef, target };
  });
  const children = record(r.childComposition, ["directChildrenStatus", "children", "childTagCounts", "positiveAreaChildTagCounts"]);
  const geometry = record(r.geometry, ["rect", "clippedRect", "parentRect"]);
  const coverageInput = expectRecord(r.measurementCoverage, "measurementCoverage");
  own(coverageInput, [...coverageFields, "directChildren", "unassessedInterior"]);
  const coverage = { directChildren: coverageInput.directChildren, unassessedInterior: coverageInput.unassessedInterior } as Record<string, unknown>;
  for (const key of coverageFields) {
    coverage[key] = coverageInput[key] === undefined
      && ((appearanceFields as readonly string[]).includes(key)
        || (interactionFields as readonly string[]).includes(key)
        || ["ownLabelPresent", "graphicDescendantPresent", "shallowStructuralPeerRatio", "coincidentChildPairRatio"].includes(key))
      ? "unmeasured"
      : coverageInput[key];
  }
  const directChildrenStatus = choice(children.directChildrenStatus, ["complete", "incomplete", "unknown"] as const);
  const childRefs = refs(c.childRefs), childRows = array(children.children).map(relative);
  const positiveAreaChildRefs = c.positiveAreaChildRefs === null ? null : refs(c.positiveAreaChildRefs);
  const childTagCounts = counts(children.childTagCounts), positiveAreaChildTagCounts = counts(children.positiveAreaChildTagCounts);
  if (JSON.stringify(childRefs) !== JSON.stringify(childRows.map(child => child.nodeRef))) throw new TypeError("childRefs disagree with exploration children");
  if (positiveAreaChildRefs?.some(ref => !childRefs.includes(ref))) throw new TypeError("unknown positiveArea childRef");
  if (coverage.directChildren !== directChildrenStatus || (directChildrenStatus !== "complete" && (childTagCounts !== null || positiveAreaChildTagCounts !== null || positiveAreaChildRefs !== null))) throw new TypeError("incomplete exploration cannot carry complete counts");
  return {
    schemaVersion: 1, nodeRef: expectNonEmptyString(r.nodeRef, "nodeRef"),
    containment: { maxRelationHops, parentRef: text(c.parentRef), parentStatus: choice(c.parentStatus, ["root", "observed", "missing_parent_observation", "unknown"] as const), childRefs, positiveAreaChildRefs,
      ancestorEdges: edges(c.ancestorEdges, "contained_by"), descendantEdges: edges(c.descendantEdges, "contains"), ancestorBoundary: choice(c.ancestorBoundary, ["complete", "hop_limit_reached", "incomplete_observation", "unknown"] as const), descendantBoundary: choice(c.descendantBoundary, ["complete", "hop_limit_reached", "incomplete_observation", "unknown"] as const) },
    childComposition: { directChildrenStatus, children: childRows, childTagCounts, positiveAreaChildTagCounts },
    geometry: { rect: rectangle(geometry.rect), clippedRect: rectangle(geometry.clippedRect), parentRect: rectangle(geometry.parentRect) },
      measurementCoverage: { ...Object.fromEntries(coverageFields.map(k => [k, choice(coverage[k], ["measured", "unmeasured", "not_applicable"] as const)])) as Record<typeof coverageFields[number], MeasurementStatus>, directChildren: directChildrenStatus, unassessedInterior: array(coverage.unassessedInterior).map(v => choice(v, ["iframe", "shadow_root"] as const)) },
  };
}

export function buildExplorationInputs(input: {
  observation: PageObservation; itemObservations?: readonly ({ readonly nodeRef: string } & BasicKindMeasurements)[];
  maxRelationHops: number; directChildrenStatus?: DirectChildrenCoverage; rootNodeRef?: string;
  unassessedInteriors?: ReadonlyMap<string, readonly ("iframe" | "shadow_root")[]>;
}): ReadonlyMap<string, ExplorationInputV1> {
  if (!Number.isInteger(input.maxRelationHops) || input.maxRelationHops < 1) throw new TypeError("maxRelationHops must be an explicit positive integer");
  const nodes = new Map(input.observation.nodes.map(n => [n.nodeRef, n]));
  if (nodes.size !== input.observation.nodes.length) throw new TypeError("duplicate exploration nodeRef");
  const locals = new Map(input.itemObservations?.map(n => [n.nodeRef, n]));
  const children = new Map<string, ObservationNode[]>();
  for (const n of nodes.values()) if (n.parentRef !== null) { const list = children.get(n.parentRef) ?? []; list.push(n); children.set(n.parentRef, list); }
  const childNodes = (ref: string) => children.get(ref) ?? [];
  const geometry = (r: Rect | null): Rect | null => r && Object.values(r).every(Number.isFinite) && input.observation.coverage.geometry !== "unassessed" ? { ...r } : null;
  const summary = (n: ObservationNode): ExplorationRelativeSummary => { const rect = geometry(n.rect), local = locals.get(n.nodeRef); return { nodeRef: n.nodeRef, tag: n.tag, role: n.role, rect, positiveArea: rect ? rect.width > 0 && rect.height > 0 : null, directTextPresent: local?.directTextPresent ?? null,
    nonFormatDirectTextPresent: local?.nonFormatDirectTextPresent ?? null, beforeContentPresent: local?.beforeContentPresent ?? null, afterContentPresent: local?.afterContentPresent ?? null, backgroundImagePresent: local?.backgroundImagePresent ?? null, maskImagePresent: local?.maskImagePresent ?? null,
    childElementCount: local?.childElementCount ?? null, directChildrenStatus: status(n.nodeRef), unassessedInterior: [...interiors(n.nodeRef)] }; };
  const status = (ref: string): DirectChildrenCoverage => {
    const requested = input.directChildrenStatus ?? "unknown", measured = locals.get(ref)?.childElementCount;
    return requested === "complete" && measured != null && measured !== childNodes(ref).length ? "incomplete" : requested;
  };
  const interiors = (ref: string) => input.unassessedInteriors?.get(ref) ?? [];
  const parentStatus = (n: ObservationNode): ExplorationInputV1["containment"]["parentStatus"] => n.parentRef !== null ? nodes.has(n.parentRef) ? "observed" : "missing_parent_observation" : n.nodeRef === input.rootNodeRef || n.tag === "html" ? "root" : "unknown";
  const tagCounts = (rows: readonly ExplorationRelativeSummary[]) => rows.some(row => row.tag === null) ? null : Object.fromEntries([...new Set(rows.map(row => row.tag!))].map(tag => [tag, rows.filter(row => row.tag === tag).length]));
  const result = new Map<string, ExplorationInputV1>();
  for (const node of nodes.values()) {
    const local = locals.get(node.nodeRef), directChildrenStatus = status(node.nodeRef), direct = childNodes(node.nodeRef).map(summary);
    const ancestorEdges: ExplorationContainmentEdge[] = [], descendantEdges: ExplorationContainmentEdge[] = [];
    let cursor = node, ancestorBoundary: Boundary = "unknown";
    const seen = new Set([node.nodeRef]);
    for (;;) {
      const p = parentStatus(cursor);
      if (p !== "observed") { ancestorBoundary = p === "root" ? "complete" : p === "missing_parent_observation" ? "incomplete_observation" : "unknown"; break; }
      if (ancestorEdges.length === input.maxRelationHops) { ancestorBoundary = "hop_limit_reached"; break; }
      cursor = nodes.get(cursor.parentRef!)!;
      if (seen.has(cursor.nodeRef)) throw new TypeError("cyclic exploration containment");
      seen.add(cursor.nodeRef);
      ancestorEdges.push({ relation: "contained_by", relativeHops: ancestorEdges.length + 1, targetRef: cursor.nodeRef, target: summary(cursor) });
    }
    let incomplete = false, unknown = false, truncated = false;
    const inspect = (n: ObservationNode) => { const s = status(n.nodeRef); incomplete ||= s === "incomplete" || interiors(n.nodeRef).length > 0; unknown ||= s === "unknown"; };
    inspect(node);
    const stack = childNodes(node.nodeRef).slice().reverse().map(n => ({ n, hops: 1 })), visited = new Set([node.nodeRef]);
    while (stack.length) {
      const { n, hops } = stack.pop()!;
      if (visited.has(n.nodeRef)) throw new TypeError("cyclic exploration containment");
      visited.add(n.nodeRef); inspect(n);
      descendantEdges.push({ relation: "contains", relativeHops: hops, targetRef: n.nodeRef, target: summary(n) });
      if (hops === input.maxRelationHops) truncated ||= childNodes(n.nodeRef).length > 0;
      else for (const child of childNodes(n.nodeRef).slice().reverse()) stack.push({ n: child, hops: hops + 1 });
    }
    const measured = (k: keyof BasicKindMeasurements): MeasurementStatus => local?.[k] == null || local[k] === "" ? "unmeasured" : "measured";
    const positiveKnown = directChildrenStatus === "complete" && direct.every(child => child.positiveArea !== null);
    const positive = direct.filter(child => child.positiveArea === true);
    result.set(node.nodeRef, {
      schemaVersion: 1, nodeRef: node.nodeRef,
      containment: { maxRelationHops: input.maxRelationHops, parentRef: node.parentRef, parentStatus: parentStatus(node), childRefs: direct.map(child => child.nodeRef), positiveAreaChildRefs: positiveKnown ? positive.map(child => child.nodeRef) : null, ancestorEdges, descendantEdges, ancestorBoundary, descendantBoundary: incomplete ? "incomplete_observation" : unknown ? "unknown" : truncated ? "hop_limit_reached" : "complete" },
      childComposition: { directChildrenStatus, children: direct, childTagCounts: directChildrenStatus === "complete" ? tagCounts(direct) : null, positiveAreaChildTagCounts: positiveKnown ? tagCounts(positive) : null },
      geometry: { rect: geometry(node.rect), clippedRect: input.observation.coverage.clipping === "unassessed" ? null : node.clippedRect ? { ...node.clippedRect } : null, parentRect: geometry(nodes.get(node.parentRef ?? "")?.rect ?? null) },
      measurementCoverage: { role: node.role === undefined ? "unmeasured" : "measured", inputType: node.tag === "input" ? measured("inputType") : "not_applicable", hrefPresent: measured("hrefPresent"), contentEditable: measured("contentEditable"), directTextPresent: measured("directTextPresent"), nonFormatDirectTextPresent: measured("nonFormatDirectTextPresent"), beforeContentPresent: measured("beforeContentPresent"), afterContentPresent: measured("afterContentPresent"), backgroundImagePresent: measured("backgroundImagePresent"), maskImagePresent: measured("maskImagePresent"), childElementCount: measured("childElementCount"), positiveAreaChildCount: measured("positiveAreaChildCount"), repeatedChildGeometry: measured("repeatedChildGeometry"), inVerifiedListParent: measured("inVerifiedListParent"), svgGraphicChildren: node.tag === "svg" ? measured("svgGraphicChildren") : "not_applicable", pointerCursor: measured("pointerCursor"), parentPointerCursor: measured("parentPointerCursor"), tabIndexFocus: measured("tabIndexFocus"), activeElementFocus: measured("activeElementFocus"), borderPresent: measured("borderPresent"), aspectRatio: measured("aspectRatio"), descendantTextPresent: measured("descendantTextPresent"), directListChildPresent: directChildrenStatus === "complete" ? measured("directListChildPresent") : "unmeasured", singleChildTag: measured("singleChildTag"), singleChildSameRect: measured("singleChildSameRect"), withinControlAncestor: measured("withinControlAncestor"), inSvgAncestor: measured("inSvgAncestor"), ownLabelPresent: measured("ownLabelPresent"), graphicDescendantPresent: measured("graphicDescendantPresent"), shallowStructuralPeerRatio: measured("shallowStructuralPeerRatio"), coincidentChildPairRatio: measured("coincidentChildPairRatio"), clippedRect: input.observation.coverage.clipping !== "unassessed" && node.clippedRect !== null ? "measured" : "unmeasured", directChildren: directChildrenStatus, unassessedInterior: [...interiors(node.nodeRef)] },
    });
  }
  return result;
}
