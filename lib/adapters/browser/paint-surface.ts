import type { Rect } from "./observation.js";

export interface AxisScale {
  readonly x: number;
  readonly y: number;
}

export interface ReplacedObjectIntrinsicFacts {
  readonly complete: boolean | null;
  readonly naturalWidth: number | null;
  readonly naturalHeight: number | null;
  readonly sourcePresent: boolean;
}

export interface RadiusPair {
  readonly x: number;
  readonly y: number;
}

/** True only for the supported CSS case whose entire image misses its clip box. */
export function backgroundImageOutsideBox(style: CSSStyleDeclaration, singleHtmlBlockBox: boolean): boolean {
  if (!singleHtmlBlockBox || !/^url\((?:"[^"\\]*"|'[^'\\]*'|[^'"(),\s]+)\)$/.test(style.backgroundImage ?? "")) return false;
  if (style.backgroundSize !== "100% auto" || style.backgroundRepeat !== "no-repeat"
    || style.backgroundOrigin !== "padding-box" || style.backgroundClip !== "border-box"
    || style.backgroundAttachment !== "scroll") return false;
  const pixels = (value: string | undefined): number | null => {
    const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))px$/.exec(value ?? "");
    if (!match) return null;
    const number = Number(match[1]);
    return Number.isFinite(number) ? number : null;
  };
  const edges = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth,
    style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft];
  if (!edges.every(value => pixels(value) === 0)) return false;
  const width = pixels(style.width), x = pixels(style.backgroundPositionX);
  return width !== null && width > 0 && x !== null && (x + width <= 0 || x >= width);
}

// A circle of radius r reaches r*(1 - 1/sqrt(2)) toward its corner along the
// diagonal. Insets use the larger of the two corners sharing each edge, so the
// resulting box is provably inside the painted rounded border ring.
const CORNER_SAFE_FACTOR = 1 - 1 / Math.SQRT2;

function length(value: string | undefined, basis: number): number | null {
  if (value === undefined) return null;
  const text = value.trim();
  if (text === "") return null;
  if (text.endsWith("%")) {
    const percent = Number(text.slice(0, -1));
    return Number.isFinite(percent) && percent >= 0 ? (basis * percent) / 100 : null;
  }
  const match = /^(-?(?:\d+|\d*\.\d+))(?:px)?$/.exec(text);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function radius(value: string | undefined, width: number, height: number): RadiusPair | null {
  if (value === undefined) return null;
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 2) return null;
  const x = length(parts[0], width);
  const y = parts.length === 2 ? length(parts[1], height) : length(parts[0], height);
  if (x === null || y === null) return null;
  return { x, y };
}

function cornerInset(border: number, cornerRadius: number): number {
  return border + Math.max(0, cornerRadius - border) * CORNER_SAFE_FACTOR;
}

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  };
}

export function normalizedRadii(style: CSSStyleDeclaration, width: number, height: number): readonly RadiusPair[] | null {
  const corners = [style.borderTopLeftRadius, style.borderTopRightRadius,
    style.borderBottomRightRadius, style.borderBottomLeftRadius].map(value => radius(value, width, height));
  const [tl, tr, br, bl] = corners;
  if (!tl || !tr || !br || !bl) return null;
  const factor = Math.min(1, width / (tl.x + tr.x), width / (bl.x + br.x),
    height / (tl.y + bl.y), height / (tr.y + br.y));
  if (!Number.isFinite(factor) || factor <= 0) return null;
  return [tl, tr, br, bl].map(corner => ({ x: corner.x * factor, y: corner.y * factor }));
}

