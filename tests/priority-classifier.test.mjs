import assert from "node:assert/strict";
import { test } from "node:test";
import * as browser from "../dist/browser-classify.js";
import { fitBasicKinds, inspectBasicKindNumericSample } from "../dist/training.js";

const config = browser.DEFAULT_BASIC_KIND_CONFIG;
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
const profile = () => ({ ...structuredClone(browser.DEFAULT_BASIC_KIND_PROFILE), id: "priority-contract-test", topology: "priority_staged_v1" });
const judge = (p, weights) => browser.classifyBasicKind(p, config, weights);
const fitConfig = { taskId: "dom.basic-kinds.v1", ...config,
  objective: { targetScore: 0.8, rivalCeiling: 0.4, otherGap: 0.05 },
  fit: { epochs: 2, learningRate: 0.02, anchorLambda: 0.001 } };
const handwiredRoot = "/Volumes/extension/code/handwired";

test("priority topology has an explicit fresh initial profile and rejects unknown topology", () => {
  const initial = browser.PRIORITY_BASIC_KIND_INITIAL_PROFILE;
  assert.equal(initial?.topology, "priority_staged_v1");
  for (const rows of [initial.familyWeights, initial.leafWeights]) {
    for (const weights of Object.values(rows)) assert.ok(Object.values(weights).every(w => w === 0));
  }
  assert.equal(Object.hasOwn(browser.DEFAULT_BASIC_KIND_PROFILE, "topology"), false);
  assert.throws(() => browser.validateBasicKindProfile({ ...profile(), topology: "unknown-topology" }), /topology/i);
});

test("missing speculative interaction cannot veto observed own text; measured interaction enters its route", () => {
  const weights = profile();
  weights.familyWeights.control.own_pointer_boundary = 0.81;
  weights.leafWeights.button.own_pointer_boundary = 0.81;
  const input = props("span", { directTextPresent: true, nonFormatDirectTextPresent: true,
    pointerCursor: null, parentPointerCursor: null });
  const oldWeights = structuredClone(weights);
  delete oldWeights.topology;
  assert.equal(judge(input, oldWeights).judgmentStatus, "unknown");
  const result = judge(input, weights);
  assert.equal(result.basicKind, "text");
  assert.equal(result.judgmentStatus, "judged");
  assert.equal(result.evidence.wires.own_pointer_boundary, null);
  assert.equal(judge({ ...input, pointerCursor: true, parentPointerCursor: false }, weights).basicKind, "button");
});

test("selection evidence distinguishes a playback-rate chooser from a generic action", () => {
  const weights = profile();
  weights.familyWeights.control.own_pointer_boundary = 0.9;
  weights.leafWeights.button.own_pointer_boundary = 0.85;
  weights.leafWeights.button.neutral_list_choice = -0.8;
  weights.leafWeights.select.neutral_list_choice = 0.9;
  const input = props("xg-playbackrate", { pointerCursor: true, parentPointerCursor: false,
    childElementCount: 2, positiveAreaChildCount: 1, directListChildPresent: true, descendantTextPresent: true });
  assert.equal(judge(input, weights).basicKind, "select");
  assert.equal(judge({ ...input, directListChildPresent: false }, weights).basicKind, "button");
});

test("ignore is reachable last without swallowing text, media, or unresolved native controls", () => {
  const weights = profile();
  weights.familyWeights.structure.neutral_same_rect_wrapper = 0.9;
  weights.leafWeights.ignore.neutral_same_rect_wrapper = 0.9;
  weights.familyWeights.structure.svg_internal_part = 0.9;
  weights.leafWeights.ignore.svg_internal_part = 0.9;
  const wrapper = props("span", { childElementCount: 1, positiveAreaChildCount: 1,
    singleChildTag: "span", singleChildSameRect: true, descendantTextPresent: true });
  assert.equal(judge(wrapper, weights).basicKind, "ignore");
  assert.equal(judge(props("path", { inSvgAncestor: true }), weights).basicKind, "ignore");
  assert.equal(judge(props("span", { directTextPresent: true, nonFormatDirectTextPresent: true }), weights).basicKind, "text");
  assert.equal(judge(props("img"), weights).basicKind, "image");
  assert.equal(judge(props("input"), weights).judgmentStatus, "unknown");
  assert.notEqual(judge(props("input"), weights).basicKind, "ignore");
  assert.equal(judge(props("ul"), weights).basicKind, "list");
  assert.equal(judge(props("article"), weights).basicKind, "container");
});

