import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BASIC_KIND_FAMILIES,
  classifyBasicKind,
  computeBasicKindStageRawIntervals,
  DEFAULT_BASIC_KIND_CONFIG,
  DEFAULT_BASIC_KIND_PROFILE,
  extractBasicKindWires,
  migrateBasicKindProfile,
  validateBasicKindProfile,
} from "../dist/filters/basic-kinds.js";
import {
  fitBasicKinds,
  inspectBasicKindNumericSample,
  validateBasicKindTrainingConfig,
} from "../dist/training/basic-kind-numeric.js";

const handwiredRoot = "/Volumes/extension/code/handwired";
const complete = {
  inputType: null,
  hrefPresent: false,
  contentEditable: false,
  directTextPresent: false,
  childElementCount: 0,
  positiveAreaChildCount: 0,
  repeatedChildGeometry: false,
  inVerifiedListParent: false,
};
const config = {
  taskId: "dom.basic-kinds.v1",
  minScore: 0.6,
  minMargin: 0.15,
  objective: { targetScore: 0.8, rivalCeiling: 0.4, otherGap: 0.05 },
  fit: { epochs: 1, learningRate: 0.1, anchorLambda: 0 },
};
const properties = (tag, fields = {}) => ({ tag, role: null, ...complete, ...fields });
const row = (tag, expectedLabel, fields = {}) => ({ properties: properties(tag, fields), expectedLabel });
const cloneProfile = () => structuredClone(DEFAULT_BASIC_KIND_PROFILE);
const clamp = value => Math.max(0, Math.min(1, value));
const close = (actual, expected, tolerance = 2e-5) => assert.ok(
  Math.abs(actual - expected) <= tolerance,
  `${actual} != ${expected} within ${tolerance}`,
);
const inspect = (propertiesValue, expectedLabel, profile, overrides = {}) => inspectBasicKindNumericSample({
  handwiredRoot,
  properties: propertiesValue,
  expectedLabel,
  profile,
  config: { ...config, ...overrides },
});
const inspectActualKnownWire = (propertiesValue, expectedLabel, profile) => {
  const wires = extractBasicKindWires(propertiesValue);
  const familyEntries = Object.entries(BASIC_KIND_FAMILIES);
  const expectedFamily = familyEntries.find(([, labels]) => labels.includes(expectedLabel));
  const family = computeBasicKindStageRawIntervals(
    "family",
    familyEntries.map(([name]) => name),
    profile.familyWeights,
    wires,
  );
  const leaf = computeBasicKindStageRawIntervals("leaf", expectedFamily[1], profile.leafWeights, wires);
  let loss = 0;
  for (const [name, scores] of Object.entries(family)) {
    loss += name === expectedFamily[0]
      ? Math.max(0, config.objective.targetScore - scores.min) ** 2
      : Math.max(0, scores.max - config.objective.rivalCeiling) ** 2;
  }
  for (const [name, scores] of Object.entries(leaf)) {
    loss += name === expectedLabel
      ? Math.max(0, config.objective.targetScore - scores.min) ** 2
      : Math.max(0, scores.max - config.objective.rivalCeiling) ** 2;
  }
  return { family, leaf, loss };
};

test("numeric raw intervals share the classifier feature and interval truth", async () => {
  const profile = cloneProfile();
  const input = properties("a", { hrefPresent: true });
  const inspected = await inspect(input, "link", profile);
  const judgment = classifyBasicKind(input, DEFAULT_BASIC_KIND_CONFIG, profile);
  const wires = extractBasicKindWires(input);
  const familyTruth = computeBasicKindStageRawIntervals(
    "family",
    Object.keys(BASIC_KIND_FAMILIES),
    profile.familyWeights,
    wires,
  );
  for (const family of Object.keys(BASIC_KIND_FAMILIES)) {
    close(inspected.family[family].min, familyTruth[family].min);
    close(inspected.family[family].max, familyTruth[family].max);
    close(clamp(inspected.family[family].min), judgment.familyScores[family].min);
    close(clamp(inspected.family[family].max), judgment.familyScores[family].max);
  }
  close(clamp(inspected.leaf.link.min), judgment.leafScores.link.min);
  close(clamp(inspected.leaf.link.max), judgment.leafScores.link.max);
  assert.equal(judgment.basicKind, "link");
});