/** Geometry only: caller must prove that all own paint follows the outer radii. */
export function roundedOuterClearCorners(
  borderBox: Rect, visibleBox: Rect, style: CSSStyleDeclaration, scale: AxisScale,
): readonly Rect[] | null {
  if (![scale.x, scale.y].every(value => Number.isFinite(value) && value > 0)
    || ![borderBox.x, borderBox.y, borderBox.width, borderBox.height].every(Number.isFinite)
    || borderBox.width <= 0 || borderBox.height <= 0) return null;
  const corners = normalizedRadii(style, borderBox.width / scale.x, borderBox.height / scale.y);
  if (corners === null) return null;
  const result: Rect[] = [];
  for (let index = 0; index < corners.length; index++) {
    const corner = corners[index]!;
    if (corner.x <= 0 || corner.y <= 0) continue;
    const rx = corner.x * scale.x, ry = corner.y * scale.y;
    const right = index === 1 || index === 2, bottom = index >= 2;
    const patch = intersect(visibleBox, {
      x: borderBox.x + (right ? borderBox.width - rx / 4 : rx / 8),
      y: borderBox.y + (bottom ? borderBox.height - ry / 4 : ry / 8),
      width: rx / 8, height: ry / 8,
    });
    if (patch.width > 0 && patch.height > 0) result.push(patch);
  }
  return result;
}

/**
 * Provably unpainted interior of a border-only box, in viewport coordinates.
 * Radii and borders are read in CSS pixels and mapped through the accumulated
 * CSS-to-viewport scale. Returns null when any measurement is unsupported or
 * when the rounded ring leaves no positive clear interior.
 */
export function borderOnlyClearInterior(
  borderBox: Rect,
  visibleBox: Rect,
  style: CSSStyleDeclaration,
  scale: AxisScale,
): Rect | null {
  if (!Number.isFinite(scale.x) || !Number.isFinite(scale.y) || scale.x <= 0 || scale.y <= 0) return null;
  if (![borderBox.x, borderBox.y, borderBox.width, borderBox.height].every(Number.isFinite)) return null;
  const cssWidth = borderBox.width / scale.x, cssHeight = borderBox.height / scale.y;
  if (!(cssWidth > 0) || !(cssHeight > 0)) return null;
  const borderTop = length(style.borderTopWidth, 0);
  const borderRight = length(style.borderRightWidth, 0);
  const borderBottom = length(style.borderBottomWidth, 0);
  const borderLeft = length(style.borderLeftWidth, 0);
  if (borderTop === null || borderRight === null || borderBottom === null || borderLeft === null) return null;
  const [topLeft, topRight, bottomRight, bottomLeft] = normalizedRadii(style, cssWidth, cssHeight) ?? [];
  if (!topLeft || !topRight || !bottomRight || !bottomLeft) return null;
  const left = Math.max(
    cornerInset(borderLeft, topLeft.x),
    cornerInset(borderLeft, bottomLeft.x),
  );
  const right = Math.max(
    cornerInset(borderRight, topRight.x),
    cornerInset(borderRight, bottomRight.x),
  );
  const top = Math.max(
    cornerInset(borderTop, topLeft.y),
    cornerInset(borderTop, topRight.y),
  );
  const bottom = Math.max(
    cornerInset(borderBottom, bottomLeft.y),
    cornerInset(borderBottom, bottomRight.y),
  );
  const width = cssWidth - left - right, height = cssHeight - top - bottom;
  if (!(width > 0) || !(height > 0)) return null;
  const clear = {
    x: borderBox.x + left * scale.x,
    y: borderBox.y + top * scale.y,
    width: width * scale.x,
    height: height * scale.y,
  };
  const clipped = intersect(clear, visibleBox);
  return clipped.width > 0 && clipped.height > 0 ? clipped : null;
}

/**
 * Upper bound for a loaded replaced image painted with centered object-fit:
 * contain. This proves possible image geometry, not opacity or paint order.
 */
