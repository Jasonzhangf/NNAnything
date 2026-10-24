// B-A1 m2 R1 red tests for the usage-relation observation projection and the
// 26-dim formal feature extractor.
//
// Each test is bound to one concrete failure mode. These are white-box unit
// tests for the new read-only layer; they do not replace the real browser
// rerun, which is the black-box acceptance for R1.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  USAGE_FORM_FEATURE_NAMES,
  extractUsageFormFeatures,
  observeUsageRelation,
  usageFormFeatureVector,
  validateUsageTokenTable,
} from "../dist/search-input-host.js";

const tokens = validateUsageTokenTable({
  query: ["搜索", "查询", "检索", "search", "query"],
  field: ["备注", "简介", "昵称", "密码", "note"],
  negation: ["禁止", "不要", "无需"],
  writeSubmit: ["添加", "保存", "提交", "发送"],
});

function element(overrides = {}) {
  return {
    tagName: "INPUT",
    textContent: "",
    labels: [],
    isContentEditable: false,
    closest: () => null,
    getAttribute: () => null,
    querySelectorAll: () => [],
    ...overrides,
  };
}

const observationBase = {
  scopeRef: "scope-1",
  documentRef: "doc-1",
  observationId: "obs-1",
  revision: 1,
  scopeRoot: element({ tagName: "FORM" }),
  properties: null,
  access: "available",
};

const featureObservation = (overrides = {}) => ({
  ref: "c1",
  scopeRef: "scope-1",
  documentRef: "doc-1",
  observationId: "obs-1",
  revision: 1,
  labels: [],
  labelCoverage: "complete",
  placeholder: "",
  placeholderCoverage: "complete",
  accessibleName: "",
  accessibleNameCoverage: "complete",
  ownedSubmits: [],
  associationCoverage: "complete",
  formResolved: true,
  access: "available",
  ...overrides,
});

test("multi-label: every associated label is kept in document order, not just labels[0]", () => {
  const first = element({ textContent: "搜索个人简介" });
  const second = element({ textContent: "成员目录" });
  const input = element({ labels: [first, second] });
  const observation = observeUsageRelation({
    ...observationBase,
    nodeRef: "c1",
    element: input,
  });
  assert.deepEqual(observation.labels, ["搜索个人简介", "成员目录"]);
  assert.equal(observation.labelCoverage, "complete");
});

test("no label reads as an empty array, never null", () => {
  const input = element({ labels: [] });
  const observation = observeUsageRelation({
    ...observationBase,
    nodeRef: "c1",
    element: input,
  });
  assert.deepEqual(observation.labels, []);
});

test("unreadable labels stay null (unmeasured), never an empty array", () => {
  const input = element({ labels: null });
  const observation = observeUsageRelation({
    ...observationBase,
    nodeRef: "c1",
    element: input,
  });
  assert.equal(observation.labels, null);
  assert.equal(observation.labelCoverage, "unmeasured");
});

test("external form owner via the form attribute is resolved, not missed by closest", () => {
  const externalForm = element({
    tagName: "FORM",
    querySelectorAll: () => [],
  });
  const input = element({
    closest: () => null,
    getAttribute: name => name === "form" ? "search-form" : null,
  });
  const scopeRoot = element({
    tagName: "FORM",
    querySelector: selector => selector === '[id="search-form"]' ? externalForm : null,
  });
  const observation = observeUsageRelation({
    ...observationBase,
    scopeRoot,
    nodeRef: "c1",
    element: input,
  });
  assert.equal(observation.associationCoverage, "complete");
  assert.equal(observation.formResolved, true);
  assert.deepEqual(observation.ownedSubmits, []);
});

test("a dangling form reference is unmeasured, not treated as no form", () => {
  const input = element({
    closest: () => null,
    getAttribute: name => name === "form" ? "missing-form" : null,
  });
  const scopeRoot = element({ tagName: "FORM", querySelector: () => null });
  const observation = observeUsageRelation({
    ...observationBase,
    scopeRoot,
    nodeRef: "c1",
    element: input,
  });
  assert.equal(observation.associationCoverage, "unmeasured");
  assert.equal(observation.formResolved, false);
  assert.equal(observation.ownedSubmits, null);
});

test("same-form multiple submit controls all enter ownedSubmits with their captions", () => {
  const submitButton = element({
    tagName: "BUTTON",
    textContent: "查找",
    getAttribute: name => name === "type" ? "submit" : null,
  });
  const submitInput = element({
    tagName: "INPUT",
    textContent: "",
    getAttribute: name => name === "type" ? "submit" : name === "value" ? "添加" : null,
  });
  const form = element({
    tagName: "FORM",
    querySelectorAll: () => [submitButton, submitInput],
  });
  const input = element({ closest: () => form });
  const observation = observeUsageRelation({
    ...observationBase,
    nodeRef: "c1",
    element: input,
  });
  // Captions are recorded verbatim from the DOM; token tables play no part in
  // observation, so a caption outside the query table is still kept as-is.
  assert.deepEqual(observation.ownedSubmits, [
    { caption: "查找", association: "same_form_owner", captionCoverage: "complete" },
    { caption: "添加", association: "same_form_owner", captionCoverage: "complete" },
  ]);
});

