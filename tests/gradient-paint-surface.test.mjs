import assert from "node:assert/strict";
import { test } from "node:test";

import {
  axisLinearGradientAlphaAt,
  axisLinearGradientDomain,
  axisLinearGradientPaintRect,
  axisLinearGradientPaintsAt,
  axisLinearGradientPositioningProven,
} from "../dist/adapters/browser/paint-surface.js";

// Test-only alpha grammar. Product code must pass the existing parseCssAlpha callback.
const simpleAlpha = (color) => {
  const text = color.trim().toLowerCase();
  if (text === "transparent" || text === "none") return 0;
  const match = /^rgba?\(([^)]+)\)$/.exec(text);
  if (match === null) return null;
  const parts = match[1].replace(/\//g, " ").split(/[\s,]+/).filter(Boolean);
  if (parts.length === 3) return 1;
  if (parts.length !== 4) return null;
  const raw = parts[3];
  const value = raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
};

const defaultStyle = (overrides = {}) => ({
  backgroundImage:
    "linear-gradient(to left, rgb(255, 255, 255) 0px, rgb(255, 255, 255) 56px, rgba(255, 255, 255, 0) 100%)",
  backgroundColor: "rgba(0, 0, 0, 0)",
  backgroundOrigin: "padding-box",
  backgroundSize: "auto",
  backgroundPosition: "0% 0%",
  backgroundPositionX: "0%",
  backgroundPositionY: "0%",
  backgroundRepeat: "repeat",
  backgroundClip: "border-box",
  backgroundAttachment: "scroll",
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  paddingTop: "0px",
  paddingRight: "0px",
  paddingBottom: "0px",
  paddingLeft: "0px",
  ...overrides,
});

const build = ({ style, box = { x: 0, y: 0, width: 100, height: 10 }, scale = { x: 1, y: 1 }, opacity = 1 } = {}) =>
  axisLinearGradientDomain({
    style: defaultStyle(style),
    borderBox: box,
    scale,
    effectiveOpacity: opacity,
    alphaOfColor: simpleAlpha,
  });

// The painter box and target strip come from the accepted ZH gradient facts.
const RAMP_PAINTER_BOX = { x: 752.5, y: 485.609375, width: 74, height: 49 };
const RAMP_TARGET = { x: 759.5625, y: 502.609375, width: 8.796875, height: 17 };
const SPLIT_PAINTER_BOX = { x: 752.5, y: 60.5, width: 74, height: 49 };
const SPLIT_TARGET = { x: 757.5625, y: 60.5, width: 48.796875, height: 1.5 };

test("347-style ramp: receiving surfaces block, pointer-none surfaces do not", () => {
  const domain = build({ box: RAMP_PAINTER_BOX });
  assert.ok(domain);
  assert.deepEqual(domain.positiveRect, RAMP_PAINTER_BOX);
  assert.deepEqual(domain.opaqueRect, { x: 770.5, y: 485.609375, width: 56, height: 49 });

  const left = axisLinearGradientAlphaAt(domain, RAMP_TARGET.x, RAMP_TARGET.y);
  const right = axisLinearGradientAlphaAt(domain, RAMP_TARGET.x + RAMP_TARGET.width, RAMP_TARGET.y);
  // Test-only tolerance for floating interpolation; the domain thresholds stay exact.
  assert.ok(Math.abs(left - (RAMP_TARGET.x - RAMP_PAINTER_BOX.x) / 18) < 1e-12, String(left));
  assert.ok(Math.abs(right - (RAMP_TARGET.x + RAMP_TARGET.width - RAMP_PAINTER_BOX.x) / 18) < 1e-12, String(right));

  for (const x of [RAMP_TARGET.x, RAMP_TARGET.x + RAMP_TARGET.width / 2, RAMP_TARGET.x + RAMP_TARGET.width]) {
    const y = RAMP_TARGET.y + RAMP_TARGET.height / 2;
    assert.equal(axisLinearGradientPaintsAt(domain, x, y, false), true, `auto ${x}`);
    assert.equal(axisLinearGradientPaintsAt(domain, x, y, true), false, `none ${x}`);
  }
  assert.deepEqual(axisLinearGradientPaintRect(domain, false), RAMP_PAINTER_BOX);
  assert.deepEqual(axisLinearGradientPaintRect(domain, true), { x: 770.5, y: 485.609375, width: 56, height: 49 });
});