export function containedReplacedPaintRect(
  borderBox: Rect,
  visibleBox: Rect,
  style: CSSStyleDeclaration,
  scale: AxisScale,
  intrinsic: ReplacedObjectIntrinsicFacts,
): Rect | null {
  if (![scale.x, scale.y].every(value => Number.isFinite(value) && value > 0)) return null;
  if (![borderBox.x, borderBox.y, borderBox.width, borderBox.height,
    visibleBox.x, visibleBox.y, visibleBox.width, visibleBox.height].every(Number.isFinite)) return null;
  if (!(borderBox.width > 0) || !(borderBox.height > 0)) return null;
  if (intrinsic.complete !== true || intrinsic.sourcePresent !== true
    || intrinsic.naturalWidth === null || intrinsic.naturalHeight === null
    || !Number.isFinite(intrinsic.naturalWidth) || !Number.isFinite(intrinsic.naturalHeight)
    || !(intrinsic.naturalWidth > 0) || !(intrinsic.naturalHeight > 0)) return null;
  if (![style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth,
    style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]
    .every(value => length(value, 0) === 0)) return null;
  if (style.objectFit !== "contain" || String(style.objectPosition ?? "").trim() !== "50% 50%") return null;
  const cssWidth = borderBox.width / scale.x, cssHeight = borderBox.height / scale.y;
  if (!Number.isFinite(cssWidth) || !Number.isFinite(cssHeight) || !(cssWidth > 0) || !(cssHeight > 0)) return null;
  const fit = Math.min(cssWidth / intrinsic.naturalWidth, cssHeight / intrinsic.naturalHeight);
  if (!Number.isFinite(fit) || !(fit > 0)) return null;
  const contentWidth = intrinsic.naturalWidth * fit, contentHeight = intrinsic.naturalHeight * fit;
  const raw = {
    x: borderBox.x + ((cssWidth - contentWidth) / 2) * scale.x,
    y: borderBox.y + ((cssHeight - contentHeight) / 2) * scale.y,
    width: contentWidth * scale.x,
    height: contentHeight * scale.y,
  };
  const clipped = intersect(raw, visibleBox);
  return clipped.width > 0 && clipped.height > 0 ? clipped : null;
}

/**
 * Lower bound for a fully covering centered replaced image. The returned rect
 * is the complete raw border box; viewport clipping belongs to the caller.
 */
export function fullReplacedImageCoverageRect(
  borderBox: Rect,
  style: CSSStyleDeclaration,
  scale: AxisScale,
  intrinsic: ReplacedObjectIntrinsicFacts,
): Rect | null {
  if (![scale.x, scale.y].every(value => Number.isFinite(value) && value > 0)) return null;
  if (![borderBox.x, borderBox.y, borderBox.width, borderBox.height].every(Number.isFinite)
    || !(borderBox.width > 0) || !(borderBox.height > 0)) return null;
  if (intrinsic.complete !== true || intrinsic.sourcePresent !== true
    || intrinsic.naturalWidth === null || intrinsic.naturalHeight === null
    || !Number.isFinite(intrinsic.naturalWidth) || !Number.isFinite(intrinsic.naturalHeight)
    || !(intrinsic.naturalWidth > 0) || !(intrinsic.naturalHeight > 0)) return null;
  if (![style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth,
    style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]
    .every(value => length(value, 0) === 0)) return null;
  if (![style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius]
    .every(value => length(value, 0) === 0)) return null;
  if (String(style.objectPosition ?? "").trim() !== "50% 50%") return null;

  const cssWidth = borderBox.width / scale.x, cssHeight = borderBox.height / scale.y;
  if (!Number.isFinite(cssWidth) || !Number.isFinite(cssHeight) || !(cssWidth > 0) || !(cssHeight > 0)) return null;
  if (style.objectFit === "contain") {
    if (intrinsic.naturalWidth * cssHeight !== intrinsic.naturalHeight * cssWidth) return null;
  } else if (style.objectFit !== "cover") {
    return null;
  }
  return { x: borderBox.x, y: borderBox.y, width: borderBox.width, height: borderBox.height };
}

export interface RoundedRectDomain {
  readonly bounds: Rect;
  readonly radii: readonly RadiusPair[];
}