test("no form owner is measured empty evidence, not unmeasured", () => {
  const input = element({ closest: () => null, getAttribute: () => null });
  const observation = observeUsageRelation({
    ...observationBase,
    nodeRef: "c1",
    element: input,
  });
  assert.equal(observation.associationCoverage, "complete");
  assert.deepEqual(observation.ownedSubmits, []);
  assert.equal(observation.formResolved, true);
});

test("the 26-dim vector is empty-false for a measured no-signal observation, and null only for unmeasured channels", () => {
  const measured = featureObservation({});
  const vector = usageFormFeatureVector(measured, tokens);
  assert.equal(vector.length, 26);
  assert.equal(USAGE_FORM_FEATURE_NAMES.length, 26);
  // measured empty evidence: no null anywhere, every fact is false
  assert.deepEqual(vector, USAGE_FORM_FEATURE_NAMES.map(() => false));

  const unmeasured = featureObservation({
    labelCoverage: "unmeasured",
    labels: null,
  });
  const unmeasuredVector = usageFormFeatureVector(unmeasured, tokens);
  // label is channels 0..7; they must be null, the rest must stay false
  assert.deepEqual(unmeasuredVector.slice(0, 8), [null, null, null, null, null, null, null, null]);
  assert.deepEqual(unmeasuredVector.slice(8), USAGE_FORM_FEATURE_NAMES.slice(8).map(() => false));
});

test("query token order facts: 评论搜索 is after-text, 搜索备注 is before-text, 用于搜索的备注 is before-text", () => {
  const featuresOf = text => extractUsageFormFeatures(featureObservation({
    labels: [text],
    labelCoverage: "complete",
  }), tokens);

  const afterText = featuresOf("评论搜索");
  assert.equal(afterText["label.queryTokenPresent"], true);
  assert.equal(afterText["label.queryTokenAfterText"], true);
  assert.equal(afterText["label.queryTokenBeforeText"], false);

  const beforeText = featuresOf("搜索备注");
  assert.equal(beforeText["label.queryTokenBeforeText"], true);
  assert.equal(beforeText["label.queryTokenAfterText"], false);
  assert.equal(beforeText["label.fieldTokenPresent"], true);

  // 用于搜索的备注 has non-query text on BOTH sides of the query token. The
  // plan requires keeping every match, so both facts are true at once and the
  // extractor must not pick the more favourable side.
  const usedFor = featuresOf("用于搜索的备注");
  assert.equal(usedFor["label.queryTokenBeforeText"], true);
  assert.equal(usedFor["label.queryTokenAfterText"], true);
});

test("button caption tokens are existence bits; two opposite captions keep both true (no broadcast, no hard decision)", () => {
  // Captions come from the declared token table only: the query table here is
  // the frozen SEARCH cue list, so a caption outside it contributes no bit.
  const observation = featureObservation({
    ownedSubmits: [
      { caption: "搜索", association: "same_form_owner", captionCoverage: "complete" },
      { caption: "添加", association: "same_form_owner", captionCoverage: "complete" },
    ],
  });
  const features = extractUsageFormFeatures(observation, tokens);
  assert.equal(features["ownedSubmit.queryTokenPresent"], true);
  assert.equal(features["ownedSubmit.writeTokenPresent"], true);
});

test("a submit control with unreadable caption makes both owned bits unmeasured, not false", () => {
  const observation = featureObservation({
    ownedSubmits: [
      { caption: null, association: "same_form_owner", captionCoverage: "unmeasured" },
    ],
  });
  const features = extractUsageFormFeatures(observation, tokens);
  assert.equal(features["ownedSubmit.queryTokenPresent"], null);
  assert.equal(features["ownedSubmit.writeTokenPresent"], null);
});

test("a truncated accessible name is not scored as a complete channel", () => {
  const input = element({ labels: [] });
  const observation = observeUsageRelation({
    ...observationBase,
    nodeRef: "c1",
    element: input,
    evidence: {
      accessibleName: "搜索".repeat(40),
      accessibleNameCoverage: "truncated",
      labelledByUnresolved: false,
    },
  });
  assert.equal(observation.accessibleNameCoverage, "truncated");
  const features = extractUsageFormFeatures(observation, tokens);
  // Truncated means partial read: the eight accessible-name facts stay null.
  assert.deepEqual(
    USAGE_FORM_FEATURE_NAMES.filter(name => name.startsWith("accessibleName.")).map(name => features[name]),
    [null, null, null, null, null, null, null, null],
  );
});

