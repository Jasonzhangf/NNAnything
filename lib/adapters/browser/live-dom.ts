import type { BasicKindMeasurements, BasicKindProperties } from "../../filters/basic-kinds.js";
import { isSafeRuleAttribute, type ObservationNode, type PageObservation, type Rect } from "./observation.js";

export interface StableNodeRefRegistry {
  readonly refByElement: WeakMap<Element, string>;
  readonly elementByRef: Map<string, WeakRef<Element>>;
  readonly nextSequence: { value: number };
  readonly prefix: string;
}
export function createStableNodeRefRegistry(prefix = "node"): StableNodeRefRegistry {
  return { prefix, refByElement: new WeakMap(), elementByRef: new Map(), nextSequence: { value: 0 } };
}
export function stableNodeRefFor(registry: StableNodeRefRegistry, element: Element): string {
  let ref = registry.refByElement.get(element);
  if (!ref) {
    ref = `${registry.prefix}-${++registry.nextSequence.value}`;
    registry.refByElement.set(element, ref);
    registry.elementByRef.set(ref, new WeakRef(element));
  }
  return ref;
}
export function resolveStableNodeRef(registry: StableNodeRefRegistry, nodeRef: string): Element | null {
  const element = registry.elementByRef.get(nodeRef)?.deref();
  if (!element) { registry.elementByRef.delete(nodeRef); return null; }
  if (element.isConnected === false) return null;
  return element;
}
export interface LiveCaptureCoverage {
  readonly scope: "top_document_only";
  readonly frameContent: "captured";
  readonly directChildren: "complete";
  readonly traversedElementCount: number;
  readonly excludedElementCount: number;
  readonly unassessedIframeCount: number;
  readonly unassessedOpenShadowRootCount: number;
  readonly closedShadowRootDetection: "not_available";
}
export interface LiveDomEvidence {
  readonly nodeRef: string;
  readonly tag: string;
  readonly id: string | null;
  readonly classList: readonly string[];
  readonly textSummary: string | null;
  readonly linkPathname: string | null;
  readonly rect: Rect | null;
  readonly clippedRect: Rect | null;
  readonly parentTags: readonly string[];
  readonly unassessedChildContent?: readonly string[];
}
export interface LiveDomSnapshot {
  readonly snapshotRef: string;
  readonly documentRef: string;
  readonly frameRef: string;
  readonly pageRef: string;
  readonly observation: PageObservation;
  readonly itemObservations: readonly ({ nodeRef: string } & BasicKindMeasurements)[];
  readonly properties: ReadonlyMap<string, BasicKindProperties>;
  readonly evidence: ReadonlyMap<string, LiveDomEvidence>;
  readonly coverage: LiveCaptureCoverage;
  resolveElement(nodeRef: string): Element | null;
}

