import { hasNonFormatDirectText, shapeAppearanceMeasurements, type BasicKindMeasurements, type BasicKindProperties } from "../../filters/basic-kinds.js";
import { isSafeRuleAttribute, type ForegroundState, type ObservationCurrentView, type ObservationNode, type PageObservation, type Rect } from "./observation.js";
import { buildExplorationInputs, type ExplorationInputV1, type UnassessedInteriorKind } from "./exploration-input.js";
import { deriveBasicKindContentRelations } from "./content-relations.js";
import {
  axisLinearGradientDomain,
  axisLinearGradientPaintRect,
  axisLinearGradientPaintsAt,
  backgroundImageOutsideBox,
  borderOnlyClearInterior,
  outlineOnlyClearInterior,
  containedReplacedPaintRect,
  fullReplacedImageCoverageRect,
  roundedOuterClearCorners,
  roundedDomainContainsRect,
  equalRoundedDomains,
  pointInRoundedDomain,
  extractRoundedClipDomain,
  type AxisLinearGradientDomain,
  type ReplacedObjectIntrinsicFacts,
  type RoundedRectDomain,
} from "./paint-surface.js";
import type { JpegImageResourceObservation } from "./image-resource.js";
import {
  certifyAxisReflectedSvgViewport,
  certifyContainedSvgOverflow,
  certifySvgAtomicViewport,
  resolveLocalSvgClipPathRect,
  resolveOutermostSvgPhysicalViewport,
  resolveSvgUserSpaceMapping,
} from "./svg-clipping.js";

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
  readonly unassessedObjectCount?: number;
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
  readonly inputValue: string | null;
  readonly placeholder: string | null;
  readonly mediaSrc: string | null;
  readonly mediaType: "video" | "audio" | null;
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
const directListChildTags = new Set(["ul", "ol", "dl"]);
const directListChildRoles = new Set(["list", "listbox", "menu"]);
const nativeControlTags = new Set(["button", "input", "select", "textarea", "summary", "a"]);
const controlRoles = new Set(["button", "link", "textbox", "searchbox", "combobox", "listbox", "option", "menuitem", "tab", "checkbox", "radio", "switch", "slider", "spinbutton"]);
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
function readableActiveElement(document: Document): Element | null {
  let candidate: unknown;
  try {
    candidate = (document as Document & { activeElement?: unknown }).activeElement;
  } catch {
    return null;
  }
  return candidate !== null && typeof candidate === "object" && (candidate as { nodeType?: unknown }).nodeType === 1
    ? candidate as Element
    : null;
}
function elementInDocument(element: Element, document: Document): boolean {
  const owner = (element as { ownerDocument?: unknown }).ownerDocument;
  if (owner !== undefined && owner !== null) return owner === document;
  for (let cursor: Element | null = element; cursor; cursor = cursor.parentElement) {
    if (cursor === document.documentElement) return true;
  }
  return false;
}
const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
function contentEditableDeclaration(element: Element): boolean | "inherit" | null {
  if (typeof element.getAttribute !== "function") return null;
  let value: string | null;
  try {
    value = element.getAttribute("contenteditable");
  } catch {
    return null;
  }
  if (value === null) return "inherit";
  if (typeof value !== "string") return null;
  const token = value.toLowerCase();
  if (token === "" || token === "true" || token === "plaintext-only") return true;
  if (token === "false") return false;
  return "inherit";
}
function measureContentEditable(element: Element, document: Document): boolean | null {
  let native: unknown;
  try {
    native = (element as { isContentEditable?: unknown }).isContentEditable;
  } catch {
    return null;
  }
  if (typeof native === "boolean") return native;

  let root: Element | null;
  try {
    root = document.documentElement;
  } catch {
    return null;
  }
  if (!root) return null;

  // Native selector substitution and declaration fallback are valid only when
  // the complete element chain is readable HTML and terminates at this root.
  const visited = new Set<Element>();
  const chain: Element[] = [];
  let current: Element | null = element;
  while (current) {
    let namespace: unknown;
    try {
      namespace = current.namespaceURI;
    } catch {
      return null;
    }
    if (visited.has(current) || namespace !== XHTML_NAMESPACE) return null;
    visited.add(current);
    chain.push(current);
    if (current === root) break;
    try {
      current = current.parentElement;
    } catch {
      return null;
    }
  }
  if (current !== root) return null;

  // A trusted native selector is authoritative for eligible HTML targets.
  // Form controls can match :read-write independently of editing.
  let tagName: unknown;
  try {
    tagName = element.tagName;
  } catch {
    return null;
  }
  const tag = typeof tagName === "string" ? tagName.toLowerCase() : null;
  if (tag !== "input" && tag !== "textarea") {
    let matches: unknown;
    try {
      matches = (element as { matches?: unknown }).matches;
    } catch {
      matches = undefined;
    }
    if (typeof matches === "function") {
      let selected: unknown;
      try {
        selected = matches.call(element, ":read-write");
      } catch {
        selected = undefined;
      }
      if (typeof selected === "boolean") return selected;
    }
  }

  // Keep the nearest exact declaration as evidence. A nearer false stops an
  // outer true from proving editability when designMode is unknown.
  let declaration: boolean | null = null;
  for (const node of chain) {
    const state = contentEditableDeclaration(node);
    if (state === null) return null;
    if (state !== "inherit") {
      declaration = state;
      break;
    }
  }

  let designMode: string | null = null;
  try {
    const raw = (document as Document & { designMode?: unknown }).designMode;
    if (typeof raw === "string") designMode = raw.toLowerCase();
  } catch {
    designMode = null;
  }
  if (designMode === "on") return true;
  if (designMode === "off") return declaration === true;
  return declaration === true ? true : null;
}
interface LocalScale {
  readonly x: number;
  readonly y: number;
}
// Accept only positive diagonal matrices; translation is retained but viewport rects already include it.
function localScaleOf(transform: string | undefined): LocalScale | null {
  if (transform === "none") return { x: 1, y: 1 };
  if (!transform) return null;
  const match = /^matrix\(([^)]+)\)$/.exec(transform);
  if (!match) return null;
  const fields = match[1]!.split(",").map(value => value.trim());
  if (fields.length !== 6 || fields.some(value => value.length === 0)) return null;
  const values = fields.map(Number);
  if (!values.every(Number.isFinite)) return null;
  const a = values[0], b = values[1], c = values[2], d = values[3];
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  if (b !== 0 || c !== 0 || a <= 0 || d <= 0) return null;
  return { x: a, y: d };
}
// This proof is local to clipping. Accept only signed unit axes, and require
// one measured physical rect with no local clipping or containing effect.
function exactHtmlAxisReflection(element: Element, style: CSSStyleDeclaration): boolean {
  const prefixedBackdrop = (style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter;
  if (element.namespaceURI !== XHTML_NAMESPACE) return false;
  if (style.translate !== "none" || style.rotate !== "none" || style.scale !== "none"
    || style.perspective !== "none" || style.overflowX !== "visible" || style.overflowY !== "visible"
    || style.clip !== "auto" || style.clipPath !== "none" || style.contain !== "none"
    || style.filter !== "none" || style.backdropFilter !== "none"
    || typeof prefixedBackdrop !== "string" || (prefixedBackdrop !== "" && prefixedBackdrop !== "none")) return false;
  const match = /^matrix\(([^)]+)\)$/.exec(style.transform ?? "");
  if (!match) return false;
  const fields = match[1]!.split(",").map(value => value.trim());
  if (fields.length !== 6 || fields.some(value => value.length === 0)) return false;
  const values = fields.map(Number);
  if (!values.every(Number.isFinite)) return false;
  const [a, b, c, d, tx, ty] = values;
  if ((a !== 1 && a !== -1) || b !== 0 || c !== 0 || (d !== 1 && d !== -1)
    || (a === 1 && d === 1) || tx === undefined || ty === undefined) return false;
  const bounds = element.getBoundingClientRect();
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    || bounds.width < 0 || bounds.height < 0) return false;
  return element.getClientRects().length === 1;
}
type LegacyClipState = "none" | "empty" | "unsupported";
// Legacy clip applies only to absolute/fixed elements; only an exact zero rect is interpretable here.
function legacyClipState(style: CSSStyleDeclaration): LegacyClipState {
  const clip = style.clip;
  if (!clip || clip === "auto") return "none";
  const position = style.position;
  if (position === "static" || position === "relative" || position === "sticky") return "none";
  if (position !== "absolute" && position !== "fixed") return "unsupported";
  const match = /^rect\(([^)]*)\)$/.exec(clip.trim());
  if (!match) return "unsupported";
  const fields = match[1]!.split(",").map(value => value.trim());
  if (fields.length !== 4) return "unsupported";
  const pixels: number[] = [];
  for (const field of fields) {
    const px = /^(-?\d+(?:\.\d+)?)px$/.exec(field);
    const raw = px?.[1];
    if (raw === undefined) return "unsupported";
    const value = Number(raw);
    if (!Number.isFinite(value)) return "unsupported";
    pixels.push(value);
  }
  return pixels.every(value => value === 0) ? "empty" : "unsupported";
}
// A root SVG has a CSS viewport; nested SVG graphics can use unmapped user space.
function svgUserSpaceClipBox(element: Element): boolean {
  for (let current: Element | null = element.parentElement; current; current = current.parentElement) {
    if (current.tagName.toLowerCase() === "svg") return true;
  }
  return false;
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
function visibleBorder(style: CSSStyleDeclaration): boolean | null {
  const edges = ["Top", "Right", "Bottom", "Left"] as const;
  let unknown = false;
  for (const edge of edges) {
    const widthText = String(style[`border${edge}Width` as keyof CSSStyleDeclaration] ?? "").trim();
    const styleText = String(style[`border${edge}Style` as keyof CSSStyleDeclaration] ?? "").trim().toLowerCase();
    const widthMatch = widthText === "" ? null : /^(-?(?:\d+|\d*\.\d+))(?:px)?$/.exec(widthText);
    const width = widthMatch ? Number(widthMatch[1]) : null;
    if (width !== null && width < 0) { unknown = true; continue; }
    if (width === 0 || ["none", "hidden"].includes(styleText)) continue;
    if (width === null || styleText === "") { unknown = true; continue; }
    if (!["dotted", "dashed", "solid", "double", "groove", "ridge", "inset", "outset"].includes(styleText)) { unknown = true; continue; }
    const color = typeof style.getPropertyValue === "function"
      ? style.getPropertyValue(`border-${edge.toLowerCase()}-color`).trim()
      : String(style[`border${edge}Color` as keyof CSSStyleDeclaration] ?? "").trim();
    if (color === "") { unknown = true; continue; }
    const alpha = parseCssAlpha(color);
    if (alpha === null) { unknown = true; continue; }
    if (alpha > 0) return true;
  }
  return unknown ? null : false;
}
function visibleOutline(style: CSSStyleDeclaration): boolean | null {
  const widthText = String(style.outlineWidth ?? "").trim();
  const styleText = String(style.outlineStyle ?? "").trim().toLowerCase();
  if (styleText === "" || ["none", "hidden"].includes(styleText)) return false;
  const widthMatch = widthText === "" ? null : /^(-?(?:\d+|\d*\.\d+))(?:px)?$/.exec(widthText);
  const width = widthMatch ? Number(widthMatch[1]) : null;
  if (width !== null && width < 0) return null;
  if (width === 0) return false;
  if (width === null) return null;
  if (!["dotted", "dashed", "solid", "double", "groove", "ridge", "inset", "outset"].includes(styleText)) return null;
  const color = typeof style.getPropertyValue === "function"
    ? style.getPropertyValue("outline-color").trim()
    : String(style.outlineColor ?? "").trim();
  if (color === "") return null;
  const alpha = parseCssAlpha(color);
  if (alpha === null) return null;
  return alpha > 0;
}
function zeroLength(value: string | undefined): boolean {
  if (value === undefined) return false;
  return /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:px|%)?$/.test(value.trim());
}
function zeroRadius(value: string | undefined): boolean {
  if (value === undefined) return false;
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return parts.length > 0 && parts.length <= 2 && parts.every(zeroLength);
}
function opaqueSolidBorderRing(style: CSSStyleDeclaration): boolean {
  if (![style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius]
    .every(zeroRadius)) return false;
  const edges = ["Top", "Right", "Bottom", "Left"] as const;
  for (const edge of edges) {
    const widthText = String(style[`border${edge}Width` as keyof CSSStyleDeclaration] ?? "").trim();
    const widthMatch = /^(-?(?:\d+|\d*\.\d+))(?:px)?$/.exec(widthText);
    const width = widthMatch ? Number(widthMatch[1]) : null;
    if (width === null || !Number.isFinite(width) || width < 0) return false;
    if (width === 0) continue;
    const styleText = String(style[`border${edge}Style` as keyof CSSStyleDeclaration] ?? "").trim().toLowerCase();
    if (styleText !== "solid") return false;
    const color = typeof style.getPropertyValue === "function"
      ? style.getPropertyValue(`border-${edge.toLowerCase()}-color`).trim()
      : String(style[`border${edge}Color` as keyof CSSStyleDeclaration] ?? "").trim();
    if (parseCssAlpha(color) !== 1) return false;
  }
  return true;
}
function descendantTextPresent(element: Element, excludedRoots: ReadonlySet<Element>, excludedIds: ReadonlySet<string>): boolean {
  const stack = Array.from(element.childNodes).reverse();
  while (stack.length) {
    const node = stack.pop()!;
    if (node.nodeType === 3) {
      if (hasNonFormatDirectText(node.textContent) === true) return true;
      continue;
    }
    if (node.nodeType !== 1) continue;
    const child = node as Element, tag = child.tagName.toLowerCase();
    if (["script", "style"].includes(tag) || excludedRoots.has(child) || (child.id !== "" && excludedIds.has(child.id))) continue;
    stack.push(...Array.from(child.childNodes).reverse());
  }
  return false;
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
function finitePositive(rect: Rect | null): rect is Rect {
  return rect !== null && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && positive(rect);
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
type FixedAnchorProof = { readonly status: "absent" } | { readonly status: "proven"; readonly index: number } | { readonly status: "unknown" };
function fixedAnchorProof(chain: readonly Element[], styles: readonly CSSStyleDeclaration[]): FixedAnchorProof {
  const ordinaryOverflow = (value: string | undefined): boolean =>
    value === "visible" || value === "hidden" || value === "scroll" || value === "auto";
  const prefixedBackdrop = (style: CSSStyleDeclaration): string | undefined =>
    (style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter;
  const baselineContainingFacts = (style: CSSStyleDeclaration): boolean => {
    const prefixed = prefixedBackdrop(style);
    return style.transform === "none" && style.translate === "none" && style.rotate === "none"
      && style.scale === "none" && style.perspective === "none" && style.filter === "none"
      && style.backdropFilter === "none"
      && (prefixed === undefined || prefixed === "" || prefixed === "none")
      && style.contain === "none" && style.willChange === "auto"
      && style.contentVisibility === "visible";
  };
  const passesViewportAnchorGuard = (start: number): boolean => {
    for (let index = start; index < chain.length; index++) {
      const style = styles[index]!, tag = chain[index]!.tagName.toLowerCase();
      if (tag === "svg" || tag === "foreignobject") return false;
      if (!ordinaryOverflow(style.overflowX) || !ordinaryOverflow(style.overflowY)) return false;
      if (!baselineContainingFacts(style)) return false;
    }
    return true;
  };
  const finiteBox = (element: Element): boolean => {
    const bounds = element.getBoundingClientRect();
    return [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
      && bounds.width >= 0 && bounds.height >= 0;
  };
  let innerAnchor = -1;
  for (let index = 0; index < chain.length; index++) {
    if (styles[index]?.position !== "fixed") continue;
    innerAnchor = index;
    // The nearest fixed ancestor is the viewport anchor. A further fixed
    // ancestor is not a containing block by itself, so it stays in the
    // containing-block guard scan below instead of rejecting the proof.
    break;
  }
  if (innerAnchor === -1) return { status: "absent" };
  if (passesViewportAnchorGuard(innerAnchor + 1)) return { status: "proven", index: innerAnchor };

  // A fixed element below one relative blur(20px) backdrop is positioned by
  // that backdrop. The outer fixed remains the first ordinary-overflow escape
  // boundary, while clipping between the target and it stays in effect.
  let containingBlock = -1, viewportAnchor = -1;
  for (let index = innerAnchor + 1; index < chain.length; index++) {
    const element = chain[index]!, style = styles[index]!;
    if (element.namespaceURI !== XHTML_NAMESPACE || ["svg", "foreignobject"].includes(element.tagName.toLowerCase())
      || !ordinaryOverflow(style.overflowX) || !ordinaryOverflow(style.overflowY)) return { status: "unknown" };
    if (style.position === "relative" && style.backdropFilter === "blur(20px)") {
      const prefixed = prefixedBackdrop(style);
      if (containingBlock !== -1 || viewportAnchor !== -1 || style.transform !== "none"
        || style.translate !== "none" || style.rotate !== "none" || style.scale !== "none"
        || style.perspective !== "none" || style.filter !== "none"
        || (prefixed !== undefined && prefixed !== "" && prefixed !== "none")
        || style.contain !== "none" || style.willChange !== "auto"
        || style.contentVisibility !== "visible" || !finiteBox(element)) return { status: "unknown" };
      containingBlock = index;
      continue;
    }
    if (style.position === "fixed") {
      if (containingBlock === -1 || viewportAnchor !== -1 || !baselineContainingFacts(style) || !finiteBox(element)) {
        return { status: "unknown" };
      }
      viewportAnchor = index;
      break;
    }
    if (!baselineContainingFacts(style)) return { status: "unknown" };
  }
  if (containingBlock === -1 || viewportAnchor === -1 || !passesViewportAnchorGuard(viewportAnchor + 1)) {
    return { status: "unknown" };
  }
  return { status: "proven", index: viewportAnchor };
}
type AbsoluteContainingBlockProof =
  | { readonly status: "absent" }
  | { readonly status: "proven"; readonly index: number }
  | { readonly status: "unknown" };
function absoluteContainingBlockProof(
  chain: readonly Element[],
  styles: readonly CSSStyleDeclaration[],
  document: Document,
  readCss: ClipCssReader,
): AbsoluteContainingBlockProof {
  if (styles[0]?.position !== "absolute" || chain[0]?.namespaceURI !== XHTML_NAMESPACE) {
    return { status: "absent" };
  }
  let containingBlock = -1;
  for (let index = 1; index < chain.length; index++) {
    const position = styles[index]?.position;
    if (typeof position !== "string") return { status: "unknown" };
    if (position !== "static") {
      containingBlock = index;
      break;
    }
  }
  if (containingBlock === -1) return { status: "absent" };
  // There is no intermediate overflow between the target and its immediate
  // positioned containing block.
  if (containingBlock === 1) return { status: "absent" };
  if (chain.at(-1) !== document.documentElement) return { status: "unknown" };
  // Only ordinary overflow that would otherwise clip the target needs proof.
  let needsEscape = false;
  for (let index = 1; index < containingBlock; index++) {
    const style = styles[index]!;
    const overflowX = readCss(chain[index]!, style, "overflowX");
    const overflowY = readCss(chain[index]!, style, "overflowY");
    const ordinary = ["visible", "hidden", "scroll", "auto"];
    const supported = (value: string | null | undefined): boolean =>
      ordinary.includes(value ?? "") || value === "clip";
    if (!supported(overflowX) || !supported(overflowY)) return { status: "unknown" };
    if (overflowX === "clip" || overflowY === "clip") continue;
    if (overflowX !== "visible" || overflowY !== "visible") needsEscape = true;
  }
  if (!needsEscape) return { status: "absent" };
  for (let index = 1; index < containingBlock; index++) {
    const element = chain[index]!, style = styles[index]!;
    const tag = element.tagName.toLowerCase();
    const prefixedBackdrop = (style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter;
    if (style.position !== "static"
      || element.namespaceURI !== XHTML_NAMESPACE || tag === "svg" || tag === "foreignobject"
      || readCss(element, style, "transform") !== "none"
      || readCss(element, style, "translate") !== "none"
      || readCss(element, style, "rotate") !== "none"
      || readCss(element, style, "scale") !== "none"
      || readCss(element, style, "perspective") !== "none"
      || style.filter !== "none" || style.backdropFilter !== "none"
      || (prefixedBackdrop !== "" && prefixedBackdrop !== "none")
      || readCss(element, style, "contain") !== "none"
      || style.willChange !== "auto" || style.contentVisibility !== "visible"
      || !["visible", "hidden", "scroll", "auto", "clip"].includes(readCss(element, style, "overflowX") ?? "")
      || !["visible", "hidden", "scroll", "auto", "clip"].includes(readCss(element, style, "overflowY") ?? "")) {
      return { status: "unknown" };
    }
  }
  return { status: "proven", index: containingBlock };
}
function rootScrollport(document: Document, window: Window, root: Element, style: CSSStyleDeclaration): Rect | null {
  if (document.compatMode !== "CSS1Compat" || document.scrollingElement !== root
    || root !== document.documentElement || root.tagName.toLowerCase() !== "html"
    || root.namespaceURI !== XHTML_NAMESPACE) return null;
  const supportedOverflow = (value: string): boolean =>
    value === "auto" || value === "hidden" || value === "scroll";
  if (!supportedOverflow(style.overflowX) || !supportedOverflow(style.overflowY)
    || style.transform !== "none" || style.translate !== "none" || style.rotate !== "none"
    || style.scale !== "none" || style.perspective !== "none" || style.zoom !== "1"
    || style.borderLeftWidth !== "0px" || style.borderTopWidth !== "0px"
    || style.paddingLeft !== "0px" || style.paddingTop !== "0px") return null;
  if (root.clientLeft !== 0 || root.clientTop !== 0
    || ![root.clientWidth, root.clientHeight, root.scrollLeft, root.scrollTop, window.innerWidth, window.innerHeight].every(Number.isFinite)
    || root.scrollLeft < 0 || root.scrollTop < 0
    || window.innerWidth <= 0 || window.innerHeight <= 0
    || root.clientWidth < 0 || root.clientHeight < 0
    || root.clientWidth > window.innerWidth || root.clientHeight > window.innerHeight) return null;
  return { x: 0, y: 0, width: root.clientWidth, height: root.clientHeight };
}
type ElementAncestry = ReadonlyMap<Element, Element | null>;
type ClipCssKey =
  | "translate"
  | "rotate"
  | "scale"
  | "perspective"
  | "transform"
  | "contain"
  | "clipPath"
  | "overflowX"
  | "overflowY";
type ClipCssReader = (
  element: Element,
  style: CSSStyleDeclaration,
  key: ClipCssKey,
) => string | null | undefined;
function ancestryPath(element: Element, ancestry: ElementAncestry): readonly Element[] {
  const path: Element[] = [];
  let current: Element | null = element;
  while (current) {
    path.push(current);
    const recorded = ancestry.get(current);
    current = recorded === undefined ? current.parentElement : recorded;
  }
  return path;
}
function clippedBox(
  element: Element,
  window: Window,
  rect: Rect,
  fragments: readonly Rect[],
  document: Document,
  ancestry: ElementAncestry,
  readCss: ClipCssReader,
): Rect | null {
  const chain: Element[] = [], styles: CSSStyleDeclaration[] = [], scales: (LocalScale | null)[] = [];
  const exactHtmlReflections: boolean[] = [];
  const clipRects: (Rect | null)[] = [];
  const containedSvg = certifyContainedSvgOverflow(element, window);
  const reflectedSvg = certifyAxisReflectedSvgViewport(element, window);
  let empty = false;
  // First pass validates the whole chain and records each local scale.
  for (const current of ancestryPath(element, ancestry)) {
    const style = window.getComputedStyle(current);
    if ([readCss(current, style, "translate"), readCss(current, style, "rotate"), readCss(current, style, "scale"), readCss(current, style, "perspective")]
      .some(value => value !== undefined && value !== "" && value !== "none")) return null;
    if (readCss(current, style, "contain")?.includes("paint")) return null;
    const transform = readCss(current, style, "transform");
    const scale = localScaleOf(transform === null ? undefined : transform);
    const exactHtmlReflection = scale === null && exactHtmlAxisReflection(current, style);
    // A reflected root has a null local axis scale, but its measured physical
    // viewport still bounds the certified direct path. Never fake a unit scale.
    if (scale === null && current !== containedSvg?.root && current !== reflectedSvg?.root
      && !exactHtmlReflection) return null;
    const legacy = legacyClipState(style);
    if (legacy === "unsupported") return null;
    if (legacy === "empty") empty = true;
    // A clip-path is provable only as one local rectangular SVG resource; any
    // other clip value stays unknown rather than being assumed absent.
    const clipPath = readCss(current, style, "clipPath");
    const clipValue = clipPath && clipPath !== "none" ? clipPath : null;
    let clipRect: Rect | null = null;
    if (clipValue !== null) {
      clipRect = resolveLocalSvgClipPathRect(current, clipValue, window);
      if (clipRect === null) return null;
    }
    chain.push(current); styles.push(style); scales.push(scale); clipRects.push(clipRect);
    exactHtmlReflections.push(exactHtmlReflection);
  }
  if (empty) return { x: rect.x, y: rect.y, width: 0, height: 0 };
  if (exactHtmlReflections.some(Boolean) && (!positive(rect) || fragments.length !== 1)) return null;
  const fixedAnchor = fixedAnchorProof(chain, styles);
  if (fixedAnchor.status === "unknown") return null;
  const absoluteContainingBlock: AbsoluteContainingBlockProof = fixedAnchor.status === "proven"
    ? { status: "absent" }
    : absoluteContainingBlockProof(chain, styles, document, readCss);
  if (absoluteContainingBlock.status === "unknown") return null;
  // Cumulative scale runs from each element through the root, so descendants cannot widen an outer clip.
  const cumulative: (LocalScale | null)[] = [];
  let outerScale: LocalScale | null = { x: 1, y: 1 };
  for (let index = chain.length - 1; index >= 0; index--) {
    const local = scales[index];
    if (local != null) {
      outerScale = outerScale === null ? null : { x: outerScale.x * local.x, y: outerScale.y * local.y };
    } else if (!exactHtmlReflections[index]) {
      outerScale = null;
    }
    // A signed unit-axis reflection changes axis sign only. Keep the positive
    // outer scale for ancestor client geometry without creating a local scale.
    cumulative[index] = outerScale;
  }
  let left = rect.x, top = rect.y, right = rect.x + rect.width, bottom = rect.y + rect.height;
  const outermostHtmlReflection = exactHtmlReflections.lastIndexOf(true);
  for (let index = 0; index < chain.length; index++) {
    const clipRect = clipRects[index] ?? null;
    if (clipRect !== null) {
      left = Math.max(left, clipRect.x);
      top = Math.max(top, clipRect.y);
      right = Math.min(right, clipRect.x + clipRect.width);
      bottom = Math.min(bottom, clipRect.y + clipRect.height);
    }
    // The element's own overflow clips descendants, not its own box.
    if (index === 0) continue;
    const style = styles[index]!, parent = chain[index]!;
    // The certified direct fill lies inside this root's physical viewport.
    // No axis scale is inferred through a rotated root.
    if (parent === containedSvg?.root) continue;
    // Only ordinary ancestor overflow outside a proved viewport anchor escapes.
    // Explicit clip-path/legacy clips were processed above and still apply.
    if (fixedAnchor.status === "proven" && index > fixedAnchor.index) continue;
    const overflowX = readCss(parent, style, "overflowX");
    const overflowY = readCss(parent, style, "overflowY");
    // An absolute target escapes ordinary overflow only between itself and its
    // nearest proven containing block. The containing block and outer ancestors
    // still clip, and explicit clip-path/legacy clips were processed above.
    if (absoluteContainingBlock.status === "proven" && index < absoluteContainingBlock.index
      && (overflowX === "visible" || overflowX === "hidden" || overflowX === "scroll" || overflowX === "auto")
      && (overflowY === "visible" || overflowY === "hidden" || overflowY === "scroll" || overflowY === "auto")) continue;
    const clipsX = overflowX === "hidden" || overflowX === "clip" || overflowX === "scroll" || overflowX === "auto";
    const clipsY = overflowY === "hidden" || overflowY === "clip" || overflowY === "scroll" || overflowY === "auto";
    // An axis-reflected root is not a convex-contained fill: its physical
    // viewport must actually clip the direct path on each declared axis.
    if (parent === reflectedSvg?.root) {
      if (clipsX) {
        left = Math.max(left, reflectedSvg.viewport.x);
        right = Math.min(right, reflectedSvg.viewport.x + reflectedSvg.viewport.width);
      }
      if (clipsY) {
        top = Math.max(top, reflectedSvg.viewport.y);
        bottom = Math.min(bottom, reflectedSvg.viewport.y + reflectedSvg.viewport.height);
      }
      continue;
    }
    if (!clipsX && !clipsY) continue;
    if (parent === document.documentElement && parent.tagName.toLowerCase() === "html") {
      const viewport = rootScrollport(document, window, parent, style);
      if (viewport === null) return null;
      if (clipsX) { left = Math.max(left, viewport.x); right = Math.min(right, viewport.x + viewport.width); }
      if (clipsY) { top = Math.max(top, viewport.y); bottom = Math.min(bottom, viewport.y + viewport.height); }
      continue;
    }
    if (parent.tagName.toLowerCase() === "svg" && svgUserSpaceClipBox(parent)) {
      // Nested svg viewport: use the measured physical viewport, never the
      // letterboxed viewBox content bounds.
      const mapping = resolveSvgUserSpaceMapping(parent, window);
      if (mapping === null) return null;
      const viewport = mapping.viewport;
      if (clipsX) {
        left = Math.max(left, viewport.x);
        right = Math.min(right, viewport.x + viewport.width);
      }
      if (clipsY) {
        top = Math.max(top, viewport.y);
        bottom = Math.min(bottom, viewport.y + viewport.height);
      }
      continue;
    }
    const physicalSvgAxesKnown = (overflowX === "hidden" || overflowX === "visible")
      && (overflowY === "hidden" || overflowY === "visible");
    if (parent.tagName.toLowerCase() === "svg" && physicalSvgAxesKnown
      && (overflowX === "hidden" || overflowY === "hidden")) {
      let unitHtmlChain = true;
      for (let ancestorIndex = index + 1; ancestorIndex < chain.length; ancestorIndex++) {
        const ancestor = chain[ancestorIndex]!;
        const scale = scales[ancestorIndex];
        if (ancestor.namespaceURI !== XHTML_NAMESPACE
          || (!exactHtmlReflections[ancestorIndex] && (scale == null || scale.x !== 1 || scale.y !== 1))) {
          unitHtmlChain = false;
          break;
        }
      }
      if (unitHtmlChain) {
        const viewport = resolveOutermostSvgPhysicalViewport(parent, window);
        if (viewport !== null) {
          if (overflowX === "hidden") {
            left = Math.max(left, viewport.x);
            right = Math.min(right, viewport.x + viewport.width);
          }
          if (overflowY === "hidden") {
            top = Math.max(top, viewport.y);
            bottom = Math.min(bottom, viewport.y + viewport.height);
          }
          continue;
        }
      }
    }
    const bounds = parent.getBoundingClientRect();
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return null;
    // Client offsets below a reflected axis cannot use the positive-axis
    // mapping. Physical SVG proofs above remain independent of this path.
    if (outermostHtmlReflection > index) return null;
    const cumulativeScale = cumulative[index];
    if (cumulativeScale == null) return null;
    if (clipsX) {
      if (!Number.isFinite(parent.clientLeft) || !Number.isFinite(parent.clientWidth)) return null;
      const x = bounds.x + cumulativeScale.x * parent.clientLeft;
      left = Math.max(left, x);
      right = Math.min(right, x + cumulativeScale.x * parent.clientWidth);
    }
    if (clipsY) {
      if (!Number.isFinite(parent.clientTop) || !Number.isFinite(parent.clientHeight)) return null;
      const y = bounds.y + cumulativeScale.y * parent.clientTop;
      top = Math.max(top, y);
      bottom = Math.min(bottom, y + cumulativeScale.y * parent.clientHeight);
    }
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

type OrdinaryOrderProof = true | "unsupported";
interface OrdinaryOrderPathNode {
  readonly element: Element;
  readonly style: CSSStyleDeclaration;
}

function ordinaryOrderPath(
  element: Element,
  styleByElement: ReadonlyMap<Element, CSSStyleDeclaration>,
): readonly OrdinaryOrderPathNode[] | null {
  const result: OrdinaryOrderPathNode[] = [];
  const seen = new Set<Element>();
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (seen.has(current)) return null;
    seen.add(current);
    const style = styleByElement.get(current);
    if (!style) return null;
    result.unshift({ element: current, style });
  }
  return result;
}

function ordinaryOrderTopLayerKnownFalse(
  document: Document,
  path: readonly OrdinaryOrderPathNode[],
): boolean {
  let fullscreenKnown = false;
  try {
    const fullscreenElement = (document as Document & { fullscreenElement?: unknown }).fullscreenElement;
    if (fullscreenElement !== undefined) {
      if (fullscreenElement !== null) return false;
      fullscreenKnown = true;
    }
  } catch {
    // The selector predicate below is a documented fallback for an unavailable getter.
  }
  if (!fullscreenKnown) {
    try {
      if (typeof document.querySelectorAll !== "function") return false;
      const matches = document.querySelectorAll(":fullscreen");
      if (!matches || typeof matches.length !== "number" || matches.length !== 0) return false;
      fullscreenKnown = true;
    } catch {
      return false;
    }
  }
  if (!fullscreenKnown) return false;
  for (const { element } of path) {
    if (typeof element.matches !== "function") return false;
    try {
      if (element.matches(":modal") || element.matches(":popover-open")) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function ordinaryOrderStackingFacts(style: CSSStyleDeclaration): boolean {
  const opacity = Number(style.opacity);
  const webkitBackdropFilter = (style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter;
  if (style.opacity === undefined || style.opacity === "" || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) return false;
  if (style.transform !== "none" || style.transformStyle !== "flat"
    || style.translate !== "none" || style.rotate !== "none" || style.scale !== "none"
    || style.perspective !== "none") return false;
  if (style.filter !== "none" || style.backdropFilter !== "none"
    || typeof webkitBackdropFilter !== "string"
    || (webkitBackdropFilter !== "" && webkitBackdropFilter !== "none")) return false;
  if (style.maskImage !== "none" || typeof style.webkitMaskImage !== "string"
    || (style.webkitMaskImage !== "" && style.webkitMaskImage !== "none")) return false;
  return style.mixBlendMode === "normal" && style.isolation === "auto"
    && style.contain === "none" && style.containerType === "normal"
    && style.willChange === "auto" && style.contentVisibility === "visible";
}

function ordinaryOrderZeroPath(
  path: readonly OrdinaryOrderPathNode[],
  start: number,
  end = path.length,
): boolean {
  const unsupportedTags = new Set([
    "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col", "ruby", "rt", "rp",
  ]);
  const supportedDisplays = new Set([
    "block", "inline", "inline-block", "flow-root", "list-item", "flex", "inline-flex", "grid", "inline-grid",
  ]);
  for (let index = start; index < end; index++) {
    const node = path[index];
    if (!node || node.element.namespaceURI !== XHTML_NAMESPACE
      || unsupportedTags.has(node.element.tagName.toLowerCase())) return false;
    const style = node.style;
    if (!supportedDisplays.has(style.display)
      || (style.position !== "static" && style.position !== "relative")
      || style.zIndex !== "auto"
      || !ordinaryOrderStackingFacts(style)) return false;
  }
  return true;
}

function ordinaryOrderOwnPaintKnown(
  target: Element,
  window: Window,
  styleByElement: ReadonlyMap<Element, CSSStyleDeclaration>,
): boolean {
  const style = styleByElement.get(target);
  if (!style || style.outlineStyle === undefined || style.outlineWidth === undefined
    || style.boxShadow === undefined || style.textShadow === undefined
    || style.backgroundImage === undefined || style.maskImage === undefined
    || typeof style.webkitMaskImage !== "string") return false;
  if (visibleOutline(style) !== false || style.boxShadow !== "none" || style.textShadow !== "none"
    || style.backgroundImage !== "none"
    || style.maskImage !== "none" || (style.webkitMaskImage !== "" && style.webkitMaskImage !== "none")) return false;
  for (const pseudo of ["::before", "::after"] as const) {
    const pseudoStyle = window.getComputedStyle(target, pseudo);
    if (pseudoStyle.content === undefined
      || !["none", "normal", '""', "''"].includes(pseudoStyle.content)) return false;
  }
  return true;
}

function knownSingleFragmentDomain(
  element: Element,
  node: ObservationNode,
  style: CSSStyleDeclaration,
  geometricPoint: { readonly x: number; readonly y: number },
  visibleRects: readonly Rect[],
  allowClearCorners: boolean,
  window: Window,
  styleByElement: ReadonlyMap<Element, CSSStyleDeclaration>,
): boolean {
  if (element.namespaceURI !== XHTML_NAMESPACE || node.fragments?.length !== 1
    || node.rect === null || node.clippedRect === null || !positive(node.clippedRect)
    || !allowClearCorners || style.clipPath !== "none" || style.display === "none"
    || style.visibility === "hidden" || style.visibility === "collapse") return false;
  if (![style.borderTopLeftRadius, style.borderTopRightRadius,
    style.borderBottomLeftRadius, style.borderBottomRightRadius].every(zeroLength)) return false;
  const scale = cumulativeScaleOf(element, window);
  if (!scale || scale.x <= 0 || scale.y <= 0) return false;
  if (!ordinaryOrderOwnPaintKnown(element, window, styleByElement)) return false;
  return visibleRects.some(rect => geometricPoint.x >= rect.x && geometricPoint.x <= rect.x + rect.width
    && geometricPoint.y >= rect.y && geometricPoint.y <= rect.y + rect.height);
}

function rectCovers(outer: Rect, inner: Rect): boolean {
  return outer.x <= inner.x && outer.y <= inner.y
    && outer.x + outer.width >= inner.x + inner.width
    && outer.y + outer.height >= inner.y + inner.height;
}

function coversAllRects(outer: Rect, rects: readonly Rect[]): boolean {
  return rects.length > 0 && rects.every(rect => positive(rect) && rectCovers(outer, rect));
}

function svgPathOwnPaintKnown(
  element: Element,
  window: Window,
  styleByElement: ReadonlyMap<Element, CSSStyleDeclaration>,
): boolean {
  const style = styleByElement.get(element);
  if (!style || style.outlineStyle === undefined || style.outlineWidth === undefined
    || style.boxShadow === undefined || style.textShadow === undefined
    || style.backgroundImage === undefined || style.maskImage === undefined
    || typeof style.webkitMaskImage !== "string") return false;
  if (visibleOutline(style) !== false || style.boxShadow !== "none" || style.textShadow !== "none"
    || style.backgroundImage !== "none" || style.maskImage !== "none"
    || (style.webkitMaskImage !== "" && style.webkitMaskImage !== "none")) return false;
  for (const pseudo of ["::before", "::after"] as const) {
    const content = window.getComputedStyle(element, pseudo).content;
    if (content === undefined) return false;
    if (!["none", "normal", '""', "''"].includes(content)) return false;
  }
  return true;
}

// Bounded negative-order seed. A center miss can hide the first native order
// witness of an eligible target. These fixed point sets only retrieve actual
// target/blocker order evidence; they do not prove paint coverage or replace
// the existing corner checks and complete subtraction.
function negativeOrderWitnessPoints(
  element: Element,
  node: ObservationNode,
  style: CSSStyleDeclaration,
  visibleRects: readonly Rect[],
  overlap: Rect,
  allowClearCorners: boolean,
  window: Window,
  styleByElement: ReadonlyMap<Element, CSSStyleDeclaration>,
): readonly { readonly x: number; readonly y: number }[] | null {
  // Multiline HTML SPAN: exactly two positive fragments of direct text and no
  // element-child escape. Own shadow, outline, generated content and other
  // unsupported paint expansion must be known absent.
  if (element.namespaceURI === XHTML_NAMESPACE && element.tagName.toLowerCase() === "span") {
    if (node.fragments?.length !== 2 || visibleRects.length !== 2) return null;
    if (element.children === undefined || element.children.length !== 0) return null;
    const directText = Array.from(element.childNodes)
      .filter(child => child.nodeType === 3).map(child => child.textContent ?? "").join("");
    if (hasNonFormatDirectText(directText) !== true) return null;
    if (!allowClearCorners) return null;
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse"
      || style.clipPath !== "none") return null;
    if (![style.borderTopLeftRadius, style.borderTopRightRadius,
      style.borderBottomLeftRadius, style.borderBottomRightRadius].every(zeroLength)) return null;
    const scale = cumulativeScaleOf(element, window);
    if (!scale || scale.x <= 0 || scale.y <= 0) return null;
    if (!ordinaryOrderOwnPaintKnown(element, window, styleByElement)) return null;
    return visibleRects.map(rect => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }));
  }
  // Direct leaf SVG PATH: the existing contained-fill certificate must already
  // admit it. A rotated root can keep atomic certification unavailable.
  if (element.namespaceURI === "http://www.w3.org/2000/svg"
    && element.tagName.toLowerCase() === "path") {
    if (node.clippedRect === null || !positive(node.clippedRect)) return null;
    if (element.children === undefined || element.children.length !== 0) return null;
    const contained = certifyContainedSvgOverflow(element, window);
    if (contained === null || contained.targetKind !== "directPath") return null;
    if (!svgPathOwnPaintKnown(element, window, styleByElement)) return null;
    const points: { readonly x: number; readonly y: number }[] = [];
    for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      for (const fy of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        points.push({ x: overlap.x + overlap.width * fx, y: overlap.y + overlap.height * fy });
      }
    }
    return points;
  }
  return null;
}

function proveOwnPaintBehindLaterPositiveBranch(
  document: Document,
  window: Window,
  blocker: Element,
  target: Element,
  styleByElement: ReadonlyMap<Element, CSSStyleDeclaration>,
): OrdinaryOrderProof {
  if (blocker === target || isWithin(blocker, target) || isWithin(target, blocker)) return "unsupported";
  const targetPath = ordinaryOrderPath(target, styleByElement);
  const blockerPath = ordinaryOrderPath(blocker, styleByElement);
  if (!targetPath || !blockerPath || targetPath[0]?.element !== blockerPath[0]?.element) return "unsupported";

  let divergence = 0;
  while (divergence < targetPath.length && divergence < blockerPath.length
    && targetPath[divergence]?.element === blockerPath[divergence]?.element) divergence++;
  const divergenceIndex = divergence - 1;
  const divergenceNode = targetPath[divergenceIndex];
  const targetBranch = targetPath[divergence];
  const coverBranch = blockerPath[divergence];
  if (!divergenceNode || !targetBranch || !coverBranch || divergenceNode.style.display !== "block") return "unsupported";
  if (targetBranch.style.display !== "block" || coverBranch.style.display !== "block") return "unsupported";
  const children = Array.from(divergenceNode.element.children ?? []);
  if (children.indexOf(targetBranch.element) < 0
    || children.indexOf(coverBranch.element) <= children.indexOf(targetBranch.element)) return "unsupported";

  const topLayerPath = Array.from(new Map([...targetPath, ...blockerPath]
    .map(node => [node.element, node] as const)).values());
  if (!ordinaryOrderTopLayerKnownFalse(document, topLayerPath)
    || !ordinaryOrderOwnPaintKnown(target, window, styleByElement)
    || !ordinaryOrderZeroPath(targetPath, divergenceIndex)) return "unsupported";

  let positiveContextIndex = -1;
  for (let index = divergence; index < blockerPath.length; index++) {
    const node = blockerPath[index]!;
    const zIndex = Number(node.style.zIndex);
    const positioned = ["relative", "absolute", "fixed", "sticky"].includes(node.style.position);
    if (positioned && node.style.zIndex !== "auto" && node.style.zIndex !== ""
      && Number.isFinite(zIndex) && zIndex > 0) {
      positiveContextIndex = index;
      break;
    }
  }
  if (positiveContextIndex < 0 || !ordinaryOrderZeroPath(blockerPath, divergenceIndex, positiveContextIndex)) {
    return "unsupported";
  }
  return true;
}

function roundedClippingAncestor(
  element: Element,
  window: Window,
  ancestry: ElementAncestry,
  includeSelf = false,
): boolean {
  const path = ancestryPath(element, ancestry);
  for (let index = includeSelf ? 0 : 1; index < path.length; index++) {
    const parent = path[index]!;
    const style = window.getComputedStyle(parent);
    if ([style.overflowX, style.overflowY].some(value => ["hidden", "clip", "scroll", "auto"].includes(value))
      && [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius]
        .some(value => Number.parseFloat(value || "0") > 0)) return true;
  }
  return false;
}

function ancestorRoundedClearCorners(
  element: Element,
  visibleBox: Rect,
  window: Window,
  styles: ReadonlyMap<Element, CSSStyleDeclaration>,
  ancestry: ElementAncestry,
): readonly Rect[] {
  const path: { element: Element; style: CSSStyleDeclaration }[] = [];
  for (const current of ancestryPath(element, ancestry)) {
    const style = styles.get(current);
    if (current.namespaceURI !== "http://www.w3.org/1999/xhtml" || !style
      || style.zoom !== "1" || localScaleOf(style.transform) === null
      || !["static", "relative", "absolute"].includes(style.position)
      || [style.translate, style.rotate, style.scale, style.perspective].some(value => value !== "none")
      || style.transformStyle !== "flat" || style.filter !== "none" || style.backdropFilter !== "none"
      || style.clipPath !== "none" || style.maskImage !== "none"
      || style.mixBlendMode !== "normal" || style.isolation !== "auto" || style.contain !== "none"
      || style.boxShadow !== "none" || style.textShadow !== "none"
      || style.borderImageSource !== "none" || !["none", "hidden"].includes(style.outlineStyle)) return [];
    const prefixed = style as CSSStyleDeclaration & { webkitBackdropFilter?: string; webkitMaskImage?: string };
    if ([prefixed.webkitBackdropFilter, prefixed.webkitMaskImage]
      .some(value => value !== undefined && value !== "" && value !== "none")) return [];
    if (typeof current.matches !== "function") return [];
    try {
      if ([":fullscreen", ":modal", ":popover-open"].some(selector => current!.matches(selector))) return [];
    } catch { return []; }
    path.push({ element: current, style });
  }
  for (const pseudo of ["::before", "::after"]) {
    if (!["none", "normal"].includes(window.getComputedStyle(element, pseudo).content)) return [];
  }
  for (const { element: parent, style } of path.slice(1)) {
    const hidden = style.overflowX === "hidden" && style.overflowY === "hidden";
    const unexpandedClip = style.overflowX === "clip" && style.overflowY === "clip"
      && ["0px", "content-box", "content-box 0px"].includes(style.overflowClipMargin);
    // A positioned clip contains the supported absolute/static descendant path.
    if ((!hidden && !unexpandedClip) || !["relative", "absolute"].includes(style.position)) continue;
    if (![style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth,
      style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].every(zeroLength)
      || parent.getClientRects().length !== 1) return [];
    const scale = cumulativeScaleOf(parent, window);
    if (scale === null) return [];
    const corners = roundedOuterClearCorners(parent.getBoundingClientRect(), visibleBox, style, scale);
    if (corners === null) return [];
    if (corners.length > 0) return corners;
  }
  return [];
}

function hitAt(document: Document, x: number, y: number): readonly Element[] | null {
  const doc = document as Document & { elementsFromPoint?: (x: number, y: number) => Element[] };
  if (typeof doc.elementsFromPoint === "function") return doc.elementsFromPoint(x, y);
  return null;
}

interface NativeWitnessViewport {
  readonly width: number;
  readonly height: number;
  readonly enabled: boolean;
}

interface NativePointQuery {
  readonly geometricPoint: { readonly x: number; readonly y: number };
  readonly nativePoint: { readonly x: number; readonly y: number };
  readonly hits: readonly Element[] | null;
  readonly supplemented: boolean;
}

function nativeWitnessViewport(window: Window): NativeWitnessViewport {
  const width = window.innerWidth, height = window.innerHeight;
  const nativeWindow = window as Window & {
    devicePixelRatio?: unknown;
    visualViewport?: { scale?: unknown; offsetLeft?: unknown; offsetTop?: unknown } | null;
  };
  try {
    const viewport = nativeWindow.visualViewport;
    return {
      width,
      height,
      enabled: Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
        && nativeWindow.devicePixelRatio === 1
        && viewport?.scale === 1
        && viewport?.offsetLeft === 0
        && viewport?.offsetTop === 0,
    };
  } catch {
    return { width, height, enabled: false };
  }
}

function reachesLastColumnBand(rect: Rect, width: number): boolean {
  return rect.x >= width - 1 && rect.x < width && rect.x + rect.width >= width;
}

function reachesLastRowBand(rect: Rect, height: number): boolean {
  return rect.y >= height - 1 && rect.y < height && rect.y + rect.height >= height;
}

function queryNativeHitPoint(
  document: Document,
  point: { readonly x: number; readonly y: number },
  rect: Rect,
  viewport: NativeWitnessViewport,
): NativePointQuery {
  const originalHits = hitAt(document, point.x, point.y);
  const original: NativePointQuery = {
    geometricPoint: point,
    nativePoint: point,
    hits: originalHits,
    supplemented: false,
  };
  if (originalHits === null || originalHits.length !== 0 || !viewport.enabled || !positive(rect)) return original;

  const right = reachesLastColumnBand(rect, viewport.width);
  const bottom = reachesLastRowBand(rect, viewport.height);
  if (!right && !bottom) return original;

  const nativePoint = {
    x: right ? viewport.width - 1 : point.x,
    y: bottom ? viewport.height - 1 : point.y,
  };
  if (nativePoint.x === point.x && nativePoint.y === point.y) return original;
  return {
    geometricPoint: point,
    nativePoint,
    hits: hitAt(document, nativePoint.x, nativePoint.y),
    supplemented: true,
  };
}

interface SurfaceClassification {
  readonly kind: "blocker" | "uncertain" | "transparent";
  readonly passThrough: boolean;
  readonly proven: boolean;
  readonly relevant: boolean;
  readonly clearInterior: Rect | null;
  readonly paintRect?: Rect | null;
  readonly clearCornerRects?: readonly Rect[];
  readonly gradientDomain?: AxisLinearGradientDomain;
}

interface ForegroundContext {
  readonly node: ObservationNode;
  readonly element: Element;
  readonly rect: Rect | null;
  readonly visibleRect: Rect | null;
  readonly surface: SurfaceClassification;
}

function cumulativeScaleOf(element: Element, window: Window): LocalScale | null {
  let x = 1, y = 1;
  for (let current: Element | null = element; current; current = current.parentElement) {
    const scale = localScaleOf(window.getComputedStyle(current).transform);
    if (scale === null) return null;
    x *= scale.x;
    y *= scale.y;
  }
  return { x, y };
}

function zeroPixels(value: string | undefined): boolean {
  if (value === undefined) return false;
  return /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:px)?$/.test(value.trim());
}

function absentPrefixedAlias(value: string | undefined): boolean {
  return value === undefined || value === "" || value === "none";
}

function outlineOnlyPseudoAbsent(style: CSSStyleDeclaration): boolean {
  const prefixed = style as CSSStyleDeclaration & {
    webkitMaskImage?: string;
    webkitBackdropFilter?: string;
  };
  const content = style.content;
  if (content === undefined || !["none", "normal", "", '""', "''"].includes(content)) return false;
  if (style.backgroundColor === undefined || parseCssAlpha(style.backgroundColor) !== 0
    || style.backgroundImage !== "none") return false;
  if (![style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth]
    .every(zeroPixels)) return false;
  if (style.borderImageSource !== "none" || style.boxShadow !== "none" || style.textShadow !== "none") return false;
  if (!["none", "hidden"].includes(String(style.outlineStyle ?? "").trim().toLowerCase())
    || !zeroPixels(style.outlineWidth)) return false;
  if (style.maskImage !== "none" || !absentPrefixedAlias(prefixed.webkitMaskImage)) return false;
  if (style.filter !== "none" || style.backdropFilter !== "none"
    || !absentPrefixedAlias(prefixed.webkitBackdropFilter) || style.clipPath !== "none") return false;
  return true;
}

function outlineOnlyPositiveAxisScale(element: Element, window: Window): LocalScale | null {
  let x = 1, y = 1;
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = window.getComputedStyle(current);
    const prefixed = style as CSSStyleDeclaration & {
      webkitMaskImage?: string;
      webkitBackdropFilter?: string;
    };
    if (style.zoom !== "1"
      || [style.translate, style.rotate, style.scale, style.perspective].some(value => value !== "none")
      || style.filter !== "none" || style.backdropFilter !== "none"
      || !absentPrefixedAlias(prefixed.webkitBackdropFilter)
      || style.maskImage !== "none" || !absentPrefixedAlias(prefixed.webkitMaskImage)
      || style.contain !== "none" || style.mixBlendMode !== "normal" || style.isolation !== "auto"
      || style.contentVisibility !== "visible" || style.transformStyle !== "flat" || style.willChange !== "auto") {
      return null;
    }
    const scale = localScaleOf(style.transform);
    if (scale === null) return null;
    x *= scale.x;
    y *= scale.y;
  }
  return { x, y };
}

function outlineOnlySurfaceClearInterior(
  node: ObservationNode,
  element: Element,
  style: CSSStyleDeclaration,
  window: Window,
): Rect | null {
  const prefixed = style as CSSStyleDeclaration & {
    webkitMaskImage?: string;
    webkitBackdropFilter?: string;
  };
  const tag = element.tagName.toLowerCase();
  if (element.namespaceURI !== XHTML_NAMESPACE
    || !["block", "flex"].includes(style.display)
    || ["img", "svg", "canvas", "video", "object", "iframe", "embed", "input", "textarea", "select", "button", "picture"].includes(tag)
    || node.fragments?.length !== 1 || !finitePositive(node.rect) || !finitePositive(node.clippedRect)
    || String(style.outlineStyle ?? "").trim().toLowerCase() !== "solid"
    || visibleOutline(style) !== true
    || style.backgroundColor === undefined || parseCssAlpha(style.backgroundColor) !== 0
    || style.backgroundImage !== "none"
    || ![style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth]
      .every(zeroPixels)
    || style.borderImageSource !== "none"
    || style.boxShadow !== "none" || style.textShadow !== "none"
    || style.maskImage !== "none" || !absentPrefixedAlias(prefixed.webkitMaskImage)
    || style.filter !== "none" || style.backdropFilter !== "none"
    || !absentPrefixedAlias(prefixed.webkitBackdropFilter)
    || style.clipPath !== "none"
    || style.mixBlendMode !== "normal" || style.isolation !== "auto"
    || style.contain !== "none" || style.contentVisibility !== "visible"
    || style.transformStyle !== "flat" || style.willChange !== "auto"
    || (style.pointerEvents !== "auto" && style.pointerEvents !== "none")) return null;
  const directText = Array.from(element.childNodes)
    .filter(child => child.nodeType === 3).map(child => child.textContent ?? "").join("");
  if (directText !== "") return null;
  for (const pseudo of ["::before", "::after"] as const) {
    if (!outlineOnlyPseudoAbsent(window.getComputedStyle(element, pseudo))) return null;
  }
  const scale = outlineOnlyPositiveAxisScale(element, window);
  return scale === null
    ? null
    : outlineOnlyClearInterior(node.rect!, node.clippedRect!, style, scale);
}

function surfaceFor(
  node: ObservationNode,
  element: Element,
  style: CSSStyleDeclaration,
  window: Window,
  ancestorOpacity: number,
  hidden: boolean,
  ancestry: ElementAncestry,
): SurfaceClassification {
  // An empty prefixed alias is absent evidence. It must not override the standard CSS fact.
  const declared = (value: string | undefined): boolean => value !== undefined && value !== "" && value !== "none";
  const ownOpacity = style.opacity === "" || style.opacity === undefined ? 1 : Number(style.opacity);
  const opacity = ancestorOpacity * (Number.isFinite(ownOpacity) ? ownOpacity : 1);
  const visible = !hidden && style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse"
    && opacity > 0;
  const tag = element.tagName.toLowerCase();
  const bgAlpha = visible ? parseCssAlpha(style.backgroundColor ?? "transparent") : 0;
  if (bgAlpha === null) {
    return { kind: "uncertain", passThrough: style.pointerEvents === "none", proven: false, relevant: visible, clearInterior: null };
  }
  const image = visible && (style.backgroundImage ?? "none") !== "none"
    && !backgroundImageOutsideBox(style, element.namespaceURI === "http://www.w3.org/1999/xhtml"
      && style.display === "block" && node.fragments?.length === 1);
  const mask = visible && (declared(style.maskImage) || declared(style.webkitMaskImage));
  const radius = visible && [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius]
    .some(value => value !== undefined && value !== "" && Number.parseFloat(value) > 0);
  const media = visible && ["img", "svg", "canvas", "video", "object"].includes(tag);
  const backdrop = visible && (declared(style.backdropFilter)
    || declared((style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter));
  const filter = visible && (style.filter ?? "none") !== "none";
  const beforeContent = visible ? window.getComputedStyle(element, "::before").content : undefined;
  const afterContent = visible ? window.getComputedStyle(element, "::after").content : undefined;
  const pseudo = [beforeContent, afterContent].some(content => content !== undefined && content !== "none" && content !== "normal" && content !== '""' && content !== "''");
  const rawDirectText = Array.from(element.childNodes).filter(child => child.nodeType === 3).map(child => child.textContent ?? "").join("");
  const ownText = visible && hasNonFormatDirectText(rawDirectText) === true;
  const boxShadow = style.boxShadow;
  const shadow = visible && boxShadow !== undefined && boxShadow.trim() !== "" && boxShadow.trim() !== "none";
  const outline = visible ? visibleOutline(style) : false;
  const borders = visible ? visibleBorder(style) : false;
  if (!visible) return { kind: "transparent", passThrough: false, proven: false, relevant: false, clearInterior: null };
  if (borders === null || outline === null) {
    return { kind: "uncertain", passThrough: style.pointerEvents === "none", proven: false, relevant: true, clearInterior: null };
  }
  const gradientCandidate = elementNamespace(element) === XHTML_NAMESPACE
    && image && (style.pointerEvents === "auto" || style.pointerEvents === "none")
    && !mask && !filter && !media && !ownText && !pseudo && !shadow && !outline && borders === false
    && style.clipPath === "none"
    && style.mixBlendMode === "normal" && style.isolation === "auto"
    && style.contain === "none" && style.contentVisibility === "visible"
    && style.transformStyle === "flat" && style.willChange === "auto"
    && [style.translate, style.rotate, style.scale, style.perspective]
      .every(value => value === "none")
    && !radius && !roundedClippingAncestor(element, window, ancestry, true);
  if (gradientCandidate && node.rect !== null && node.clippedRect !== null
    && positive(node.rect) && positive(node.clippedRect) && node.fragments?.length === 1) {
    let zoomProven = true, gradientOpacityProven = true, gradientEffectiveOpacity = 1;
    for (let current: Element | null = element; current; current = current.parentElement) {
      const currentStyle = current === element ? style : window.getComputedStyle(current);
      const opacityText = currentStyle.opacity;
      const opacityValue = opacityText === undefined || String(opacityText).trim() === ""
        ? null : Number(opacityText);
      if (opacityValue === null || !Number.isFinite(opacityValue)
        || opacityValue < 0 || opacityValue > 1) {
        gradientOpacityProven = false;
        break;
      }
      gradientEffectiveOpacity *= opacityValue;
      const prefixed = currentStyle as CSSStyleDeclaration & { webkitBackdropFilter?: string; webkitMaskImage?: string };
      if (declared(currentStyle.maskImage) || declared(prefixed.webkitMaskImage)
        || declared(currentStyle.backdropFilter) || declared(prefixed.webkitBackdropFilter)
        || currentStyle.filter !== "none" || currentStyle.clipPath !== "none"
        || currentStyle.contain !== "none" || currentStyle.mixBlendMode !== "normal"
        || currentStyle.isolation !== "auto" || currentStyle.contentVisibility !== "visible"
        || currentStyle.transformStyle !== "flat" || currentStyle.willChange !== "auto") {
        zoomProven = false;
        break;
      }
      if (currentStyle.zoom !== "1"
        || [currentStyle.translate, currentStyle.rotate, currentStyle.scale, currentStyle.perspective]
          .some(value => value !== undefined && value !== "none")) {
        zoomProven = false;
        break;
      }
    }
    const gradientScale = zoomProven ? cumulativeScaleOf(element, window) : null;
    if (gradientOpacityProven
      && gradientScale !== null && gradientScale.x > 0 && gradientScale.y > 0
      && hasNoEscapeEffects(element, window)) {
      const gradientDomain = axisLinearGradientDomain({
        style,
        borderBox: node.rect,
        scale: gradientScale,
        effectiveOpacity: gradientEffectiveOpacity,
        alphaOfColor: parseCssAlpha,
      });
      if (gradientDomain !== null) {
        const pointerPassThrough = style.pointerEvents === "none";
        const paintRect = axisLinearGradientPaintRect(gradientDomain, pointerPassThrough);
        return paintRect === null
          ? {
            kind: "transparent", passThrough: pointerPassThrough, proven: false,
            relevant: true, clearInterior: null, gradientDomain,
          }
          : {
            kind: "blocker", passThrough: pointerPassThrough, proven: true,
            relevant: true, clearInterior: null, paintRect, gradientDomain,
          };
      }
    }
  }
  const hasOwnPaint = bgAlpha > 0 || image || mask || backdrop || filter || media || ownText || pseudo || borders || shadow || outline;
  if (!hasOwnPaint) {
    return { kind: "transparent", passThrough: style.pointerEvents === "none", proven: false, relevant: false, clearInterior: null };
  }
  const borderOnly = bgAlpha === 0 && borders && !image && !mask && !backdrop && !filter && !media
    && !ownText && !pseudo && !shadow && !outline;
  if (borderOnly) {
    const scale = cumulativeScaleOf(element, window);
    const clearInterior = scale !== null && node.rect !== null && node.clippedRect !== null
      && node.fragments !== null && node.fragments.length === 1
      ? borderOnlyClearInterior(node.rect, node.clippedRect, style, scale)
      : null;
    if (clearInterior !== null && opacity === 1 && opaqueSolidBorderRing(style)) {
      return { kind: "blocker", passThrough: style.pointerEvents === "none", proven: true, relevant: true, clearInterior };
    }
    return { kind: "uncertain", passThrough: style.pointerEvents === "none", proven: false, relevant: true, clearInterior };
  }
  const outlineOnlyCandidate = bgAlpha === 0 && outline === true && borders === false
    && !image && !mask && !backdrop && !filter && !media && !ownText && !shadow;
  if (outlineOnlyCandidate) {
    const clearInterior = outlineOnlySurfaceClearInterior(node, element, style, window);
    if (clearInterior !== null) {
      return { kind: "uncertain", passThrough: style.pointerEvents === "none", proven: false, relevant: true, clearInterior };
    }
  }
  const rect = node.rect, clippedRect = node.clippedRect;
  const clippedReplaced = (tag === "img" || tag === "video")
    && !image && !mask && !backdrop && !filter && !ownText && !pseudo && !shadow && !outline
    && [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft,
      style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].every(zeroLength)
    && rect !== null && clippedRect !== null && node.fragments?.length === 1
    && boundedReplacedPaint(element, window);
  if (clippedReplaced && rect !== null && clippedRect !== null) {
    let knownZoom = true;
    for (let current: Element | null = element; current; current = current.parentElement) {
      if (window.getComputedStyle(current).zoom !== "1") knownZoom = false;
    }
    const scale = knownZoom ? cumulativeScaleOf(element, window) : null;
    // Rounded clip corners need the original overflow-clip guard. The contain
    // bound is separate and additionally requires an unfilled own background so
    // a letterbox band cannot be silently narrowed.
    const corners = scale !== null && style.overflowX === "clip" && style.overflowY === "clip"
      && (tag === "img" || ["0px", "content-box", "content-box 0px"].includes(style.overflowClipMargin))
      ? roundedOuterClearCorners(rect, clippedRect, style, scale)
      : null;
    const paintRect = tag === "img" && scale !== null && bgAlpha === 0 && !borders
      ? containedReplacedPaintRect(rect, clippedRect, style, scale, replacedObjectIntrinsicFacts(element))
      : null;
    if (paintRect !== null || (corners !== null && corners.length > 0)) {
      return {
        kind: "uncertain", passThrough: style.pointerEvents === "none", proven: false,
        relevant: true, clearInterior: null,
        ...(paintRect !== null ? { paintRect } : {}),
        ...(corners !== null && corners.length > 0 ? { clearCornerRects: corners } : {}),
      };
    }
  }
  const contentBoxCoincidentOpaque = style.backgroundClip === "content-box"
    && [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft,
      style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].every(zeroLength)
    && bgAlpha === 1 && opacity === 1;
  const pure = node.clippedRect !== null && positive(node.clippedRect) && !radius && !image && !mask && !media && !backdrop && !filter
    && (!shadow || contentBoxCoincidentOpaque) && !outline
    && style.clipPath === "none" && !roundedClippingAncestor(element, window, ancestry)
    && (!style.backgroundClip || style.backgroundClip === "border-box" || contentBoxCoincidentOpaque);
  if (!pure) return { kind: "uncertain", passThrough: style.pointerEvents === "none", proven: false, relevant: true, clearInterior: null };
  if (style.pointerEvents === "none") {
    return bgAlpha === 1 && opacity === 1
      ? { kind: "blocker", passThrough: true, proven: true, relevant: true, clearInterior: null }
      : { kind: "transparent", passThrough: true, proven: false, relevant: true, clearInterior: null };
  }
  return bgAlpha * opacity > 0
    ? { kind: "blocker", passThrough: false, proven: true, relevant: true, clearInterior: null }
    : { kind: "uncertain", passThrough: false, proven: false, relevant: true, clearInterior: null };
}

function surfacePaintRects(surface: SurfaceClassification, outer: Rect, allowCorners: boolean): Rect[] {
  const gradientRect = surface.gradientDomain === undefined
    ? undefined
    : axisLinearGradientPaintRect(surface.gradientDomain, surface.passThrough);
  const paintRect = surface.gradientDomain === undefined ? surface.paintRect : gradientRect;
  if (surface.gradientDomain !== undefined && paintRect === null) return [];
  const base = paintRect ? intersection(outer, paintRect) : outer;
  if (!positive(base)) return [];
  let result: Rect[] = [base];
  const clear = [...(surface.clearInterior === null ? [] : [surface.clearInterior]),
    ...(allowCorners ? surface.clearCornerRects ?? [] : [])];
  for (const rect of clear) result = result.flatMap(piece => subtractRect(piece, rect));
  return result;
}

function subtractSurface(source: readonly Rect[] | null, surface: SurfaceClassification, outer: Rect, allowCorners = true): Rect[] | null {
  if (source === null) return null;
  let result: Rect[] | null = [...source];
  for (const piece of surfacePaintRects(surface, outer, allowCorners)) {
    result = subtractAll(result, piece);
    if (result === null) break;
  }
  return result;
}

function surfacePaintsAt(surface: SurfaceClassification, x: number, y: number, allowCorners = true): boolean {
  if (surface.gradientDomain !== undefined) {
    if (!axisLinearGradientPaintsAt(surface.gradientDomain, x, y, surface.passThrough)) return false;
  } else if (surface.paintRect
    && !(x >= surface.paintRect.x && x <= surface.paintRect.x + surface.paintRect.width
      && y >= surface.paintRect.y && y <= surface.paintRect.y + surface.paintRect.height)) return false;
  const clear = [...(surface.clearInterior === null ? [] : [surface.clearInterior]),
    ...(allowCorners ? surface.clearCornerRects ?? [] : [])];
  return !clear.some(rect => x > rect.x && x < rect.x + rect.width && y > rect.y && y < rect.y + rect.height);
}

// Read native replaced-object facts without inventing missing defaults.
function replacedObjectIntrinsicFacts(element: Element): ReplacedObjectIntrinsicFacts {
  const image = element as { complete?: unknown; naturalWidth?: unknown; naturalHeight?: unknown; currentSrc?: unknown };
  const currentSrc = image.currentSrc;
  return {
    complete: typeof image.complete === "boolean" ? image.complete : null,
    naturalWidth: typeof image.naturalWidth === "number" && Number.isFinite(image.naturalWidth) ? image.naturalWidth : null,
    naturalHeight: typeof image.naturalHeight === "number" && Number.isFinite(image.naturalHeight) ? image.naturalHeight : null,
    sourcePresent: typeof currentSrc === "string" && currentSrc.trim() !== "",
  };
}

// This bounds possible image paint; it proves neither image opacity nor order.
function boundedImagePaint(element: Element, window: Window): boolean {
  return element.tagName.toLowerCase() === "img" && boundedReplacedPaint(element, window);
}

function boundedReplacedPaint(element: Element, window: Window): boolean {
  if (!["img", "video"].includes(element.tagName.toLowerCase())) return false;
  const style = window.getComputedStyle(element);
  if (style.boxShadow !== "none" || style.borderImageSource !== "none"
    || !["none", "hidden"].includes(style.outlineStyle)) return false;
  for (const pseudo of ["::before", "::after"]) {
    if (!["none", "normal"].includes(window.getComputedStyle(element, pseudo).content)) return false;
  }
  for (let current: Element | null = element; current; current = current.parentElement) {
    const currentStyle = window.getComputedStyle(current);
    if (currentStyle.filter !== "none" || currentStyle.backdropFilter !== "none") return false;
    const prefixed = (currentStyle as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter;
    if (prefixed !== undefined && prefixed !== "" && prefixed !== "none") return false;
  }
  return true;
}

export interface ForegroundDiagnosticSurface {
  readonly kind: "blocker" | "uncertain" | "transparent";
  readonly proven: boolean;
  readonly passThrough: boolean;
  readonly relevant: boolean;
  readonly clearInterior: Rect | null;
}

export type ForegroundDiagnosticBlockerOutcome =
  | "remaining_unavailable_break"
  | "blocker_rect_unavailable"
  | "overlap_unavailable"
  | "hit_unavailable_break"
  | "paint_order_uncertain_subtracted"
  | "bounded_image_order_uncertain_subtracted"
  | "pointer_not_before"
  | "uncertain_surface_subtracted"
  | "fragment_cap_break"
  | "ordinary_order_proven_subtracted"
  | "proven_surface_subtracted";

export type ForegroundDiagnosticEvent =
  | {
    readonly phase: "initial";
    readonly targetRef: string;
    readonly node: ObservationNode;
    readonly clippedRect: Rect | null;
    readonly visibleRects: readonly Rect[];
    readonly surface: ForegroundDiagnosticSurface | null;
  }
  | {
    readonly phase: "blocker";
    readonly targetRef: string;
    readonly blockerRef: string;
    readonly kind: "blocker" | "uncertain" | "transparent";
    readonly proven: boolean;
    readonly clearInterior: Rect | null;
    readonly overlap: Rect | null;
    readonly hitRefs: readonly (string | null)[] | null;
    readonly nativeBefore: boolean;
    readonly nativeOrderWitnessRef?: string;
    readonly nativeWitnessPoint?: { readonly x: number; readonly y: number };
    readonly paintOrderBefore: boolean | "uncertain" | "not_queried";
    readonly pointerBefore: boolean;
    readonly remainingBefore: number | null;
    readonly remainingAfter: number | null;
    readonly provenRemainingBefore: number | null;
    readonly provenRemainingAfter: number | null;
    readonly outcome: ForegroundDiagnosticBlockerOutcome;
  }
  | {
    readonly phase: "point_probe";
    readonly targetRef: string;
    readonly remainingRect: Rect;
    readonly point: { readonly x: number; readonly y: number };
    readonly nativePoint?: { readonly x: number; readonly y: number };
    readonly hitRefs: readonly (string | null)[] | null;
    readonly firstOpaqueRef: string | null;
    readonly chosenOwnerRef: string | null;
    readonly targetBeforeOpaque: boolean;
    readonly exposed: boolean;
  }
  | {
    readonly phase: "final";
    readonly targetRef: string;
    readonly foreground: ForegroundState | null;
    readonly exposedRects: readonly Rect[] | null;
    readonly reason?: string;
  };

const diagnosticSurface = (surface: SurfaceClassification | undefined): ForegroundDiagnosticSurface | null => surface === undefined ? null : ({
  kind: surface.kind,
  proven: surface.proven,
  passThrough: surface.passThrough,
  relevant: surface.relevant,
  clearInterior: surface.clearInterior,
});

const remainingCount = (rects: readonly Rect[] | null): number | null => rects === null ? null : rects.length;

function isTopLayer(element: Element): boolean | null {
  try {
    if (typeof element.matches !== "function") return null;
    return [":fullscreen", ":modal", ":popover-open"].some(selector => element.matches(selector));
  } catch {
    return null;
  }
}

function nativeTabIndexOf(element: Element): number | null {
  try {
    const native = (element as Element & { tabIndex?: unknown }).tabIndex;
    return typeof native === "number" && Number.isInteger(native) ? native : null;
  } catch {
    return null;
  }
}

function pointerEventsNone(style: CSSStyleDeclaration): boolean | null {
  const value = style.pointerEvents;
  return value === undefined || value === "" ? null : value === "none";
}

function strictZeroOpacity(style: CSSStyleDeclaration): boolean | null {
  const raw = style.opacity;
  if (raw === undefined || String(raw).trim() === "") return null;
  const text = String(raw).trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value === 0 : null;
}

function htmlElement(element: Element): boolean {
  try {
    return element.namespaceURI === XHTML_NAMESPACE;
  } catch {
    return false;
  }
}

function zeroOpacityInCurrentPaintPath(
  element: Element,
  style: CSSStyleDeclaration,
  styleByElement: Map<Element, CSSStyleDeclaration>,
  cache: Map<Element, boolean | null>,
): boolean | null {
  const path: Element[] = [];
  let result: boolean | null = null;
  let current: Element | null = element;
  let currentStyle: CSSStyleDeclaration | undefined = style;
  while (current) {
    if (cache.has(current)) { result = cache.get(current)!; break; }
    path.push(current);
    if (!htmlElement(current) || currentStyle === undefined) break;
    const currentOpacity = strictZeroOpacity(currentStyle);
    if (currentOpacity === true) { result = true; break; }
    if (currentOpacity === null || isTopLayer(current) !== false) break;
    const parent: Element | null = current.parentElement;
    if (parent === null) { result = false; break; }
    current = parent;
    currentStyle = styleByElement.get(parent);
  }
  for (const entry of path) cache.set(entry, result);
  return result;
}

function elementNamespace(element: Element): string | null {
  try {
    const namespace = element.namespaceURI;
    return typeof namespace === "string" ? namespace : null;
  } catch {
    return null;
  }
}

function elementLocalTag(element: Element): string | null {
  try {
    const tag = element.tagName;
    return typeof tag === "string" ? tag.toLowerCase() : null;
  } catch {
    return null;
  }
}

function supportedSvgTarget(element: Element, tag: string): boolean {
  return (tag === "svg" || tag === "use") && elementNamespace(element) === SVG_NAMESPACE;
}

// An SVG proof only crosses an unbroken svg/use chain into HTML, and every
// node in that chain must be explicitly outside the top layer. The zero comes
// from one node's own computed opacity; products of small positives never count.
function svgZeroOpacityInCurrentPaintPath(
  element: Element,
  style: CSSStyleDeclaration,
  styleByElement: Map<Element, CSSStyleDeclaration>,
  cache: Map<Element, boolean | null>,
): boolean | null {
  const path: Element[] = [];
  let result: boolean | null = null;
  let current: Element | null = element;
  let currentStyle: CSSStyleDeclaration | undefined = style;
  let inSvgSegment = true;
  while (current) {
    if (cache.has(current)) { result = cache.get(current)!; break; }
    path.push(current);
    if (currentStyle === undefined) break;
    const namespace = elementNamespace(current);
    if (inSvgSegment) {
      if (namespace === XHTML_NAMESPACE) {
        inSvgSegment = false;
      } else if (namespace === SVG_NAMESPACE) {
        const tag = elementLocalTag(current);
        if (tag !== "svg" && tag !== "use") break;
      } else {
        break;
      }
    } else if (namespace !== XHTML_NAMESPACE) {
      break;
    }
    if (isTopLayer(current) !== false) break;
    const currentOpacity = strictZeroOpacity(currentStyle);
    if (currentOpacity === true) { result = true; break; }
    if (currentOpacity === null) break;
    const parent: Element | null = current.parentElement;
    if (parent === null) { result = false; break; }
    current = parent;
    currentStyle = styleByElement.get(parent);
  }
  for (const entry of path) cache.set(entry, result);
  return result;
}

function svgOwnLabelPresent(element: Element): boolean {
  for (const name of ["title", "aria-label", "aria-labelledby"]) {
    if (hasNonFormatDirectText(element.getAttribute(name)) === true) return true;
  }
  for (const child of Array.from(element.children ?? [])) {
    const tag = elementLocalTag(child);
    if (tag !== "title" && tag !== "desc") continue;
    if (hasNonFormatDirectText(child.textContent ?? "") === true) return true;
  }
  return false;
}

// Native SVG editability protects directly. Otherwise the complete svg/use
// chain must reach an HTML host whose existing measurement is authoritative;
// no separate designMode gate overrides a trusted HTML false.
function editingContextActiveFor(element: Element, document: Document): boolean | null {
  let native: unknown;
  try {
    native = (element as { isContentEditable?: unknown }).isContentEditable;
  } catch {
    return null;
  }
  if (native === true) return true;
  const visited = new Set<Element>();
  let current: Element | null = element;
  let nearestHtml: Element | null = null;
  while (current) {
    if (visited.has(current)) return null;
    visited.add(current);
    const namespace = elementNamespace(current);
    if (namespace === XHTML_NAMESPACE) {
      nearestHtml = current;
      break;
    }
    if (namespace !== SVG_NAMESPACE) return null;
    const tag = elementLocalTag(current);
    if (tag !== "svg" && tag !== "use") return null;
    try {
      current = current.parentElement;
    } catch {
      return null;
    }
  }
  if (nearestHtml === null) return null;
  return measureContentEditable(nearestHtml, document);
}

function currentViewRecordFor(
  element: Element,
  tag: string,
  style: CSSStyleDeclaration,
  styleByElement: Map<Element, CSSStyleDeclaration>,
  opacityPathCache: Map<Element, boolean | null>,
  svgOpacityPathCache: Map<Element, boolean | null>,
  document: Document,
  directText: boolean | null,
  ownLabelPresent: boolean | null,
  contentEditable: boolean | null,
): ObservationCurrentView | undefined {
  const htmlBranch = htmlElement(element) && (tag === "div" || tag === "object");
  const svgBranch = supportedSvgTarget(element, tag);
  if (!htmlBranch && !svgBranch) return undefined;
  let focusWithin: boolean | null = null;
  try {
    const matched = typeof element.matches === "function" ? element.matches(":focus-within") : null;
    focusWithin = typeof matched === "boolean" ? matched : null;
  } catch {
    focusWithin = null;
  }
  if (svgBranch) {
    return {
      namespaceURI: elementNamespace(element),
      zeroOpacityInCurrentPaintPath: svgZeroOpacityInCurrentPaintPath(element, style, styleByElement, svgOpacityPathCache),
      pointerEventsNone: pointerEventsNone(style),
      activeElementFocus: null,
      focusWithin,
      nativeTabIndex: nativeTabIndexOf(element),
      contentEditable: null,
      editingContextActive: editingContextActiveFor(element, document),
      directTextPresent: directText,
      ownLabelPresent,
      topLayer: isTopLayer(element),
    };
  }
  return {
    zeroOpacityInCurrentPaintPath: zeroOpacityInCurrentPaintPath(element, style, styleByElement, opacityPathCache),
    pointerEventsNone: pointerEventsNone(style),
    activeElementFocus: null,
    focusWithin,
    nativeTabIndex: nativeTabIndexOf(element),
    contentEditable,
    directTextPresent: directText,
    ownLabelPresent,
    topLayer: isTopLayer(element),
  };
}

function hasZeroEdges(style: CSSStyleDeclaration): boolean {
  return [
    style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth,
    style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft,
  ].every(zeroLength);
}

function hasNoEscapeEffects(element: Element, window: Window): boolean {
  const style = window.getComputedStyle(element);
  if (style.boxShadow !== "none" || style.borderImageSource !== "none"
    || !["none", "hidden"].includes(style.outlineStyle)
    || style.clipPath !== "none") return false;
  if ((style.maskImage && style.maskImage !== "none")
    || ((style as CSSStyleDeclaration & { webkitMaskImage?: string }).webkitMaskImage && (style as CSSStyleDeclaration & { webkitMaskImage?: string }).webkitMaskImage !== "none")) return false;
  for (const pseudo of ["::before", "::after"]) {
    if (!["none", "normal"].includes(window.getComputedStyle(element, pseudo).content)) return false;
  }
  for (let current: Element | null = element; current; current = current.parentElement) {
    const currentStyle = window.getComputedStyle(current);
    if (currentStyle.filter !== "none" || currentStyle.backdropFilter !== "none") return false;
    const prefixed = (currentStyle as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter;
    if (prefixed !== undefined && prefixed !== "" && prefixed !== "none") return false;
  }
  return true;
}

function commonAncestorOf(a: Element, b: Element): Element | null {
  const ancestors = new Set<Element>();
  for (let current: Element | null = a.parentElement; current; current = current.parentElement) {
    ancestors.add(current);
  }
  for (let current: Element | null = b.parentElement; current; current = current.parentElement) {
    if (ancestors.has(current)) return current;
  }
  return null;
}

function sameRect(left: Rect, right: Rect): boolean {
  return left.x === right.x && left.y === right.y
    && left.width === right.width && left.height === right.height;
}

function rectangleDomain(rect: Rect): RoundedRectDomain {
  return {
    bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    radii: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
  };
}

function boundedEmptyHtmlSubtree(element: Element, window: Window): boolean {
  if (element.namespaceURI !== XHTML_NAMESPACE || element.tagName.toLowerCase() !== "div") return false;
  const text = Array.from(element.childNodes)
    .filter(child => child.nodeType === 3)
    .map(child => child.textContent ?? "")
    .join("");
  if (hasNonFormatDirectText(text) === true) return false;
  const children = Array.from(element.children);
  if (children.length > 1 || (children.length === 1 && children[0]!.tagName.toLowerCase() !== "div")) return false;
  if (children.length === 1) {
    const rect = element.getBoundingClientRect(), childRect = children[0]!.getBoundingClientRect();
    if (![rect.x, rect.y, rect.width, rect.height, childRect.x, childRect.y, childRect.width, childRect.height]
      .every(Number.isFinite) || !sameRect(rect, childRect)) return false;
  }
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse"
    || style.backgroundImage !== "none" || style.mixBlendMode !== "normal"
    || style.isolation !== "auto" || !hasNoEscapeEffects(element, window)) return false;
  return children.length === 0 || boundedEmptyHtmlSubtree(children[0]!, window);
}

// A normal source-over background can add coverage without removing opaque
// descendant pixels. This lower-bound proof is not a paint-bounds proof.
function preservesOpaqueDescendantCoverage(element: Element, window: Window): boolean {
  const supported = (style: CSSStyleDeclaration): boolean => style.opacity === "1"
    && style.mixBlendMode === "normal" && style.filter === "none" && style.backdropFilter === "none"
    && style.clipPath === "none" && style.maskImage === "none"
    && [style.webkitMaskImage, (style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter]
      .every(value => value === undefined || value === "" || value === "none")
    && style.boxShadow === "none" && style.borderImageSource === "none"
    && ["none", "hidden"].includes(style.outlineStyle);
  if (!supported(window.getComputedStyle(element))) return false;
  for (const pseudo of ["::before", "::after"]) {
    const style = window.getComputedStyle(element, pseudo);
    if (["none", "normal"].includes(style.content)) continue;
    if (!["\"\"", "''"].includes(style.content) || !supported(style)
      || !style.backgroundImage.startsWith("linear-gradient(")) return false;
  }
  return true;
}

interface ImageCoverageProof {
  readonly targetPaintDomain: RoundedRectDomain;
  readonly commonAncestor: Element;
}

function verifyImageResourceProof(
  element: Element,
  documentRef: string,
  registry: StableNodeRefRegistry,
  imageResourceFor?: (element: Element) => JpegImageResourceObservation | undefined,
): boolean {
  if (!imageResourceFor || element.tagName.toLowerCase() !== "img") return false;
  let observation: JpegImageResourceObservation | undefined;
  try {
    observation = imageResourceFor(element);
  } catch {
    return false;
  }
  if (!observation || observation.status !== "proven") return false;
  const proof = observation.proof;
  if (!proof || !proof.binding) return false;
  const binding = proof.binding;
  if (binding.documentRef !== documentRef) return false;
  if (binding.nodeRef !== stableNodeRefFor(registry, element)) return false;

  const img = element as HTMLImageElement;
  if (img.currentSrc !== binding.currentSrc || typeof img.currentSrc !== "string" || img.currentSrc.trim() === "") {
    return false;
  }
  if (img.complete !== true || binding.complete !== true) return false;
  if (
    typeof img.naturalWidth !== "number"
    || typeof img.naturalHeight !== "number"
    || img.naturalWidth <= 0
    || img.naturalHeight <= 0
    || img.naturalWidth !== binding.naturalWidth
    || img.naturalHeight !== binding.naturalHeight
    || proof.width !== binding.naturalWidth
    || proof.height !== binding.naturalHeight
  ) {
    return false;
  }
  return true;
}

function certifyImageCoverage(
  targetElement: Element,
  targetNode: ObservationNode,
  blockerElement: Element,
  blockerNode: ObservationNode,
  targetVisibleRect: Rect,
  window: Window,
  styleByElement: Map<Element, CSSStyleDeclaration>,
  effectiveOpacity: Map<Element, number>,
): ImageCoverageProof | null {
  const targetTag = targetElement.tagName.toLowerCase();
  if (!["video", "div"].includes(targetTag) || blockerElement.tagName.toLowerCase() !== "img") return null;
  if (targetElement.namespaceURI !== XHTML_NAMESPACE || targetNode.fragments?.length !== 1) return null;
  if (blockerElement.namespaceURI !== XHTML_NAMESPACE || blockerNode.fragments?.length !== 1) return null;
  if (!positive(targetVisibleRect)) return null;
  if (effectiveOpacity.get(targetElement) !== 1 || effectiveOpacity.get(blockerElement) !== 1) {
    return null;
  }
  if (targetTag === "div" && !boundedEmptyHtmlSubtree(targetElement, window)) return null;
  if (isTopLayer(targetElement) !== false || isTopLayer(blockerElement) !== false) {
    return null;
  }
  const targetStyle = styleByElement.get(targetElement);
  const blockerStyle = styleByElement.get(blockerElement);
  if (!targetStyle || !blockerStyle) return null;
  const supportedStyle = (style: CSSStyleDeclaration): boolean => style.zoom === "1"
    && [style.translate, style.rotate, style.scale, style.perspective].every(value => value === "none")
    && style.transformStyle === "flat" && style.mixBlendMode === "normal" && style.isolation === "auto"
    && style.contain === "none" && style.clip === "auto";
  for (const element of [targetElement, blockerElement]) {
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = styleByElement.get(current);
      if (!style || !supportedStyle(style) || isTopLayer(current) !== false) return null;
    }
  }

  if (!hasZeroEdges(blockerStyle)) return null;
  if (![blockerStyle.borderTopLeftRadius, blockerStyle.borderTopRightRadius,
    blockerStyle.borderBottomRightRadius, blockerStyle.borderBottomLeftRadius].every(zeroLength)) return null;
  if (!hasNoEscapeEffects(targetElement, window) || !hasNoEscapeEffects(blockerElement, window)) {
    return null;
  }

  const targetScale = cumulativeScaleOf(targetElement, window);
  const blockerScale = cumulativeScaleOf(blockerElement, window);
  if (!targetScale || targetScale.x <= 0 || targetScale.y <= 0
    || !blockerScale || blockerScale.x <= 0 || blockerScale.y <= 0) {
    return null;
  }

  if (!targetNode.rect || !blockerNode.rect || !blockerNode.clippedRect) return null;
  const bgAlpha = parseCssAlpha(blockerStyle.backgroundColor ?? "transparent");
  if (bgAlpha !== 0) return null;

  const coverageRect = fullReplacedImageCoverageRect(
    blockerNode.rect,
    blockerStyle,
    blockerScale,
    replacedObjectIntrinsicFacts(blockerElement),
  );
  if (!coverageRect || !sameRect(coverageRect, blockerNode.rect) || !boundedImagePaint(blockerElement, window)) return null;

  const commonAncestor = commonAncestorOf(targetElement, blockerElement);
  if (!commonAncestor) return null;

  let imageDomain: RoundedRectDomain | null = null;
  let reachedCommon = false;
  for (let curr: Element | null = blockerElement.parentElement; curr; curr = curr.parentElement) {
    if (curr.namespaceURI !== XHTML_NAMESPACE || curr.getClientRects().length !== 1) return null;
    if (effectiveOpacity.get(curr) !== 1) return null;
    if (isTopLayer(curr) !== false) return null;
    const currStyle = styleByElement.get(curr) ?? window.getComputedStyle(curr);
    if (!hasZeroEdges(currStyle) || !preservesOpaqueDescendantCoverage(curr, window)) return null;
    const currScale = cumulativeScaleOf(curr, window);
    if (!currScale || currScale.x <= 0 || currScale.y <= 0) return null;

    const unclipped = currStyle.overflowX === "visible" && currStyle.overflowY === "visible";
    if (unclipped) {
      if (curr === commonAncestor) {
        reachedCommon = true;
        break;
      }
      continue;
    }
    const currDomain = extractRoundedClipDomain(curr.getBoundingClientRect(), currStyle, currScale, "hidden_or_clip");
    // The image's raw border box may be taller or wider than the rounded
    // ancestor clip. The effective image domain is the clipped rect, while
    // intrinsic cover is still proven against the raw rect above.
    if (!currDomain || !sameRect(currDomain.bounds, blockerNode.clippedRect)) return null;
    const rounded = currDomain.radii.some(radius => radius.x > 0 || radius.y > 0);
    if (rounded && imageDomain === null) imageDomain = currDomain;
    else if (rounded && !equalRoundedDomains(imageDomain!, currDomain)) return null;
    if (curr === commonAncestor) {
      reachedCommon = true;
      break;
    }
  }
  if (!reachedCommon || imageDomain === null) return null;

  let targetAncestorDomain: RoundedRectDomain | null = null;
  reachedCommon = false;
  for (let curr: Element | null = targetElement.parentElement; curr; curr = curr.parentElement) {
    if (curr.namespaceURI !== XHTML_NAMESPACE || curr.getClientRects().length !== 1) return null;
    if (effectiveOpacity.get(curr) !== 1) return null;
    if (isTopLayer(curr) !== false) return null;
    const currStyle = styleByElement.get(curr) ?? window.getComputedStyle(curr);
    if (!hasZeroEdges(currStyle) || !hasNoEscapeEffects(curr, window)) return null;
    const currScale = cumulativeScaleOf(curr, window);
    if (!currScale || currScale.x <= 0 || currScale.y <= 0) return null;

    const unclipped = currStyle.overflowX === "visible" && currStyle.overflowY === "visible";
    if (unclipped) {
      if (curr === commonAncestor) {
        reachedCommon = true;
        break;
      }
      continue;
    }
    const currDomain = extractRoundedClipDomain(curr.getBoundingClientRect(), currStyle, currScale, "hidden_or_clip");
    if (!currDomain) return null;
    const rounded = currDomain.radii.some(radius => radius.x > 0 || radius.y > 0);
    if (rounded && sameRect(currDomain.bounds, targetNode.rect)) targetAncestorDomain = currDomain;
    if (curr === commonAncestor) {
      reachedCommon = true;
      break;
    }
  }
  if (!reachedCommon) return null;

  let targetPaintDomain: RoundedRectDomain;
  if (targetTag === "video") {
    if (!hasZeroEdges(targetStyle)) return null;
    const ownDomain = extractRoundedClipDomain(targetNode.rect, targetStyle, targetScale, "clip");
    if (!ownDomain || !ownDomain.radii.some(radius => radius.x > 0 || radius.y > 0)) return null;
    targetPaintDomain = targetAncestorDomain && equalRoundedDomains(targetAncestorDomain, ownDomain)
      ? targetAncestorDomain
      : ownDomain;
  } else {
    targetPaintDomain = targetAncestorDomain ?? rectangleDomain(targetVisibleRect);
  }

  const targetContained = equalRoundedDomains(targetPaintDomain, imageDomain)
    || roundedDomainContainsRect(imageDomain, targetPaintDomain.bounds);
  if (!targetContained) return null;

  return { targetPaintDomain, commonAncestor };
}

export function observeLiveDom(input: {
  document: Document; window: Window; registry: StableNodeRefRegistry; excludeRoot: Element | null;
  excludeRoots?: readonly (Element | null)[]; excludeRootIds?: readonly string[];
  snapshotRef: string; documentRef: string;
  maxRelationHops?: number;
  diagnostic?: {
    selectedRefs: ReadonlySet<string>;
    callback?: (event: ForegroundDiagnosticEvent) => void;
  };
  imageResourceFor?: (element: Element) => JpegImageResourceObservation | undefined;
}): LiveDomSnapshot {
  const { document, window, registry } = input;
  const nodes: ObservationNode[] = [], itemObservations: ({ nodeRef: string } & BasicKindMeasurements)[] = [];
  const properties = new Map<string, BasicKindProperties>(), evidence = new Map<string, LiveDomEvidence>();
  const elementByRef = new Map<string, Element>(), participating = new Map<Element, PaintParticipation>();
  const styleByElement = new Map<Element, CSSStyleDeclaration>();
  const ancestryByElement = new Map<Element, Element | null>();
  const effectiveOpacity = new Map<Element, number>();
  const opacityPathCache = new Map<Element, boolean | null>();
  const svgOpacityPathCache = new Map<Element, boolean | null>();
  const hiddenByElement = new Map<Element, boolean>();
  const clippedBoxCss = new Map<Element, Map<ClipCssKey, string | null | undefined>>();
  const readClippedBoxCss: ClipCssReader = (element, style, key) => {
    let byKey = clippedBoxCss.get(element);
    if (byKey !== undefined && byKey.has(key)) return byKey.get(key)!;
    const value = (style as CSSStyleDeclaration & Record<ClipCssKey, string | null | undefined>)[key];
    if (byKey === undefined) {
      byKey = new Map();
      clippedBoxCss.set(element, byKey);
    }
    byKey.set(key, value);
    return value;
  };
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
  let excluded = 0, frames = 0, objects = 0, shadows = 0;
  let domOrder = 0;
  while (stack.length) {
    const element = stack.pop()!;
    if (isExcluded(element)) { excluded += 1 + element.querySelectorAll("*").length; continue; }
    ancestryByElement.set(element, element.parentElement);
    const allChildren = Array.from(element.children), children = allChildren.filter(child => !isExcluded(child));
    for (let index = allChildren.length - 1; index >= 0; index--) stack.push(allChildren[index]!);
    const nodeRef = stableNodeRefFor(registry, element), tag = element.tagName.toLowerCase();
    const style = window.getComputedStyle(element), rect = rectOf(element.getBoundingClientRect());
    const directListChildPresent = children.some(child => directListChildTags.has(child.tagName.toLowerCase())
      || roleTokens(child).some(role => directListChildRoles.has(role)));
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
    const clippedRect = clippedBox(element, window, rect, fragments, document, ancestryByElement, readClippedBoxCss);
    const attributes: Record<string, string | boolean> = {};
    for (const key of ["aria-disabled", "aria-expanded", "aria-hidden", "aria-selected", "aria-checked", "aria-readonly", "contenteditable", "disabled", "hidden", "readonly", "open", "selected", "tabindex"]) {
      const value = element.getAttribute(key);
      if (value !== null && isSafeRuleAttribute(key)) attributes[key] = value;
    }
    // Complete live DOM observation makes absent HTML boolean attributes known false.
    attributes.disabled = element.hasAttribute("disabled");
    attributes.hidden = element.hasAttribute("hidden");
    // readOnly applies to editable host elements only; other tags stay unobserved.
    if (tag === "input" || tag === "textarea") attributes.readonly = element.hasAttribute("readonly") || element.getAttribute("aria-readonly") === "true";
    // Checked is a live choice state, not an attribute; only choice inputs carry it.
    if (tag === "input" && ["checkbox", "radio"].includes((element as HTMLInputElement).type)) attributes.checked = (element as HTMLInputElement).checked;
    // Expanded declared state: details open attribute is the native declaration.
    if (tag === "details") attributes.open = element.hasAttribute("open");
    // Selected native state on option elements; aria-selected stays the raw attribute.
    if (tag === "option") attributes.selected = element.hasAttribute("selected");
    const role = element.getAttribute("role");
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
    const ancestorControl = (() => {
      for (let cursor = element.parentElement; cursor; cursor = cursor.parentElement) {
        const ancestorTag = cursor.tagName.toLowerCase();
        if (nativeControlTags.has(ancestorTag) || roleTokens(cursor).some(role => controlRoles.has(role))) return true;
      }
      return false;
    })();
    const ancestorSvg = (() => {
      for (let cursor = element.parentElement; cursor; cursor = cursor.parentElement) {
        if (cursor.tagName.toLowerCase() === "svg") return true;
      }
      return false;
    })();
    const tabIndex = element.getAttribute("tabindex");
    const tabIndexNumber = tabIndex === null || !/^[+-]?\d+$/.test(tabIndex.trim()) ? null : Number(tabIndex);
    const tabIndexFocus = tabIndex === null ? false : tabIndexNumber === null || !Number.isFinite(tabIndexNumber) ? null : tabIndexNumber >= 0;
    const exactOneChild = allChildren.length === 1;
    const soleChild = exactOneChild ? allChildren[0]! : null;
    const soleChildRect = soleChild?.getBoundingClientRect();
    const singleChildSameRect = soleChild === null ? false
      : ![rect.x, rect.y, rect.width, rect.height, soleChildRect!.x, soleChildRect!.y, soleChildRect!.width, soleChildRect!.height].every(Number.isFinite) ? null
      : Math.abs(rect.x - soleChildRect!.x) <= 2
        && Math.abs(rect.y - soleChildRect!.y) <= 2
        && Math.abs(rect.width - soleChildRect!.width) <= 2
        && Math.abs(rect.height - soleChildRect!.height) <= 2;
    const parentCursor = element.parentElement ? window.getComputedStyle(element.parentElement).cursor : "";
    const area = rect.width * rect.height;
    const svgTarget = supportedSvgTarget(element, tag);
    const ownLabelPresent = svgTarget
      ? svgOwnLabelPresent(element)
      : [element.getAttribute("title"), element.getAttribute("aria-label")]
        .some(value => hasNonFormatDirectText(value) === true);
    const contentEditable = svgTarget ? null : measureContentEditable(element, document);
    const currentView = currentViewRecordFor(
      element,
      tag,
      style,
      styleByElement,
      opacityPathCache,
      svgOpacityPathCache,
      document,
      appearance.directTextPresent,
      ownLabelPresent,
      contentEditable,
    );
    const local: BasicKindMeasurements = {
      inputType: tag === "input" ? element.getAttribute("type") || "text" : null,
      hrefPresent: element.hasAttribute("href"),
      contentEditable,
      ...appearance,
      childElementCount: children.length,
      positiveAreaChildCount: positiveAreaChildren.length,
      repeatedChildGeometry: repeatedChildGeometry(children),
      inVerifiedListParent: listParentMeasured(element),
      svgGraphicChildren: svgGraphicChildren(element, tag),
      pointerCursor: style.cursor ? style.cursor === "pointer" : null,
      parentPointerCursor: element.parentElement ? (parentCursor ? parentCursor === "pointer" : null) : false,
      tabIndexFocus,
      borderPresent: visibleBorder(style),
      aspectRatio: area > 0 && rect.width > 0 && rect.height > 0 ? Math.min(rect.width, rect.height) / Math.max(rect.width, rect.height) : null,
      descendantTextPresent: descendantTextPresent(element, excludedRoots, excludedIds),
      directListChildPresent,
      singleChildTag: soleChild?.tagName.toLowerCase() ?? null,
      singleChildSameRect,
      withinControlAncestor: ancestorControl,
      inSvgAncestor: ancestorSvg,
      ownLabelPresent,
    };
    itemObservations.push({ nodeRef, ...local });
    properties.set(nodeRef, { ...local, tag, role, disabled: element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true", hidden: element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true" });
    nodes.push({ nodeRef, parentRef: element.parentElement ? stableNodeRefFor(registry, element.parentElement) : null, tag, role, rect, fragments, clippedRect, ...(currentView === undefined ? {} : { currentView }), attributes });
    const parents: string[] = [];
    for (let p = element.parentElement; p && parents.length < 3; p = p.parentElement) parents.push(p.tagName.toLowerCase());
    let linkPathname: string | null = null;
    const href = element.getAttribute("href");
    if (href && !href.startsWith("javascript:")) { try { linkPathname = new URL(href, document.baseURI).pathname; } catch { /* Invalid link is evidence, not a navigation request. */ } }
    const unassessedChildContent: string[] = [];
    if (tag === "iframe") { frames++; unassessedChildContent.push("iframe"); }
    if (tag === "object") { objects++; unassessedChildContent.push("object_content"); }
    if (element.shadowRoot) { shadows++; unassessedChildContent.push("shadow_root"); }
    const inputElement = element as HTMLInputElement;
    const isInputHost = tag === "input" || tag === "textarea" || tag === "select";
    const inputValue = isInputHost ? (inputElement.value !== undefined ? inputElement.value : null) : null;
    const placeholder = tag === "input" || tag === "textarea" ? (element.getAttribute("placeholder") ?? null) : null;
    const mediaElement = element as HTMLMediaElement;
    const mediaSrc = tag === "video" || tag === "audio" ? (mediaElement.currentSrc !== undefined && mediaElement.currentSrc !== "" ? mediaElement.currentSrc : (element.getAttribute("src") ?? null)) : null;
    const mediaType = tag === "video" ? "video" : tag === "audio" ? "audio" : null;
    evidence.set(nodeRef, { nodeRef, tag, id: element.id || null, classList: Array.from(element.classList), textSummary: safeText(element), linkPathname, inputValue, placeholder, mediaSrc, mediaType, rect, clippedRect, parentTags: parents, unassessedChildContent });
  }
  // Focus is a single-document fact. A readable observed active element gives
  // true for its node and false for every other observed node; a missing or
  // unmappable value stays unknown.
  const activeElement = readableActiveElement(document);
  const activeElementInDocument = activeElement !== null && elementInDocument(activeElement, document);
  const candidateFocusRef = activeElementInDocument ? registry.refByElement.get(activeElement) ?? null : null;
  const activeElementRef = candidateFocusRef !== null && elementByRef.has(candidateFocusRef) ? candidateFocusRef : null;
  const activeFocus = (ref: string): boolean | null =>
    activeElementInDocument ? ref === activeElementRef : null;
  for (let index = 0; index < itemObservations.length; index++) {
    const item = itemObservations[index]!;
    itemObservations[index] = { ...item, activeElementFocus: activeFocus(item.nodeRef) };
  }
  for (const [ref, value] of [...properties]) {
    properties.set(ref, { ...value, activeElementFocus: activeFocus(ref) });
  }
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    if (node.currentView !== undefined) {
      nodes[index] = { ...node, currentView: { ...node.currentView, activeElementFocus: activeFocus(node.nodeRef) } };
    }
  }
  const foregroundByRef = new Map<string, { readonly foreground: ForegroundState; readonly exposedRects: readonly Rect[] | null }>();
  const viewport = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
  const witnessViewport = nativeWitnessViewport(window);
  const refByElement = new Map([...elementByRef].map(([ref, element]) => [element, ref] as const));
  const nodeByRef = new Map(nodes.map(node => [node.nodeRef, node] as const));
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
    const surface = surfaceFor(
      node,
      element,
      style,
      window,
      element.parentElement ? effectiveOpacity.get(element.parentElement) ?? 1 : 1,
      hiddenByElement.get(element) ?? false,
      ancestryByElement,
    );
    const corners = surface.relevant && surface.kind !== "transparent" && node.clippedRect !== null
      && node.fragments?.length === 1
      ? ancestorRoundedClearCorners(element, node.clippedRect, window, styleByElement, ancestryByElement)
      : [];
    surfaces.set(node.nodeRef, corners.length === 0 ? surface : {
      ...surface, clearCornerRects: [...(surface.clearCornerRects ?? []), ...corners],
    });
  }
  const nativeMeasurement = hitAt(document, 0, 0) !== null;
  const foregroundContexts: ForegroundContext[] = nativeMeasurement ? nodes.flatMap(node => {
    const element = elementByRef.get(node.nodeRef), surface = surfaces.get(node.nodeRef);
    const visibleRect = visibleByRef.get(node.nodeRef)?.find(positive) ?? null;
    return element && surface && visibleRect ? [{ node, element, rect: node.rect, visibleRect, surface }] : [];
  }) : [];
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
    const node = nodes[nodeIndex]!;
    const targetRef = node.nodeRef;
    const visibleRects = visibleByRef.get(targetRef) ?? [];
    const report = input.diagnostic?.selectedRefs.has(targetRef) ? input.diagnostic.callback : undefined;
    const reportFinal = (
      foreground: ForegroundState | null,
      exposedRects: readonly Rect[] | null,
      reason?: string,
    ): void => {
      if (!report) return;
      report(reason === undefined
        ? { phase: "final", targetRef, foreground, exposedRects }
        : { phase: "final", targetRef, foreground, exposedRects, reason });
    };
    if (report) {
      report({
        phase: "initial",
        targetRef,
        node,
        clippedRect: node.clippedRect,
        visibleRects,
        surface: diagnosticSurface(surfaces.get(targetRef)),
      });
    }
    if (!nativeMeasurement) {
      reportFinal(null, null, "native_measurement_unavailable");
      continue;
    }
    const element = elementByRef.get(node.nodeRef);
    if (!element) {
      reportFinal(null, null, "element_unavailable");
      continue;
    }
    if (node.rect === null || node.clippedRect === null) {
      nodes[nodeIndex] = { ...node, foreground: "unassessed", exposedRects: null };
      reportFinal("unassessed", null, "geometry_unavailable");
      continue;
    }
    const rects = visibleRects;
    const atomicSvg = certifySvgAtomicViewport(element, window);
    if (rects.length === 0) {
      const result = { foreground: "visible", exposedRects: [] } as const;
      foregroundByRef.set(node.nodeRef, result);
      nodes[nodeIndex] = { ...node, ...result };
      reportFinal(result.foreground, result.exposedRects);
      continue;
    }
    let remaining: Rect[] | null = [...rects];
    const allowClearCorners = !roundedClippingAncestor(element, window, ancestryByElement, true);
    let provenRemaining: Rect[] | null = [...rects];
    const unresolvedWitnessBlockers: Rect[] = [];
    const targetRect = node.clippedRect;
    if (targetRect === null) {
      reportFinal(null, null, "clipped_rect_unavailable");
      continue;
    }
    const boundDomain = atomicSvg?.paintDomain ?? null;
    const relevantBound = boundDomain === null ? null : intersection(boundDomain, viewport);
    // Only the certified domain inside this observation viewport is auditable.
    // An empty intersection stays unknown and cannot authorize a BCR-only proof.
    const boundedPaintDomain = relevantBound !== null && positive(relevantBound) ? relevantBound : null;
    const paintDomain = boundedPaintDomain ?? targetRect;
    let boundRemaining: Rect[] | null = boundedPaintDomain === null ? null : [boundedPaintDomain];
    const blockers = foregroundContexts.filter(blocker => blocker.node.nodeRef !== node.nodeRef
      && blocker.surface.relevant && blocker.surface.kind !== "transparent"
      && blocker.visibleRect !== null && positive(intersection(paintDomain, blocker.visibleRect))
      && !isWithin(blocker.element, element) && !isWithin(element, blocker.element));
    for (const blocker of blockers) {
      let overlap: Rect | null = null;
      let hitRefs: readonly (string | null)[] | null = null;
      let nativeBefore = false;
      let nativeOrderWitnessRef: string | null = null;
      let nativeWitnessPoint: { readonly x: number; readonly y: number } | null = null;
      let paintOrderBefore: boolean | "uncertain" | "not_queried" = "not_queried";
      let pointerBefore = false;
      const remainingBefore = remainingCount(remaining);
      const provenRemainingBefore = remainingCount(provenRemaining);
      const reportBlocker = (outcome: ForegroundDiagnosticBlockerOutcome): void => {
        if (!report) return;
        report({
          phase: "blocker",
          targetRef,
          blockerRef: blocker.node.nodeRef,
          kind: blocker.surface.kind,
          proven: blocker.surface.proven,
          clearInterior: blocker.surface.clearInterior,
          overlap,
          hitRefs,
          nativeBefore,
          ...(nativeOrderWitnessRef === null ? {} : { nativeOrderWitnessRef }),
          ...(nativeWitnessPoint === null ? {} : { nativeWitnessPoint }),
          paintOrderBefore,
          pointerBefore,
          remainingBefore,
          remainingAfter: remainingCount(remaining),
          provenRemainingBefore,
          provenRemainingAfter: remainingCount(provenRemaining),
          outcome,
        });
      };
      if (!remaining) {
        reportBlocker("remaining_unavailable_break");
        break;
      }
      const blockerRect = blocker.visibleRect;
      if (!blockerRect) {
        reportBlocker("blocker_rect_unavailable");
        continue;
      }
      overlap = intersection(blockerRect, paintDomain);
      if (!positive(overlap)) {
        reportBlocker("overlap_unavailable");
        continue;
      }
      const subtractBound = (): void => {
        if (boundRemaining !== null) {
          boundRemaining = subtractSurface(boundRemaining, blocker.surface, blockerRect, allowClearCorners);
        }
      };
      const point = { x: overlap.x + overlap.width / 2, y: overlap.y + overlap.height / 2 };
      const rawHits = queryNativeHitPoint(document, point, overlap, witnessViewport).hits;
      if (rawHits === null) {
        remaining = null;
        reportBlocker("hit_unavailable_break");
        break;
      }
      const hits = rawHits.filter(candidate => !isExcluded(candidate));
      hitRefs = hits.map(candidate => refByElement.get(candidate) ?? null);
      const blockerIndex = hits.indexOf(blocker.element);
      const targetIndex = hits.indexOf(element);
      nativeBefore = blockerIndex >= 0 && targetIndex >= 0 && targetIndex > blockerIndex;
      const centerBefore = nativeBefore;
      // Geometry and paint order qualify first. The resource callback runs only
      // after this pair is a candidate for proven coverage.
      const coverageGeometry = (["video", "div"].includes(element.tagName.toLowerCase())
        && blocker.element.tagName.toLowerCase() === "img")
        ? certifyImageCoverage(
          element,
          node,
          blocker.element,
          blocker.node,
          rects[0]!,
          window,
          styleByElement,
          effectiveOpacity,
        )
        : null;
      // A bounded finite seed can recover the missing initial target order
      // witness for the two narrow subsets. The center result and its
      // diagnostic stay intact; centerBefore is never promoted by this seed.
      if (!nativeBefore && blockerIndex >= 0 && targetIndex < 0
        && blocker.surface.proven && !blocker.surface.passThrough
        && styleByElement.get(element)?.pointerEvents !== "none"
        && coversAllRects(blockerRect, rects)) {
        const elementStyle = styleByElement.get(element);
        const before = simplePaintBefore(blocker.element, element, participating);
        // The overlap center already missed the target, so the explicit
        // paint-order rule must explain every target-absent sample.
        if (elementStyle !== undefined && before === true) {
          const witnessPoints = negativeOrderWitnessPoints(
            element, node, elementStyle, rects, overlap, allowClearCorners, window, styleByElement,
          );
          let witnessed: { readonly x: number; readonly y: number } | null = null;
          let contradicted = false;
          for (const witnessPoint of witnessPoints ?? []) {
            if (witnessPoint.x === point.x && witnessPoint.y === point.y) continue;
            const stack = queryNativeHitPoint(document, witnessPoint, overlap, witnessViewport)
              .hits?.filter(candidate => !isExcluded(candidate));
            if (stack === undefined || stack === null) continue;
            const blockerAt = stack.indexOf(blocker.element);
            const targetAt = stack.indexOf(element);
            if (targetAt >= 0) {
              if (blockerAt >= 0 && targetAt > blockerAt) {
                if (witnessed === null) witnessed = witnessPoint;
                continue;
              }
              contradicted = true;
              break;
            }
          }
          if (witnessed !== null && !contradicted) {
            nativeBefore = true;
            nativeWitnessPoint = witnessed;
          }
        }
      }
      if (nativeBefore) {
        const dx = Math.min(1, overlap.width / 4), dy = Math.min(1, overlap.height / 4);
        const probePoints: [number, number][] = [
          [overlap.x + dx, overlap.y + dy], [overlap.x + overlap.width - dx, overlap.y + dy],
          [overlap.x + dx, overlap.y + overlap.height - dy], [overlap.x + overlap.width - dx, overlap.y + overlap.height - dy],
        ];
        if (coverageGeometry !== null) {
          const paintBefore = simplePaintBefore(blocker.element, element, participating);
          if (paintBefore !== true) {
            nativeBefore = false;
          } else {
            nativeBefore = probePoints.every(([x, y]) => {
              const stack = queryNativeHitPoint(document, { x: x!, y: y! }, overlap!, witnessViewport)
                .hits?.filter(candidate => !isExcluded(candidate));
              if (!stack) return false;
              const front = stack.indexOf(blocker.element), back = stack.indexOf(element);
              if (back >= 0 && (front < 0 || back < front)) return false;
              if (pointInRoundedDomain(coverageGeometry.targetPaintDomain, x!, y!)) {
                return front >= 0 && (back > front
                  || (back < 0 && paintBefore === true));
              }
              return true;
            });
          }
        } else {
          nativeBefore = probePoints.every(([x, y]) => {
            const stack = queryNativeHitPoint(document, { x: x!, y: y! }, overlap!, witnessViewport)
              .hits?.filter(candidate => !isExcluded(candidate));
            if (!stack) return false;
            const front = stack.indexOf(blocker.element), back = stack.indexOf(element);
            return front >= 0 && (back > front
              || (back < 0 && simplePaintBefore(blocker.element, element, participating) === true));
          });
        }
      }
      if (!nativeBefore && targetIndex < 0 && blocker.surface.proven && !blocker.surface.passThrough
        && atomicSvg !== null && !isWithin(blocker.element, atomicSvg.rootElement)) {
        const witness = atomicSvg.rootElement;
        const beforeWitness = (stack: readonly Element[]): boolean => {
          const front = stack.indexOf(blocker.element), boundary = stack.indexOf(witness), target = stack.indexOf(element);
          return front >= 0 && boundary > front && (target < 0 || target > front);
        };
        const dx = Math.min(1, overlap.width / 4), dy = Math.min(1, overlap.height / 4);
        nativeBefore = beforeWitness(hits) && [
          [overlap.x + dx, overlap.y + dy], [overlap.x + overlap.width - dx, overlap.y + dy],
          [overlap.x + dx, overlap.y + overlap.height - dy], [overlap.x + overlap.width - dx, overlap.y + overlap.height - dy],
        ].every(([x, y]) => {
          const stack = queryNativeHitPoint(document, { x: x!, y: y! }, overlap!, witnessViewport)
            .hits?.filter(candidate => !isExcluded(candidate));
          return stack !== undefined && stack !== null && beforeWitness(stack);
        });
        if (nativeBefore) nativeOrderWitnessRef = refByElement.get(witness) ?? null;
      }
      if (!nativeBefore && targetIndex < 0 && coverageGeometry !== null
        && styleByElement.get(element)?.pointerEvents === "none") {
        const before = simplePaintBefore(blocker.element, element, participating);
        const witnessIndex = hits.indexOf(coverageGeometry.commonAncestor);
        nativeBefore = before === true && blockerIndex >= 0 && witnessIndex > blockerIndex;
        if (nativeBefore) nativeOrderWitnessRef = refByElement.get(coverageGeometry.commonAncestor) ?? null;
      }
      pointerBefore = nativeBefore;
      if (blocker.surface.passThrough || styleByElement.get(element)?.pointerEvents === "none") {
        const before = simplePaintBefore(blocker.element, element, participating);
        paintOrderBefore = before;
        pointerBefore = before === true;
        if (before === "uncertain") {
          remaining = subtractSurface(remaining, blocker.surface, blockerRect, allowClearCorners);
          reportBlocker("paint_order_uncertain_subtracted");
          continue;
        }
      }
      if (!pointerBefore) {
        if (targetIndex < 0 && blockerIndex >= 0 && blocker.surface.proven && !blocker.surface.passThrough
          && proveOwnPaintBehindLaterPositiveBranch(document, window, blocker.element, element, styleByElement) === true) {
          const next = subtractSurface(remaining, blocker.surface, blockerRect, allowClearCorners);
          provenRemaining = provenRemaining === null ? null : subtractSurface(provenRemaining, blocker.surface, blockerRect, allowClearCorners);
          if (next === null) {
            remaining = null;
            reportBlocker("fragment_cap_break");
            break;
          }
          remaining = next;
          subtractBound();
          reportBlocker("ordinary_order_proven_subtracted");
          continue;
        }
        if (centerBefore && !blocker.surface.passThrough
          && !blocker.surface.proven && boundedImagePaint(blocker.element, window)) {
          // Conservative possible-paint subtraction only. The pointer-none
          // order decision above is unchanged; this can hide area, never
          // invent exposure, and centerBefore already requires the target to
          // be present in the native stack.
          remaining = subtractSurface(remaining, blocker.surface, blockerRect, allowClearCorners);
          reportBlocker("bounded_image_order_uncertain_subtracted");
          continue;
        }
        unresolvedWitnessBlockers.push(blockerRect);
        reportBlocker("pointer_not_before");
        continue;
      }
      if (coverageGeometry !== null && verifyImageResourceProof(
        blocker.element,
        input.documentRef,
        registry,
        input.imageResourceFor,
      )) {
        remaining = [];
        provenRemaining = [];
        reportBlocker("proven_surface_subtracted");
        break;
      }
      if (!blocker.surface.proven) {
        remaining = subtractSurface(remaining, blocker.surface, blockerRect, allowClearCorners);
        reportBlocker("uncertain_surface_subtracted");
        continue;
      }
      const next = subtractSurface(remaining, blocker.surface, blockerRect, allowClearCorners);
      provenRemaining = provenRemaining === null ? null : subtractSurface(provenRemaining, blocker.surface, blockerRect, allowClearCorners);
      subtractBound();
      if (next === null) {
        remaining = null;
        reportBlocker("fragment_cap_break");
        break;
      }
      remaining = next;
      reportBlocker("proven_surface_subtracted");
    }
    const boundCovered = boundedPaintDomain !== null && boundRemaining !== null && boundRemaining.length === 0;
    // A USE can paint beyond its target BCR. Without a complete paint-domain
    // certificate, the target-rect fallback cannot prove full occlusion.
    const unboundedSvgUse = boundDomain === null
      && element.tagName.toLowerCase() === "use"
      && element.namespaceURI === "http://www.w3.org/2000/svg";
    // A local USE certificate widens the occlusion domain to the complete
    // conservative bound inside this viewport. If bound tracking is unavailable
    // (fragment cap), the smaller target-rect result cannot prove occlusion.
    if (boundCovered || (boundDomain === null && remaining !== null && remaining.length === 0)) {
      const result = boundCovered || (boundDomain === null && !unboundedSvgUse && provenRemaining?.length === 0)
        ? { foreground: "occluded", exposedRects: [] } as const
        : { foreground: "unassessed", exposedRects: null } as const;
      foregroundByRef.set(node.nodeRef, result);
      nodes[nodeIndex] = { ...node, ...result };
      reportFinal(result.foreground, result.exposedRects);
      continue;
    }
    const exposed: Rect[] = [];
    const crossPoints = boundDomain === null || node.rect === null ? [] : [
      { x: node.rect.x + node.rect.width * 0.5, y: node.rect.y + node.rect.height * 0.1 },
      { x: node.rect.x + node.rect.width * 0.9, y: node.rect.y + node.rect.height * 0.5 },
      { x: node.rect.x + node.rect.width * 0.5, y: node.rect.y + node.rect.height * 0.9 },
      { x: node.rect.x + node.rect.width * 0.1, y: node.rect.y + node.rect.height * 0.5 },
    ];
    const queriedPoints: { readonly x: number; readonly y: number }[] = [];
    const legacyUnavailableRects = new Set<Rect>();
    const evaluatePoint = (
      rect: Rect,
      point: { readonly x: number; readonly y: number },
      strictSvgUseWitness = false,
    ): boolean | null => {
      const nativeQuery = queryNativeHitPoint(
        document,
        point,
        rect,
        witnessViewport,
      );
      const rawHits = nativeQuery.hits;
      const nativePointDiagnostic = nativeQuery.supplemented ? { nativePoint: nativeQuery.nativePoint } : {};
      if (rawHits === null) {
        report?.({
          phase: "point_probe",
          targetRef,
          remainingRect: rect,
          point,
          ...nativePointDiagnostic,
          hitRefs: null,
          firstOpaqueRef: null,
          chosenOwnerRef: null,
          targetBeforeOpaque: false,
          exposed: false,
        });
        return null;
      }
      const hits = rawHits.filter(candidate => !isExcluded(candidate));
      let knownBoundaryWitness: Element | null = null;
      if (nativeQuery.supplemented && !unresolvedWitnessBlockers.some(blockerRect => positive(intersection(blockerRect, rect)))) {
        const candidate = hits.find(hit => {
          const ref = refByElement.get(hit);
          if (ref === undefined) return false;
          const witnessNode = hit === element ? node : nodeByRef.get(ref);
          const witnessStyle = styleByElement.get(hit);
          const witnessRects = visibleByRef.get(ref);
          const witnessSurface = surfaces.get(ref);
          if (!witnessNode || !witnessStyle || !witnessRects || !witnessSurface) return false;
          if (hit !== element && !isWithin(hit, element)) return false;
          if (!knownSingleFragmentDomain(
            hit,
            witnessNode,
            witnessStyle,
            point,
            witnessRects,
            allowClearCorners,
            window,
            styleByElement,
          )) return false;
          return surfacePaintsAt(witnessSurface, point.x, point.y, allowClearCorners);
        });
        if (candidate !== undefined) {
          const candidateIndex = hits.indexOf(candidate);
          if (hits.slice(0, candidateIndex).every(hit => isWithin(hit, element))) knownBoundaryWitness = candidate;
        }
      }
      const first = hits[0];
      const firstOpaque = hits.find(candidate => {
        const ref = refByElement.get(candidate);
        if (ref === undefined) return false;
        const surface = surfaces.get(ref);
        return surface !== undefined && surface.kind !== "transparent" && surfacePaintsAt(surface, point.x, point.y, allowClearCorners);
      });
      const owner = firstOpaque ?? first;
      const opaqueIndex = firstOpaque === undefined ? -1 : hits.indexOf(firstOpaque);
      const target = element;
      const targetBeforeOpaque = opaqueIndex > 0 && hits.slice(0, opaqueIndex)
        .some(hit => hit === target || isWithin(hit, target));
      const ownerSurface = owner ? surfaces.get(refByElement.get(owner) ?? "") : undefined;
      const ownerPaintsHere = ownerSurface !== undefined
        && surfacePaintsAt(ownerSurface, point.x, point.y, allowClearCorners);
      const clearRoundedImageCorner = owner !== undefined
        && styleByElement.get(element)?.pointerEvents === "none"
        && boundedImagePaint(owner, window)
        && (ownerSurface?.clearCornerRects?.length ?? 0) > 0
        && !ownerPaintsHere
        && simplePaintBefore(owner, element, participating) === true;
      // A complete SVG paint domain only bounds and orders paint; an ancestor
      // owner proves containment, not that the target paints here.
      const hasCompleteSvgPaintDomain = boundDomain !== null;
      const hasStrictSvgPaintDomain = strictSvgUseWitness || hasCompleteSvgPaintDomain;
      const exposedHere = nativeQuery.supplemented
        ? knownBoundaryWitness !== null
        : hasStrictSvgPaintDomain
          ? targetBeforeOpaque || Boolean(owner && (owner === element || isWithin(owner, element)))
          : targetBeforeOpaque || clearRoundedImageCorner
            || Boolean(owner && (owner === element || isWithin(owner, element) || isWithin(element, owner)
              || (styleByElement.get(element)?.pointerEvents === "none" && simplePaintBefore(owner, element, participating) === false)));
      report?.({
        phase: "point_probe",
        targetRef,
        remainingRect: rect,
        point,
        ...nativePointDiagnostic,
        hitRefs: hits.map(candidate => refByElement.get(candidate) ?? null),
        firstOpaqueRef: firstOpaque === undefined ? null : refByElement.get(firstOpaque) ?? null,
        chosenOwnerRef: owner === undefined ? null : refByElement.get(owner) ?? null,
        targetBeforeOpaque,
        exposed: exposedHere,
      });
      return exposedHere;
    };
    const svgUsePerimeter = element.tagName.toLowerCase() === "use"
      && element.namespaceURI === "http://www.w3.org/2000/svg"
      && node.fragments?.length === 1
      && finitePositive(node.rect)
      && finitePositive(node.clippedRect)
      && remaining !== null && remaining.length > 0
      && styleByElement.get(element)?.pointerEvents !== undefined
      && styleByElement.get(element)?.pointerEvents !== "none"
      ? (() => {
        const points: { readonly x: number; readonly y: number }[] = [];
        for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) {
          const fys = fx === 0.1 || fx === 0.9 ? [0.1, 0.3, 0.5, 0.7, 0.9] : [0.1, 0.9];
          for (const fy of fys) {
            points.push({
              x: node.rect.x + node.rect.width * fx,
              y: node.rect.y + node.rect.height * fy,
            });
          }
        }
        return points;
      })()
      : [];
    for (const rect of remaining ?? []) {
      const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      queriedPoints.push(center);
      const centerResult = evaluatePoint(rect, center);
      if (centerResult === true) {
        exposed.push(rect);
        continue;
      }
      if (centerResult === null) {
        legacyUnavailableRects.add(rect);
        continue;
      }
      for (const point of crossPoints) {
        if (queriedPoints.some(previous => previous.x === point.x && previous.y === point.y)) continue;
        if (!(point.x >= rect.x && point.x < rect.x + rect.width
          && point.y >= rect.y && point.y < rect.y + rect.height)) continue;
        queriedPoints.push(point);
        const result = evaluatePoint(rect, point);
        if (result === true) {
          exposed.push(rect);
          break;
        }
        if (result === null) {
          legacyUnavailableRects.add(rect);
          break;
        }
      }
    }
    if (svgUsePerimeter.length > 0 && remaining !== null) {
      let perimeterUnavailable = false;
      for (const point of svgUsePerimeter) {
        if (perimeterUnavailable) break;
        if (queriedPoints.some(previous => previous.x === point.x && previous.y === point.y)) continue;
        const rect = remaining.find(candidate => point.x >= candidate.x && point.x < candidate.x + candidate.width
          && point.y >= candidate.y && point.y < candidate.y + candidate.height);
        if (rect === undefined || exposed.includes(rect) || legacyUnavailableRects.has(rect)) continue;
        queriedPoints.push(point);
        const result = evaluatePoint(rect, point, true);
        if (result === true) {
          exposed.push(rect);
        } else if (result === null) {
          perimeterUnavailable = true;
        }
      }
    }
    const result: { readonly foreground: ForegroundState; readonly exposedRects: readonly Rect[] | null } = exposed.length > 0
      ? { foreground: "visible", exposedRects: exposed }
      : { foreground: "unassessed", exposedRects: null };
    foregroundByRef.set(node.nodeRef, result);
    nodes[nodeIndex] = { ...node, ...result };
    reportFinal(result.foreground, result.exposedRects);
  }
  for (const ref of registry.elementByRef.keys()) resolveStableNodeRef(registry, ref);
  const clipping = nodes.every(node => node.clippedRect !== null) ? "assessed" : nodes.some(node => node.clippedRect !== null) ? "mixed" : "unassessed";
  const foregroundNodes = nodes.filter(node => node.foreground !== undefined);
  const foregroundCoverage = foregroundNodes.length === 0 ? undefined
    : foregroundNodes.every(node => node.foreground === "visible" || node.foreground === "occluded") ? "assessed"
      : foregroundNodes.some(node => node.foreground === "visible" || node.foreground === "occluded") ? "mixed" : "unassessed";
  const observation: PageObservation = { viewport, nodes, coverage: { geometry: "assessed", fragments: "assessed", clipping, ...(foregroundCoverage ? { foreground: foregroundCoverage } : {}) } };
  const unassessedInteriors = new Map([...evidence].map(([ref, ev]) => [ref, (ev.unassessedChildContent ?? []) as readonly UnassessedInteriorKind[]]));
  const explorationInputs = new Map(buildExplorationInputs({ observation, itemObservations, maxRelationHops: input.maxRelationHops ?? 4, ...(nodes[0] ? { rootNodeRef: nodes[0].nodeRef } : {}), directChildrenStatus: "complete", unassessedInteriors }));
  const enrichedObservations = itemObservations.map(item => {
    const exploration = explorationInputs.get(item.nodeRef);
    return exploration ? { ...item, ...deriveBasicKindContentRelations(exploration) } : item;
  });
  for (let index = 0; index < itemObservations.length; index++) {
    const enriched = enrichedObservations[index]!;
    itemObservations[index] = enriched;
    const current = properties.get(enriched.nodeRef);
    if (current) properties.set(enriched.nodeRef, {
      ...current,
      shallowStructuralPeerRatio: enriched.shallowStructuralPeerRatio ?? null,
      coincidentChildPairRatio: enriched.coincidentChildPairRatio ?? null,
      graphicDescendantPresent: enriched.graphicDescendantPresent ?? null,
    });
    const exploration = explorationInputs.get(enriched.nodeRef);
    if (exploration) explorationInputs.set(enriched.nodeRef, {
      ...exploration,
      measurementCoverage: {
        ...exploration.measurementCoverage,
        shallowStructuralPeerRatio: enriched.shallowStructuralPeerRatio == null ? "unmeasured" : "measured",
        coincidentChildPairRatio: enriched.coincidentChildPairRatio == null ? "unmeasured" : "measured",
        graphicDescendantPresent: enriched.graphicDescendantPresent == null ? "unmeasured" : "measured",
      },
    });
  }
  return {
    snapshotRef: input.snapshotRef, documentRef: input.documentRef, frameRef: "top", pageRef: input.documentRef,
    observation, explorationInputs,
    itemObservations: enrichedObservations, properties, evidence,
    coverage: { scope: "top_document_only", frameContent: "captured", directChildren: "complete", traversedElementCount: nodes.length, excludedElementCount: excluded, unassessedIframeCount: frames, unassessedObjectCount: objects, unassessedOpenShadowRootCount: shadows, closedShadowRootDetection: "not_available" },
    resolveElement: ref => resolveStableNodeRef(registry, ref),
  };
}