export function equalRoundedDomains(
  left: RoundedRectDomain,
  right: RoundedRectDomain,
): boolean {
  if (
    left.bounds.x !== right.bounds.x
    || left.bounds.y !== right.bounds.y
    || left.bounds.width !== right.bounds.width
    || left.bounds.height !== right.bounds.height
  ) {
    return false;
  }
  if (left.radii.length !== 4 || right.radii.length !== 4) return false;
  for (let index = 0; index < 4; index++) {
    const l = left.radii[index]!, r = right.radii[index]!;
    if (l.x !== r.x || l.y !== r.y) return false;
  }
  return true;
}

export function pointInRoundedDomain(
  domain: RoundedRectDomain,
  x: number,
  y: number,
): boolean {
  const { bounds, radii } = domain;
  if (x < bounds.x || x > bounds.x + bounds.width || y < bounds.y || y > bounds.y + bounds.height) {
    return false;
  }
  const [tl, tr, br, bl] = radii;
  if (!tl || !tr || !br || !bl) return false;

  // Top-left corner
  if (x < bounds.x + tl.x && y < bounds.y + tl.y) {
    if (tl.x <= 0 || tl.y <= 0) return true;
    const dx = (x - (bounds.x + tl.x)) / tl.x;
    const dy = (y - (bounds.y + tl.y)) / tl.y;
    return dx * dx + dy * dy <= 1;
  }
  // Top-right corner
  if (x > bounds.x + bounds.width - tr.x && y < bounds.y + tr.y) {
    if (tr.x <= 0 || tr.y <= 0) return true;
    const dx = (x - (bounds.x + bounds.width - tr.x)) / tr.x;
    const dy = (y - (bounds.y + tr.y)) / tr.y;
    return dx * dx + dy * dy <= 1;
  }
  // Bottom-right corner
  if (x > bounds.x + bounds.width - br.x && y > bounds.y + bounds.height - br.y) {
    if (br.x <= 0 || br.y <= 0) return true;
    const dx = (x - (bounds.x + bounds.width - br.x)) / br.x;
    const dy = (y - (bounds.y + bounds.height - br.y)) / br.y;
    return dx * dx + dy * dy <= 1;
  }
  // Bottom-left corner
  if (x < bounds.x + bl.x && y > bounds.y + bounds.height - bl.y) {
    if (bl.x <= 0 || bl.y <= 0) return true;
    const dx = (x - (bounds.x + bl.x)) / bl.x;
    const dy = (y - (bounds.y + bounds.height - bl.y)) / bl.y;
    return dx * dx + dy * dy <= 1;
  }
  return true;
}

/** A rectangle is contained when its four vertices lie in the convex domain. */
export function roundedDomainContainsRect(domain: RoundedRectDomain, rect: Rect): boolean {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    || !(rect.width > 0) || !(rect.height > 0)) return false;
  const right = rect.x + rect.width, bottom = rect.y + rect.height;
  return [[rect.x, rect.y], [right, rect.y], [rect.x, bottom], [right, bottom]]
    .every(([x, y]) => pointInRoundedDomain(domain, x!, y!));
}

export function extractRoundedClipDomain(
  borderBox: Rect,
  style: CSSStyleDeclaration,
  scale: AxisScale,
  mode: "clip" | "hidden_or_clip",
): RoundedRectDomain | null {
  if (![scale.x, scale.y].every(value => Number.isFinite(value) && value > 0)) return null;
  if (![borderBox.x, borderBox.y, borderBox.width, borderBox.height].every(Number.isFinite)
    || borderBox.width <= 0 || borderBox.height <= 0) return null;

  const hidden = style.overflowX === "hidden" && style.overflowY === "hidden";
  const unexpandedClip = style.overflowX === "clip" && style.overflowY === "clip"
    && ["0px", "content-box", "content-box 0px"].includes(style.overflowClipMargin);

  if (mode === "clip") {
    if (!unexpandedClip) return null;
  } else {
    if (!hidden && !unexpandedClip) return null;
  }

  const cssWidth = borderBox.width / scale.x, cssHeight = borderBox.height / scale.y;
  if (!Number.isFinite(cssWidth) || !Number.isFinite(cssHeight) || cssWidth <= 0 || cssHeight <= 0) return null;

  const corners = normalizedRadii(style, cssWidth, cssHeight);
  if (corners === null) return null;
  return {
    bounds: { x: borderBox.x, y: borderBox.y, width: borderBox.width, height: borderBox.height },
    radii: corners.map(corner => ({ x: corner.x * scale.x, y: corner.y * scale.y })),
  };
}