test("a zero missing line keeps its ReLU-corner subgradient at zero", async () => {
  const profile = cloneProfile();
  const inspected = await inspect(properties("button", { hidden: null }), "button", profile);
  close(inspected.family.control.max, 0.85);
  assert.equal(inspected.familyGradients.control.state_hidden, 0);
  assert.equal(inspected.leafGradients.button.state_hidden, 0);
});

test("finite differences match real Handwired gradients away from ReLU corners", async () => {
  const profile = cloneProfile();
  const input = properties("button");
  const inspected = await inspect(input, "button", profile);
  const epsilon = 1e-3;
  const plus = cloneProfile();
  const minus = cloneProfile();
  plus.familyWeights.control.nat_control_button += epsilon;
  minus.familyWeights.control.nat_control_button -= epsilon;
  const plusLoss = (await inspect(input, "button", plus)).loss;
  const minusLoss = (await inspect(input, "button", minus)).loss;
  const finiteDifference = (plusLoss - minusLoss) / (2 * epsilon);
  const backpropagation = inspected.familyGradients.control.nat_control_button;
  assert.ok(Math.abs(backpropagation - finiteDifference) <= 1e-4 + 1e-3 * Math.max(Math.abs(backpropagation), Math.abs(finiteDifference)));

  const container = properties("div", {
    childElementCount: 3,
    positiveAreaChildCount: 3,
    repeatedChildGeometry: true,
  });
  const negative = cloneProfile();
  const negativeInspected = await inspect(container, "container", negative);
  const negativePlus = cloneProfile();
  const negativeMinus = cloneProfile();
  negativePlus.leafWeights.container.div_repeated_children += epsilon;
  negativeMinus.leafWeights.container.div_repeated_children -= epsilon;
  const negativeFiniteDifference = (
    (await inspect(container, "container", negativePlus)).loss
    - (await inspect(container, "container", negativeMinus)).loss
  ) / (2 * epsilon);
  const negativeBackpropagation = negativeInspected.leafGradients.container.div_repeated_children;
  assert.ok(Math.abs(negativeBackpropagation - negativeFiniteDifference) <= 1e-4 + 1e-3 * Math.max(Math.abs(negativeBackpropagation), Math.abs(negativeFiniteDifference)));
});

test("a wrong initial family still receives family and leaf gradients from the gold label", async () => {
  const profile = cloneProfile();
  profile.familyWeights.control.nat_control_button = 0;
  profile.leafWeights.button.nat_control_button = 0;
  const input = properties("button");
  assert.equal(classifyBasicKind(input, DEFAULT_BASIC_KIND_CONFIG, profile).basicKind, "other");
  const inspected = await inspect(input, "button", profile);
  assert.ok(inspected.familyGradients.control.nat_control_button < 0);
  assert.ok(inspected.leafGradients.button.nat_control_button < 0);
});

test("fitting learns the gold family and leaf even when the initial prediction is other", async () => {
  const profile = cloneProfile();
  profile.familyWeights.control.nat_control_button = 0;
  profile.leafWeights.button.nat_control_button = 0;
  const input = properties("button");
  const progress = [];
  const result = await fitBasicKinds({
    handwiredRoot,
    rows: [{ properties: input, expectedLabel: "button" }],
    baseProfile: profile,
    config: { ...config, fit: { epochs: 30, learningRate: 0.1, anchorLambda: 0 } },
    candidateId: "trained-button",
    onProgress: value => progress.push(value),
  });
  assert.equal(result.trajectory.length, 30);
  assert.equal(progress.length, 30);
  assert.ok(result.lossAfter < result.lossBefore);
  assert.ok(result.profile.familyWeights.control.nat_control_button >= config.minScore);
  assert.ok(result.profile.leafWeights.button.nat_control_button >= config.minScore);
  assert.equal(classifyBasicKind(input, DEFAULT_BASIC_KIND_CONFIG, result.profile).basicKind, "button");
  validateBasicKindProfile(result.profile);
});

test("confirmed other suppresses every family upper below the other threshold", async () => {
  const profile = cloneProfile();
  const input = properties("button");
  const result = await fitBasicKinds({
    handwiredRoot,
    rows: [{ properties: input, expectedLabel: "other" }],
    baseProfile: profile,
    config: { ...config, fit: { epochs: 30, learningRate: 0.1, anchorLambda: 0 } },
    candidateId: "trained-other",
  });
  assert.ok(result.lossAfter < result.lossBefore);
  const inspected = await inspect(input, "other", result.profile);
  for (const family of Object.keys(BASIC_KIND_FAMILIES)) assert.ok(inspected.family[family].max < 0.6);
  assert.equal(classifyBasicKind(input, DEFAULT_BASIC_KIND_CONFIG, result.profile).basicKind, "other");
});

