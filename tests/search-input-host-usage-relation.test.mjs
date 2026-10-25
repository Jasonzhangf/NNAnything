// B-A1 m2 R2 red tests for the usage-relation member: 27-dim profile, two tanh
// heads, and the four-state guard with the unmeasured interval rule (ruling 3).
//
// Each test binds one concrete failure mode. These are white-box unit tests for
// the new member layer; the real-browser rerun is the black-box acceptance.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  USAGE_FORM_FEATURE_NAMES,
  USAGE_RELATION_BOUNDARY,
  USAGE_RELATION_CONTRACT,
  USAGE_RELATION_THRESHOLD,
  inferUsageRelation,
  neutralUsageRelationProfile,
  usageRelationHeadInterval,
  validateUsageRelationProfile,
  validateUsageTokenTable,
} from "../dist/search-input-host.js";

const tokens = validateUsageTokenTable({
  query: ["搜索", "查询", "检索", "search", "query"],
  field: ["备注", "简介", "昵称", "密码", "note", "评论", "回复"],
  negation: ["禁止", "不要", "无需"],
  writeSubmit: ["添加", "保存", "提交", "发送"],
});

const DIMS = USAGE_FORM_FEATURE_NAMES.length;

/** An observation whose every channel is measured empty. */
function observation(overrides = {}) {
  return {
    ref: "c1",
    scopeRef: "scope-1",
    documentRef: "doc-1",
    observationId: "obs-1",
    revision: 3,
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
  };
}

/** A profile with explicit per-feature weights built by name, not position. */
function profileFrom(queryByName = {}, fieldByName = {}) {
  const build = table => USAGE_FORM_FEATURE_NAMES.map(name => table[name] ?? 0);
  return {
    contract: USAGE_RELATION_CONTRACT,
    features: [...USAGE_FORM_FEATURE_NAMES],
    queryWeights: build(queryByName),
    fieldWeights: build(fieldByName),
    threshold: USAGE_RELATION_THRESHOLD,
    calibration: "uncalibrated",
    adoption: "not_applied",
  };
}

test("the member is 27-dimensional and carries 54 parameters, not 52", () => {
  assert.equal(DIMS, 27);
  assert.equal(USAGE_RELATION_CONTRACT, "browser.search-input-usage-relation.v1");
  const profile = neutralUsageRelationProfile();
  assert.equal(profile.queryWeights.length, 27);
  assert.equal(profile.fieldWeights.length, 27);
  // No bias term: 27 + 27 is the whole parameter count.
  assert.equal(profile.queryWeights.length + profile.fieldWeights.length, 54);
});

test("the profile validator refuses a 26-dim vector and a wrong feature order", () => {
  const good = neutralUsageRelationProfile();
  assert.throws(() => validateUsageRelationProfile({ ...good, queryWeights: good.queryWeights.slice(0, 26) }),
    /27 values/);
  // A positional read is only safe if the order is the declared one.
  const reordered = [...USAGE_FORM_FEATURE_NAMES];
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  assert.throws(() => validateUsageRelationProfile({ ...good, features: reordered }), /feature order/);
});

// ---------------------------------------------------------------------------
// Ruling 3: the unmeasured interval rule.
// ---------------------------------------------------------------------------

test("a zero weight makes an unmeasured feature harmless: the head stays decided", () => {
  // The whole accessibleName channel (16..23) is unmeasured here.
  const unmeasuredAria = observation({
    accessibleName: null,
    accessibleNameCoverage: "unmeasured",
  });
  // Weights only on the label channel, which is measured, so the interval is a point.
  const profile = profileFrom(
    { "label.queryTokenPresent": 2 },
    { "label.fieldTokenPresent": 2 },
  );
  const interval = usageRelationHeadInterval(profile.queryWeights,
    // build vector: only label.queryTokenPresent true
    USAGE_FORM_FEATURE_NAMES.map(name => (name === "label.queryTokenPresent" ? true : null)));
  assert.equal(interval.lo, interval.hi, "a null feature with zero weight must not widen the interval");

  const result = inferUsageRelation({ observation: unmeasuredAria, tokens }, { profile });
  // Nothing measured is true, so no head reaches: decided as unsupported, not unmeasured.
  assert.equal(result.state, "ambiguous");
  assert.equal(result.reason, "unsupported_relation");
  assert.equal(typeof result.querySupport, "number", "a decided head reports a finite score");
});

