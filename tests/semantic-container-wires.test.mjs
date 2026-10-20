import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BASIC_KIND_FAMILIES,
  DEFAULT_BASIC_KIND_CONFIG,
  classifyBasicKind,
  extractBasicKindWires,
  validateBasicKindProfile,
  validateBasicKindProperties,
} from "nnanything/browser";

function fixtureProfile({ natContainer = 0, singleChildDiv = 0 } = {}) {
  const familyWeights = Object.fromEntries(Object.keys(BASIC_KIND_FAMILIES).map(family => [family, {}]));
  const leafWeights = Object.fromEntries(Object.values(BASIC_KIND_FAMILIES).flat().map(label => [label, {}]));
  familyWeights.structure = { nat_container: natContainer, single_child_div: singleChildDiv };
  leafWeights.container = { nat_container: natContainer, single_child_div: singleChildDiv };
  return validateBasicKindProfile({
    id: "semantic-container-wires-fixture",
    familyWeights,
    leafWeights,
  });
}

const neutralDiv = {
  tag: "div",
  role: null,
  contentEditable: false,
  directTextPresent: false,
};

test("single_child_div treats a known non-single raw child count as inapplicable", () => {
  const wires = fields => extractBasicKindWires(validateBasicKindProperties({ ...neutralDiv, ...fields }));

  assert.equal(wires({ childElementCount: 2, positiveAreaChildCount: 1, singleChildTag: null }).single_child_div, 0);
  assert.equal(wires({ childElementCount: 1, positiveAreaChildCount: 1, singleChildTag: "div" }).single_child_div, 1);
  assert.equal(wires({ childElementCount: 1, positiveAreaChildCount: 1, singleChildTag: "span" }).single_child_div, 0);
  assert.equal(wires({ childElementCount: 1, positiveAreaChildCount: 1, singleChildTag: null }).single_child_div, null);
  assert.equal(wires({ childElementCount: null, positiveAreaChildCount: 1, singleChildTag: null }).single_child_div, null);
  assert.equal(wires({ childElementCount: 2, positiveAreaChildCount: 0, singleChildTag: null }).single_child_div, 0);
  assert.equal(wires({ childElementCount: 2, positiveAreaChildCount: 1, singleChildTag: "div" }).single_child_div, 0);
  assert.equal(wires({ tag: "span", childElementCount: 2, positiveAreaChildCount: 1, singleChildTag: null }).single_child_div, 0);
});

test("public scoring separates corrected raw-count applicability from the retained single-DIV case", () => {
  const profile = fixtureProfile({ singleChildDiv: 0.8 });

  const rawCountTwo = classifyBasicKind(
    { ...neutralDiv, childElementCount: 2, positiveAreaChildCount: 1, singleChildTag: null },
    DEFAULT_BASIC_KIND_CONFIG,
    profile,
  );
  assert.equal(rawCountTwo.evidence.wires.single_child_div, 0);
  assert.deepEqual(rawCountTwo.familyScores.structure, { min: 0, max: 0 });
  assert.equal(rawCountTwo.judgmentStatus, "unknown");
  assert.equal(rawCountTwo.basicKind, "other");

  const rawCountOne = classifyBasicKind(
    { ...neutralDiv, childElementCount: 1, positiveAreaChildCount: 1, singleChildTag: "div" },
    DEFAULT_BASIC_KIND_CONFIG,
    profile,
  );
  assert.equal(rawCountOne.evidence.wires.single_child_div, 1);
  assert.deepEqual(rawCountOne.familyScores.structure, { min: 0.8, max: 0.8 });
  assert.deepEqual(rawCountOne.leafScores.container, { min: 0.8, max: 0.8 });
  assert.equal(rawCountOne.judgmentStatus, "judged");
  assert.equal(rawCountOne.basicKind, "container");
  assert.ok(rawCountOne.evidence.activeTerms.some(term =>
    term.stage === "leaf" && term.target === "container" && term.wire === "single_child_div" && term.value === 1));

  const missingCountAndTag = classifyBasicKind(
    { ...neutralDiv, childElementCount: null, positiveAreaChildCount: 1, singleChildTag: null },
    DEFAULT_BASIC_KIND_CONFIG,
    profile,
  );
  assert.equal(missingCountAndTag.evidence.wires.single_child_div, null);
  assert.deepEqual(missingCountAndTag.familyScores.structure, { min: 0, max: 0.8 });
  assert.equal(missingCountAndTag.judgmentStatus, "unknown");
  assert.equal(missingCountAndTag.basicKind, "other");
});

