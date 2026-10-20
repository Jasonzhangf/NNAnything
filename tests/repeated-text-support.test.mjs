import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_BASIC_KIND_CONFIG,
  PRIORITY_BASIC_KIND_INITIAL_PROFILE,
  classifyBasicKind,
} from "../dist/filters/basic-kinds.js";
import { inspectBasicKindNumericSample } from "../dist/training/basic-kind-numeric.js";

const handwiredRoot = "/Volumes/extension/code/handwired";
const config = {
  taskId: DEFAULT_BASIC_KIND_CONFIG.taskId,
  minScore: DEFAULT_BASIC_KIND_CONFIG.minScore,
  minMargin: DEFAULT_BASIC_KIND_CONFIG.minMargin,
  objective: { targetScore: 0.8, rivalCeiling: 0.4, otherGap: 0.05 },
  fit: { epochs: 0, learningRate: 0.01, anchorLambda: 0 },
};

const zhihuRepeatedFooter = {
  tag: "div",
  role: null,
  contentEditable: false,
  directTextPresent: true,
  nonFormatDirectTextPresent: true,
  childElementCount: 5,
  positiveAreaChildCount: 5,
  repeatedChildGeometry: true,
  inVerifiedListParent: false,
};
const plainTextLeaf = {
  tag: "div",
  role: null,
  contentEditable: false,
  directTextPresent: true,
  nonFormatDirectTextPresent: true,
  childElementCount: 0,
  positiveAreaChildCount: 0,
  repeatedChildGeometry: false,
  inVerifiedListParent: false,
};
const paragraphWithInlineSpans = {
  tag: "p",
  role: null,
  contentEditable: false,
  directTextPresent: true,
  nonFormatDirectTextPresent: true,
  childElementCount: 2,
  positiveAreaChildCount: 2,
  repeatedChildGeometry: false,
  inVerifiedListParent: false,
};

function counterweightProfile() {
  const profile = structuredClone(PRIORITY_BASIC_KIND_INITIAL_PROFILE);
  assert.equal(profile.familyWeights.text.div_repeated_children, 0, "text family counter-address must be migration-registered");
  assert.equal(profile.leafWeights.text.div_repeated_children, 0, "text leaf counter-address must be migration-registered");
  profile.id = "repeated-text-counterweight-test";
  profile.familyWeights.text.direct_non_format_text = 1;
  profile.leafWeights.text.direct_non_format_text = 1;
  profile.familyWeights.text.div_repeated_children = -0.5;
  profile.leafWeights.text.div_repeated_children = -0.5;
  return profile;
}

test("registered div repeated-group counterweights lower text without excluding text leaves", () => {
  const profile = counterweightProfile();
  const repeated = classifyBasicKind(zhihuRepeatedFooter, DEFAULT_BASIC_KIND_CONFIG, profile);
  assert.equal(repeated.familyScores.text.min, 0.5);
  assert.equal(repeated.leafScores.text.min, 0.5);
  assert.equal(repeated.judgmentStatus, "unknown");
  assert.equal(repeated.basicKind, "other");

  for (const input of [plainTextLeaf, paragraphWithInlineSpans]) {
    const result = classifyBasicKind(input, DEFAULT_BASIC_KIND_CONFIG, profile);
    assert.equal(result.familyScores.text.min, 1);
    assert.equal(result.leafScores.text.min, 1);
    assert.equal(result.judgmentStatus, "judged");
    assert.equal(result.basicKind, "text");
  }
});

test("Handwired repeated-group counterweights match the public text intervals", async () => {
  const profile = counterweightProfile();
  const inspected = await inspectBasicKindNumericSample({
    handwiredRoot,
    properties: zhihuRepeatedFooter,
    expectedLabel: "text",
    profile,
    config,
  });
  const judged = classifyBasicKind(zhihuRepeatedFooter, DEFAULT_BASIC_KIND_CONFIG, profile);
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 2e-5, `${actual} != ${expected}`);

  close(inspected.family.text.min, judged.familyScores.text.min);
  close(inspected.family.text.max, judged.familyScores.text.max);
  close(inspected.leaf.text.min, judged.leafScores.text.min);
  close(inspected.leaf.text.max, judged.leafScores.text.max);
  assert.notEqual(inspected.familyGradients.text.div_repeated_children, 0);
  assert.notEqual(inspected.leafGradients.text.div_repeated_children, 0);
});
