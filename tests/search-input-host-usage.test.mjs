// B-A1 m2 R1 red tests for the usage-relation observation projection and the
// 27-dim formal feature extractor.
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

// 这一张必须与交付观测里声明的词表逐项一致（见 r1-usage-observation.json 的
// declaredTokens，共 19 个词元：query 5、field 7、negation 3、writeSubmit 4）。词元表是外部注入的，模块里没有默认表，所以测试里
// 少写一个词就会让红测在「和交付不同的配置」上通过——那等于没测。
// 注意 field 含「评论」「回复」：Alice 裁定 1 不批准把这两个词当作**无条件非搜索**的
// 判决依据，但它们作为可学位的词法证据是允许的。二者区别见 token-table-contract-draft.md。
const DECLARED_TOKENS = {
  query: ["搜索", "查询", "检索", "search", "query"],
  field: ["备注", "简介", "昵称", "密码", "note", "评论", "回复"],
  negation: ["禁止", "不要", "无需"],
  writeSubmit: ["添加", "保存", "提交", "发送"],
};
const tokens = validateUsageTokenTable(DECLARED_TOKENS);

test("the test token table matches the delivered declared table token for token", () => {
  const total = Object.values(DECLARED_TOKENS).reduce((sum, list) => sum + list.length, 0);
  assert.equal(total, 19, "declared table must carry 19 tokens, matching r1-usage-observation.json");
  assert.deepEqual(validateUsageTokenTable(DECLARED_TOKENS).query, DECLARED_TOKENS.query);
  assert.deepEqual(validateUsageTokenTable(DECLARED_TOKENS).field, DECLARED_TOKENS.field);
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
  // A real HTMLFormElement always exposes `elements`; that collection is what
  // the browser submits, so it is the authority for owned controls.
  const externalForm = element({
    tagName: "FORM",
    elements: [],
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
    elements: [submitButton, submitInput],
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

test("the 27-dim vector is empty-false for a measured no-signal observation, and null only for unmeasured channels", () => {
  const measured = featureObservation({});
  const vector = usageFormFeatureVector(measured, tokens);
  assert.equal(vector.length, 27);
  assert.equal(USAGE_FORM_FEATURE_NAMES.length, 27);
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

test("identity fields never enter the numeric vector: changing every ref keeps all 27 bits identical", () => {
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

test("a form owner that cannot be read stays unmeasured, never an empty form", () => {
  // If the host exposes no closest(), the ancestor relation was not read at all.
  // Reporting "complete + no form" would claim a measured absence we never saw,
  // and it would make both owned-submit bits a confident false.
  const input = element({ closest: undefined, getAttribute: () => null });
  const observation = observeUsageRelation({ ...observationBase, nodeRef: "c1", element: input });
  assert.equal(observation.associationCoverage, "unmeasured");
  assert.equal(observation.formResolved, false);
  assert.equal(observation.ownedSubmits, null);
});

test("an unreadable form control collection is unmeasured, not guessed from descendants", () => {
  // form.elements is what the browser submits. A descendant query is a different
  // relation: it misses controls bound with form="id" and can pick up a
  // descendant whose real owner is another form. Guessing is worse than null.
  const submit = element({ tagName: "BUTTON", textContent: "搜索", getAttribute: () => "submit" });
  const form = element({ tagName: "FORM", elements: undefined, querySelectorAll: () => [submit] });
  const input = element({ closest: () => form });
  const observation = observeUsageRelation({ ...observationBase, nodeRef: "c1", element: input });
  assert.equal(observation.associationCoverage, "unmeasured");
  assert.equal(observation.ownedSubmits, null);
});

test("an explicit form attribute wins over an ancestor form, as the HTML form owner algorithm requires", () => {
  // HTML: the form attribute decides ownership; the ancestor is only the fallback.
  // A control inside form A that declares form="b" belongs to B, so B's submit
  // controls are the ones that own it.
  const submitB = element({ tagName: "BUTTON", textContent: "搜索B", getAttribute: () => "submit" });
  const formB = element({ tagName: "FORM", elements: [submitB] });
  const submitA = element({ tagName: "BUTTON", textContent: "保存A", getAttribute: () => "submit" });
  const formA = element({ tagName: "FORM", elements: [submitA] });
  const scopeRoot = element({ tagName: "FORM", querySelector: selector => selector === '[id="b"]' ? formB : null });
  const input = element({
    closest: () => formA,
    getAttribute: name => (name === "form" ? "b" : null),
  });
  const observation = observeUsageRelation({ ...observationBase, scopeRoot, nodeRef: "c1", element: input });
  assert.equal(observation.formResolved, true);
  assert.deepEqual(observation.ownedSubmits?.map(entry => entry.caption), ["搜索B"]);
});

test("multi-match order facts keep every match instead of the outermost pair", () => {
  const featuresOf = text => extractUsageFormFeatures(
    featureObservation({ labels: [text], labelCoverage: "complete" }),
    tokens,
  );
  // 搜索备注搜索: text follows the first query and precedes the last, so BOTH
  // order facts hold. Comparing only the last query end with the last other
  // character reports two false facts here.
  const sandwich = featuresOf("搜索备注搜索");
  assert.equal(sandwich["label.queryTokenBeforeText"], true);
  assert.equal(sandwich["label.queryTokenAfterText"], true);
  // 备注搜索备注: a field token also follows the query even though the first
  // field token precedes it.
  const fieldBothSides = featuresOf("备注搜索备注");
  assert.equal(fieldBothSides["label.fieldTokenAfterQuery"], true);
  assert.equal(fieldBothSides["label.fieldTokenPresent"], true);
  // 搜索禁止搜索: the negation precedes the second query even though it follows
  // the first.
  const negationSandwich = featuresOf("搜索禁止搜索");
  assert.equal(negationSandwich["label.negationTokenBeforeQuery"], true);
});

test("a definite owned-submit hit is not erased by another unreadable caption", () => {
  const observation = featureObservation({
    ownedSubmits: [
      { caption: "搜索", association: "same_form_owner", captionCoverage: "complete" },
      { caption: null, association: "same_form_owner", captionCoverage: "unmeasured" },
    ],
  });
  const features = extractUsageFormFeatures(observation, tokens);
  // A read hit is real evidence; an unrelated unreadable caption only makes the
  // ABSENCE of a write token unknown.
  assert.equal(features["ownedSubmit.queryTokenPresent"], true);
  assert.equal(features["ownedSubmit.writeTokenPresent"], null);
});

test("labels null stays unmeasured even when the coverage field claims complete", () => {
  // The observation layer never emits this pair, but the exported extractor must
  // not turn an unreadable label list into eight confident false facts.
  const observation = featureObservation({ labels: null, labelCoverage: "complete" });
  const vector = usageFormFeatureVector(observation, tokens);
  assert.deepEqual(vector.slice(0, 8), [null, null, null, null, null, null, null, null]);
});

test("a resolved-but-empty accessible name is measured empty, not an unfinished read", () => {
  // live-dom reports name null + coverage complete when every aria-labelledby
  // reference resolves but carries no text. That is a measured absence: eight
  // false facts, not eight nulls.
  const observation = observeUsageRelation({
    ...observationBase,
    nodeRef: "c1",
    element: element({ getAttribute: () => null }),
    evidence: { accessibleName: null, accessibleNameCoverage: "complete", labelledByUnresolved: false },
  });
  assert.equal(observation.accessibleName, "");
  assert.equal(observation.accessibleNameCoverage, "complete");
});

test("an empty token in the table cannot hang the extractor", () => {
  // validateUsageTokenTable rejects empty tokens, but the extractor takes any
  // table. An empty needle makes indexOf return the same offset forever.
  const unsafe = { query: [""], field: ["备注"], negation: ["禁止"], writeSubmit: ["添加"] };
  const observation = featureObservation({ labels: ["搜索备注"], labelCoverage: "complete" });
  const features = extractUsageFormFeatures(observation, unsafe);
  assert.equal(features["label.queryTokenPresent"], false);
  assert.equal(features["label.fieldTokenPresent"], true);
});

test("a submit caption that reads as empty text is unmeasured, not a measured empty caption", () => {
  // An empty textContent can be an icon button whose caption is visual, and an
  // input whose value attribute is absent shows a browser default label we
  // cannot read. Reporting either as "measured: no token" would fabricate
  // evidence that no query/write token exists. Honest reading is: unmeasured.
  const iconButton = element({
    tagName: "BUTTON",
    textContent: "",
    getAttribute: name => (name === "type" ? "submit" : null),
  });
  const form = element({ tagName: "FORM", elements: [iconButton] });
  const input = element({ closest: () => form, getAttribute: () => null });
  const observation = observeUsageRelation({ ...observationBase, nodeRef: "c1", element: input });
  assert.deepEqual(observation.ownedSubmits, [
    { caption: null, association: "same_form_owner", captionCoverage: "unmeasured" },
  ]);
  assert.equal(observation.associationCoverage, "complete");

  // The extractor must keep the channel unknown rather than confidently false.
  const features = extractUsageFormFeatures(observation, tokens);
  assert.equal(features["ownedSubmit.queryTokenPresent"], null);
  assert.equal(features["ownedSubmit.writeTokenPresent"], null);
});

// ---------------------------------------------------------------------------
// Ruling 1: `ownedSubmit.fieldTokenPresent` is the 27th bit.
//
// Failure mode this guards: the delivered button bits only recorded query and
// write tokens, so a real, measured fact — the caption literally contains a
// declared field token — was dropped before it could ever reach a head. The
// ruling admits that fact as a learnable bit; it does not make the word mean
// "not a search box" (that stays the supervised relation's job).
// ---------------------------------------------------------------------------

test("the declared feature table carries ownedSubmit.fieldTokenPresent as the 27th bit", () => {
  assert.equal(USAGE_FORM_FEATURE_NAMES.length, 27);
  assert.equal(USAGE_FORM_FEATURE_NAMES[26], "ownedSubmit.fieldTokenPresent");
  // The first 26 keep their delivered order; only an append is allowed.
  assert.deepEqual(USAGE_FORM_FEATURE_NAMES.slice(24, 26), [
    "ownedSubmit.queryTokenPresent",
    "ownedSubmit.writeTokenPresent",
  ]);
});

test("a field token in an owned submit caption sets the field bit", () => {
  const observed = featureObservation({
    ownedSubmits: [
      { caption: "发表评论", association: "same_form_owner", captionCoverage: "complete" },
    ],
  });
  const features = extractUsageFormFeatures(observed, tokens);
  assert.equal(features["ownedSubmit.fieldTokenPresent"], true);
  // 「评论」 is a field token only; it is not a declared query or write token.
  assert.equal(features["ownedSubmit.queryTokenPresent"], false);
  assert.equal(features["ownedSubmit.writeTokenPresent"], false);
});

test("query, write and field button bits are independent and may all be true", () => {
  // Isolation debt: a caption can carry a query token, a write token and a
  // field token at once. Ruling 4 says the tables do not exclude each other, so
  // the extractor must not "claim" the word for one table and drop the others.
  const observed = featureObservation({
    ownedSubmits: [
      { caption: "搜索并添加备注", association: "same_form_owner", captionCoverage: "complete" },
    ],
  });
  const features = extractUsageFormFeatures(observed, tokens);
  assert.equal(features["ownedSubmit.queryTokenPresent"], true);
  assert.equal(features["ownedSubmit.writeTokenPresent"], true);
  assert.equal(features["ownedSubmit.fieldTokenPresent"], true);
});

test("an unreadable caption makes the field bit unknown but never erases a proven hit", () => {
  // Same all-or-nothing rule the other two bits already follow: one unreadable
  // caption means the ABSENCE of a field token is unknown; it says nothing
  // against a hit another control already proved.
  const readable = featureObservation({
    ownedSubmits: [
      { caption: "备注", association: "same_form_owner", captionCoverage: "complete" },
    ],
  });
  assert.equal(extractUsageFormFeatures(readable, tokens)["ownedSubmit.fieldTokenPresent"], true);

  const mixed = featureObservation({
    ownedSubmits: [
      { caption: "备注", association: "same_form_owner", captionCoverage: "complete" },
      { caption: null, association: "same_form_owner", captionCoverage: "unmeasured" },
    ],
  });
  // The hit stands: unreadable evidence cannot retract measured evidence.
  assert.equal(extractUsageFormFeatures(mixed, tokens)["ownedSubmit.fieldTokenPresent"], true);

  const onlyUnreadable = featureObservation({
    ownedSubmits: [
      { caption: null, association: "same_form_owner", captionCoverage: "unmeasured" },
    ],
  });
  // No proven hit and one unreadable caption: absence is unknown, not false.
  assert.equal(extractUsageFormFeatures(onlyUnreadable, tokens)["ownedSubmit.fieldTokenPresent"], null);
});

test("the field bit is null when the submit association itself is unmeasured", () => {
  for (const observed of [
    featureObservation({ ownedSubmits: null }),
    featureObservation({
      ownedSubmits: [{ caption: "发表评论", association: "same_form_owner", captionCoverage: "complete" }],
      associationCoverage: "unmeasured",
    }),
  ]) {
    const features = extractUsageFormFeatures(observed, tokens);
    assert.equal(features["ownedSubmit.fieldTokenPresent"], null);
    // A measured absence is still distinguishable from unmeasured.
    assert.notEqual(features["ownedSubmit.fieldTokenPresent"], false);
  }
});

test("the vector stays positional: 27 entries and the field bit sits at index 26", () => {
  const observed = featureObservation({
    ownedSubmits: [
      { caption: "发表评论", association: "same_form_owner", captionCoverage: "complete" },
    ],
  });
  const vector = usageFormFeatureVector(observed, tokens);
  assert.equal(vector.length, 27);
  assert.equal(vector[26], true);
  // Nothing else moved: a caption with only a field token leaves 24 and 25 false.
  assert.equal(vector[24], false);
  assert.equal(vector[25], false);
});
