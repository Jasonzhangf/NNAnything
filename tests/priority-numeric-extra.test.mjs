import assert from "node:assert/strict";
import { test } from "node:test";
import * as browser from "../dist/browser-classify.js";
import { fitBasicKinds, inspectBasicKindNumericSample } from "../dist/training.js";

const handwiredRoot = "/Volumes/extension/code/handwired";
const complete = {
  role: null, inputType: null, hrefPresent: false, contentEditable: false,
  directTextPresent: false, nonFormatDirectTextPresent: false,
  beforeContentPresent: false, afterContentPresent: false, backgroundImagePresent: false, maskImagePresent: false,
  childElementCount: 0, positiveAreaChildCount: 0, repeatedChildGeometry: false,
  inVerifiedListParent: false, svgGraphicChildren: false, pointerCursor: false, parentPointerCursor: false,
  tabIndexFocus: false, borderPresent: false, aspectRatio: 1, descendantTextPresent: false,
  directListChildPresent: false, singleChildTag: null, singleChildSameRect: false,
  withinControlAncestor: false, inSvgAncestor: false, disabled: false, hidden: false,
};
const props = (tag, fields = {}) => ({ ...complete, tag, ...fields });
const config = {
  taskId: "dom.basic-kinds.v1",
  minScore: 0.6,
  minMargin: 0.15,
  objective: { targetScore: 0.8, rivalCeiling: 0.4, otherGap: 0.05 },
  fit: { epochs: 1, learningRate: 0.02, anchorLambda: 0 },
};
const inference = { taskId: config.taskId, minScore: config.minScore, minMargin: config.minMargin };
const priorityProfile = () => structuredClone(browser.PRIORITY_BASIC_KIND_INITIAL_PROFILE);
const close = (actual, expected, tolerance = 2e-5) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
};

test("priority Handwired gates zero out unsupported negative and positive family evidence", async () => {
  const profile = priorityProfile();
  profile.familyWeights.control.span_direct_text = -0.3;
  profile.familyWeights.control.own_pointer_boundary = 0.81;
  const input = props("span", { directTextPresent: true, nonFormatDirectTextPresent: true, pointerCursor: null, parentPointerCursor: null });
  const inspected = await inspectBasicKindNumericSample({ handwiredRoot, properties: input, expectedLabel: "text", profile, config });
  const judgment = browser.classifyBasicKind(input, inference, profile);
  close(inspected.family.control.min, 0);
  close(inspected.family.control.max, 0);
  close(judgment.familyScores.control.min, 0);
  close(judgment.familyScores.control.max, 0);
});

test("priority Handwired keeps a gated missing interval for positive and negative leaf weights", async () => {
  const profile = priorityProfile();
  profile.familyWeights.navigation.anchor_href = 0.4;
  profile.leafWeights.link.anchor_href = -0.25;
  const input = props("a", { hrefPresent: null });
  const inspected = await inspectBasicKindNumericSample({ handwiredRoot, properties: input, expectedLabel: "link", profile, config });
  const judgment = browser.classifyBasicKind(input, inference, profile);
  close(inspected.family.navigation.min, 0);
  close(inspected.family.navigation.max, 0.4);
  close(inspected.leaf.link.min, -0.25);
  close(inspected.leaf.link.max, 0);
  close(judgment.familyScores.navigation.min, 0);
  close(judgment.familyScores.navigation.max, 0.4);
  close(judgment.leafScores.link.min, 0);
  close(judgment.leafScores.link.max, 0);
});

test("priority loss does not penalize a later ignore branch for a meaningful list target", async () => {
  const profile = priorityProfile();
  profile.familyWeights.structure.div_repeated_children = 0.5;
  profile.leafWeights.list.div_repeated_children = 0.2;
  profile.leafWeights.ignore.neutral_same_rect_wrapper = 0.8;
  const input = props("div", {
    childElementCount: 1,
    positiveAreaChildCount: 1,
    repeatedChildGeometry: true,
    singleChildTag: "div",
    singleChildSameRect: true,
  });
  const inspected = await inspectBasicKindNumericSample({ handwiredRoot, properties: input, expectedLabel: "list", profile, config });
  assert.equal(inspected.leafGradients.ignore.neutral_same_rect_wrapper, 0);
});

test("priority ignore supervision penalizes earlier meaningful structure leaves", async () => {
  const profile = priorityProfile();
  profile.leafWeights.list.div_repeated_children = 0.8;
  profile.leafWeights.ignore.neutral_same_rect_wrapper = 0.1;
  const input = props("div", {
    childElementCount: 1,
    positiveAreaChildCount: 1,
    repeatedChildGeometry: true,
    singleChildTag: "div",
    singleChildSameRect: true,
  });
  const inspected = await inspectBasicKindNumericSample({ handwiredRoot, properties: input, expectedLabel: "ignore", profile, config });
  assert.ok(inspected.leafGradients.list.div_repeated_children > 0);
});

test("priority fit preserves topology and reports zero-epoch row passes", async () => {
  const profile = priorityProfile();
  const result = await fitBasicKinds({
    handwiredRoot,
    rows: [
      { properties: props("span", { directTextPresent: true, nonFormatDirectTextPresent: true }), expectedLabel: "text" },
      { properties: props("button"), expectedLabel: "button" },
    ],
    baseProfile: profile,
    config: { ...config, fit: { ...config.fit, epochs: 0 } },
    candidateId: "priority-zero-epoch",
  });
  assert.equal(result.profile.topology, "priority_staged_v1");
  assert.equal(result.timing.completedEpochs, 0);
  assert.equal(result.timing.processedRowCount, 2);
  assert.equal(result.timing.gradientRowEpochs, 0);
  assert.equal(result.timing.totalRowPasses, 4);
});

test("missing backend keeps the original error and exposes zero completed work", async () => {
  await assert.rejects(
    fitBasicKinds({
      handwiredRoot: "/private/tmp/nnanything-missing-handwired-root",
      rows: [{ properties: props("button"), expectedLabel: "button" }],
      baseProfile: browser.DEFAULT_BASIC_KIND_PROFILE,
      config,
      candidateId: "missing-backend",
    }),
    error => {
      assert.match(error.message, /Handwired core is missing/);
      assert.equal(error.completedEpochs, 0);
      assert.equal(error.timing.completedEpochs, 0);
      assert.ok(error.timing.fitTotalMs >= 0);
      return true;
    },
  );
});
