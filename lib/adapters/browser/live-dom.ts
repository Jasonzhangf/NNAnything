import { hasNonFormatDirectText, shapeAppearanceMeasurements, type BasicKindMeasurements, type BasicKindProperties } from "../../filters/basic-kinds.js";
import { isSafeRuleAttribute, type ForegroundState, type ObservationNode, type PageObservation, type Rect } from "./observation.js";
import { buildExplorationInputs, type ExplorationInputV1 } from "./exploration-input.js";

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
  readonly explorationInputs?: ReadonlyMap<string, ExplorationInputV1>;
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
function parseCssAlpha(color: string): number | null {
  const value = color.trim().toLowerCase();
  if (value === "" || value === "transparent" || value === "none") return 0;
  const match = /^rgba?\(([^)]+)\)$/.exec(value);
  if (!match) {
    if (!/^(?:hsla?|hwb|lab|lch|oklab|oklch|color)\(/.test(value)) return null;
    const alpha = /\/\s*([^/]+)\)$/.exec(value)?.[1]?.trim();
    if (alpha === undefined) return 1;
    const numeric = alpha.endsWith("%") ? Number(alpha.slice(0, -1)) / 100 : Number(alpha);
    return Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : null;
  }
  const parts = match[1]!.replace(/\//g, " ").split(/[\s,]+/).filter(Boolean);
  if (parts.length < 4) return 1;
  const raw = parts[3]!;
  const alpha = raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
  return Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : null;
}
function intersection(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  };
}
function positive(rect: Rect): boolean {
  return rect.width > 0 && rect.height > 0;
}
function subtractRect(source: Rect, blocker: Rect): Rect[] {
  if (!positive(intersection(source, blocker))) return [source];
  const sx1 = source.x, sy1 = source.y, sx2 = source.x + source.width, sy2 = source.y + source.height;
  const bx1 = Math.max(sx1, blocker.x), by1 = Math.max(sy1, blocker.y);
  const bx2 = Math.min(sx2, blocker.x + blocker.width), by2 = Math.min(sy2, blocker.y + blocker.height);
  if (bx1 <= sx1 && by1 <= sy1 && bx2 >= sx2 && by2 >= sy2) return [];
  const pieces: Rect[] = [];
  if (by1 > sy1) pieces.push({ x: sx1, y: sy1, width: sx2 - sx1, height: by1 - sy1 });
  if (by2 < sy2) pieces.push({ x: sx1, y: by2, width: sx2 - sx1, height: sy2 - by2 });
  if (bx1 > sx1) pieces.push({ x: sx1, y: by1, width: bx1 - sx1, height: by2 - by1 });
  if (bx2 < sx2) pieces.push({ x: bx2, y: by1, width: sx2 - bx2, height: by2 - by1 });
  return pieces.filter(positive);
}
function subtractAll(source: readonly Rect[], blocker: Rect): Rect[] | null {
  const result: Rect[] = [];
  for (const rect of source) {
    result.push(...subtractRect(rect, blocker));
    if (result.length > 32) return null;
  }
  return result;
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

export const DEFAULT_EXCLUDED_TOOL_ROOT_IDS = ["codex-browser-sidebar-comments-root"] as const;

interface PaintParticipation {
  readonly zIndex: number | null;
  readonly positioned: boolean;
  readonly order: number;
  readonly context: boolean;
}

function paintParticipation(style: CSSStyleDeclaration, order: number, parentDisplay: string): PaintParticipation {
  const position = style.position;
  const rawZ = style.zIndex;
  const parsedZ = rawZ === "auto" || rawZ === "" ? null : Number(rawZ);
  const zIndex = parsedZ !== null && Number.isFinite(parsedZ) ? parsedZ : null;
  const positioned = ["fixed", "sticky", "relative", "absolute"].includes(position);
  return {
    zIndex,
    positioned,
    order,
    context: ((positioned || ["flex", "inline-flex", "grid", "inline-grid"].includes(parentDisplay)) && zIndex !== null) || position === "fixed" || position === "sticky"
      || (Number(style.opacity || 1) < 1) || (style.transform && style.transform !== "none")
      || (style.filter && style.filter !== "none") || style.isolation === "isolate"
      || (style.mixBlendMode && style.mixBlendMode !== "normal")
      || Boolean(style.contain && /paint|layout|strict|content/.test(style.contain)),
  };
}

function isWithin(element: Element | null | undefined, ancestor: Element): boolean {
  for (let current = element; current; current = current.parentElement) {
    if (current === ancestor) return true;
  }
  return false;
}

function simplePaintBefore(
  blocker: Element,
  target: Element,
  participating: ReadonlyMap<Element, PaintParticipation>,
): boolean | "uncertain" {
  // Compare context paths, never a descendant's z-index against another root.
  const path = (element: Element): Element[] => {
    const result: Element[] = [];
    for (let current: Element | null = element; current; current = current.parentElement) {
      if (current === element || participating.get(current)?.context) result.unshift(current);
    }
    return result;
  };
  const left = path(blocker), right = path(target);
  let index = 0;
  while (left[index] && left[index] === right[index]) index++;
  const leftElement = left[index], rightElement = right[index];
  if (!leftElement || !rightElement) return "uncertain";
  const blockerPaint = participating.get(leftElement), targetPaint = participating.get(rightElement);
  if (!blockerPaint || !targetPaint) return "uncertain";
  const blockerZ = blockerPaint.context ? blockerPaint.zIndex ?? 0 : 0;
  const targetZ = targetPaint.context ? targetPaint.zIndex ?? 0 : 0;
  if (blockerZ !== targetZ) return blockerZ > targetZ;
  const blockerPositioned = blockerPaint.positioned || blockerPaint.context;
  const targetPositioned = targetPaint.positioned || targetPaint.context;
  if (blockerPositioned !== targetPositioned) return blockerPositioned;
  return blockerPaint.order > targetPaint.order;
}

function roundedClippingAncestor(element: Element, window: Window): boolean {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = window.getComputedStyle(parent);
    if ([style.overflowX, style.overflowY].some(value => ["hidden", "clip", "scroll", "auto"].includes(value))
      && [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius]
        .some(value => Number.parseFloat(value || "0") > 0)) return true;
  }
  return false;
}

