import assert from "node:assert/strict";
import { test } from "node:test";

const classifier = await import(process.env.NNANYTHING_CLASSIFIER_DIST ?? "../dist/browser-classify.js");
const {
  DEFAULT_BASIC_KIND_CONFIG,
  classifyBasicKind,
  extractBasicKindWires,
  PRIORITY_BASIC_KIND_INITIAL_PROFILE,
} = classifier;

async function directXhs249Properties() {
  // Synthetic public fixture for an empty presentation leaf under a link.
  // Real site evidence and fitted profiles remain local experiment artifacts.
  return {
    tag: "i", role: null, inputType: null, hrefPresent: false, contentEditable: false,
    directTextPresent: false, nonFormatDirectTextPresent: false,
    beforeContentPresent: false, afterContentPresent: false,
    backgroundImagePresent: false, maskImagePresent: false,
    childElementCount: 0, positiveAreaChildCount: 0, repeatedChildGeometry: false,
    inVerifiedListParent: false, svgGraphicChildren: false,
    pointerCursor: true, parentPointerCursor: true, tabIndexFocus: false,
    borderPresent: false, aspectRatio: 1, descendantTextPresent: false,
    directListChildPresent: false, singleChildTag: null, singleChildSameRect: false,
    withinControlAncestor: true, inSvgAncestor: false, ownLabelPresent: false,
    disabled: false, hidden: false, shallowStructuralPeerRatio: 0,
    coincidentChildPairRatio: 0, graphicDescendantPresent: false,
  };
}

async function candidateProfile() {
  const profile = structuredClone(PRIORITY_BASIC_KIND_INITIAL_PROFILE);
  for (const group of ["familyWeights", "leafWeights"]) {
    for (const weights of Object.values(profile[group])) {
      for (const wire of Object.keys(weights)) weights[wire] = 0;
    }
  }
  profile.familyWeights.structure.neutral_presentation_leaf = 0.8;
  profile.leafWeights.ignore.neutral_presentation_leaf = 0.8;
  return profile;
}

test("empty i presentation wires reach the configured ignore score through the public classifier", async () => {
  const properties = await directXhs249Properties();
  const profile = await candidateProfile();
  const wires = extractBasicKindWires(properties);
  const result = classifyBasicKind(properties, DEFAULT_BASIC_KIND_CONFIG, profile);

  assert.equal(properties.tag, "i");
  assert.equal(properties.role, null);
  assert.equal(properties.contentEditable, false);
  assert.equal(wires.neutral_presentation_leaf, 1);
  assert.equal(wires.empty_pointer_extent, 1);
  assert.equal(wires.empty_border_extent, 0);
  assert.equal(result.family, "structure");
  assert.equal(result.basicKind, "ignore");
  assert.equal(result.judgmentStatus, "judged");
  assert.equal(result.evidence.wires.neutral_presentation_leaf, 1);
  assert.equal(result.evidence.wires.empty_pointer_extent, 1);
  assert.ok(result.familyScores.structure.min >= DEFAULT_BASIC_KIND_CONFIG.minScore);
  assert.ok(result.leafScores.ignore.min >= DEFAULT_BASIC_KIND_CONFIG.minScore);
  assert.equal(result.evidence.path.at(-1).stage, "redundant_ignore");
});

test("empty presentation i keeps missing facts null and rejects content-bearing counterexamples", async () => {
  const observed = await directXhs249Properties();
  const wire = overrides => extractBasicKindWires({ ...observed, ...overrides }).neutral_presentation_leaf;
  const nonPresentation = [
    ["role", { role: "presentation" }],
    ["editable", { contentEditable: true }],
    ["text", { directTextPresent: true, nonFormatDirectTextPresent: true }],
    ["descendant text", { descendantTextPresent: true }],
    ["child", { childElementCount: 1, positiveAreaChildCount: 1 }],
    ["focus", { tabIndexFocus: true }],
    ["own pointer", { parentPointerCursor: false }],
    ["before pseudo", { beforeContentPresent: true }],
    ["after pseudo", { afterContentPresent: true }],
    ["background image", { backgroundImagePresent: true }],
    ["mask image", { maskImagePresent: true }],
  ];

  for (const [name, overrides] of nonPresentation) assert.equal(wire(overrides), 0, name);
  const formatOnly = extractBasicKindWires({
    ...observed,
    directTextPresent: true,
    nonFormatDirectTextPresent: false,
  });
  assert.equal(formatOnly.neutral_presentation_leaf, 1);
  assert.equal(formatOnly.empty_pointer_extent, 0);
  for (const [name, overrides] of [
    ["contentEditable", { contentEditable: null }],
    ["direct text", { directTextPresent: null, nonFormatDirectTextPresent: null }],
    ["positive area children", { positiveAreaChildCount: null }],
    ["descendant text", { descendantTextPresent: null }],
    ["focus", { tabIndexFocus: null }],
    ["before pseudo", { beforeContentPresent: null }],
    ["background image", { backgroundImagePresent: null }],
  ]) assert.equal(wire(overrides), null, name);
  assert.equal(extractBasicKindWires({ ...observed, childElementCount: null }).empty_pointer_extent, null);
});

test("empty i extension does not widen structural, focus, or multi-child wires", async () => {
  const observed = await directXhs249Properties();
  const wires = extractBasicKindWires({
    ...observed,
    childElementCount: 2,
    positiveAreaChildCount: 2,
    descendantTextPresent: true,
    tabIndexFocus: true,
  });

  assert.equal(wires.neutral_multi_child, 0);
  assert.equal(wires.neutral_focusable_control, 0);
  assert.equal(wires.neutral_same_rect_wrapper, 0);
  assert.equal(wires.neutral_single_positive_wrapper, 0);
});