test("FIGURE uses the existing nat_container score for image, code, caption and NOSCRIPT groups", () => {
  const profile = fixtureProfile({ natContainer: 0.8 });
  const cases = [
    ["image", { childElementCount: 1, positiveAreaChildCount: 1, singleChildTag: "img", graphicDescendantPresent: true }],
    ["code", { childElementCount: 1, positiveAreaChildCount: 1, singleChildTag: "code", graphicDescendantPresent: false }],
    ["caption", { childElementCount: 2, positiveAreaChildCount: 2, singleChildTag: null, graphicDescendantPresent: false }],
    ["NOSCRIPT", { childElementCount: 1, positiveAreaChildCount: 1, singleChildTag: "noscript", graphicDescendantPresent: false }],
  ];

  for (const [name, fields] of cases) {
    const result = classifyBasicKind(
      {
        tag: "figure",
        role: null,
        contentEditable: false,
        directTextPresent: false,
        nonFormatDirectTextPresent: false,
        ...fields,
      },
      DEFAULT_BASIC_KIND_CONFIG,
      profile,
    );
    assert.equal(result.evidence.wires.nat_container, 1, name);
    assert.equal(result.evidence.wires.nat_image, 0, name);
    assert.equal(result.evidence.wires.role_image, 0, name);
    assert.deepEqual(result.familyScores.structure, { min: 0.8, max: 0.8 }, name);
    assert.deepEqual(result.leafScores.container, { min: 0.8, max: 0.8 }, name);
    assert.ok(result.evidence.activeTerms.some(term =>
      term.stage === "family" && term.target === "structure" && term.wire === "nat_container" && term.value === 1), name);
    assert.equal(result.basicKind, "container", name);
    assert.equal(result.judgmentStatus, "judged", name);
    if (name === "NOSCRIPT") {
      assert.equal(result.evidence.wires.nat_text, 0);
      assert.equal(result.evidence.wires.direct_non_format_text, 0);
      assert.equal(result.evidence.wires.span_direct_text, 0);
    }
  }

  const noContainerEvidence = classifyBasicKind(
    { tag: "figure", role: null, contentEditable: false, directTextPresent: false, childElementCount: 1, positiveAreaChildCount: 1, singleChildTag: "img" },
    DEFAULT_BASIC_KIND_CONFIG,
    fixtureProfile(),
  );
  assert.deepEqual(noContainerEvidence.familyScores.structure, { min: 0, max: 0 });
  assert.equal(noContainerEvidence.basicKind, "other");
});

test("the applicability correction preserves ordinary DIV, SPAN, focus, click, text and state wires", () => {
  const divWires = extractBasicKindWires(validateBasicKindProperties({
    ...neutralDiv,
    childElementCount: 2,
    positiveAreaChildCount: 2,
    singleChildTag: null,
  }));
  assert.equal(divWires.div_multi_child, 1);
  assert.equal(divWires.div_single_child, 0);
  assert.equal(divWires.neutral_multi_child, 1);
  assert.equal(divWires.single_child_div, 0);

  const spanWires = extractBasicKindWires(validateBasicKindProperties({
    tag: "span",
    role: null,
    contentEditable: false,
    childElementCount: 1,
    positiveAreaChildCount: 1,
    singleChildTag: "span",
    directTextPresent: true,
    nonFormatDirectTextPresent: true,
  }));
  assert.equal(spanWires.span_leaf, 0);
  assert.equal(spanWires.span_direct_text, 1);
  assert.equal(spanWires.div_multi_child, 0);
  assert.equal(spanWires.div_single_child, 0);
  assert.equal(spanWires.single_child_div, 0);

  const protectedWires = extractBasicKindWires(validateBasicKindProperties({
    ...neutralDiv,
    childElementCount: 2,
    positiveAreaChildCount: 1,
    singleChildTag: null,
    directTextPresent: true,
    nonFormatDirectTextPresent: true,
    pointerCursor: true,
    parentPointerCursor: false,
    activeElementFocus: true,
    disabled: true,
    hidden: true,
  }));
  assert.equal(protectedWires.single_child_div, 0);
  assert.equal(protectedWires.neutral_actual_focus, 1);
  assert.equal(protectedWires.own_pointer_boundary, 1);
  assert.equal(protectedWires.direct_non_format_text, 1);
  assert.equal(protectedWires.state_disabled, 1);
  assert.equal(protectedWires.state_hidden, 1);
});