test("235-style split: pointer-none subtracts only the opaque band", () => {
  const domain = build({ box: SPLIT_PAINTER_BOX });
  assert.ok(domain);
  const opaque = axisLinearGradientPaintRect(domain, true);
  assert.deepEqual(opaque, { x: 770.5, y: 60.5, width: 56, height: 49 });
  const overlap = Math.min(SPLIT_TARGET.x + SPLIT_TARGET.width, opaque.x + opaque.width)
    - Math.max(SPLIT_TARGET.x, opaque.x);
  assert.equal(overlap, 35.859375);
  assert.equal(SPLIT_TARGET.width - overlap, 12.9375);

  // Exact zero at the 100% stop stays out of both policies.
  assert.equal(axisLinearGradientPaintsAt(domain, 752.5, 65, false), false);
  assert.equal(axisLinearGradientPaintsAt(domain, 752.5, 65, true), false);
  // Exact one at the 56px stop is included only by the opaque policy.
  assert.equal(axisLinearGradientPaintsAt(domain, 770.5, 65, false), true);
  assert.equal(axisLinearGradientPaintsAt(domain, 770.5, 65, true), true);
  // A point inside the ramp paints but is not fully opaque.
  assert.equal(axisLinearGradientPaintsAt(domain, 770.4375, 65, false), true);
  assert.equal(axisLinearGradientPaintsAt(domain, 770.4375, 65, true), false);
});

test("reverse axis and a different length use the same generic model", () => {
  const horizontal = build({
    style: {
      backgroundImage:
        "linear-gradient(to right, rgba(10, 20, 30, 0) 0%, rgba(10, 20, 30, 0.5) 25%, rgb(10, 20, 30) 100%)",
    },
    box: { x: 100, y: 200, width: 160, height: 40 },
  });
  assert.ok(horizontal);
  assert.equal(horizontal.axis, "x");
  assert.equal(horizontal.direction, "to-right");
  assert.deepEqual(horizontal.positiveRect, { x: 100, y: 200, width: 160, height: 40 });
  assert.equal(horizontal.opaqueRect, null);
  assert.equal(axisLinearGradientPaintsAt(horizontal, 100, 210, false), false);
  assert.equal(axisLinearGradientPaintsAt(horizontal, 100.0625, 210, false), true);
  assert.equal(axisLinearGradientPaintsAt(horizontal, 260, 210, true), true);
  assert.equal(axisLinearGradientPaintsAt(horizontal, 259.9375, 210, true), false);

  const vertical = build({
    style: { backgroundImage: "linear-gradient(to bottom, rgb(0, 0, 0) 0px, rgba(0, 0, 0, 0) 40px)" },
    box: { x: 0, y: 0, width: 20, height: 80 },
  });
  assert.ok(vertical);
  assert.equal(vertical.axis, "y");
  assert.deepEqual(vertical.positiveRect, { x: 0, y: 0, width: 20, height: 40 });
  assert.equal(vertical.opaqueRect, null);
  assert.equal(axisLinearGradientPaintsAt(vertical, 10, 0, true), true);
  assert.equal(axisLinearGradientPaintsAt(vertical, 10, 40, false), false);
  assert.equal(axisLinearGradientPaintsAt(vertical, 10, 79, false), false);
});

test("effective alpha is exact at the zero and one thresholds", () => {
  const domain = build({
    style: { backgroundImage: "linear-gradient(to right, rgb(0, 0, 0) 0px, rgba(0, 0, 0, 0) 100px)" },
    box: { x: 10, y: 20, width: 100, height: 10 },
  });
  assert.ok(domain);
  assert.equal(axisLinearGradientAlphaAt(domain, 10, 25), 1);
  assert.equal(axisLinearGradientAlphaAt(domain, 110, 25), 0);
  assert.equal(axisLinearGradientPaintsAt(domain, 10, 25, true), true);
  assert.equal(axisLinearGradientPaintsAt(domain, 110, 25, true), false);
  assert.equal(axisLinearGradientPaintsAt(domain, 10, 25, false), true);
  assert.equal(axisLinearGradientPaintsAt(domain, 110, 25, false), false);
  assert.deepEqual(domain.positiveRect, { x: 10, y: 20, width: 100, height: 10 });
  assert.equal(domain.opaqueRect, null);
  assert.deepEqual(domain.opaque, { start: 0, end: 0, startInclusive: true, endInclusive: true });
});

test("gradient alpha composes with background alpha and effective opacity", () => {
  const domain = build({
    style: {
      backgroundImage: "linear-gradient(to right, rgb(0, 0, 0) 0%, rgba(0, 0, 0, 0) 100%)",
      backgroundColor: "rgba(0, 0, 0, 0.5)",
    },
    box: { x: 0, y: 0, width: 100, height: 10 },
    opacity: 0.5,
  });
  assert.ok(domain);
  assert.equal(axisLinearGradientAlphaAt(domain, 0, 5), 0.5);
  assert.equal(axisLinearGradientAlphaAt(domain, 100, 5), 0.25);
  const middle = axisLinearGradientAlphaAt(domain, 50, 5);
  assert.ok(middle > 0.25 && middle < 0.5, String(middle));
  assert.deepEqual(domain.positiveRect, { x: 0, y: 0, width: 100, height: 10 });
  assert.equal(domain.opaqueRect, null);
  assert.equal(axisLinearGradientPaintsAt(domain, 50, 5, true), false);
  assert.equal(axisLinearGradientPaintsAt(domain, 50, 5, false), true);
});

