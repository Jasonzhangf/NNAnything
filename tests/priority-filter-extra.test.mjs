import assert from "node:assert/strict";
import { test } from "node:test";
import * as browser from "../dist/browser-classify.js";

const properties = (fields = {}) => ({
  tag: "span",
  role: null,
  inputType: null,
  hrefPresent: false,
  contentEditable: false,
  directTextPresent: false,
  nonFormatDirectTextPresent: false,
  beforeContentPresent: false,
  afterContentPresent: false,
  backgroundImagePresent: false,
  maskImagePresent: false,
  childElementCount: 0,
  positiveAreaChildCount: 0,
  repeatedChildGeometry: false,
  inVerifiedListParent: false,
  svgGraphicChildren: false,
  pointerCursor: false,
  parentPointerCursor: false,
  tabIndexFocus: false,
  borderPresent: false,
  aspectRatio: 1,
  descendantTextPresent: false,
  directListChildPresent: false,
  singleChildTag: null,
  singleChildSameRect: false,
  withinControlAncestor: false,
  inSvgAncestor: false,
  disabled: false,
  hidden: false,
  ...fields,
});

function priorityProfile() {
  return {
    ...structuredClone(browser.PRIORITY_BASIC_KIND_INITIAL_PROFILE),
    id: "priority-css-glyph-extra",
  };
}

test("registered CSS glyph image supports stay eligible without a tag shortcut", () => {
  for (const [wire, measurement] of [
    ["css_before_content", "beforeContentPresent"],
    ["css_after_content", "afterContentPresent"],
  ]) {
    const profile = priorityProfile();
    profile.familyWeights.media[wire] = 0.7;
    profile.leafWeights.image[wire] = 0.7;
    const result = browser.classifyBasicKind(
      properties({ [measurement]: true }),
      browser.DEFAULT_BASIC_KIND_CONFIG,
      profile,
    );
    assert.equal(result.basicKind, "image", wire);
    assert.equal(result.judgmentStatus, "judged", wire);
    assert.equal(result.evidence.wires[wire], 1, wire);
  }
});