test("asset contract versions prevent old and priority topology cross-loading", () => {
  const asset = (version, weights) => ({ targetOperator: "dom.basic_kinds", operatorVersion: "0.1.0",
    contractVersion: version, taskId: "dom.basic-kinds.v1", profileId: weights.id, profile: weights,
    compatibility: { taskId: "dom.basic-kinds.v1", minScore: 0.6, minMargin: 0.15 }, calibrated: false });
  assert.equal(browser.parseBrowserWeightAsset(asset(2, profile())).profile.topology, "priority_staged_v1");
  assert.throws(() => browser.parseBrowserWeightAsset(asset(1, profile())), /contract|topology/i);
  assert.throws(() => browser.parseBrowserWeightAsset(asset(2, browser.DEFAULT_BASIC_KIND_PROFILE)), /contract|topology/i);
});

test("priority Handwired raw intervals agree with formal forward including negative and missing evidence", async () => {
  const weights = profile();
  weights.familyWeights.control.own_pointer_boundary = 0.81;
  weights.familyWeights.control.span_direct_text = -0.3;
  const input = props("span", { directTextPresent: true, nonFormatDirectTextPresent: true,
    pointerCursor: null, parentPointerCursor: null });
  const measured = await inspectBasicKindNumericSample({ handwiredRoot, properties: input,
    expectedLabel: "text", profile: weights, config: fitConfig });
  const actual = judge(input, weights);
  for (const name of Object.keys(browser.BASIC_KIND_FAMILIES)) {
    assert.ok(Math.abs(Math.max(0, Math.min(1, measured.family[name].min)) - actual.familyScores[name].min) < 2e-5);
    assert.ok(Math.abs(Math.max(0, Math.min(1, measured.family[name].max)) - actual.familyScores[name].max) < 2e-5);
  }
});

test("fit timing counts actual row passes and completed epochs, separate from loss", async () => {
  const result = await fitBasicKinds({ handwiredRoot, rows: [{ properties: props("button"), expectedLabel: "button" }],
    baseProfile: browser.DEFAULT_BASIC_KIND_PROFILE, config: fitConfig, candidateId: "timing-contract" });
  const timing = result.timing;
  assert.ok(timing, "actual fit must return timing");
  for (const field of ["backendLoadMs", "circuitBuildMs", "baselineEvalMs", "trainEpochGradMs", "postEpochEvalMs", "finalEvalMs", "fitTotalMs"]) {
    assert.ok(Number.isFinite(timing[field]) && timing[field] >= 0, field);
  }
  assert.equal(timing.completedEpochs, 2);
  assert.equal(timing.gradientRowEpochs, 2);
  assert.equal(timing.totalRowPasses, 6);
  assert.ok(timing.trainableParamCount > 0);
  assert.equal(result.trajectory.length, 2);
});

test("progress failure retains the already completed epoch and measured time", async () => {
  await assert.rejects(() => fitBasicKinds({ handwiredRoot,
    rows: [{ properties: props("button"), expectedLabel: "button" }],
    baseProfile: browser.DEFAULT_BASIC_KIND_PROFILE, config: fitConfig, candidateId: "failed-timing-contract",
    onProgress() { throw new Error("intentional progress consumer failure"); },
  }), error => error.completedEpochs === 1 && error.timing?.completedEpochs === 1 && error.timing.fitTotalMs >= 0);
});