test("saturated raw intervals keep deficit/rival hinge loss and stage-specific gradients", async () => {
  const profile = cloneProfile();
  profile.familyWeights.control.nat_control_button = 1;
  profile.familyWeights.media.nat_control_button = 1;
  profile.leafWeights.button.nat_control_button = 0;
  const input = properties("button");
  const inspected = await inspect(input, "button", profile);
  const actualKnown = inspectActualKnownWire(input, "button", profile);
  assert.equal(inspected.family.control.min, 1);
  assert.equal(inspected.family.media.max, 1);
  const expectedDeficitLoss = (0.8 - actualKnown.leaf.button.min) ** 2;
  const expectedRivalLoss = (actualKnown.family.media.max - 0.4) ** 2;
  close(expectedDeficitLoss + expectedRivalLoss, 1);
  close(actualKnown.loss, expectedDeficitLoss + expectedRivalLoss);
  close(inspected.loss, actualKnown.loss);
  assert.equal(inspected.otherLoss, 0);
  assert.equal(inspected.familyGradients.control.nat_control_button, 0);
  assert.ok(inspected.familyGradients.media.nat_control_button > 0);
  assert.ok(inspected.leafGradients.button.nat_control_button < 0);
  assert.equal(classifyBasicKind(input, DEFAULT_BASIC_KIND_CONFIG, profile).familyStatus, "conflict");
});

test("anchor loss is explicit and trajectory components sum to the total", async () => {
  const profile = cloneProfile();
  profile.familyWeights.control.nat_control_button = 0;
  profile.leafWeights.button.nat_control_button = 0;
  const result = await fitBasicKinds({
    handwiredRoot,
    rows: [row("button", "button")],
    baseProfile: profile,
    config: { ...config, fit: { epochs: 2, learningRate: 0.05, anchorLambda: 0.5 } },
    candidateId: "anchored-button",
  });
  assert.ok(result.trajectory[0].anchorLoss > 0);
  for (const progress of result.trajectory) {
    close(progress.loss, progress.knownLoss + progress.otherLoss + progress.anchorLoss, 1e-5);
    assert.equal(progress.sampleCount, 1);
    assert.equal(progress.projectedWeightCount, 0);
  }
});

test("training config rejects objectives that cannot guarantee the classifier margin", () => {
  assert.throws(() => validateBasicKindTrainingConfig({
    ...config,
    objective: { targetScore: 0.6, rivalCeiling: 0.5, otherGap: 0.05 },
  }), /minMargin/);
  assert.throws(() => validateBasicKindTrainingConfig({
    ...config,
    objective: { targetScore: 0.8, rivalCeiling: 0.4, otherGap: 0.6 },
  }), /otherGap/);
});

test("missing signed terms retain audit contributions and receive interval gradients", async () => {
  const profile = cloneProfile();
  profile.familyWeights.navigation.state_hidden = -0.2;
  profile.familyWeights.media.state_hidden = 0.7;
  const input = properties("a", { hrefPresent: null, hidden: null });
  const judgment = classifyBasicKind(input, DEFAULT_BASIC_KIND_CONFIG, profile);
  const term = judgment.evidence.activeTerms.find(item => item.stage === "family" && item.target === "navigation" && item.wire === "anchor_href");
  assert.deepEqual(term?.contribution, { min: 0, max: 0.35 });
  assert.equal(term.value, null);
  const evaluated = await inspect(input, "link", profile);
  close(evaluated.family.navigation.min, 0.25);
  close(evaluated.family.media.max, 0.7);
  for (const family of ["navigation", "media"]) {
    const epsilon = 1e-3;
    const plus = structuredClone(profile), minus = structuredClone(profile);
    plus.familyWeights[family].state_hidden += epsilon;
    minus.familyWeights[family].state_hidden -= epsilon;
    const finite = ((await inspect(input, "link", plus)).loss - (await inspect(input, "link", minus)).loss) / (2 * epsilon);
    const actual = evaluated.familyGradients[family].state_hidden;
    assert.ok(Math.abs(actual - finite) <= 1e-4 + 1e-3 * Math.max(Math.abs(actual), Math.abs(finite)));
  }
});

