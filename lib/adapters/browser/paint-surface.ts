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
    bounds: { ...borderBox },
    radii: corners.map(corner => ({ x: corner.x * scale.x, y: corner.y * scale.y })),
  };
}