export interface AxisLinearGradientStyleFacts {
  readonly backgroundImage?: string;
  readonly backgroundColor?: string;
  readonly backgroundOrigin?: string;
  readonly backgroundSize?: string;
  readonly backgroundPosition?: string;
  readonly backgroundPositionX?: string;
  readonly backgroundPositionY?: string;
  readonly backgroundRepeat?: string;
  readonly backgroundClip?: string;
  readonly backgroundAttachment?: string;
  readonly borderTopWidth?: string;
  readonly borderRightWidth?: string;
  readonly borderBottomWidth?: string;
  readonly borderLeftWidth?: string;
  readonly paddingTop?: string;
  readonly paddingRight?: string;
  readonly paddingBottom?: string;
  readonly paddingLeft?: string;
}

export type AxisLinearGradientDirection = "to-left" | "to-right" | "to-top" | "to-bottom";

export interface AxisLinearGradientStop {
  /** Distance from the gradient-line start in CSS pixels. */
  readonly position: number;
  /** Effective alpha after background-color and group opacity composition. */
  readonly alpha: number;
}

/** A threshold range along the gradient line. Endpoint flags preserve exact 0/1 boundaries. */
export interface AxisGradientRange {
  readonly start: number;
  readonly end: number;
  readonly startInclusive: boolean;
  readonly endInclusive: boolean;
}

export interface AxisLinearGradientDomain {
  readonly axis: "x" | "y";
  readonly direction: AxisLinearGradientDirection;
  readonly box: Rect;
  readonly scale: AxisScale;
  /** Gradient-line length in CSS pixels. */
  readonly length: number;
  readonly stops: readonly AxisLinearGradientStop[];
  /** Range where effective alpha is strictly greater than zero. */
  readonly positive: AxisGradientRange | null;
  /** Range where effective alpha is exactly one. */
  readonly opaque: AxisGradientRange | null;
  /** Viewport rectangle for the positive-alpha range. */
  readonly positiveRect: Rect | null;
  /** Viewport rectangle for the opaque range. */
  readonly opaqueRect: Rect | null;
}

export interface AxisLinearGradientInput {
  readonly style: AxisLinearGradientStyleFacts;
  /** Caller-certified border box in viewport coordinates for a single HTML box. */
  readonly borderBox: Rect;
  readonly scale: AxisScale;
  /** Product of the element's own opacity and all ancestor group opacities. */
  readonly effectiveOpacity: number;
  /** Reuse the caller's CSS color parser instead of duplicating it here. */
  readonly alphaOfColor: (color: string) => number | null;
}

function gradientZeroLength(value: string | undefined): boolean {
  return value !== undefined && /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:px)?$/.test(value.trim());
}

/**
 * Proves the background positioning area equals the caller's border box.
 * A gradient has no intrinsic dimensions, so `auto` resolves to the full
 * positioning area. With zero border/padding, padding-box origin and
 * border-box clip coincide, and `repeat` cannot create a smaller tile.
 */