test("a nonzero weight on an unmeasured feature makes the head undetermined and the scores null", () => {
  const unmeasuredAria = observation({
    accessibleName: null,
    accessibleNameCoverage: "unmeasured",
  });
  // Putting weight on an accessibleName feature means that missing channel can
  // flip the verdict, so the member must abstain instead of guessing.
  const profile = profileFrom(
    { "label.queryTokenPresent": 2, "accessibleName.queryTokenPresent": 4 },
    {},
  );
  const result = inferUsageRelation({ observation: unmeasuredAria, tokens }, { profile });
  assert.equal(result.state, "unmeasured");
  assert.equal(result.querySupport, null, "an undetermined head must not fabricate a point score");
  assert.equal(result.fieldSupport, null);
  assert.equal(result.reason, null, "unmeasured is not an ambiguity reason");
});

test("null is never turned into false: an all-unmeasured control is not 'measured empty'", () => {
  const allUnmeasured = observation({
    labels: null,
    labelCoverage: "unmeasured",
    placeholder: null,
    placeholderCoverage: "unmeasured",
    accessibleName: null,
    accessibleNameCoverage: "unmeasured",
    ownedSubmits: null,
    associationCoverage: "unmeasured",
  });
  // Any nonzero weight can be moved by the unknown completion.
  const profile = profileFrom({ "label.queryTokenPresent": 1 }, {});
  const result = inferUsageRelation({ observation: allUnmeasured, tokens }, { profile });
  assert.equal(result.state, "unmeasured");
  assert.notEqual(result.state, "ambiguous");
  assert.equal(result.querySupport, null);
});

test("the interval endpoints follow the weight sign", () => {
  const vector = [null, null];
  const positive = usageRelationHeadInterval([3, -2], vector);
  // Positive weight can reach 3, negative weight can drop by 2.
  assert.equal(positive.lo, -2);
  assert.equal(positive.hi, 3);

  const negative = usageRelationHeadInterval([-3, 2], vector);
  assert.equal(negative.lo, -3);
  assert.equal(negative.hi, 2);
});

test("a head whose interval straddles the boundary is undetermined, not decided by the point", () => {
  // lo below the boundary, hi above it: the completion decides, so abstain.
  const straddle = usageRelationHeadInterval([1.2], [null]);
  assert.ok(straddle.lo < USAGE_RELATION_BOUNDARY && straddle.hi >= USAGE_RELATION_BOUNDARY);
  assert.equal(straddle.verdict, "undetermined");

  // Entirely below: decided "below" even though one feature is unmeasured,
  // because even the largest completion cannot reach the boundary.
  const below = usageRelationHeadInterval([0.4], [null]);
  assert.equal(below.lo, 0);
  assert.equal(below.hi, 0.4);
  assert.equal(below.verdict, "below");

  // Unmeasured evidence can never decide "reaches" on its own: its floor is 0,
  // which sits below the boundary. Only measured positive evidence can carry a
  // head over the threshold, and then the unmeasured slack must not pull it back.
  const unmeasuredOnly = usageRelationHeadInterval([0.8], [null]);
  assert.equal(unmeasuredOnly.verdict, "undetermined", "an unknown completion cannot be the only reason a head reaches");

  const measuredPlusSlack = usageRelationHeadInterval([1.0, 0.2], [true, null]);
  assert.equal(measuredPlusSlack.lo, 1.0);
  assert.equal(measuredPlusSlack.hi, 1.2);
  assert.equal(measuredPlusSlack.verdict, "reaches", "measured evidence decides even with unknown slack beside it");
});

