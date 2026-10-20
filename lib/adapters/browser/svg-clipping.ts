import type { Rect } from "./observation.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

// Axis-aligned user-space -> screen mapping for an SVG viewport. Only positive,
// axis-aligned scales are representable; rotation, skew, and flips stay null.
export interface SvgUserSpaceMapping {
  readonly sx: number;
  readonly sy: number;
  readonly tx: number;
  readonly ty: number;
  readonly viewport: Rect;
  readonly userWidth: number;
  readonly userHeight: number;
}

interface SvgElementLike extends Element {
  readonly x?: { readonly baseVal?: { readonly value?: number } };
  readonly y?: { readonly baseVal?: { readonly value?: number } };
  readonly width?: { readonly baseVal?: { readonly value?: number } };
  readonly height?: { readonly baseVal?: { readonly value?: number } };
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface AxisTransform {
  readonly a: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

interface MatrixTransform {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

function parseCssPx(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)px$/.exec(raw.trim());
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function knownNone(value: string | undefined): boolean {
  return value === "none";
}

function knownNoMask(style: CSSStyleDeclaration): boolean {
  return knownNone(style.maskImage)
    && (style.webkitMaskImage === undefined || style.webkitMaskImage === "" || knownNone(style.webkitMaskImage));
}

function finiteInvertible2dTransform(raw: string | undefined): MatrixTransform | null {
  if (raw === undefined || raw === "") return null;
  if (raw === "none") return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const match = /^matrix\(([^)]+)\)$/.exec(raw.trim());
  if (!match) return null;
  const fields = match[1]!.split(",").map(value => value.trim());
  if (fields.length !== 6 || fields.some(value => value.length === 0)) return null;
  const values = fields.map(Number);
  const [a, b, c, d, e, f] = values;
  if (a === undefined || b === undefined || c === undefined || d === undefined || e === undefined || f === undefined) return null;
  if (!values.every(Number.isFinite)) return null;
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || determinant === 0) return null;
  return { a, b, c, d, e, f };
}

function positiveAxisTransform(transform: string | undefined): AxisTransform | null {
  if (transform === undefined || transform === "") return null;
  if (transform === "none") return { a: 1, d: 1, e: 0, f: 0 };
  const match = /^matrix\(([^)]+)\)$/.exec(transform.trim());
  if (!match) return null;
  const fields = match[1]!.split(",").map(value => value.trim());
  if (fields.length !== 6 || fields.some(value => value.length === 0)) return null;
  const [a, b, c, d, e, f] = fields.map(Number);
  if (a === undefined || b === undefined || c === undefined || d === undefined || e === undefined || f === undefined) return null;
  if (![a, b, c, d, e, f].every(Number.isFinite)) return null;
  if (b !== 0 || c !== 0 || a <= 0 || d <= 0) return null;
  return { a, d, e, f };
}

function numericAttribute(element: Element, name: string): number | null {
  const raw = element.getAttribute(name);
  if (raw === null) return null;
  const value = raw.trim();
  if (value === "" || value.endsWith("%") || /[a-z]/i.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseViewBox(element: Element): Box | null {
  const raw = element.getAttribute("viewBox");
  if (raw === null) return null;
  const parts = raw.trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length !== 4) return null;
  const numbers = parts.map(Number);
  if (!numbers.every(Number.isFinite)) return null;
  const [x, y, width, height] = numbers;
  if (x === undefined || y === undefined || width === undefined || height === undefined) return null;
  if (!(width > 0 && height > 0)) return null;
  return { x, y, width, height };
}

interface Alignment {
  readonly ax: number;
  readonly ay: number;
  readonly uniform: boolean;
}

function parsePreserveAspectRatio(raw: string | null): Alignment | null {
  const value = (raw ?? "xMidYMid meet").trim();
  if (value === "") return { ax: 0.5, ay: 0.5, uniform: true };
  const tokens = value.split(/\s+/);
  const align = tokens[0] ?? "";
  if (align === "none") return { ax: 0, ay: 0, uniform: false };
  const meet = tokens[1] ?? "meet";
  if (meet !== "meet") return null;
  const table: Record<string, readonly [number, number]> = {
    xMinYMin: [0, 0], xMidYMin: [0.5, 0], xMaxYMin: [1, 0],
    xMinYMid: [0, 0.5], xMidYMid: [0.5, 0.5], xMaxYMid: [1, 0.5],
    xMinYMax: [0, 1], xMidYMax: [0.5, 1], xMaxYMax: [1, 1],
  };
  const pair = table[align];
  if (pair === undefined) return null;
  return { ax: pair[0], ay: pair[1], uniform: true };
}

function parseStrictMeetAspectRatio(raw: string | null): Alignment | null {
  const value = (raw ?? "xMidYMid meet").trim();
  if (value === "") return null;
  const tokens = value.split(/\s+/);
  if (tokens.length > 2) return null;
  const align = tokens[0] ?? "";
  const meet = tokens[1] ?? "meet";
  if (meet !== "meet") return null;
  const table: Record<string, readonly [number, number]> = {
    xMinYMin: [0, 0], xMidYMin: [0.5, 0], xMaxYMin: [1, 0],
    xMinYMid: [0, 0.5], xMidYMid: [0.5, 0.5], xMaxYMid: [1, 0.5],
    xMinYMax: [0, 1], xMidYMax: [0.5, 1], xMaxYMax: [1, 1],
  };
  const pair = table[align];
  return pair === undefined ? null : { ax: pair[0], ay: pair[1], uniform: true };
}

function nearestAncestorSvg(element: Element): Element | null {
  for (let current: Element | null = element.parentElement; current; current = current.parentElement) {
    if (current.tagName.toLowerCase() === "svg") return current;
  }
  return null;
}

function nearestSvgIncludingSelf(element: Element): Element | null {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.tagName.toLowerCase() === "svg") return current;
  }
  return null;
}