test("an unresolved aria-labelledby reference stays unmeasured instead of a measured empty name", () => {
  const input = element({ labels: [] });
  const observation = observeUsageRelation({
    ...observationBase,
    nodeRef: "c1",
    element: input,
    evidence: {
      accessibleName: null,
      accessibleNameCoverage: "unavailable",
      labelledByUnresolved: true,
    },
  });
  assert.equal(observation.accessibleName, null);
  assert.equal(observation.accessibleNameCoverage, "unmeasured");
});

test("a resolved but empty accessible name is measured empty evidence", () => {
  const input = element({ labels: [] });
  const observation = observeUsageRelation({
    ...observationBase,
    nodeRef: "c1",
    element: input,
    evidence: {
      accessibleName: null,
      accessibleNameCoverage: "unavailable",
      labelledByUnresolved: false,
    },
  });
  assert.equal(observation.accessibleName, "");
  assert.equal(observation.accessibleNameCoverage, "complete");
});


// A submit control listed through `form="id"` is not a DOM descendant of the
// form element. Reading only descendants reports "no owned submit", which is a
// false measured-empty: the form does own that button.
function externalFormFixture(formId, buttonCaption, buttonType = "submit") {
  const submitButton = element({
    tagName: "BUTTON",
    textContent: buttonCaption,
    getAttribute: (name) => (name === "type" ? buttonType : null),
  });
  // The form element owns the button, but the button is elsewhere in the tree,
  // so a descendant query cannot see it.
  const form = element({
    tagName: "FORM",
    id: formId,
    elements: [submitButton],
    querySelectorAll: () => [],
  });
  const input = element({
    getAttribute: (name) => (name === "form" ? formId : null),
  });
  const scopeRoot = element({
    tagName: "BODY",
    querySelectorAll: (selector) => (selector === `[id="${formId}"]` ? [form] : []),
    querySelector: (selector) => (selector === `[id="${formId}"]` ? form : null),
  });
  return { input, scopeRoot };
}

test("a submit control associated only through form= is still an owned submit", () => {
  const { input, scopeRoot } = externalFormFixture("site-search", "搜索");
  const observation = observeUsageRelation({ ...observationBase, nodeRef: "c1", element: input, scopeRoot });
  assert.equal(observation.formResolved, true);
  assert.equal(observation.associationCoverage, "complete");
  assert.deepEqual(observation.ownedSubmits, [
    { caption: "搜索", association: "same_form_owner", captionCoverage: "complete" },
  ]);
});

test("a reset control associated through form= stays out of owned submits", () => {
  const { input, scopeRoot } = externalFormFixture("msg-form", "清空", "reset");
  const observation = observeUsageRelation({ ...observationBase, nodeRef: "c1", element: input, scopeRoot });
  assert.equal(observation.formResolved, true);
  assert.deepEqual(observation.ownedSubmits, []);
});

test("owned submit existence bits are true for a form= associated submit caption", () => {
  const { input, scopeRoot } = externalFormFixture("site-search", "搜索");
  const observation = observeUsageRelation({ ...observationBase, nodeRef: "c1", element: input, scopeRoot });
  const features = extractUsageFormFeatures(observation, tokens);
  assert.equal(features["ownedSubmit.queryTokenPresent"], true);
  assert.equal(features["ownedSubmit.writeTokenPresent"], false);
});

// Alice 裁定 2 强制反例的其余形式事实：否定、引号、括号。extractor 只输出
// 形式事实，不据此判死语义（“禁止搜索的词”里的查询位照实置真，由下游决定
// 如何解释，而不是在这里把否定当否定查询意图的证据）。

test("a negation token before the query token sets negationTokenBeforeQuery, query facts stay true", () => {
  const features = extractUsageFormFeatures(featureObservation({
    labels: ["禁止搜索的词"],
    labelCoverage: "complete",
  }), tokens);
  assert.equal(features["label.queryTokenPresent"], true);
  assert.equal(features["label.negationTokenBeforeQuery"], true);
  // 形式事实不判死：不能因为否定就把查询位翻成 false。
});

test("a negation token after the query token does not set negationTokenBeforeQuery", () => {
  const features = extractUsageFormFeatures(featureObservation({
    labels: ["搜索不要备注"],
    labelCoverage: "complete",
  }), tokens);
  assert.equal(features["label.queryTokenPresent"], true);
  assert.equal(features["label.negationTokenBeforeQuery"], false);
  assert.equal(features["label.fieldTokenPresent"], true);
});