function hitAt(document: Document, x: number, y: number): readonly Element[] | null {
  const doc = document as Document & { elementsFromPoint?: (x: number, y: number) => Element[] };
  if (typeof doc.elementsFromPoint === "function") return doc.elementsFromPoint(x, y);
  return null;
}

interface SurfaceClassification {
  readonly kind: "blocker" | "uncertain" | "transparent";
  readonly passThrough: boolean;
  readonly proven: boolean;
  readonly relevant: boolean;
}

interface ForegroundContext {
  readonly node: ObservationNode;
  readonly element: Element;
  readonly rect: Rect | null;
  readonly visibleRect: Rect | null;
  readonly surface: SurfaceClassification;
}

function surfaceFor(
  node: ObservationNode,
  element: Element,
  style: CSSStyleDeclaration,
  window: Window,
  ancestorOpacity: number,
  hidden: boolean,
): SurfaceClassification {
  const visible = !hidden && style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse"
    && ancestorOpacity > 0;
  const tag = element.tagName.toLowerCase();
  const bgAlpha = visible ? parseCssAlpha(style.backgroundColor ?? "transparent") : 0;
  if (bgAlpha === null) return { kind: "uncertain", passThrough: style.pointerEvents === "none", proven: false, relevant: visible };
  const ownOpacity = Number(style.opacity === "" ? 1 : style.opacity);
  const opacity = ancestorOpacity * (Number.isFinite(ownOpacity) ? ownOpacity : 1);
  const image = visible && (style.backgroundImage ?? "none") !== "none";
  const mask = visible && ((style.maskImage ?? "none") !== "none" || (style.webkitMaskImage ?? "none") !== "none");
  const radius = visible && [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius]
    .some(value => value !== undefined && value !== "" && Number.parseFloat(value) > 0);
  const media = visible && ["img", "svg", "canvas", "video", "picture", "object"].includes(tag);
  const backdrop = visible && ((style.backdropFilter ?? "none") !== "none"
    || ((style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter ?? "none") !== "none");
  const filter = visible && (style.filter ?? "none") !== "none";
  const beforeContent = visible ? window.getComputedStyle(element, "::before").content : undefined;
  const afterContent = visible ? window.getComputedStyle(element, "::after").content : undefined;
  const pseudo = [beforeContent, afterContent].some(content => content !== undefined && content !== "none" && content !== "normal" && content !== '""' && content !== "''");
  const rawDirectText = Array.from(element.childNodes).filter(child => child.nodeType === 3).map(child => child.textContent ?? "").join("");
  const ownText = visible && hasNonFormatDirectText(rawDirectText) === true;
  const positioned = ["fixed", "sticky", "relative", "absolute"].includes(style.position ?? "static")
    || (style.zIndex ?? "auto") !== "auto";
  const borders = [(style.borderTopWidth ?? "0px"), (style.borderRightWidth ?? "0px"), (style.borderBottomWidth ?? "0px"), (style.borderLeftWidth ?? "0px")]
    .some(width => width !== "0px");
  const content = !pseudo && !ownText && !borders;
  const relevant = visible && (bgAlpha > 0 || image || mask || backdrop || filter || media || radius || positioned || ownText || pseudo || borders);
  if (!visible) return { kind: "transparent", passThrough: false, proven: false, relevant: false };
  if (bgAlpha === 0 && !image && !mask && !backdrop && !filter && !media && !radius && content && opacity === 1) {
    return { kind: "transparent", passThrough: style.pointerEvents === "none", proven: true, relevant };
  }
  const pure = node.clippedRect !== null && positive(node.clippedRect) && !radius && !image && !mask && !media && !backdrop && !filter
    && style.clipPath === "none" && !roundedClippingAncestor(element, window)
    && (!style.backgroundClip || style.backgroundClip === "border-box");
  if (!pure) return { kind: "uncertain", passThrough: style.pointerEvents === "none", proven: false, relevant };
  if (style.pointerEvents === "none") {
    return bgAlpha === 1 && opacity === 1
      ? { kind: "blocker", passThrough: true, proven: true, relevant }
      : { kind: "transparent", passThrough: true, proven: false, relevant };
  }
  return bgAlpha * opacity > 0
    ? { kind: "blocker", passThrough: false, proven: true, relevant }
    : { kind: "uncertain", passThrough: false, proven: false, relevant };
}

export function observeLiveDom(input: {
  document: Document; window: Window; registry: StableNodeRefRegistry; excludeRoot: Element | null;
  excludeRoots?: readonly (Element | null)[]; excludeRootIds?: readonly string[];
  snapshotRef: string; documentRef: string;
  maxRelationHops?: number;
}): LiveDomSnapshot {
  const { document, window, registry } = input;
  const nodes: ObservationNode[] = [], itemObservations: ({ nodeRef: string } & BasicKindMeasurements)[] = [];
  const properties = new Map<string, BasicKindProperties>(), evidence = new Map<string, LiveDomEvidence>();
  const elementByRef = new Map<string, Element>(), participating = new Map<Element, PaintParticipation>();
  const styleByElement = new Map<Element, CSSStyleDeclaration>();
  const effectiveOpacity = new Map<Element, number>();
  const hiddenByElement = new Map<Element, boolean>();
  const stack: Element[] = document.documentElement ? [document.documentElement] : [];
  const excludedRoots = new Set(input.excludeRoots?.filter((root): root is Element => root !== null) ?? []);
  if (input.excludeRoot) excludedRoots.add(input.excludeRoot);
  const excludedIds = new Set([...DEFAULT_EXCLUDED_TOOL_ROOT_IDS, ...(input.excludeRootIds ?? [])]);
  const isExcluded = (element: Element): boolean => {
    for (let current: Element | null = element; current; current = current.parentElement) {
      if (excludedRoots.has(current) || (current.id !== "" && excludedIds.has(current.id))) return true;
    }
    return false;
  };
  let excluded = 0, frames = 0, shadows = 0;
  let domOrder = 0;
  while (stack.length) {
    const element = stack.pop()!;
    if (isExcluded(element)) { excluded += 1 + element.querySelectorAll("*").length; continue; }
    const allChildren = Array.from(element.children), children = allChildren.filter(child => !isExcluded(child));
    for (let index = allChildren.length - 1; index >= 0; index--) stack.push(allChildren[index]!);
    const nodeRef = stableNodeRefFor(registry, element), tag = element.tagName.toLowerCase();
    const style = window.getComputedStyle(element), rect = rectOf(element.getBoundingClientRect());
    elementByRef.set(nodeRef, element);
    styleByElement.set(element, style);
    participating.set(element, paintParticipation(style, domOrder++, element.parentElement ? styleByElement.get(element.parentElement)?.display ?? "" : ""));
    const parentOpacity = element.parentElement ? effectiveOpacity.get(element.parentElement) ?? 1 : 1;
    const ownOpacity = Number(style.opacity === "" ? 1 : style.opacity);
    effectiveOpacity.set(element, parentOpacity * (Number.isFinite(ownOpacity) ? ownOpacity : 1));
    // display suppresses a subtree; visibility is computed independently and
    // can be explicitly restored by a descendant.
    const hidden = (element.parentElement ? hiddenByElement.get(element.parentElement) ?? false : false)
      || style.display === "none";
    hiddenByElement.set(element, hidden);
    const visible = !hidden && style.visibility !== "hidden" && style.visibility !== "collapse";
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
    const rawDirectText = Array.from(element.childNodes).filter(node => node.nodeType === 3).map(node => node.textContent ?? "").join("");
    const beforeStyle = window.getComputedStyle(element, "::before"), afterStyle = window.getComputedStyle(element, "::after");
    const appearance = shapeAppearanceMeasurements({
      directText: rawDirectText,
      beforeContent: beforeStyle.content,
      afterContent: afterStyle.content,
      backgroundImage: style.backgroundImage,
      maskImage: style.maskImage,
      webkitMaskImage: style.webkitMaskImage,
    });
    const local: BasicKindMeasurements = {
      inputType: tag === "input" ? element.getAttribute("type") || "text" : null,
      hrefPresent: element.hasAttribute("href"),
      contentEditable: (element as HTMLElement).isContentEditable === true,
      ...appearance,
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
  const foregroundByRef = new Map<string, { readonly foreground: ForegroundState; readonly exposedRects: readonly Rect[] | null }>();
  const viewport = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
  const refByElement = new Map([...elementByRef].map(([ref, element]) => [element, ref] as const));
  const visibleByRef = new Map<string, readonly Rect[]>();
  const surfaces = new Map<string, SurfaceClassification>();
  for (const node of nodes) {
    const element = elementByRef.get(node.nodeRef);
    if (!element) continue;
    const rects = node.rect === null || node.clippedRect === null ? []
      : (node.fragments ?? []).map(fragment => intersection(intersection(node.rect!, viewport), intersection(fragment, node.clippedRect!))).filter(positive);
    visibleByRef.set(node.nodeRef, rects);
    const style = styleByElement.get(element);
    if (!style) continue;
    surfaces.set(node.nodeRef, surfaceFor(
      node,
      element,
      style,
      window,
      element.parentElement ? effectiveOpacity.get(element.parentElement) ?? 1 : 1,
      hiddenByElement.get(element) ?? false,
    ));
  }
  const nativeMeasurement = hitAt(document, 0, 0) !== null;
  const foregroundContexts: ForegroundContext[] = nativeMeasurement ? nodes.flatMap(node => {
    const element = elementByRef.get(node.nodeRef), surface = surfaces.get(node.nodeRef);
    const visibleRect = visibleByRef.get(node.nodeRef)?.find(positive) ?? null;
    return element && surface && visibleRect ? [{ node, element, rect: node.rect, visibleRect, surface }] : [];
  }) : [];
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
    const node = nodes[nodeIndex]!;
    if (!nativeMeasurement) continue;
    const element = elementByRef.get(node.nodeRef);
    if (!element) continue;
    if (node.rect === null || node.clippedRect === null) {
      nodes[nodeIndex] = { ...node, foreground: "unassessed", exposedRects: null };
      continue;
    }
    const rects = visibleByRef.get(node.nodeRef) ?? [];
    if (rects.length === 0) {
      const result = { foreground: "visible", exposedRects: [] } as const;
      foregroundByRef.set(node.nodeRef, result);
      nodes[nodeIndex] = { ...node, ...result };
      continue;
    }
    let remaining: Rect[] | null = [...rects];
    let provenRemaining: Rect[] | null = [...rects];
    const targetRect = node.clippedRect;
    if (targetRect === null) continue;
    const blockers = foregroundContexts.filter(blocker => blocker.node.nodeRef !== node.nodeRef
      && blocker.surface.relevant && blocker.surface.kind !== "transparent"
      && !isWithin(blocker.element, element) && !isWithin(element, blocker.element)
      && blocker.visibleRect !== null && positive(intersection(targetRect, blocker.visibleRect)));
    for (const blocker of blockers) {
      if (!remaining) break;
      const blockerRect = blocker.visibleRect;
      if (!blockerRect) continue;
      const overlap = intersection(blockerRect, targetRect);
      if (!positive(overlap)) continue;
      const point = { x: overlap.x + overlap.width / 2, y: overlap.y + overlap.height / 2 };
      const rawHits = hitAt(document, point.x, point.y);
      if (rawHits === null) {
        remaining = null;
        break;
      }
      const hits = rawHits.filter(candidate => !isExcluded(candidate));
      const blockerIndex = hits.indexOf(blocker.element);
      const targetIndex = hits.indexOf(element);
      let nativeBefore = blockerIndex >= 0 && targetIndex >= 0 && targetIndex > blockerIndex;
      if (nativeBefore) {
        const dx = Math.min(0.5, overlap.width / 4), dy = Math.min(0.5, overlap.height / 4);
        nativeBefore = [
          [overlap.x + dx, overlap.y + dy], [overlap.x + overlap.width - dx, overlap.y + dy],
          [overlap.x + dx, overlap.y + overlap.height - dy], [overlap.x + overlap.width - dx, overlap.y + overlap.height - dy],
        ].every(([x, y]) => {
          const stack = hitAt(document, x!, y!)?.filter(candidate => !isExcluded(candidate));
          if (!stack) return false;
          const front = stack.indexOf(blocker.element), back = stack.indexOf(element);
          return front >= 0 && (back > front
            || (back < 0 && simplePaintBefore(blocker.element, element, participating) === true));
        });
      }
      let pointerBefore = nativeBefore;
      if (blocker.surface.passThrough || styleByElement.get(element)?.pointerEvents === "none") {
        const before = simplePaintBefore(blocker.element, element, participating);
        pointerBefore = before === true;
        if (before === "uncertain") {
          remaining = subtractAll(remaining, blockerRect);
          continue;
        }
      }
      if (!pointerBefore) continue;
      if (!blocker.surface.proven) {
        remaining = subtractAll(remaining, blockerRect);
        continue;
      }
      const next = subtractAll(remaining, blockerRect);
      provenRemaining = provenRemaining === null ? null : subtractAll(provenRemaining, blockerRect);
      if (next === null) {
        remaining = null;
        break;
      }
      remaining = next;
    }
    if (remaining !== null && remaining.length === 0) {
      const result = provenRemaining?.length === 0
        ? { foreground: "occluded", exposedRects: [] } as const
        : { foreground: "unassessed", exposedRects: null } as const;
      foregroundByRef.set(node.nodeRef, result);
      nodes[nodeIndex] = { ...node, ...result };
      continue;
    }
    const exposed: Rect[] = [];
    for (const rect of remaining ?? []) {
      const rawHits = hitAt(document, rect.x + rect.width / 2, rect.y + rect.height / 2);
      if (rawHits === null) {
        continue;
      }
      const hits = rawHits.filter(candidate => !isExcluded(candidate));
      const first = hits[0];
      const firstOpaque = hits.find(candidate => {
        const ref = refByElement.get(candidate);
        return ref !== undefined && surfaces.get(ref)?.kind !== "transparent";
      });
      const owner = firstOpaque ?? first;
      if (owner && (owner === element || isWithin(owner, element) || isWithin(element, owner)
        || (styleByElement.get(element)?.pointerEvents === "none" && simplePaintBefore(owner, element, participating) === false))) exposed.push(rect);
    }
    const result: { readonly foreground: ForegroundState; readonly exposedRects: readonly Rect[] | null } = exposed.length > 0
      ? { foreground: "visible", exposedRects: exposed }
      : { foreground: "unassessed", exposedRects: null };
    foregroundByRef.set(node.nodeRef, result);
    nodes[nodeIndex] = { ...node, ...result };
  }
  for (const ref of registry.elementByRef.keys()) resolveStableNodeRef(registry, ref);
  const clipping = nodes.every(node => node.clippedRect !== null) ? "assessed" : nodes.some(node => node.clippedRect !== null) ? "mixed" : "unassessed";
  const foregroundNodes = nodes.filter(node => node.foreground !== undefined);
  const foregroundCoverage = foregroundNodes.length === 0 ? undefined
    : foregroundNodes.every(node => node.foreground === "visible" || node.foreground === "occluded") ? "assessed"
      : foregroundNodes.some(node => node.foreground === "visible" || node.foreground === "occluded") ? "mixed" : "unassessed";
  const observation: PageObservation = { viewport, nodes, coverage: { geometry: "assessed", fragments: "assessed", clipping, ...(foregroundCoverage ? { foreground: foregroundCoverage } : {}) } };
  const unassessedInteriors = new Map([...evidence].map(([ref, ev]) => [ref, (ev.unassessedChildContent ?? []) as readonly ("iframe" | "shadow_root")[]]));
  const explorationInputs = buildExplorationInputs({ observation, itemObservations, maxRelationHops: input.maxRelationHops ?? 4, ...(nodes[0] ? { rootNodeRef: nodes[0].nodeRef } : {}), directChildrenStatus: "complete", unassessedInteriors });
  return {
    snapshotRef: input.snapshotRef, documentRef: input.documentRef, frameRef: "top", pageRef: input.documentRef,
    observation, explorationInputs,
    itemObservations, properties, evidence,
    coverage: { scope: "top_document_only", frameContent: "captured", directChildren: "complete", traversedElementCount: nodes.length, excludedElementCount: excluded, unassessedIframeCount: frames, unassessedOpenShadowRootCount: shadows, closedShadowRootDetection: "not_available" },
    resolveElement: ref => resolveStableNodeRef(registry, ref),
  };
}