// ---------------------------------------------------------------------------
// The four states.
// ---------------------------------------------------------------------------

test("query evidence alone yields query_action; field evidence alone yields field_description", () => {
  const observed = observation({ placeholder: "搜索", placeholderCoverage: "complete" });
  const asQuery = inferUsageRelation({ observation: observed, tokens }, {
    profile: profileFrom({ "placeholder.queryTokenPresent": 2 }, { "placeholder.queryTokenPresent": -2 }),
  });
  assert.equal(asQuery.state, "query_action");
  assert.ok(asQuery.querySupport > 0.5 && asQuery.fieldSupport < 0.5);

  const asField = inferUsageRelation({ observation: observed, tokens }, {
    profile: profileFrom({ "placeholder.queryTokenPresent": -2 }, { "placeholder.queryTokenPresent": 2 }),
  });
  assert.equal(asField.state, "field_description");
});

test("both heads reaching is a conflict; neither reaching is unsupported", () => {
  const observed = observation({ placeholder: "搜索", placeholderCoverage: "complete" });
  const conflict = inferUsageRelation({ observation: observed, tokens }, {
    profile: profileFrom({ "placeholder.queryTokenPresent": 2 }, { "placeholder.queryTokenPresent": 2 }),
  });
  assert.equal(conflict.state, "ambiguous");
  assert.equal(conflict.reason, "conflicting_support");

  const unsupported = inferUsageRelation({ observation: observed, tokens }, {
    profile: profileFrom({ "placeholder.queryTokenPresent": -2 }, { "placeholder.queryTokenPresent": -2 }),
  });
  assert.equal(unsupported.state, "ambiguous");
  assert.equal(unsupported.reason, "unsupported_relation");
});

test("conflicting and unsupported ambiguities stay distinguishable", () => {
  const observed = observation({ placeholder: "搜索", placeholderCoverage: "complete" });
  const a = inferUsageRelation({ observation: observed, tokens }, {
    profile: profileFrom({ "placeholder.queryTokenPresent": 2 }, { "placeholder.queryTokenPresent": 2 }),
  });
  const b = inferUsageRelation({ observation: observed, tokens }, {
    profile: profileFrom({ "placeholder.queryTokenPresent": -2 }, { "placeholder.queryTokenPresent": -2 }),
  });
  assert.equal(a.state, b.state, "both are ambiguous");
  assert.notEqual(a.reason, b.reason, "but the reasons must not collapse into one");
});

// ---------------------------------------------------------------------------
// Ruling 1: the 27th bit is what makes the page-01 class decidable.
// ---------------------------------------------------------------------------

test("a control whose only true bit is the button field token can be decided", () => {
  // This is the page-01 shape: no label, no placeholder, empty measured aria,
  // and an owned submit caption carrying a field token.
  const observed = observation({
    ownedSubmits: [{ caption: "发表评论", association: "same_form_owner", captionCoverage: "complete" }],
  });
  const profile = profileFrom(
    { "ownedSubmit.fieldTokenPresent": -2, "ownedSubmit.queryTokenPresent": 1.5 },
    { "ownedSubmit.fieldTokenPresent": 2 },
  );
  const result = inferUsageRelation({ observation: observed, tokens }, { profile });
  assert.equal(result.state, "field_description",
    "the appended bit must be able to carry the page-01 class to a verdict");
  assert.ok(result.fieldSupport > 0.5);
});

test("the member never reports a state it cannot support as measured", () => {
  // Determinism: same inputs, same answer, and the score is a real tanh value.
  const observed = observation({ placeholder: "搜索", placeholderCoverage: "complete" });
  const profile = profileFrom({ "placeholder.queryTokenPresent": 1 }, {});
  const once = inferUsageRelation({ observation: observed, tokens }, { profile });
  const twice = inferUsageRelation({ observation: observed, tokens }, { profile });
  assert.deepEqual(once, twice);
  assert.equal(once.querySupport, Math.tanh(1));
  assert.equal(once.observedRevision, 3, "the observed revision is carried through for staleness checks");
});