test("a query token inside quotes sets queryTokenQuoted (both western and CJK quote pairs)", () => {
  const quoted = extractUsageFormFeatures(featureObservation({
    labels: ["备注“搜索”"],
    labelCoverage: "complete",
  }), tokens);
  assert.equal(quoted["label.queryTokenQuoted"], true);
  assert.equal(quoted["label.queryTokenPresent"], true);
  // 引号内的查询位照实置真，不因引用语境翻 false。
});

test("a query token inside parentheses sets queryTokenParenthesized (both western and CJK pairs)", () => {
  const parenthesized = extractUsageFormFeatures(featureObservation({
    labels: ["备注（搜索历史）"],
    labelCoverage: "complete",
  }), tokens);
  assert.equal(parenthesized["label.queryTokenParenthesized"], true);
  assert.equal(parenthesized["label.queryTokenPresent"], true);
});

test("the same order facts hold independently on the placeholder channel", () => {
  const features = extractUsageFormFeatures(featureObservation({
    placeholder: "搜索词备注",
    placeholderCoverage: "complete",
  }), tokens);
  assert.equal(features["placeholder.queryTokenBeforeText"], true);
  assert.equal(features["placeholder.fieldTokenPresent"], true);
  assert.equal(features["placeholder.queryTokenAfterText"], false);
  // 通道互不干扰：label 通道没内容时保持已测空。
  assert.equal(features["label.queryTokenPresent"], false);
});

test("identity fields never enter the numeric vector: changing every ref keeps all 26 bits identical", () => {
  const base = featureObservation({
    labels: ["搜索备注"],
    labelCoverage: "complete",
    placeholder: "请输入",
    placeholderCoverage: "complete",
    ownedSubmits: [{ caption: "搜索", association: "same_form_owner", captionCoverage: "complete" }],
  });
  const renamed = featureObservation({
    ...base,
    ref: "completely-different-ref",
    scopeRef: "other-scope",
    documentRef: "other-doc",
    observationId: "other-observation",
    revision: 99,
  });
  assert.deepEqual(
    usageFormFeatureVector(renamed, tokens),
    usageFormFeatureVector(base, tokens),
    "ref/scope/document/observation/revision must not influence any feature bit",
  );
});

test("a truncated placeholder channel yields eight nulls while the label channel still scores", () => {
  const observation = featureObservation({
    labels: ["搜索备注"],
    labelCoverage: "complete",
    placeholder: "搜索".repeat(40),
    placeholderCoverage: "truncated",
  });
  const features = extractUsageFormFeatures(observation, tokens);
  assert.deepEqual(
    USAGE_FORM_FEATURE_NAMES.filter(name => name.startsWith("placeholder.")).map(name => features[name]),
    [null, null, null, null, null, null, null, null],
  );
  assert.equal(features["label.queryTokenPresent"], true);
});

test("an unavailable channel is unmeasured even when the other channel carries a signal", () => {
  const observation = featureObservation({
    labels: null,
    labelCoverage: "unmeasured",
    placeholder: "搜索",
    placeholderCoverage: "complete",
  });
  const features = extractUsageFormFeatures(observation, tokens);
  assert.equal(features["placeholder.queryTokenPresent"], true);
  assert.equal(features["label.queryTokenPresent"], null);
  assert.equal(features["label.fieldTokenPresent"], null);
});

test("a channel is all-or-nothing: never a half-measured eight-bit group", () => {
  // 每个通道八位共享一个 coverage。若某通道是 unmeasured，八位必须全 null；
  // 若已测，八位必须全为布尔。半通道混用说明有人在位级别各自判断覆盖，
  // 那会把「这一位读不到」和「这一位测到为空」混起来。
  const cases = [
    { observation: featureObservation({ labelCoverage: "unmeasured", labels: null }), channel: "label" },
    { observation: featureObservation({ labelCoverage: "truncated", labels: ["搜索"] }), channel: "label" },
    { observation: featureObservation({ placeholderCoverage: "unavailable", placeholder: "搜索" }), channel: "placeholder" },
    { observation: featureObservation({ accessibleNameCoverage: "unmeasured", accessibleName: null }), channel: "accessibleName" },
    { observation: featureObservation({ labels: ["搜索"] }), channel: "label" },
  ];
  for (const { observation, channel } of cases) {
    const bits = USAGE_FORM_FEATURE_NAMES
      .filter(name => name.startsWith(`${channel}.`))
      .map(name => extractUsageFormFeatures(observation, tokens)[name]);
    assert.equal(bits.length, 8, `${channel} must have exactly eight bits`);
    const nullCount = bits.filter(bit => bit === null).length;
    assert.ok(nullCount === 0 || nullCount === 8,
      `${channel} must be entirely null or entirely measured, got ${nullCount}/8 null`);
  }
});
