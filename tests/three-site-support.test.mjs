import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BASIC_KIND_WIRE_NAMES,
  DEFAULT_BASIC_KIND_CONFIG,
  DEFAULT_BASIC_KIND_PROFILE,
  LEGACY_BASIC_KIND_PROFILE,
  basicKindLeafSupportGate,
  classifyBasicKind,
  extractBasicKindWires,
  migrateBasicKindProfile,
} from "../dist/filters/basic-kinds.js";

const measured = {
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
  withinControlAncestor: null,
  inSvgAncestor: false,
  disabled: false,
  hidden: false,
};

const newAddresses = [
  ["familyWeights", "structure", "neutral_inherited_pointer_wrapper"],
  ["leafWeights", "ignore", "neutral_inherited_pointer_wrapper"],
  ["leafWeights", "container", "neutral_inherited_pointer_wrapper"],
  ["familyWeights", "structure", "neutral_single_element_wrapper"],
  ["leafWeights", "ignore", "neutral_single_element_wrapper"],
  ["leafWeights", "container", "neutral_single_element_wrapper"],
  ["familyWeights", "structure", "noninteractive_hidden_leaf"],
  ["leafWeights", "ignore", "noninteractive_hidden_leaf"],
  ["familyWeights", "structure", "search_region_group"],
  ["leafWeights", "container", "search_region_group"],
];

function profileFor(...assignments) {
  const profile = structuredClone(migrateBasicKindProfile(DEFAULT_BASIC_KIND_PROFILE));
  for (const group of ["familyWeights", "leafWeights"]) {
    for (const weights of Object.values(profile[group])) {
      for (const wire of Object.keys(weights)) weights[wire] = 0;
    }
  }
  for (const [group, target, wire] of assignments) profile[group][target][wire] = 1;
  profile.id = `three-site-support-${assignments.map(([, target, wire]) => `${target}-${wire}`).join("-")}`;
  return profile;
}

const classify = (properties, profile) => classifyBasicKind({ role: null, ...measured, ...properties }, DEFAULT_BASIC_KIND_CONFIG, profile);

test("four composite wires open only their measured support groups", () => {
  const inheritedWrapper = { tag: "span", childElementCount: 3, positiveAreaChildCount: 3, pointerCursor: true, parentPointerCursor: true };
  const singleElementWrapper = { tag: "div", childElementCount: 1, positiveAreaChildCount: 0, descendantTextPresent: true };
  const hiddenLeaf = { tag: "object", hidden: true };
  const searchRegion = { tag: "div", role: "search", childElementCount: 3, positiveAreaChildCount: 3, descendantTextPresent: true };

  const cases = [
    ["neutral_inherited_pointer_wrapper", inheritedWrapper, "ignore", [["familyWeights", "structure"], ["leafWeights", "ignore"]]],
    ["neutral_single_element_wrapper", singleElementWrapper, "ignore", [["familyWeights", "structure"], ["leafWeights", "ignore"]]],
    ["noninteractive_hidden_leaf", hiddenLeaf, "ignore", [["familyWeights", "structure"], ["leafWeights", "ignore"]]],
    ["search_region_group", searchRegion, "container", [["familyWeights", "structure"], ["leafWeights", "container"]]],
  ];

  for (const [wire, properties, expected, addresses] of cases) {
    const wires = extractBasicKindWires({ role: null, ...measured, ...properties });
    assert.equal(wires[wire], 1, wire);
    assert.equal(basicKindLeafSupportGate(wires, expected), 1, wire);
    const profile = profileFor(...addresses.map(([group, target]) => [group, target, wire]));
    const result = classify(properties, profile);
    assert.equal(result.basicKind, expected, wire);
    assert.equal(result.judgmentStatus, "judged", wire);
    assert.equal(result.evidence.wires[wire], 1, wire);
  }
});