test("positive scale maps CSS stops into viewport coordinates", () => {
  const domain = build({ box: { x: 10, y: 20, width: 200, height: 20 }, scale: { x: 2, y: 1 } });
  assert.ok(domain);
  assert.deepEqual(domain.opaqueRect, { x: 98, y: 20, width: 112, height: 20 });
  assert.equal(axisLinearGradientPaintsAt(domain, 210, 30, true), true);
  assert.equal(axisLinearGradientPaintsAt(domain, 210, 30, false), true);
  assert.equal(axisLinearGradientPaintsAt(domain, 10, 30, false), false);
});

test("default positioning proof requires every captured fact", () => {
  assert.equal(axisLinearGradientPositioningProven(defaultStyle()), true);
  const broken = [
    ["origin", { backgroundOrigin: "content-box" }],
    ["size", { backgroundSize: "50% auto" }],
    ["position", { backgroundPosition: "10% 0%", backgroundPositionX: "10%", backgroundPositionY: "0%" }],
    ["repeat", { backgroundRepeat: "no-repeat" }],
    ["clip", { backgroundClip: "content-box" }],
    ["attachment", { backgroundAttachment: "fixed" }],
    ["border", { borderLeftWidth: "1px" }],
    ["padding", { paddingBottom: "1px" }],
    ["missing attachment", { backgroundAttachment: undefined }],
    ["missing position", { backgroundPosition: undefined, backgroundPositionX: undefined, backgroundPositionY: undefined }],
  ];
  for (const [label, overrides] of broken) {
    assert.equal(axisLinearGradientPositioningProven(defaultStyle(overrides)), false, label);
  }
});

test("unsupported gradients, positioning, and geometry stay null", () => {
  const box = { x: 0, y: 0, width: 100, height: 10 };
  const unsupported = [
    ["missing image", { backgroundImage: undefined }],
    ["none image", { backgroundImage: "none" }],
    ["two layers", { backgroundImage: "linear-gradient(to right, rgb(0,0,0) 0%, rgba(0,0,0,0) 100%), linear-gradient(to right, rgb(0,0,0) 0%, rgba(0,0,0,0) 100%)" }],
    ["diagonal", { backgroundImage: "linear-gradient(to top left, rgb(0,0,0) 0%, rgba(0,0,0,0) 100%)" }],
    ["angle", { backgroundImage: "linear-gradient(90deg, rgb(0,0,0) 0%, rgba(0,0,0,0) 100%)" }],
    ["no direction", { backgroundImage: "linear-gradient(rgb(0,0,0) 0%, rgba(0,0,0,0) 100%)" }],
    ["missing stop position", { backgroundImage: "linear-gradient(to right, rgb(0,0,0), rgba(0,0,0,0) 100%)" }],
    ["duplicate stop position", { backgroundImage: "linear-gradient(to right, rgb(0,0,0) 50%, rgba(0,0,0,0) 50%)" }],
    ["bad unit", { backgroundImage: "linear-gradient(to right, rgb(0,0,0) 0em, rgba(0,0,0,0) 100%)" }],
    ["outside line", { backgroundImage: "linear-gradient(to right, rgb(0,0,0) 0%, rgba(0,0,0,0) 101%)" }],
    ["non-monotone alpha", { backgroundImage: "linear-gradient(to right, rgb(0,0,0) 0%, rgba(0,0,0,0) 50%, rgb(0,0,0) 100%)" }],
    ["missing color", { backgroundColor: undefined }],
    ["missing origin", { backgroundOrigin: undefined }],
    ["missing size", { backgroundSize: undefined }],
    ["missing repeat", { backgroundRepeat: undefined }],
    ["missing clip", { backgroundClip: undefined }],
  ];
  for (const [label, overrides] of unsupported) {
    assert.equal(build({ style: overrides, box }), null, label);
  }
  assert.equal(build({ box: { x: 0, y: 0, width: 0, height: 10 } }), null, "zero width");
  assert.equal(build({ box: { x: 0, y: 0, width: 100, height: Number.NaN } }), null, "nan height");
  assert.equal(build({ box, scale: { x: 0, y: 1 } }), null, "zero scale");
  assert.equal(build({ box, opacity: Number.NaN }), null, "nan opacity");
  assert.equal(build({ box, opacity: 1.5 }), null, "opacity above one");
});