function knownSvgBaseChainStyle(style: CSSStyleDeclaration): boolean {
  const prefixedBackdrop = (style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter;
  const prefixedMask = (style as CSSStyleDeclaration & { webkitMaskImage?: string }).webkitMaskImage;
  return knownNone(style.filter)
    && knownNone(style.maskImage)
    && (prefixedMask === undefined || prefixedMask === "" || knownNone(prefixedMask))
    && knownNone(style.backdropFilter)
    && (prefixedBackdrop === undefined || prefixedBackdrop === "" || knownNone(prefixedBackdrop))
    && style.mixBlendMode === "normal"
    && style.isolation === "auto"
    && style.contain === "none"
    && (style.willChange === undefined || style.willChange === "auto")
    && (style.contentVisibility === undefined || style.contentVisibility === "visible")
    && (style.transformStyle === undefined || style.transformStyle === "flat")
    && (style.perspective === "none" || style.perspective === undefined || style.perspective === "");
}

function knownSvgChainStyle(style: CSSStyleDeclaration): boolean {
  return knownSvgBaseChainStyle(style)
    && knownNone(style.clipPath)
    && style.opacity === "1";
}

interface AtomicSvgClipFacts {
  readonly rects: readonly Rect[];
  readonly hasComputedClip: boolean;
}

function atomicSvgClipFacts(
  element: Element,
  style: CSSStyleDeclaration,
  window: Window,
): AtomicSvgClipFacts | null {
  const rects: Rect[] = [];
  const attribute = element.getAttribute("clip-path");
  if (attribute !== null && attribute.trim() !== "none") {
    const rect = resolveLocalSvgClipPathRect(element, attribute, window);
    if (rect === null) return null;
    rects.push(rect);
  }
  const computed = style.clipPath;
  if (computed === undefined || computed === "") return null;
  if (computed !== "none") {
    const rect = resolveLocalSvgClipPathRect(element, computed, window);
    if (rect === null) return null;
    rects.push(rect);
  }
  return { rects, hasComputedClip: computed !== "none" };
}

function knownAtomicSvgOpacity(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return false;
  const opacity = Number(value);
  return Number.isFinite(opacity) && opacity > 0 && opacity <= 1;
}

function knownSvgAtomicChainStyle(
  element: Element,
  style: CSSStyleDeclaration,
  window: Window,
): boolean {
  return knownSvgBaseChainStyle(style)
    && knownAtomicSvgOpacity(style.opacity)
    && atomicSvgClipFacts(element, style, window) !== null;
}

function knownSvgRootMappingStyle(style: CSSStyleDeclaration): boolean {
  return knownSvgChainStyle(style)
    && [style.translate, style.rotate, style.scale, style.perspective]
      .every(value => value === "none" || value === undefined || value === "");
}

function passesKnownSvgChain(node: Element): boolean {
  return node.namespaceURI === "http://www.w3.org/2000/svg"
    && node.tagName.toLowerCase() !== "foreignobject"
    && node.getAttribute("clip-path") === null;
}

function passesAtomicSvgChain(node: Element): boolean {
  return node.namespaceURI === "http://www.w3.org/2000/svg"
    && node.tagName.toLowerCase() !== "foreignobject";
}

function svgLength(svg: SvgElementLike, name: "x" | "y" | "width" | "height", fallback: number): number | null {
  const raw = svg.getAttribute(name);
  if (raw === null) {
    const native = svg[name]?.baseVal?.value;
    if (typeof native === "number" && Number.isFinite(native)) return native;
    return name === "x" || name === "y" ? 0 : fallback;
  }
  const value = raw.trim();
  if (value === "") return null;
  if (value.endsWith("%")) {
    return (name === "width" || name === "height") && value === "100%" ? fallback : null;
  }
  if (/[a-z]/i.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function zeroBorderAndPadding(style: CSSStyleDeclaration): boolean {
  const properties = [
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  ] as const;
  for (const property of properties) {
    const raw = String(style[property] ?? "").trim();
    const match = /^(-?(?:\d+|\d*\.\d+))(?:px)?$/.exec(raw);
    if (match?.[1] === undefined) return false;
    if (Number(match[1]) !== 0) return false;
  }
  return true;
}

function resolveSvgViewport(svg: SvgElementLike, window: Window): Rect | null {
  if (!zeroBorderAndPadding(window.getComputedStyle(svg))) return null;
  const parentSvg = nearestAncestorSvg(svg);
  if (parentSvg) {
    const parentMapping = resolveSvgUserSpaceMapping(parentSvg, window);
    if (parentMapping === null) return null;
    const x = svgLength(svg, "x", 0);
    const y = svgLength(svg, "y", 0);
    const width = svgLength(svg, "width", parentMapping.userWidth);
    const height = svgLength(svg, "height", parentMapping.userHeight);
    if (x === null || y === null || width === null || height === null) return null;
    if (!(width > 0 && height > 0)) return null;
    const viewport: Rect = {
      x: parentMapping.tx + parentMapping.sx * x,
      y: parentMapping.ty + parentMapping.sy * y,
      width: parentMapping.sx * width,
      height: parentMapping.sy * height,
    };
    return [viewport.x, viewport.y, viewport.width, viewport.height].every(Number.isFinite) ? viewport : null;
  }
  // Outermost svg: the measured border box already carries any CSS transform.
  const bounds = svg.getBoundingClientRect();
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return null;
  if (!(bounds.width > 0 && bounds.height > 0)) return null;
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

// Exact screen-space viewport proof for an outermost SVG. The measured border
// box is the viewport because the chain only contains positive translations or
// the existing HTML unit-axis reflection certificate. This proof is independent
// of viewBox, path geometry, resource content, and paint.
export function resolveOutermostSvgPhysicalViewport(element: Element, window: Window): Rect | null {
  if (element.tagName.toLowerCase() !== "svg" || element.namespaceURI !== SVG_NAMESPACE) return null;
  if (nearestAncestorSvg(element) !== null) return null;
  const svg = element as SvgElementLike;
  const style = window.getComputedStyle(element);
  if (!zeroBorderAndPadding(style)) return null;
  const width = parseCssPx(style.width);
  const height = parseCssPx(style.height);
  if (width === null || height === null) return null;
  if (positiveAxisTransform(style.transform) === null) return null;
  if ([style.translate, style.rotate, style.scale, style.perspective]
    .some(value => value !== "none")) return null;
  if (typeof element.getClientRects !== "function") return null;
  let fragments: DOMRectList;
  try {
    fragments = element.getClientRects();
  } catch {
    return null;
  }
  if (fragments.length !== 1) return null;
  const viewport = resolveSvgViewport(svg, window);
  if (viewport === null) return null;
  if (![viewport.x, viewport.y, viewport.width, viewport.height].every(Number.isFinite)) return null;
  return viewport.width > 0 && viewport.height > 0 ? viewport : null;
}

export function resolveSvgUserSpaceMapping(element: Element, window: Window): SvgUserSpaceMapping | null {
  if (element.tagName.toLowerCase() !== "svg") return null;
  const svg = element as SvgElementLike;
  const transform = positiveAxisTransform(window.getComputedStyle(element).transform);
  if (transform === null) return null;
  const parentSvg = nearestAncestorSvg(element);
  if (parentSvg !== null) {
    if (transform.a !== 1 || transform.d !== 1 || transform.e !== 0 || transform.f !== 0) return null;
    for (let current = element.parentElement; current !== parentSvg; current = current.parentElement) {
      if (current === null) return null;
      const intervening = positiveAxisTransform(window.getComputedStyle(current).transform);
      if (intervening === null || intervening.a !== 1 || intervening.d !== 1
        || intervening.e !== 0 || intervening.f !== 0) return null;
    }
  }
  const viewBox = parseViewBox(element);
  if (viewBox === null) return null;
  const alignment = parsePreserveAspectRatio(element.getAttribute("preserveAspectRatio"));
  if (alignment === null) return null;
  const measuredViewport = resolveSvgViewport(svg, window);
  if (measuredViewport === null) return null;
  const viewport = measuredViewport;
  const rawSx = viewport.width / viewBox.width;
  const rawSy = viewport.height / viewBox.height;
  if (!(rawSx > 0) || !(rawSy > 0) || !Number.isFinite(rawSx) || !Number.isFinite(rawSy)) return null;
  if (!alignment.uniform) {
    return {
      sx: rawSx, sy: rawSy,
      tx: viewport.x - viewBox.x * rawSx,
      ty: viewport.y - viewBox.y * rawSy,
      viewport, userWidth: viewBox.width, userHeight: viewBox.height,
    };
  }
  const scale = Math.min(rawSx, rawSy);
  const leftoverX = viewport.width - viewBox.width * scale;
  const leftoverY = viewport.height - viewBox.height * scale;
  return {
    sx: scale, sy: scale,
    tx: viewport.x + alignment.ax * leftoverX - viewBox.x * scale,
    ty: viewport.y + alignment.ay * leftoverY - viewBox.y * scale,
    viewport, userWidth: viewBox.width, userHeight: viewBox.height,
  };
}

export interface SvgAtomicViewportCertificate {
  readonly rootElement: Element;
  readonly physicalViewport: Rect;
  readonly paintDomain?: Rect;
}

function noTopLayerEscape(element: Element): boolean {
  if (typeof element.matches !== "function") return false;
  try {
    return [":fullscreen", ":modal", ":popover-open"].every(selector => element.matches(selector) === false);
  } catch {
    return false;
  }
}

function knownSvgFillBounds(element: Element, window: Window): boolean {
  if (typeof element.querySelectorAll !== "function") return false;
  for (const part of [element, ...Array.from(element.querySelectorAll("*"))]) {
    if (part.namespaceURI !== "http://www.w3.org/2000/svg"
      || !["g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon"].includes(part.tagName.toLowerCase())) return false;
    const style = window.getComputedStyle(part);
    if (!knownSvgAtomicChainStyle(part, style, window) || !noTopLayerEscape(part)
      || style.stroke !== "none" || style.markerStart !== "none" || style.markerMid !== "none" || style.markerEnd !== "none"
      || style.boxShadow !== "none" || style.outlineStyle !== "none"
      || style.transformStyle !== "flat" || style.perspective !== "none"
      || [style.translate, style.rotate, style.scale].some(value => value !== "none")) return false;
    for (const pseudo of ["::before", "::after"]) {
      const content = window.getComputedStyle(part, pseudo).content;
      if (content !== "none" && content !== "normal") return false;
    }
  }
  return true;
}

function noElementChildContent(element: Element): boolean {
  return element.children !== undefined && element.children.length === 0;
}

function localUseReference(element: Element): string | null {
  const href = element.getAttribute("href");
  let xlinkHref: string | null = null;
  if (typeof element.getAttributeNS === "function") {
    try {
      xlinkHref = element.getAttributeNS(XLINK_NAMESPACE, "href");
    } catch {
      return null;
    }
  } else {
    xlinkHref = element.getAttribute("xlink:href");
  }
  if (href !== null && xlinkHref !== null && href !== xlinkHref) return null;
  return href ?? xlinkHref;
}

function uniqueLocalUseSymbol(element: Element): Element | null {
  const href = localUseReference(element);
  if (href === null || !href.startsWith("#")) return null;
  const id = href.slice(1);
  if (id === "" || id.includes("#")) return null;
  const document = element.ownerDocument;
  if (document === null || typeof document.querySelectorAll !== "function") return null;
  let matches: Element[];
  try {
    matches = Array.from(document.querySelectorAll("*"))
      .filter(candidate => (candidate.getAttribute("id") ?? candidate.id) === id);
  } catch {
    return null;
  }
  if (matches.length !== 1) return null;
  const symbol = matches[0]!;
  if (symbol.namespaceURI !== SVG_NAMESPACE || symbol.tagName.toLowerCase() !== "symbol"
    || symbol.ownerDocument !== document) return null;
  return symbol;
}

function finiteLocalUseSubtree(symbol: Element, window: Window): boolean {
  if (typeof symbol.querySelectorAll !== "function") return false;
  let pathCount = 0;
  for (const element of [symbol, ...Array.from(symbol.querySelectorAll("*"))]) {
    if (element.namespaceURI !== SVG_NAMESPACE) return false;
    const tag = element.tagName.toLowerCase();
    if (element === symbol ? tag !== "symbol" : (tag !== "g" && tag !== "path")) return false;
    if (tag === "path") pathCount += 1;
    if (!noTopLayerEscape(element)) return false;
    const style = window.getComputedStyle(element);
    if (style.position === "fixed" || style.position === "sticky") return false;
  }
  return pathCount > 0;
}

function knownUseOuterStyle(style: CSSStyleDeclaration): boolean {
  return knownSvgBaseChainStyle(style)
    && knownNone(style.clipPath)
    && style.boxShadow === "none"
    && style.outlineStyle === "none";
}

function knownUseOuterContainmentStyle(style: CSSStyleDeclaration): boolean {
  return knownSvgBaseChainStyle(style)
    && knownNone(style.clipPath);
}

function certifySvgLocalUseViewport(
  element: Element,
  window: Window,
): SvgAtomicViewportCertificate | null {
  if (!noElementChildContent(element)) return null;
  const root = nearestSvgIncludingSelf(element);
  if (root === null || root === element || root.namespaceURI !== SVG_NAMESPACE) return null;
  if (nearestAncestorSvg(root) !== null) return null;
  if (typeof root.getClientRects !== "function") return null;
  let rootRects: DOMRectList;
  try {
    rootRects = root.getClientRects();
  } catch {
    return null;
  }
  if (rootRects.length !== 1) return null;
  // Local `#` references read and validate the finite same-document symbol
  // subtree. External references cannot be read here, so they keep only the
  // physical outer root bound; the root atomic order stays with the caller.
  const reference = localUseReference(element);
  if (reference === null) return null;
  const localReference = reference.startsWith("#");
  if (localReference) {
    const symbol = uniqueLocalUseSymbol(element);
    if (symbol === null || !finiteLocalUseSubtree(symbol, window)) return null;
  } else if (reference.trim() === "") {
    return null;
  }
  for (let current: Element | null = element; current !== root; current = current.parentElement) {
    if (current === null || current.namespaceURI !== SVG_NAMESPACE) return null;
    const tag = current.tagName.toLowerCase();
    if (tag !== "use" && tag !== "g") return null;
    if (!noTopLayerEscape(current)) return null;
    const style = window.getComputedStyle(current);
    if (style.position === "fixed" || style.position === "sticky") return null;
  }

  const rootStyle = window.getComputedStyle(root);
  if (!knownSvgRootMappingStyle(rootStyle)) return null;
  if (positiveAxisTransform(rootStyle.transform) === null) return null;
  if (!knownUseOuterStyle(rootStyle)) return null;
  if (rootStyle.overflowX !== "hidden" || rootStyle.overflowY !== "hidden") return null;
  if (!passesKnownSvgChain(root) || !noTopLayerEscape(root)) return null;
  for (const pseudo of ["::before", "::after"]) {
    const content = window.getComputedStyle(root, pseudo).content;
    if (content !== "none" && content !== "normal") return null;
  }

  const physicalViewport = localReference
    ? resolveSvgViewport(root as SvgElementLike, window)
    : resolveOutermostSvgPhysicalViewport(root, window);
  if (physicalViewport === null) return null;
  if (![physicalViewport.x, physicalViewport.y, physicalViewport.width, physicalViewport.height]
    .every(Number.isFinite) || !(physicalViewport.width > 0 && physicalViewport.height > 0)) return null;

  for (let current: Element | null = root.parentElement; current; current = current.parentElement) {
    const style = window.getComputedStyle(current);
    if (positiveAxisTransform(style.transform) === null) return null;
    if ([style.translate, style.rotate, style.scale, style.perspective].some(value => value !== "none")) return null;
    if (!knownUseOuterContainmentStyle(style)) return null;
  }

  return { rootElement: root, physicalViewport, paintDomain: physicalViewport };
}

function certifySvgStrokedLeafPathViewport(
  element: Element,
  window: Window,
): SvgAtomicViewportCertificate | null {
  if (element.tagName.toLowerCase() !== "path"
    || element.namespaceURI !== SVG_NAMESPACE
    || element.children === undefined
    || element.children.length !== 0
    || element.getAttribute("transform") !== null) return null;
  const style = window.getComputedStyle(element);
  if (!knownSvgAtomicChainStyle(element, style, window)
    || !noTopLayerEscape(element)
    || style.stroke === undefined || style.stroke.trim() === "" || style.stroke === "none"
    || style.position === "fixed" || style.position === "sticky"
    || style.markerStart !== "none" || style.markerMid !== "none" || style.markerEnd !== "none"
    || style.boxShadow !== "none" || style.outlineStyle !== "none"
    || style.transformStyle !== "flat" || style.perspective !== "none"
    || [style.translate, style.rotate, style.scale].some(value => value !== "none")) return null;
  for (const pseudo of ["::before", "::after"]) {
    const content = window.getComputedStyle(element, pseudo).content;
    if (content !== "none" && content !== "normal") return null;
  }

  const root = nearestSvgIncludingSelf(element);
  if (root === null || root === element || root.namespaceURI !== SVG_NAMESPACE
    || nearestAncestorSvg(root) !== null
    || element.parentElement !== root) return null;
  const rootStyle = window.getComputedStyle(root);
  if (!knownSvgRootMappingStyle(rootStyle) || !knownUseOuterStyle(rootStyle)
    || positiveAxisTransform(rootStyle.transform) === null
    || rootStyle.overflowX !== "hidden" || rootStyle.overflowY !== "hidden"
    || !passesKnownSvgChain(root) || !noTopLayerEscape(root)) return null;
  for (const pseudo of ["::before", "::after"]) {
    const content = window.getComputedStyle(root, pseudo).content;
    if (content !== "none" && content !== "normal") return null;
  }

  const mapping = resolveSvgUserSpaceMapping(root, window);
  if (mapping === null) return null;
  const physicalViewport = mapping.viewport;
  if (![physicalViewport.x, physicalViewport.y,
    physicalViewport.width, physicalViewport.height].every(Number.isFinite)
    || !(physicalViewport.width > 0 && physicalViewport.height > 0)) return null;

  for (let current: Element | null = root.parentElement; current; current = current.parentElement) {
    const currentStyle = window.getComputedStyle(current);
    if (positiveAxisTransform(currentStyle.transform) === null) return null;
    if ([currentStyle.translate, currentStyle.rotate, currentStyle.scale, currentStyle.perspective]
      .some(value => value !== "none")) return null;
    if (!knownUseOuterContainmentStyle(currentStyle)) return null;
  }

  return { rootElement: root, physicalViewport, paintDomain: physicalViewport };
}

// Narrow containment certificate for a PATH/G descendant of an outermost SVG
// whose hidden viewport clips all target paint. It proves only physical
// containment and actual viewport clipping; it does not prove opacity, order,
// category, or that the target has paint.
export function certifySvgAtomicViewport(
  element: Element,
  window: Window,
): SvgAtomicViewportCertificate | null {
  const tag = element.tagName.toLowerCase();
  if (tag === "use") return certifySvgLocalUseViewport(element, window);
  if (tag !== "path" && tag !== "g") return null;
  if (element.namespaceURI !== "http://www.w3.org/2000/svg") return null;
  if (tag === "path" && window.getComputedStyle(element).stroke !== "none") {
    return certifySvgStrokedLeafPathViewport(element, window);
  }
  if (!knownSvgFillBounds(element, window)) return null;
  const root = nearestSvgIncludingSelf(element);
  if (root === null || root === element || root.namespaceURI !== "http://www.w3.org/2000/svg") return null;
  if (nearestAncestorSvg(root) !== null) return null;

  for (let current: Element | null = element; current !== root; current = current.parentElement) {
    if (current === null) return null;
    const currentTag = current.tagName.toLowerCase();
    if ((currentTag !== "g" && currentTag !== "path") || !passesAtomicSvgChain(current) || !noTopLayerEscape(current)) return null;
    if (!knownSvgAtomicChainStyle(current, window.getComputedStyle(current), window)) return null;
  }

  const rootStyle = window.getComputedStyle(root);
  if (!knownSvgRootMappingStyle(rootStyle)) return null;
  if (!["hidden", "clip"].includes(rootStyle.overflowX)
    || !["hidden", "clip"].includes(rootStyle.overflowY)) return null;
  if (!passesKnownSvgChain(root) || !noTopLayerEscape(root)) return null;

  const mapping = resolveSvgUserSpaceMapping(root, window);
  let physicalViewport: Rect | null = mapping?.viewport ?? null;
  if (physicalViewport === null) {
    const reflected = certifyAxisReflectedSvgViewport(element, window);
    if (reflected === null || reflected.targetKind !== "directPath" || reflected.root !== root) return null;
    physicalViewport = reflected.viewport;
  }
  if (![physicalViewport.x, physicalViewport.y, physicalViewport.width, physicalViewport.height]
    .every(Number.isFinite) || !(physicalViewport.width > 0 && physicalViewport.height > 0)) return null;

  for (let current: Element | null = root.parentElement; current; current = current.parentElement) {
    const style = window.getComputedStyle(current);
    if (positiveAxisTransform(style.transform) === null) return null;
    if ([style.translate, style.rotate, style.scale, style.perspective].some(value => value !== "none")) return null;
    if (style.transformStyle !== "flat") return null;
  }

  const bounds = element.getBoundingClientRect();
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    || !(bounds.width > 0 && bounds.height > 0)) return null;
  const contained = bounds.x >= physicalViewport.x
    && bounds.y >= physicalViewport.y
    && bounds.x + bounds.width <= physicalViewport.x + physicalViewport.width
    && bounds.y + bounds.height <= physicalViewport.y + physicalViewport.height;
  // Hidden overflow clips every supported fill to this physical viewport.
  // `clip` may expand via overflow-clip-margin and retains the narrower proof.
  const hiddenViewport = rootStyle.overflowX === "hidden" && rootStyle.overflowY === "hidden";
  if (!contained && !hiddenViewport) {
    let left = bounds.x, top = bounds.y;
    let right = bounds.x + bounds.width, bottom = bounds.y + bounds.height;
    let hasComputedChainClip = false;
    for (let current: Element | null = element; current !== null && current !== root; current = current.parentElement) {
      const style = window.getComputedStyle(current);
      const facts = atomicSvgClipFacts(current, style, window);
      if (facts === null) return null;
      if (facts.hasComputedClip) hasComputedChainClip = true;
      for (const rect of facts.rects) {
        left = Math.max(left, rect.x);
        top = Math.max(top, rect.y);
        right = Math.min(right, rect.x + rect.width);
        bottom = Math.min(bottom, rect.y + rect.height);
      }
    }
    if (!hasComputedChainClip) return null;
    left = Math.max(left, physicalViewport.x);
    top = Math.max(top, physicalViewport.y);
    right = Math.min(right, physicalViewport.x + physicalViewport.width);
    bottom = Math.min(bottom, physicalViewport.y + physicalViewport.height);
    if (!(right > left && bottom > top)) return null;
  }

  return { rootElement: root, physicalViewport };
}

function allClipPathElements(document: Document): Element[] {
  const nodes = document.querySelectorAll("clipPath");
  return Array.from(nodes);
}

// Strict absolute cubic path parser for the narrow containment certificate.
// Accepts only one or more closed subpaths built from explicit absolute M, C, Z:
//   M x y  ( C x1 y1 x2 y2 x y )+  Z  ( M ... Z )*
// No relative commands, no arcs/smooth/quadratic/lines, no implicit repetition,
// no shorthand, no gaps, no trailing tokens, no unclosed subpaths. This is a
// self-contained parser kept separate from parsePathRectangle (rect clip).
interface AbsoluteCubicSubpath {
  readonly points: ReadonlyArray<readonly [number, number]>;
}

function parseStrictAbsoluteCubicPath(d: string | null): AbsoluteCubicSubpath[] | null {
  if (d === null || d.includes(",")) return null;
  const tokens = d.match(/[MCZ]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g);
  if (tokens === null) return null;
  const compact = d.replace(/[\s,]+/g, "");
  if (compact === "" || tokens.join("") !== compact) return null;
  let index = 0;
  const subpaths: { points: [number, number][] }[] = [];
  let current: { points: [number, number][] } | null = null;
  let currentHasCurve = false;
  const next = (): number | null => {
    const token = tokens[index++];
    if (token === undefined) return null;
    const value = Number(token);
    return Number.isFinite(value) ? value : null;
  };
  while (index < tokens.length) {
    const command = tokens[index++];
    if (command !== "M" && command !== "C" && command !== "Z") return null;
    if (command === "M") {
      if (current !== null) return null;
      const x = next(), y = next();
      if (x === null || y === null) return null;
      current = { points: [[x, y]] };
      currentHasCurve = false;
    } else if (command === "C") {
      if (current === null) return null;
      const x1 = next(), y1 = next(), x2 = next(), y2 = next(), x = next(), y = next();
      if (x1 === null || y1 === null || x2 === null || y2 === null || x === null || y === null) return null;
      current.points.push([x1, y1], [x2, y2], [x, y]);
      currentHasCurve = true;
    } else {
      if (current === null || !currentHasCurve) return null;
      subpaths.push(current);
      current = null;
      currentHasCurve = false;
    }
  }
  if (current !== null || subpaths.length === 0) return null;
  return subpaths;
}

// Narrow containment certificate for a rotated outermost SVG whose only direct
// element child is one path. It proves the filled path stays inside the local
// viewBox via the cubic control-point convex hull, then relies on the default
// meet mapping using the measured physical viewport. It does NOT prove pixel
// alpha/opacity/visibility. Returns null for every unsupported case.
export interface ContainedSvgCertificate {
  readonly root: Element;
  readonly targetKind: "root" | "directPath";
}

export function certifyContainedSvgOverflow(element: Element, window: Window): ContainedSvgCertificate | null {
  const tag = element.tagName.toLowerCase();
  if (tag !== "svg" && tag !== "path") return null;
  const root = tag === "svg" ? element : element.parentElement;
  if (root === null || root.tagName.toLowerCase() !== "svg") return null;
  if (root.namespaceURI !== "http://www.w3.org/2000/svg") return null;
  const targetKind: ContainedSvgCertificate["targetKind"] = tag === "svg" ? "root" : "directPath";
  // Outermost svg only: no ancestor svg.
  if (nearestAncestorSvg(root) !== null) return null;
  const style = window.getComputedStyle(root);
  // Measured CSS viewport must be finite positive px; border/padding known zero.
  if (!zeroBorderAndPadding(style)) return null;
  const width = parseCssPx(style.width);
  const height = parseCssPx(style.height);
  if (width === null || height === null || !(width > 0) || !(height > 0)) return null;
  // Single direct path child; preserve children.length semantics, not IAB-only.
  if (root.children === undefined || root.children.length !== 1) return null;
  const direct = root.children[0]!;
  if (direct.tagName.toLowerCase() !== "path" || direct.namespaceURI !== "http://www.w3.org/2000/svg") return null;
  // viewBox valid, positive width/height.
  const viewBox = parseViewBox(root);
  if (viewBox === null) return null;
  if (!Number.isFinite(viewBox.x + viewBox.width) || !Number.isFinite(viewBox.y + viewBox.height)) return null;
  // preserveAspectRatio: default or strict x*-mid-*-meet only.
  const alignment = parseStrictMeetAspectRatio(root.getAttribute("preserveAspectRatio"));
  if (alignment === null || !alignment.uniform) return null;
  // Root transform: none or finite invertible 2D matrix. No matrix3d.
  const rootTransform = finiteInvertible2dTransform(style.transform);
  if (rootTransform === null) return null;
  if ([style.translate, style.rotate, style.scale, style.perspective]
    .some(value => value !== "none")) return null;
  // Root effects that can alter the painted geometry must be known absent.
  if (!knownNone(style.filter) || !knownNone(style.clipPath)
    || !knownNoMask(style)) return null;
  if (style.contain !== "none") return null;
  // All ancestors transform none; independent transforms none.
  for (let current: Element | null = root.parentElement; current; current = current.parentElement) {
    const ancestorStyle = window.getComputedStyle(current);
    if ([ancestorStyle.translate, ancestorStyle.rotate, ancestorStyle.scale, ancestorStyle.perspective]
      .some(value => value !== "none")) return null;
    if (ancestorStyle.transform !== "none") return null;
    if (!knownNone(ancestorStyle.filter) || !knownNone(ancestorStyle.clipPath)
      || !knownNoMask(ancestorStyle)) return null;
    if (ancestorStyle.contain !== "none") return null;
  }
  // Draw geometry must come from actual computed CSS d and agree with the
  // attribute used for the certificate. A missing computed geometry is unknown.
  const directStyle = window.getComputedStyle(direct);
  const computedD = typeof directStyle.getPropertyValue === "function" ? directStyle.getPropertyValue("d").trim() : "";
  const attributeD = direct.getAttribute("d");
  if (attributeD === null) return null;
  const unwrapped = /^path\(\s*"(.*)"\s*\)$/.exec(computedD);
  if (unwrapped?.[1] === undefined) return null;
  const effectiveD = unwrapped[1].trim();
  if (effectiveD.replace(/\s+/g, "") !== attributeD.replace(/\s+/g, "")) return null;
  // Direct path must have no stroke/marker/filter/mask/clip/transform.
  if (!knownNone(directStyle.stroke)) return null;
  if (!knownNone(directStyle.markerStart) || !knownNone(directStyle.markerMid) || !knownNone(directStyle.markerEnd)) return null;
  if (!knownNone(directStyle.filter) || !knownNone(directStyle.clipPath)
    || !knownNoMask(directStyle)) return null;
  if (!knownNone(directStyle.transform)) return null;
  if ([directStyle.translate, directStyle.rotate, directStyle.scale, directStyle.perspective]
    .some(value => value !== "none")) return null;
  // Strict absolute M/C/Z only; no path child/subelement.
  if (direct.children === undefined || direct.children.length !== 0) return null;
  const subpaths = parseStrictAbsoluteCubicPath(effectiveD);
  if (subpaths === null) return null;
  // Every M point and every C control point/endpoint strictly inside viewBox.
  for (const subpath of subpaths) {
    for (const [px, py] of subpath.points) {
      if (!(px > viewBox.x && px < viewBox.x + viewBox.width)) return null;
      if (!(py > viewBox.y && py < viewBox.y + viewBox.height)) return null;
    }
  }
  return { root, targetKind };
}

// Narrow physical-viewport certificate for an outermost axis-reflected SVG.
// The root transform must be an exact axis-aligned 2D matrix with at least one
// negative diagonal. A single direct leaf path may use any path commands
// because this certificate never parses path geometry: it proves only the
// rectangular screen-space viewport, not painted pixels or a category.
export interface AxisReflectedSvgViewportCertificate {
  readonly root: Element;
  readonly viewport: Rect;
  readonly targetKind: "root" | "directPath";
}

function reflectedAxisTransform(transform: string | undefined): MatrixTransform | null {
  const matrix = finiteInvertible2dTransform(transform);
  if (matrix === null) return null;
  if (matrix.b !== 0 || matrix.c !== 0) return null;
  if (matrix.a === 0 || matrix.d === 0) return null;
  if (!(matrix.a < 0 || matrix.d < 0)) return null;
  return matrix;
}

export function certifyAxisReflectedSvgViewport(
  element: Element,
  window: Window,
): AxisReflectedSvgViewportCertificate | null {
  const tag = element.tagName.toLowerCase();
  if (tag !== "svg" && tag !== "path") return null;
  const root = tag === "svg" ? element : element.parentElement;
  if (root === null || root.tagName.toLowerCase() !== "svg") return null;
  if (root.namespaceURI !== "http://www.w3.org/2000/svg") return null;
  // Outermost svg only: nested svg user space is not a physical viewport.
  if (nearestAncestorSvg(root) !== null) return null;
  const style = window.getComputedStyle(root);
  if (!zeroBorderAndPadding(style)) return null;
  const width = parseCssPx(style.width);
  const height = parseCssPx(style.height);
  if (width === null || height === null) return null;
  // Exact axis-aligned reflection only; independent transforms stay unknown.
  if (reflectedAxisTransform(style.transform) === null) return null;
  if ([style.translate, style.rotate, style.scale, style.perspective]
    .some(value => value !== "none")) return null;
  if (!knownNone(style.filter) || !knownNone(style.clipPath) || !knownNoMask(style)) return null;
  if (style.contain !== "none") return null;
  // Outer transforms must keep the measured viewport rectangular. Missing
  // facts and angled/skewed ancestors are unsupported, not assumed identity.
  for (let current: Element | null = root.parentElement; current; current = current.parentElement) {
    const ancestorStyle = window.getComputedStyle(current);
    if ([ancestorStyle.translate, ancestorStyle.rotate, ancestorStyle.scale, ancestorStyle.perspective]
      .some(value => value !== "none")) return null;
    if (positiveAxisTransform(ancestorStyle.transform) === null) return null;
  }
  if (root.children === undefined || root.children.length !== 1) return null;
  const direct = root.children[0]!;
  if (direct.tagName.toLowerCase() !== "path") return null;
  if (direct.namespaceURI !== "http://www.w3.org/2000/svg") return null;
  if (direct.children === undefined || direct.children.length !== 0) return null;
  const directStyle = window.getComputedStyle(direct);
  if (!knownNone(directStyle.transform)) return null;
  if ([directStyle.translate, directStyle.rotate, directStyle.scale, directStyle.perspective]
    .some(value => value !== "none")) return null;
  if (!knownNone(directStyle.stroke)) return null;
  if (!knownNone(directStyle.markerStart) || !knownNone(directStyle.markerMid)
    || !knownNone(directStyle.markerEnd)) return null;
  if (!knownNone(directStyle.filter) || !knownNone(directStyle.clipPath)
    || !knownNoMask(directStyle)) return null;
  const bounds = root.getBoundingClientRect();
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return null;
  if (!(bounds.width > 0) || !(bounds.height > 0)) return null;
  return {
    root,
    viewport: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    targetKind: tag === "svg" ? "root" : "directPath",
  };
}

function parsePathRectangle(d: string | null): Box | null {
  if (d === null) return null;
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi);
  if (tokens === null) return null;
  const compact = d.replace(/[\s,]+/g, "");
  if (compact === "" || tokens.join("") !== compact) return null;
  const points: [number, number][] = [];
  const edges: [number, number][] = [];
  let index = 0;
  let command = "";
  let cx = 0, cy = 0, startX = 0, startY = 0;
  let sawMove = false, sawClose = false;
  const next = (): number | null => {
    const token = tokens[index++];
    if (token === undefined) return null;
    const value = Number(token);
    return Number.isFinite(value) ? value : null;
  };
  while (index < tokens.length) {
    if (sawClose) return null;
    const token = tokens[index]!;
    if (/^[a-zA-Z]$/.test(token)) { command = token; index++; }
    else if (command === "") return null;
    switch (command) {
      case "M": case "m": {
        if (sawMove) return null;
        const x = next(), y = next();
        if (x === null || y === null) return null;
        cx = command === "m" ? cx + x : x;
        cy = command === "m" ? cy + y : y;
        startX = cx; startY = cy;
        points.push([cx, cy]);
        sawMove = true;
        command = command === "m" ? "l" : "L";
        if (index < tokens.length && !/^[a-zA-Z]$/.test(tokens[index]!)) return null;
        break;
      }
      case "L": case "l": {
        const x = next(), y = next();
        if (x === null || y === null) return null;
        const fromX = cx, fromY = cy;
        cx = command === "l" ? cx + x : x;
        cy = command === "l" ? cy + y : y;
        points.push([cx, cy]);
        edges.push([cx - fromX, cy - fromY]);
        break;
      }
      case "H": case "h": {
        const x = next();
        if (x === null) return null;
        const fromX = cx;
        cx = command === "h" ? cx + x : x;
        points.push([cx, cy]);
        edges.push([cx - fromX, 0]);
        break;
      }
      case "V": case "v": {
        const y = next();
        if (y === null) return null;
        const fromY = cy;
        cy = command === "v" ? cy + y : y;
        points.push([cx, cy]);
        edges.push([0, cy - fromY]);
        break;
      }
      case "Z": case "z":
        if (sawClose) return null;
        edges.push([startX - cx, startY - cy]);
        cx = startX; cy = startY;
        sawClose = true;
        command = "";
        break;
      default:
        return null;
    }
  }
  if (!sawMove || !sawClose) return null;
  const cleaned: [number, number][] = [];
  for (const point of points) {
    const last = cleaned[cleaned.length - 1];
    if (last === undefined || last[0] !== point[0] || last[1] !== point[1]) cleaned.push(point);
  }
  while (cleaned.length > 1 && cleaned[cleaned.length - 1]![0] === cleaned[0]![0] && cleaned[cleaned.length - 1]![1] === cleaned[0]![1]) cleaned.pop();
  if (cleaned.length !== 4) return null;
  if (edges.length !== 4 || !edges.every(([dx, dy]) => (dx === 0) !== (dy === 0))) return null;
  const turns = edges.map(([dx, dy], edgeIndex) => {
    const [nextX, nextY] = edges[(edgeIndex + 1) % edges.length]!;
    return dx * nextY - dy * nextX;
  });
  if (!turns.every(turn => turn !== 0 && Math.sign(turn) === Math.sign(turns[0]!))) return null;
  const xs = [...new Set(cleaned.map(point => point[0]))].sort((a, b) => a - b);
  const ys = [...new Set(cleaned.map(point => point[1]))].sort((a, b) => a - b);
  if (xs.length !== 2 || ys.length !== 2) return null;
  const [x0, x1] = xs, [y0, y1] = ys;
  if (x0 === undefined || x1 === undefined || y0 === undefined || y1 === undefined) return null;
  if (!(x0 < x1 && y0 < y1)) return null;
  const corners = new Set([`${x0},${y0}`, `${x1},${y0}`, `${x1},${y1}`, `${x0},${y1}`]);
  for (const point of cleaned) if (!corners.has(`${point[0]},${point[1]}`)) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function rectangleOfRect(rect: Element): Box | null {
  const x = rect.getAttribute("x") === null ? 0 : numericAttribute(rect, "x");
  const y = rect.getAttribute("y") === null ? 0 : numericAttribute(rect, "y");
  const width = numericAttribute(rect, "width");
  const height = numericAttribute(rect, "height");
  if (x === null || y === null || width === null || height === null || !(width > 0) || !(height > 0)) return null;
  const rx = numericAttribute(rect, "rx");
  const ry = numericAttribute(rect, "ry");
  if ((rect.getAttribute("rx") !== null && rx === null) || (rect.getAttribute("ry") !== null && ry === null)) return null;
  if ((rx !== null && rx !== 0) || (ry !== null && ry !== 0)) return null;
  return { x, y, width, height };
}

interface ClipPathDefinition {
  readonly units: string;
  readonly rect: Box;
}

function parseClipPath(clipPath: Element): ClipPathDefinition | null {
  if (clipPath.getAttribute("transform") !== null) return null;
  if (clipPath.getAttribute("clip-path") !== null) return null;
  const units = clipPath.getAttribute("clipPathUnits") ?? "userSpaceOnUse";
  if (clipPath.children === undefined || clipPath.children.length !== 1) return null;
  const child = clipPath.children[0];
  if (child === undefined) return null;
  if (child.getAttribute("transform") !== null) return null;
  if (child.getAttribute("clip-path") !== null) return null;
  const tag = child.tagName.toLowerCase();
  const rect = tag === "rect" ? rectangleOfRect(child)
    : tag === "path" ? parsePathRectangle(child.getAttribute("d")) : null;
  if (rect === null) return null;
  return { units, rect };
}

function sameDefinition(a: ClipPathDefinition, b: ClipPathDefinition): boolean {
  return a.units === b.units
    && a.rect.x === b.rect.x && a.rect.y === b.rect.y
    && a.rect.width === b.rect.width && a.rect.height === b.rect.height;
}

export function resolveLocalSvgClipPathRect(element: Element, clipPathValue: string, window: Window): Rect | null {
  const match = /^url\(\s*["']?#([^"'()]+)["']?\s*\)$/i.exec(clipPathValue.trim());
  const id = match?.[1];
  if (id === undefined || id === "") return null;
  const document = element.ownerDocument;
  if (!document) return null;
  const candidates = allClipPathElements(document).filter(candidate => (candidate.getAttribute("id") ?? candidate.id) === id);
  if (candidates.length === 0) return null;
  let definition: ClipPathDefinition | null = null;
  for (const candidate of candidates) {
    const parsed = parseClipPath(candidate);
    if (parsed === null) return null;
    if (definition === null) definition = parsed;
    else if (!sameDefinition(definition, parsed)) return null;
  }
  if (definition === null || definition.units !== "userSpaceOnUse") return null;
  const svg = nearestSvgIncludingSelf(element);
  if (svg === null) return null;
  for (let current: Element | null = element; current !== svg; current = current.parentElement) {
    if (current === null) return null;
    const transform = positiveAxisTransform(window.getComputedStyle(current).transform);
    if (transform === null || transform.a !== 1 || transform.d !== 1
      || transform.e !== 0 || transform.f !== 0) return null;
  }
  const mapping = resolveSvgUserSpaceMapping(svg, window);
  if (mapping === null) return null;
  const { x, y, width, height } = definition.rect;
  const x1 = mapping.tx + mapping.sx * x;
  const y1 = mapping.ty + mapping.sy * y;
  const x2 = mapping.tx + mapping.sx * (x + width);
  const y2 = mapping.ty + mapping.sy * (y + height);
  const rect: Rect = {
    x: Math.min(x1, x2), y: Math.min(y1, y2),
    width: Math.abs(x2 - x1), height: Math.abs(y2 - y1),
  };
  return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ? rect : null;
}