export function axisLinearGradientPositioningProven(style: AxisLinearGradientStyleFacts): boolean {
  const positionProven = style.backgroundPositionX !== undefined || style.backgroundPositionY !== undefined
    ? style.backgroundPositionX === "0%" && style.backgroundPositionY === "0%"
    : style.backgroundPosition?.trim() === "0% 0%";
  return style.backgroundOrigin?.trim() === "padding-box"
    && style.backgroundSize?.trim() === "auto"
    && style.backgroundRepeat?.trim() === "repeat"
    && style.backgroundClip?.trim() === "border-box"
    && style.backgroundAttachment?.trim() === "scroll"
    && positionProven
    && [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth,
      style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].every(gradientZeroLength);
}

function splitAxisGradientArguments(value: string): string[] | null {
  const result: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth < 0) return null;
    } else if (character === "," && depth === 0) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (depth !== 0) return null;
  result.push(value.slice(start).trim());
  return result;
}

function singleLinearGradientArguments(value: string | undefined): string[] | null {
  const text = (value ?? "").trim();
  if (!text.toLowerCase().startsWith("linear-gradient(") || !text.endsWith(")")) return null;
  const args = splitAxisGradientArguments(text.slice("linear-gradient(".length, -1));
  return args === null || args.length < 3 ? null : args;
}

function axisGradientDirection(value: string): AxisLinearGradientDirection | null {
  const text = value.trim().toLowerCase().replace(/\s+/g, " ");
  switch (text) {
    case "to left": return "to-left";
    case "to right": return "to-right";
    case "to top": return "to-top";
    case "to bottom": return "to-bottom";
    default: return null;
  }
}

interface AxisGradientStopText {
  readonly color: string;
  readonly position: string;
}

function axisGradientStopText(value: string): AxisGradientStopText | null {
  const match = /^(rgba?\([^()]*\))\s+(\S+)$/i.exec(value.trim());
  return match === null ? null : { color: match[1]!, position: match[2]! };
}

function axisGradientStopPosition(value: string, length: number): number | null {
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(px|%)$/i.exec(value);
  if (match === null) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const percent = match[2]!.toLowerCase() === "%";
  if (percent && amount > 100) return null;
  const resolved = percent ? (amount === 100 ? length : (length * amount) / 100) : amount;
  return Number.isFinite(resolved) && resolved >= 0 && resolved <= length ? resolved : null;
}

function composeAxisGradientAlpha(alpha: number, baseAlpha: number, opacity: number): number {
  return Math.min(1, Math.max(0, (baseAlpha + alpha * (1 - baseAlpha)) * opacity));
}

function increasingPositiveRange(
  stops: readonly AxisLinearGradientStop[],
  length: number,
): AxisGradientRange | null {
  const last = stops[stops.length - 1]!;
  if (!(last.alpha > 0)) return null;
  for (let index = 0; index + 1 < stops.length; index++) {
    const current = stops[index]!, next = stops[index + 1]!;
    if (!(current.alpha > 0) && next.alpha > 0) {
      return { start: current.position, end: length, startInclusive: false, endInclusive: true };
    }
  }
  return { start: 0, end: length, startInclusive: true, endInclusive: true };
}

function decreasingPositiveRange(
  stops: readonly AxisLinearGradientStop[],
  length: number,
): AxisGradientRange | null {
  const first = stops[0]!;
  if (!(first.alpha > 0)) return null;
  for (let index = 0; index + 1 < stops.length; index++) {
    const current = stops[index]!, next = stops[index + 1]!;
    if (current.alpha > 0 && !(next.alpha > 0)) {
      return { start: 0, end: next.position, startInclusive: true, endInclusive: false };
    }
  }
  return { start: 0, end: length, startInclusive: true, endInclusive: true };
}

function increasingOpaqueRange(
  stops: readonly AxisLinearGradientStop[],
  length: number,
): AxisGradientRange | null {
  if (stops[stops.length - 1]!.alpha < 1) return null;
  for (let index = 0; index + 1 < stops.length; index++) {
    const current = stops[index]!, next = stops[index + 1]!;
    if (current.alpha < 1 && next.alpha === 1) {
      return { start: next.position, end: length, startInclusive: true, endInclusive: true };
    }
  }
  return { start: 0, end: length, startInclusive: true, endInclusive: true };
}