const rectOf = (r: DOMRect | DOMRectReadOnly): Rect => ({ x: r.x, y: r.y, width: r.width, height: r.height });
const roleTokens = (element: Element): string[] => String(element.getAttribute("role") ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
function listParentMeasured(element: Element): boolean {
  const parent = element.parentElement;
  if (!parent) return false;
  return ["ul", "ol", "dl"].includes(parent.tagName.toLowerCase())
    || roleTokens(parent).some(role => ["list", "feed", "menu", "tablist"].includes(role));
}
function repeatedChildGeometry(children: readonly Element[]): boolean | null {
  const measured = children.map(child => child.getBoundingClientRect());
  if (measured.some(box => ![box.x, box.y, box.width, box.height].every(Number.isFinite))) return null;
  const boxes = measured.filter(box => box.width > 0 && box.height > 0);
  if (boxes.length < 2) return false;
  for (let left = 0; left < boxes.length; left++) {
    for (let right = left + 1; right < boxes.length; right++) {
      const a = boxes[left]!, b = boxes[right]!;
      if (Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2
        && ((Math.abs(a.y - b.y) <= 2 && Math.abs(a.x - b.x) > 2)
          || (Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) > 2))) return true;
    }
  }
  return false;
}
function svgGraphicChildren(element: Element, tag: string): boolean | null {
  if (tag !== "svg") return false;
  const children = Array.from(element.children ?? []);
  if (element.childElementCount === 0) return false;
  return children.some(child => ["path", "use", "g", "circle", "rect", "line", "polyline", "polygon", "ellipse", "image", "text"].includes(String(child.tagName ?? "").toLowerCase()));
}
function safeText(root: Element): string | null {
  let text = "";
  const stack: Node[] = [root];
  while (stack.length && text.length < 180) {
    const node = stack.pop()!;
    if (node.nodeType === 3) text += (node.textContent ?? "").slice(0, 180 - text.length);
    else if (node.nodeType === 1 && !["INPUT", "TEXTAREA", "SCRIPT", "STYLE"].includes((node as Element).tagName)) stack.push(...Array.from(node.childNodes).reverse());
  }
  return text.trim() || null;
}
function is2DTranslation(transform: string): boolean {
  if (!transform || transform === "none") return true;
  const match = /^matrix\(([^)]+)\)$/.exec(transform);
  if (!match) return false;
  const fields = match[1]!.split(",").map(value => value.trim());
  const values = fields.map(Number);
  return fields.length === 6 && fields.every(value => value.length > 0) && values.every(Number.isFinite)
    && values[0] === 1 && values[1] === 0 && values[2] === 0 && values[3] === 1;
}
function clippedBox(element: Element, window: Window, rect: Rect): Rect | null {
  let left = rect.x, top = rect.y, right = rect.x + rect.width, bottom = rect.y + rect.height;
  for (let parent: Element | null = element; parent; parent = parent.parentElement) {
    const style = window.getComputedStyle(parent);
    // Viewport rects already include translation; client offsets retain their unit scale.
    // Other transforms and unassessed clipping still cannot supply a trusted rectangle.
    if (!is2DTranslation(style.transform)
      || [style.translate, style.rotate, style.scale, style.perspective].some(value => value && value !== "none")
      || (style.clipPath && style.clipPath !== "none") || (style.clip && style.clip !== "auto") || style.contain?.includes("paint")) return null;
    if (parent === element) continue;
    const clipsX = ["hidden", "clip", "scroll", "auto"].includes(style.overflowX);
    const clipsY = ["hidden", "clip", "scroll", "auto"].includes(style.overflowY);
    if (!clipsX && !clipsY) continue;
    const bounds = parent.getBoundingClientRect();
    const x = bounds.x + parent.clientLeft, y = bounds.y + parent.clientTop;
    if (clipsX) { left = Math.max(left, x); right = Math.min(right, x + parent.clientWidth); }
    if (clipsY) { top = Math.max(top, y); bottom = Math.min(bottom, y + parent.clientHeight); }
  }
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function observeLiveDom(input: {
  document: Document; window: Window; registry: StableNodeRefRegistry; excludeRoot: Element | null; snapshotRef: string; documentRef: string;
}): LiveDomSnapshot {
  const { document, window, registry } = input;
  const nodes: ObservationNode[] = [], itemObservations: ({ nodeRef: string } & BasicKindMeasurements)[] = [];
  const properties = new Map<string, BasicKindProperties>(), evidence = new Map<string, LiveDomEvidence>();
  const stack: Element[] = document.documentElement ? [document.documentElement] : [];
  let excluded = 0, frames = 0, shadows = 0;
  while (stack.length) {
    const element = stack.pop()!;
    if (element === input.excludeRoot) { excluded += 1 + element.querySelectorAll("*").length; continue; }
    const allChildren = Array.from(element.children), children = allChildren.filter(child => child !== input.excludeRoot);
    for (let index = allChildren.length - 1; index >= 0; index--) stack.push(allChildren[index]!);
    const nodeRef = stableNodeRefFor(registry, element), tag = element.tagName.toLowerCase();
    const style = window.getComputedStyle(element), rect = rectOf(element.getBoundingClientRect());
    const visible = style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
    const fragments = visible ? Array.from(element.getClientRects(), rectOf) : [];
    const clippedRect = clippedBox(element, window, rect);
    const attributes: Record<string, string | boolean> = {};
    for (const key of ["aria-disabled", "aria-expanded", "aria-hidden", "aria-selected", "contenteditable", "disabled", "hidden", "tabindex"]) {
      const value = element.getAttribute(key);
      if (value !== null && isSafeRuleAttribute(key)) attributes[key] = value;
    }
    // Complete live DOM observation makes absent HTML boolean attributes known false.
    attributes.disabled = element.hasAttribute("disabled");
    attributes.hidden = element.hasAttribute("hidden");
    const role = element.getAttribute("role");
    nodes.push({ nodeRef, parentRef: element.parentElement ? stableNodeRefFor(registry, element.parentElement) : null, tag, role, rect, fragments, clippedRect, attributes });
    const positiveAreaChildren = children.filter(child => { const r = child.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    const local: BasicKindMeasurements = {
      inputType: tag === "input" ? element.getAttribute("type") || "text" : null,
      hrefPresent: element.hasAttribute("href"),
      contentEditable: (element as HTMLElement).isContentEditable === true,
      directTextPresent: Array.from(element.childNodes).some(node => node.nodeType === 3 && Boolean(node.textContent?.trim())),
      childElementCount: children.length,
      positiveAreaChildCount: positiveAreaChildren.length,
      repeatedChildGeometry: repeatedChildGeometry(children),
      inVerifiedListParent: listParentMeasured(element),
      svgGraphicChildren: svgGraphicChildren(element, tag),
    };
    itemObservations.push({ nodeRef, ...local });
    properties.set(nodeRef, { ...local, tag, role, disabled: element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true", hidden: element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true" });
    const parents: string[] = [];
    for (let p = element.parentElement; p && parents.length < 3; p = p.parentElement) parents.push(p.tagName.toLowerCase());
    let linkPathname: string | null = null;
    const href = element.getAttribute("href");
    if (href && !href.startsWith("javascript:")) { try { linkPathname = new URL(href, document.baseURI).pathname; } catch { /* Invalid link is evidence, not a navigation request. */ } }
    const unassessedChildContent: string[] = [];
    if (tag === "iframe") { frames++; unassessedChildContent.push("iframe"); }
    if (element.shadowRoot) { shadows++; unassessedChildContent.push("shadow_root"); }
    evidence.set(nodeRef, { nodeRef, tag, id: element.id || null, classList: Array.from(element.classList), textSummary: safeText(element), linkPathname, rect, clippedRect, parentTags: parents, unassessedChildContent });
  }
  for (const ref of registry.elementByRef.keys()) resolveStableNodeRef(registry, ref);
  const clipping = nodes.every(node => node.clippedRect !== null) ? "assessed" : nodes.some(node => node.clippedRect !== null) ? "mixed" : "unassessed";
  return {
    snapshotRef: input.snapshotRef, documentRef: input.documentRef, frameRef: "top", pageRef: input.documentRef,
    observation: { viewport: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }, nodes, coverage: { geometry: "assessed", fragments: "assessed", clipping } },
    itemObservations, properties, evidence,
    coverage: { scope: "top_document_only", frameContent: "captured", directChildren: "complete", traversedElementCount: nodes.length, excludedElementCount: excluded, unassessedIframeCount: frames, unassessedOpenShadowRootCount: shadows, closedShadowRootDetection: "not_available" },
    resolveElement: ref => resolveStableNodeRef(registry, ref),
  };
}
