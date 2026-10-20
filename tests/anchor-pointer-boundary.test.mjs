import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BASIC_KIND_FAMILIES,
  BASIC_KIND_WIRE_NAMES,
  DEFAULT_BASIC_KIND_CONFIG,
  DEFAULT_BASIC_KIND_PROFILE,
  PRIORITY_BASIC_KIND_INITIAL_PROFILE,
  basicKindFamilySupportGate,
  basicKindLeafSupportGate,
  classifyBasicKind,
  extractBasicKindWires,
  migrateBasicKindProfile,
  validateBasicKindProfile,
} from "../dist/filters/basic-kinds.js";

const measured = {
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
  pointerCursor: true,
  parentPointerCursor: false,
  tabIndexFocus: false,
  activeElementFocus: false,
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

// Actual WB270 facts: a no-href anchor whose parent click opened the statistics popover.
const wbAnchor = { tag: "a", role: null, ...measured };
const wiresFor = fields => extractBasicKindWires({ ...wbAnchor, ...fields });
const migratedDefault = () => migrateBasicKindProfile(DEFAULT_BASIC_KIND_PROFILE);

test("no-href anchor with its own pointer boundary opens button support", () => {
  const wires = wiresFor({});
  assert.equal(wires.anchor_pointer_boundary, 1);
  assert.equal(basicKindLeafSupportGate(wires, "button"), 1);
  assert.equal(basicKindFamilySupportGate(wires, "control"), 1);
  // Only the new wire opens the gate here; every pre-existing button support input stays zero.
  for (const wire of ["nat_control_button", "role_button", "input_type_button", "own_pointer_boundary", "neutral_focusable_control", "neutral_actual_focus", "empty_pointer_extent"]) {
    assert.equal(wires[wire], 0, wire);
  }
});

test("a valid href keeps the link path and never activates the new wire", () => {
  const wires = wiresFor({ hrefPresent: true });
  assert.equal(wires.anchor_pointer_boundary, 0);
  assert.equal(wires.anchor_href, 1);
  assert.equal(basicKindLeafSupportGate(wires, "link"), 1);
  const result = classifyBasicKind({ ...wbAnchor, hrefPresent: true }, DEFAULT_BASIC_KIND_CONFIG, migratedDefault());
  assert.equal(result.basicKind, "link");
  assert.equal(result.judgmentStatus, "judged");
});

test("an inherited-pointer non-anchor wrapper keeps its existing wire", () => {
  const wrapper = { ...wbAnchor, tag: "div", childElementCount: 2, positiveAreaChildCount: 2, pointerCursor: true, parentPointerCursor: true };
  const wires = extractBasicKindWires(wrapper);
  assert.equal(wires.neutral_inherited_pointer_wrapper, 1);
  assert.equal(basicKindLeafSupportGate(wires, "ignore"), 1);
  assert.equal(wires.anchor_pointer_boundary, 0);
  assert.equal(basicKindLeafSupportGate(wires, "button"), 0);
});

test("nullable operands stay null and known falsifiers stay zero", () => {
  for (const field of ["hrefPresent", "contentEditable", "pointerCursor", "parentPointerCursor"]) {
    assert.equal(wiresFor({ [field]: null }).anchor_pointer_boundary, null, field);
  }
  assert.equal(wiresFor({ pointerCursor: false }).anchor_pointer_boundary, 0);
  assert.equal(wiresFor({ parentPointerCursor: true }).anchor_pointer_boundary, 0);
  // An explicit non-empty role uses the existing canonical role contract and fails the predicate.
  // The properties validator normalizes an omitted role to null, so a missing-role-vs-null
  // distinction is not representable here and is deliberately not tested.
  assert.equal(wiresFor({ role: "button" }).anchor_pointer_boundary, 0);
  assert.equal(wiresFor({ role: "link" }).anchor_pointer_boundary, 0);
});

// Full pre-change row: every current wire name except the new one, so the migration diff is exact.
function preChangeRow() {
  return Object.fromEntries(BASIC_KIND_WIRE_NAMES.filter(name => name !== "anchor_pointer_boundary").map(name => [name, 0]));
}
function preChangeProfile() {
  const profile = { id: "pre-anchor-pointer", familyWeights: {}, leafWeights: {} };
  for (const family of Object.keys(BASIC_KIND_FAMILIES)) profile.familyWeights[family] = preChangeRow();
  for (const leaf of Object.values(BASIC_KIND_FAMILIES).flat()) profile.leafWeights[leaf] = preChangeRow();
  profile.familyWeights.control.nat_control_button = 0.77;
  profile.leafWeights.button.nat_control_button = 0.66;
  profile.leafWeights.button.role_button = 0.5;
  return profile;
}
function addedAddresses(old, migrated) {
  const added = [];
  for (const group of ["familyWeights", "leafWeights"]) {
    for (const [target, row] of Object.entries(migrated[group])) {
      for (const [wire, value] of Object.entries(row)) {
        if (!Object.hasOwn(old[group][target], wire)) added.push([group, target, wire, value]);
      }
    }
  }
  return added;
}

test("migration adds exactly the two named zero addresses and preserves old values", () => {
  assert.ok(BASIC_KIND_WIRE_NAMES.includes("anchor_pointer_boundary"));
  const old = preChangeProfile();
  const before = structuredClone(old);
  const migrated = migrateBasicKindProfile(old);
  assert.deepEqual(old, before);
  assert.doesNotThrow(() => validateBasicKindProfile(migrated));
  assert.deepEqual(addedAddresses(before, migrated), [
    ["familyWeights", "control", "anchor_pointer_boundary", 0],
    ["leafWeights", "button", "anchor_pointer_boundary", 0],
  ]);
  for (const group of ["familyWeights", "leafWeights"]) {
    for (const [target, row] of Object.entries(before[group])) {
      for (const [wire, value] of Object.entries(row)) assert.equal(migrated[group][target][wire], value, `${group}.${target}.${wire}`);
    }
  }
});

test("zero extension does not force button; explicit test coefficients score through competition", () => {
  const zero = structuredClone(PRIORITY_BASIC_KIND_INITIAL_PROFILE);
  assert.equal(zero.leafWeights.button.anchor_pointer_boundary, 0);
  const none = classifyBasicKind(wbAnchor, DEFAULT_BASIC_KIND_CONFIG, zero);
  assert.equal(none.evidence.wires.anchor_pointer_boundary, 1);
  assert.equal(none.basicKind, "other");
  assert.notEqual(none.basicKind, "button");

  // Test-only synthetic coefficients; never persisted as a candidate weight.
  const synthetic = structuredClone(PRIORITY_BASIC_KIND_INITIAL_PROFILE);
  synthetic.id = "synthetic-anchor-pointer-boundary-test";
  synthetic.familyWeights.control.anchor_pointer_boundary = 0.9;
  synthetic.leafWeights.button.anchor_pointer_boundary = 0.9;
  const result = classifyBasicKind(wbAnchor, DEFAULT_BASIC_KIND_CONFIG, synthetic);
  assert.equal(result.family, "control");
  assert.equal(result.basicKind, "button");
  assert.equal(result.judgmentStatus, "judged");
  assert.ok(result.evidence.activeTerms.some(term => term.wire === "anchor_pointer_boundary" && term.target === "button" && term.weight === 0.9));
});