function decreasingOpaqueRange(
  stops: readonly AxisLinearGradientStop[],
  length: number,
): AxisGradientRange | null {
  if (stops[0]!.alpha < 1) return null;
  for (let index = 0; index + 1 < stops.length; index++) {
    const current = stops[index]!, next = stops[index + 1]!;
    if (current.alpha === 1 && next.alpha < 1) {
      return { start: 0, end: current.position, startInclusive: true, endInclusive: true };
    }
  }
  return { start: 0, end: length, startInclusive: true, endInclusive: true };
}

function axisGradientRangeRect(
  axis: "x" | "y",
  direction: AxisLinearGradientDirection,
  box: Rect,
  scale: AxisScale,
  range: AxisGradientRange | null,
): Rect | null {
  if (range === null) return null;
  const span = range.end - range.start;
  const factor = axis === "x" ? scale.x : scale.y;
  const extent = span * factor;
  if (!(span > 0) || !Number.isFinite(extent) || !(extent > 0)) return null;
  if (axis === "x") {
    const start = direction === "to-right" ? box.x + range.start * factor : box.x + box.width - range.end * factor;
    return { x: start, y: box.y, width: extent, height: box.height };
  }
  const start = direction === "to-bottom" ? box.y + range.start * factor : box.y + box.height - range.end * factor;
  return { x: box.x, y: start, width: box.width, height: extent };
}

function axisGradientRangeContains(range: AxisGradientRange, value: number): boolean {
  if (range.start === range.end) {
    return range.startInclusive && range.endInclusive && value === range.start;
  }
  const afterStart = value > range.start || (range.startInclusive && value === range.start);
  const beforeEnd = value < range.end || (range.endInclusive && value === range.end);
  return afterStart && beforeEnd;
}

function axisGradientCoordinate(domain: AxisLinearGradientDomain, x: number, y: number): number | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const { box, scale } = domain;
  if (x < box.x || x > box.x + box.width || y < box.y || y > box.y + box.height) return null;
  const coordinate = domain.axis === "x"
    ? (domain.direction === "to-right" ? (x - box.x) / scale.x : (box.x + box.width - x) / scale.x)
    : (domain.direction === "to-bottom" ? (y - box.y) / scale.y : (box.y + box.height - y) / scale.y);
  return Math.min(domain.length, Math.max(0, coordinate));
}

function axisGradientAlphaAtCoordinate(domain: AxisLinearGradientDomain, coordinate: number): number {
  const stops = domain.stops;
  const first = stops[0]!, last = stops[stops.length - 1]!;
  if (coordinate <= first.position) return first.alpha;
  if (coordinate >= last.position) return last.alpha;
  for (let index = 0; index + 1 < stops.length; index++) {
    const current = stops[index]!, next = stops[index + 1]!;
    if (coordinate === current.position) return current.alpha;
    if (coordinate < next.position) {
      const ratio = (coordinate - current.position) / (next.position - current.position);
      return current.alpha + (next.alpha - current.alpha) * ratio;
    }
    if (coordinate === next.position) return next.alpha;
  }
  return last.alpha;
}

/**
 * Bounded single-layer axis linear-gradient model. The caller must already
 * prove a single HTML box with a known positive axis mapping and no other own
 * paint. Unsupported syntax, positioning, geometry, or non-monotone alpha
 * profiles return null.
 */