test("non-finite loss is an explicit fitting failure, never a saved candidate", async () => {
  const profile = cloneProfile();
  profile.familyWeights.control.nat_control_button = 0;
  profile.familyWeights.control.role_button = 0;
  profile.leafWeights.button.nat_control_button = 0;
  profile.leafWeights.button.role_button = 0;
  await assert.rejects(fitBasicKinds({
    handwiredRoot,
    rows: [{ properties: properties("button", { role: "button" }), expectedLabel: "button" }],
    baseProfile: profile,
    config: { ...config, fit: { epochs: 3, learningRate: 1, anchorLambda: Number.MAX_VALUE } },
    candidateId: "overflow-candidate",
  }), /Non-finite training/);
});

test("real Handwired fitting updates the new explicit-zero appearance cells", async () => {
  const profile = cloneProfile();
  profile.familyWeights.media.css_background_image = 0;
  profile.leafWeights.image.css_background_image = 0;
  profile.familyWeights.text.direct_non_format_text = 0;
  profile.leafWeights.text.direct_non_format_text = 0;
  const image = properties("span", {
    nonFormatDirectTextPresent: false,
    beforeContentPresent: true,
    afterContentPresent: true,
    backgroundImagePresent: true,
    maskImagePresent: true,
  });
  const text = properties("b", {
    nonFormatDirectTextPresent: true,
    beforeContentPresent: false,
    afterContentPresent: false,
    backgroundImagePresent: false,
    maskImagePresent: false,
  });
  const result = await fitBasicKinds({
    handwiredRoot,
    rows: [{ properties: image, expectedLabel: "image" }, { properties: text, expectedLabel: "text" }],
    baseProfile: profile,
    config: { ...config, fit: { epochs: 25, learningRate: 0.1, anchorLambda: 0 } },
    candidateId: "appearance-trainability",
  });
  assert.notEqual(result.profile.familyWeights.media.css_background_image, 0);
  assert.notEqual(result.profile.leafWeights.image.css_background_image, 0);
  for (const wire of ["css_before_content", "css_after_content", "css_mask_image"]) {
    assert.notEqual(result.profile.familyWeights.media[wire], 0);
    assert.notEqual(result.profile.leafWeights.image[wire], 0);
  }
  assert.notEqual(result.profile.familyWeights.text.direct_non_format_text, 0);
  assert.notEqual(result.profile.leafWeights.text.direct_non_format_text, 0);
  assert.ok(result.lossAfter < result.lossBefore);
  validateBasicKindProfile(result.profile);
  const gradients = await inspect(image, "image", profile);
  assert.equal(Object.hasOwn(gradients.familyGradients.media, "nat_svg_child"), true);
  assert.equal(Object.hasOwn(gradients.leafGradients.image, "nat_svg_child"), true);
});

test("public Handwired numeric graph binds neutral_multi_child_shape on positive, negative and missing paths", async () => {
  const wire = "neutral_multi_child_shape";
  const shapeProperties = aspectRatio => properties("div", {
    childElementCount: 2,
    positiveAreaChildCount: 2,
    repeatedChildGeometry: true,
    aspectRatio,
  });
  const shapeProfile = (weight, id) => {
    const profile = structuredClone(migrateBasicKindProfile(DEFAULT_BASIC_KIND_PROFILE));
    profile.id = id;
    profile.leafWeights.list[wire] = weight;
    return profile;
  };
  const zeroProfile = shapeProfile(0, "shape-numeric-zero");

  for (const [id, weight, aspectRatio, contribution] of [
    ["shape-numeric-positive", 0.4, 0.25, [0.1, 0.1]],
    ["shape-numeric-negative", -0.4, 0.25, [-0.1, -0.1]],
    ["shape-numeric-missing", 0.4, null, [0, 0.4]],
  ]) {
    const input = shapeProperties(aspectRatio);
    const profile = shapeProfile(weight, id);
    const wires = extractBasicKindWires(input);
    const formal = computeBasicKindStageRawIntervals(
      "leaf",
      Object.values(BASIC_KIND_FAMILIES).flat(),
      profile.leafWeights,
      wires,
    );
    const baseline = await inspect(input, "list", zeroProfile);
    const evaluated = await inspect(input, "list", profile);

    close(evaluated.leaf.list.min, formal.list.min);
    close(evaluated.leaf.list.max, formal.list.max);
    close(evaluated.leaf.list.min - baseline.leaf.list.min, contribution[0]);
    close(evaluated.leaf.list.max - baseline.leaf.list.max, contribution[1]);
    assert.equal(Object.hasOwn(evaluated.leafGradients.list, wire), true);
    assert.equal(typeof evaluated.leafGradients.list[wire], "number");
  }
});