test("wrapper support rejects own content, own pointer boundaries, and native targets", () => {
  const inherited = { tag: "span", childElementCount: 2, positiveAreaChildCount: 2, pointerCursor: true, parentPointerCursor: true };
  const single = { tag: "div", childElementCount: 1, positiveAreaChildCount: 0 };
  const inheritedWires = extractBasicKindWires({
    role: null,
    ...measured,
    ...inherited,
    nonFormatDirectTextPresent: true,
    directTextPresent: true,
  });
  const imageWires = extractBasicKindWires({
    role: null,
    ...measured,
    ...single,
    backgroundImagePresent: true,
  });
  const ownPointerWires = extractBasicKindWires({
    role: null,
    ...measured,
    ...inherited,
    parentPointerCursor: false,
  });

  assert.equal(inheritedWires.neutral_inherited_pointer_wrapper, 0);
  assert.equal(imageWires.neutral_single_element_wrapper, 0);
  assert.equal(ownPointerWires.neutral_inherited_pointer_wrapper, 0);
  assert.equal(ownPointerWires.own_pointer_boundary, 1);
  assert.notEqual(classify({ ...inherited, directTextPresent: true, nonFormatDirectTextPresent: true }, profileFor(
    ["familyWeights", "structure", "neutral_inherited_pointer_wrapper"],
    ["leafWeights", "ignore", "neutral_inherited_pointer_wrapper"],
  )).basicKind, "ignore");

  for (const tag of ["button", "img", "article"]) {
    const wires = extractBasicKindWires({ role: null, ...measured, tag, childElementCount: 1, positiveAreaChildCount: 0 });
    assert.equal(wires.neutral_single_element_wrapper, 0, tag);
  }
  const nativeButton = extractBasicKindWires({ role: null, ...measured, tag: "button", hidden: true });
  const anchor = extractBasicKindWires({ role: null, ...measured, tag: "a", hidden: true });
  const nativeImage = extractBasicKindWires({ role: null, ...measured, tag: "img", hidden: true });
  assert.equal(nativeButton.noninteractive_hidden_leaf, 0);
  assert.equal(anchor.noninteractive_hidden_leaf, 0);
  assert.equal(nativeImage.noninteractive_hidden_leaf, 1);
});

test("missing operands stay null, state alone cannot activate, and migration adds zero addresses", () => {
  const allNull = extractBasicKindWires({
    tag: "span",
    role: null,
    contentEditable: null,
    nonFormatDirectTextPresent: null,
    beforeContentPresent: null,
    afterContentPresent: null,
    backgroundImagePresent: null,
    maskImagePresent: null,
    childElementCount: null,
    positiveAreaChildCount: null,
    pointerCursor: null,
    parentPointerCursor: null,
    tabIndexFocus: null,
    hidden: null,
  });
  assert.equal(allNull.neutral_inherited_pointer_wrapper, null);
  assert.equal(allNull.neutral_single_element_wrapper, null);
  assert.equal(allNull.noninteractive_hidden_leaf, null);
  assert.equal(allNull.search_region_group, 0);

  const missingWrapper = { tag: "div", childElementCount: null, positiveAreaChildCount: null, pointerCursor: false };
  const missingProfile = profileFor(
    ["familyWeights", "structure", "neutral_single_element_wrapper"],
    ["leafWeights", "ignore", "neutral_single_element_wrapper"],
  );
  const missing = classify(missingWrapper, missingProfile);
  assert.equal(missing.evidence.wires.neutral_single_element_wrapper, null);
  assert.equal(missing.basicKind, "other");
  assert.equal(missing.familyStatus, "unknown");

  const stateOnly = classifyBasicKind(
    { tag: "object", role: null, hidden: true },
    DEFAULT_BASIC_KIND_CONFIG,
    profileFor(
      ["familyWeights", "structure", "noninteractive_hidden_leaf"],
      ["leafWeights", "ignore", "noninteractive_hidden_leaf"],
    ),
  );
  assert.equal(stateOnly.evidence.wires.noninteractive_hidden_leaf, null);
  assert.notEqual(stateOnly.basicKind, "ignore");

  for (const name of [
    "neutral_inherited_pointer_wrapper",
    "neutral_single_element_wrapper",
    "noninteractive_hidden_leaf",
    "search_region_group",
  ]) {
    assert.ok(BASIC_KIND_WIRE_NAMES.includes(name), name);
  }
  for (const profile of [LEGACY_BASIC_KIND_PROFILE, DEFAULT_BASIC_KIND_PROFILE]) {
    const migrated = migrateBasicKindProfile(profile);
    for (const [group, target, wire] of newAddresses) {
      assert.equal(migrated[group][target][wire], 0, `${profile.id}:${group}.${target}.${wire}`);
    }
  }
});