export function axisLinearGradientDomain(input: AxisLinearGradientInput): AxisLinearGradientDomain | null {
  const { style, borderBox, scale, effectiveOpacity, alphaOfColor } = input;
  if (![borderBox.x, borderBox.y, borderBox.width, borderBox.height].every(Number.isFinite)
    || !(borderBox.width > 0) || !(borderBox.height > 0)) return null;
  if (![scale.x, scale.y].every(value => Number.isFinite(value) && value > 0)) return null;
  if (!Number.isFinite(effectiveOpacity) || effectiveOpacity < 0 || effectiveOpacity > 1) return null;
  if (!axisLinearGradientPositioningProven(style)) return null;

  const args = singleLinearGradientArguments(style.backgroundImage);
  if (args === null) return null;
  const direction = axisGradientDirection(args[0]!);
  if (direction === null) return null;
  const axis = direction === "to-left" || direction === "to-right" ? "x" : "y";
  const cssWidth = borderBox.width / scale.x;
  const cssHeight = borderBox.height / scale.y;
  if (!Number.isFinite(cssWidth) || !Number.isFinite(cssHeight) || !(cssWidth > 0) || !(cssHeight > 0)) return null;
  const length = axis === "x" ? cssWidth : cssHeight;

  const backgroundColor = style.backgroundColor;
  if (backgroundColor === undefined || backgroundColor.trim() === "") return null;
  const baseAlpha = alphaOfColor(backgroundColor);
  if (baseAlpha === null || !Number.isFinite(baseAlpha) || baseAlpha < 0 || baseAlpha > 1) return null;

  const stops: AxisLinearGradientStop[] = [];
  for (const arg of args.slice(1)) {
    const text = axisGradientStopText(arg);
    if (text === null) return null;
    const position = axisGradientStopPosition(text.position, length);
    if (position === null) return null;
    const alpha = alphaOfColor(text.color);
    if (alpha === null || !Number.isFinite(alpha) || alpha < 0 || alpha > 1) return null;
    const previous = stops[stops.length - 1];
    if (previous !== undefined && !(position > previous.position)) return null;
    stops.push({ position, alpha: composeAxisGradientAlpha(alpha, baseAlpha, effectiveOpacity) });
  }
  if (stops.length < 2) return null;

  const nonIncreasing = stops.every((stop, index) => index === 0 || stop.alpha <= stops[index - 1]!.alpha);
  const nonDecreasing = stops.every((stop, index) => index === 0 || stop.alpha >= stops[index - 1]!.alpha);
  if (!nonIncreasing && !nonDecreasing) return null;
  const increasing = nonDecreasing && !nonIncreasing;
  const positive = increasing ? increasingPositiveRange(stops, length) : decreasingPositiveRange(stops, length);
  const opaque = increasing ? increasingOpaqueRange(stops, length) : decreasingOpaqueRange(stops, length);
  return {
    axis,
    direction,
    box: borderBox,
    scale,
    length,
    stops,
    positive,
    opaque,
    positiveRect: axisGradientRangeRect(axis, direction, borderBox, scale, positive),
    opaqueRect: axisGradientRangeRect(axis, direction, borderBox, scale, opaque),
  };
}

/** Exact effective alpha at a viewport point, or null outside the gradient box. */
export function axisLinearGradientAlphaAt(
  domain: AxisLinearGradientDomain,
  x: number,
  y: number,
): number | null {
  const coordinate = axisGradientCoordinate(domain, x, y);
  return coordinate === null ? null : axisGradientAlphaAtCoordinate(domain, coordinate);
}

/**
 * Point predicate derived from the same ranges as the rectangles.
 * Receiving surfaces use alpha > 0; pointer-events:none uses alpha === 1.
 */
export function axisLinearGradientPaintsAt(
  domain: AxisLinearGradientDomain,
  x: number,
  y: number,
  pointerPassThrough: boolean,
): boolean {
  const coordinate = axisGradientCoordinate(domain, x, y);
  if (coordinate === null) return false;
  const range = pointerPassThrough ? domain.opaque : domain.positive;
  return range !== null && axisGradientRangeContains(range, coordinate);
}

/** Rectangle selector matching the pointer policy used by the point predicate. */
export function axisLinearGradientPaintRect(
  domain: AxisLinearGradientDomain,
  pointerPassThrough: boolean,
): Rect | null {
  return pointerPassThrough ? domain.opaqueRect : domain.positiveRect;
}

