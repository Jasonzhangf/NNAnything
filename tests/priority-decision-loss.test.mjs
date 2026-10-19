import assert from "node:assert/strict";
import { test } from "node:test";
import * as browser from "../dist/browser-classify.js";
import {
  fitBasicKinds,
  inspectBasicKindNumericSample,
  validateBasicKindTrainingConfig,
} from "../dist/training.js";

const handwiredRoot = "/Volumes/extension/code/handwired";
const complete = {
  role: null, inputType: null, hrefPresent: false, contentEditable: false,
  directTextPresent: false, nonFormatDirectTextPresent: false,
  beforeContentPresent: false, afterContentPresent: false, backgroundImagePresent: false, maskImagePresent: false,
  childElementCount: 0, positiveAreaChildCount: 0, repeatedChildGeometry: false,
  inVerifiedListParent: false, svgGraphicChildren: false, pointerCursor: false, parentPointerCursor: false,
  tabIndexFocus: false, activeElementFocus: false, borderPresent: false, aspectRatio: 1, descendantTextPresent: false,
  directListChildPresent: false, singleChildTag: null, singleChildSameRect: false,
  withinControlAncestor: false, inSvgAncestor: false, disabled: false, hidden: false,
};
const props = (tag, fields = {}) => ({ ...complete, tag, ...fields });
const baseConfig = {
  taskId: "dom.basic-kinds.v1",
  minScore: 0.6,
  minMargin: 0.15,
  objective: { targetScore: 0.8, rivalCeiling: 0.4, otherGap: 0.05 },
  fit: { epochs: 1, learningRate: 0.1, anchorLambda: 0 },
};
const decisionConfig = {
  ...baseConfig,
  objective: {
    ...baseConfig.objective,
    mode: "priority_decision_v1",
    boundarySlack: 0.0001,
  },
};
const inference = {
  taskId: baseConfig.taskId,
  minScore: baseConfig.minScore,
  minMargin: baseConfig.minMargin,
};
const priorityProfile = () => structuredClone(browser.PRIORITY_BASIC_KIND_INITIAL_PROFILE);
const close = (actual, expected, tolerance = 2e-5) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} within ${tolerance}`);
};
const inspect = (properties, expectedLabel, profile, config = decisionConfig) =>
  inspectBasicKindNumericSample({ handwiredRoot, properties, expectedLabel, profile, config });

function weakStructureProfile(earlierScore) {
  const profile = priorityProfile();
  profile.familyWeights.structure.div_repeated_children = earlierScore;
  profile.familyWeights.structure.neutral_single_positive_wrapper = earlierScore;
  profile.familyWeights.structure.neutral_same_rect_wrapper = 0.8;
  profile.leafWeights.list.div_repeated_children = earlierScore;
  profile.leafWeights.container.neutral_single_positive_wrapper = earlierScore;
  profile.leafWeights.ignore.neutral_same_rect_wrapper = 0.8;
  return profile;
}

const weakStructureInput = props("div", {
  childElementCount: 1,
  positiveAreaChildCount: 1,
  repeatedChildGeometry: true,
  singleChildTag: "div",
  singleChildSameRect: true,
});

test("decision loss releases an earlier structure branch already below the exit threshold", async () => {
  const profile = weakStructureProfile(0.55);
  const inspected = await inspect(weakStructureInput, "ignore", profile);
  assert.equal(browser.classifyBasicKind(weakStructureInput, inference, profile).basicKind, "ignore");
  assert.equal(browser.classifyBasicKind(weakStructureInput, inference, profile).judgmentStatus, "judged");
  close(inspected.loss, 0, 1e-9);
  assert.equal(inspected.leafGradients.list.div_repeated_children, 0);
  assert.equal(inspected.leafGradients.container.neutral_single_positive_wrapper, 0);

  const legacy = await inspect(weakStructureInput, "ignore", profile, baseConfig);
  assert.ok(legacy.loss > 0);
  assert.ok(legacy.leafGradients.list.div_repeated_children > 0);
  assert.ok(legacy.leafGradients.container.neutral_single_positive_wrapper > 0);
});

test("same-stage competitors use the target lower bound minus the classifier margin", async () => {
  const input = props("div", {
    childElementCount: 3,
    positiveAreaChildCount: 3,
    repeatedChildGeometry: true,
  });
  const profile = priorityProfile();
  profile.familyWeights.structure.div_multi_child = 0.75;
  profile.familyWeights.structure.div_repeated_children = 0.59;
  profile.leafWeights.container.div_multi_child = 0.75;
  profile.leafWeights.list.div_repeated_children = 0.59;

  const passing = await inspect(input, "container", profile);
  close(passing.loss, 0, 1e-9);
  assert.equal(passing.leafGradients.list.div_repeated_children, 0);
  assert.equal(browser.classifyBasicKind(input, inference, profile).basicKind, "container");

  profile.familyWeights.structure.div_repeated_children = 0.61;
  profile.leafWeights.list.div_repeated_children = 0.61;
  const failing = await inspect(input, "container", profile);
  assert.ok(failing.loss > 0);
  assert.ok(failing.leafGradients.list.div_repeated_children > 0);
  assert.equal(browser.classifyBasicKind(input, inference, profile).judgmentStatus, "conflict");
});

test("decision loss gradients match finite differences through target and competitor endpoints", async () => {
  const input = props("div", {
    childElementCount: 3,
    positiveAreaChildCount: 3,
    repeatedChildGeometry: true,
  });
  const makeProfile = () => {
    const profile = priorityProfile();
    profile.familyWeights.structure.div_multi_child = 0.75;
    profile.familyWeights.structure.div_repeated_children = 0.61;
    profile.leafWeights.container.div_multi_child = 0.75;
    profile.leafWeights.list.div_repeated_children = 0.61;
    return profile;
  };
  const inspected = await inspect(input, "container", makeProfile());
  const epsilon = 1e-3;
  for (const [row, wire, gradient] of [
    ["container", "div_multi_child", inspected.leafGradients.container.div_multi_child],
    ["list", "div_repeated_children", inspected.leafGradients.list.div_repeated_children],
  ]) {
    const plus = makeProfile();
    const minus = makeProfile();
    plus.leafWeights[row][wire] += epsilon;
    minus.leafWeights[row][wire] -= epsilon;
    const plusLoss = (await inspect(input, "container", plus)).loss;
    const minusLoss = (await inspect(input, "container", minus)).loss;
    const finiteDifference = (plusLoss - minusLoss) / (2 * epsilon);
    assert.ok(Math.abs(gradient - finiteDifference) <= 1e-4 + 1e-3 * Math.max(Math.abs(gradient), Math.abs(finiteDifference)));
  }
});

test("missing focus remains a raw interval and never becomes observed false or zero", async () => {
  const profile = priorityProfile();
  profile.familyWeights.structure.neutral_actual_focus = 0.3;
  profile.leafWeights.container.neutral_actual_focus = 0.2;
  const input = props("div", {
    childElementCount: 1,
    positiveAreaChildCount: 1,
    activeElementFocus: null,
  });

  const missing = await inspect(input, "container", profile);
  close(missing.family.structure.min, 0);
  close(missing.family.structure.max, 0.3);
  close(missing.leaf.container.min, 0);
  close(missing.leaf.container.max, 0.2);
  assert.equal(browser.classifyBasicKind(input, inference, profile).judgmentStatus, "unknown");

  const observedFalse = await inspect({ ...input, activeElementFocus: false }, "container", profile);
  close(observedFalse.family.structure.min, 0);
  close(observedFalse.family.structure.max, 0);
  close(observedFalse.leaf.container.min, 0);
  close(observedFalse.leaf.container.max, 0);

  const observedTrue = await inspect({ ...input, activeElementFocus: true }, "container", profile);
  close(observedTrue.family.structure.min, 0.3);
  close(observedTrue.family.structure.max, 0.3);
  close(observedTrue.leaf.container.min, 0.2);
  close(observedTrue.leaf.container.max, 0.2);
});

test("an earlier upper bound exactly at the inference threshold violates boundary slack", async () => {
  const profile = weakStructureProfile(0.6);
  const inspected = await inspect(weakStructureInput, "ignore", profile);
  assert.ok(inspected.loss > 0);
  assert.ok(inspected.leafGradients.list.div_repeated_children > 0);
  assert.ok(inspected.leafGradients.container.neutral_single_positive_wrapper > 0);
});

test("family and leaf bottlenecks choose the limiting raw endpoint deterministically", async () => {
  const input = props("article");
  const familyBottleneck = priorityProfile();
  familyBottleneck.familyWeights.structure.nat_container = 0.55;
  familyBottleneck.leafWeights.container.nat_container = 0.8;
  const family = await inspect(input, "container", familyBottleneck);
  assert.ok(family.loss > 0);
  assert.ok(family.familyGradients.structure.nat_container < 0);
  assert.equal(family.leafGradients.container.nat_container, 0);

  const leafBottleneck = priorityProfile();
  leafBottleneck.familyWeights.structure.nat_container = 0.8;
  leafBottleneck.leafWeights.container.nat_container = 0.55;
  const leaf = await inspect(input, "container", leafBottleneck);
  assert.ok(leaf.loss > 0);
  assert.equal(leaf.familyGradients.structure.nat_container, 0);
  assert.ok(leaf.leafGradients.container.nat_container < 0);

  const tied = priorityProfile();
  tied.familyWeights.structure.nat_container = 0.55;
  tied.leafWeights.container.nat_container = 0.55;
  const first = await inspect(input, "container", tied);
  const second = await inspect(input, "container", tied);
  assert.equal(first.familyGradients.structure.nat_container, 0);
  assert.ok(first.leafGradients.container.nat_container < 0);
  assert.equal(first.leafGradients.container.nat_container, second.leafGradients.container.nat_container);
});

test("clamped target margin does not hide a saturated competitor upper bound", async () => {
  const input = props("div", {
    childElementCount: 3,
    positiveAreaChildCount: 3,
    repeatedChildGeometry: true,
    shallowStructuralPeerRatio: 1,
  });
  const profile = priorityProfile();
  profile.familyWeights.structure.div_multi_child = 0.8;
  profile.familyWeights.structure.neutral_multi_child = 0.4;
  profile.familyWeights.structure.div_repeated_children = 0.8;
  profile.familyWeights.structure.neutral_structural_peers = 0.1;
  profile.leafWeights.container.div_multi_child = 0.8;
  profile.leafWeights.container.neutral_multi_child = 0.4;
  profile.leafWeights.list.div_repeated_children = 0.8;
  profile.leafWeights.list.neutral_structural_peers = 0.1;

  const inspected = await inspect(input, "container", profile);
  close(inspected.family.structure.min, 2.1);
  close(inspected.leaf.container.min, 1.2);
  close(inspected.leaf.list.min, 0.9);
  assert.ok(inspected.loss > 0);
  assert.ok(inspected.leafGradients.list.div_repeated_children > 0);
  assert.ok(inspected.leafGradients.list.neutral_structural_peers > 0);
  assert.equal(inspected.leafGradients.container.div_multi_child, 0);
});

test("explicit other supervision bounds every eligible category upper", async () => {
  const input = props("div", {
    childElementCount: 3,
    positiveAreaChildCount: 3,
    repeatedChildGeometry: true,
  });
  const profile = priorityProfile();
  profile.familyWeights.structure.div_multi_child = 0.55;
  profile.familyWeights.structure.div_repeated_children = 0.55;
  profile.leafWeights.container.div_multi_child = 0.55;
  profile.leafWeights.list.div_repeated_children = 0.55;
  const passing = await inspect(input, "other", profile);
  close(passing.loss, 0, 1e-9);

  profile.familyWeights.structure.div_multi_child = 0.65;
  profile.familyWeights.structure.div_repeated_children = 0.65;
  profile.leafWeights.container.div_multi_child = 0.65;
  profile.leafWeights.list.div_repeated_children = 0.65;
  const failing = await inspect(input, "other", profile);
  assert.ok(failing.loss > 0);
  assert.ok(failing.leafGradients.container.div_multi_child > 0);
  assert.ok(failing.leafGradients.list.div_repeated_children > 0);
});

test("objective_feasible may stop at baseline and returns the actual candidate", async () => {
  const profile = priorityProfile();
  profile.familyWeights.control.nat_control_button = 0.7;
  profile.leafWeights.button.nat_control_button = 0.7;
  const input = props("button");
  const result = await fitBasicKinds({
    handwiredRoot,
    rows: [{ properties: input, expectedLabel: "button" }],
    baseProfile: profile,
    config: {
      ...decisionConfig,
      fit: { epochs: 5, learningRate: 0.1, anchorLambda: 0, stopWhen: "objective_feasible" },
    },
    candidateId: "decision-baseline-feasible",
  });
  assert.equal(result.stoppingReason, "objective_feasible");
  assert.equal(result.trajectory.length, 0);
  assert.equal(result.timing.completedEpochs, 0);
  assert.equal(result.timing.totalRowPasses, 2);
  assert.equal(result.profile.id, "decision-baseline-feasible");
  assert.equal(browser.classifyBasicKind(input, inference, result.profile).basicKind, "button");
  assert.equal(browser.classifyBasicKind(input, inference, result.profile).judgmentStatus, "judged");
});

test("objective_feasible stops at the first feasible post-epoch result", async () => {
  const input = props("button");
  const result = await fitBasicKinds({
    handwiredRoot,
    rows: [{ properties: input, expectedLabel: "button" }],
    baseProfile: priorityProfile(),
    config: {
      ...decisionConfig,
      fit: { epochs: 50, learningRate: 0.2, anchorLambda: 0, stopWhen: "objective_feasible" },
    },
    candidateId: "decision-epoch-feasible",
  });
  assert.equal(result.stoppingReason, "objective_feasible");
  assert.ok(result.timing.completedEpochs > 0);
  assert.ok(result.timing.completedEpochs < 50);
  assert.equal(result.trajectory.length, result.timing.completedEpochs);
  assert.equal(result.timing.totalRowPasses, 2 * result.timing.completedEpochs + 2);
  assert.equal(browser.classifyBasicKind(input, inference, result.profile).basicKind, "button");
  assert.equal(browser.classifyBasicKind(input, inference, result.profile).judgmentStatus, "judged");
});

test("decision objective validation preserves legacy fields and limits new options", () => {
  const validated = validateBasicKindTrainingConfig(decisionConfig);
  assert.equal(validated.objective.mode, "priority_decision_v1");
  assert.equal(validated.objective.boundarySlack, 0.0001);
  assert.throws(() => validateBasicKindTrainingConfig({
    ...baseConfig,
    fit: { ...baseConfig.fit, stopWhen: "objective_feasible" },
  }), /priority_decision_v1/);
  assert.throws(() => validateBasicKindTrainingConfig({
    ...baseConfig,
    objective: { ...baseConfig.objective, mode: "unknown" },
  }), /mode/);
  assert.throws(() => validateBasicKindTrainingConfig({
    ...decisionConfig,
    objective: { ...decisionConfig.objective, targetScore: undefined },
  }), /targetScore/);
});

test("decision objective rejects profiles that are not priority staged", async () => {
  await assert.rejects(
    inspectBasicKindNumericSample({
      handwiredRoot,
      properties: props("button"),
      expectedLabel: "button",
      profile: browser.DEFAULT_BASIC_KIND_PROFILE,
      config: decisionConfig,
    }),
    /priority_staged_v1/,
  );
});
