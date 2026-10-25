// B-A1 m2 R2: black-box tests for the production composition entry.
//
// These tests cover the milestone review P1-2 finding. Before the entry existed,
// the member-to-binder wiring lived only in a run-directory script, so the
// 36-wire binder could never receive real member support from production code.
// Each test drives the public entry `bindSearchInputHostScope` end to end:
// observe -> project -> member infer -> attach support -> binder infer.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  USAGE_FORM_FEATURE_NAMES,
  USAGE_RELATION_CONTRACT,
  SEARCH_INPUT_HOST_WIRES,
  bindSearchInputHostScope,
  neutralSearchInputHostProfile,
  validateSearchInputHostProfile,
  validateUsageRelationProfile,
  validateUsageTokenTable,
} from "../dist/search-input-host.js";

// The projection and the observation layer read a real DOM. These stubs are the
// smallest surface those layers touch, so the composition itself stays real.
globalThis.document = { documentElement: { clientWidth: 1200, clientHeight: 800 } };
globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1" });

const TOKENS = validateUsageTokenTable({
  query: ["搜索", "查询", "检索", "search", "query"],
  field: ["备注", "简介", "昵称", "密码", "note", "评论", "回复"],
  negation: ["禁止", "不要", "无需"],
  writeSubmit: ["添加", "保存", "提交", "发送"],
});

function element(overrides = {}) {
  return {
    tagName: "INPUT",
    textContent: "",
    labels: [],
    isContentEditable: false,
    readOnly: false,
    closest: () => null,
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 200, height: 24, top: 10, left: 10, right: 210, bottom: 34 }),
    // The projection walks parentElement to band the DOM depth.
    parentElement: null,
    ...overrides,
  };
}

const searchForm = element({
  tagName: "FORM",
  getAttribute: name => (name === "role" ? "search" : null),
  querySelector: selector => (selector.includes("submit") ? element({ tagName: "BUTTON" }) : null),
});

/** A search box whose form is role=search and owns a submit control. */
const searchHost = () => element({
  labels: [element({ tagName: "LABEL", textContent: "搜索" })],
  getAttribute: name => (name === "type" ? "search" : name === "placeholder" ? "输入关键词" : null),
  closest: selector => (selector === "form" ? searchForm : null),
});

/** Binder profile that reads the marker wires and both member support wires. */
function dependantProfile() {
  const neutral = neutralSearchInputHostProfile();
  const changes = {
    "type.search": 1,
    "hasPlaceholder": 1,
    "markerHit": 2,
    "formRoleSearch": 1,
    "nonSearchMarker": -2,
    "usage.query_support": 1,
    "usage.field_support": -1,
  };
  const weights = neutral.weights.map((weight, index) => changes[SEARCH_INPUT_HOST_WIRES[index]] ?? weight);
  return validateSearchInputHostProfile({ ...neutral, weights });
}

function projectionInput(nodes, overrides = {}) {
  return {
    scopeRef: "scope-1",
    documentRef: "doc-1",
    observationId: "obs-1",
    revision: 1,
    scopeRoot: searchForm,
    nodes,
    // observeLiveDom measured these facts before the projection runs; the
    // projection must receive them, never coerce them itself.
    propertiesOf: () => ({ explicitTabIndexKind: "absent", tabIndexFocus: false }),
    coverage: {
      scopeRef: "scope-1",
      observedCandidateCount: nodes.length,
      unassessedIframeCount: 0,
      unassessedObjectCount: 0,
      unassessedOpenShadowRootCount: 0,
      excluded: [],
    },
    access: "available",
    ...overrides,
  };
}

/** A member profile that reads exactly one named feature with weight 4. */
function singleFeatureProfile(name) {
  const index = USAGE_FORM_FEATURE_NAMES.indexOf(name);
  assert.ok(index >= 0, `unknown feature ${name}`);
  const raw = {
    contract: USAGE_RELATION_CONTRACT,
    features: [...USAGE_FORM_FEATURE_NAMES],
    queryWeights: USAGE_FORM_FEATURE_NAMES.map(() => 0),
    fieldWeights: USAGE_FORM_FEATURE_NAMES.map(() => 0),
    threshold: 0.5,
    calibration: "uncalibrated",
    adoption: "not_applied",
  };
  raw.queryWeights[index] = 4;
  return validateUsageRelationProfile(raw);
}

test("the composition entry runs observe -> member -> binder and selects the search host", () => {
  const outcome = bindSearchInputHostScope(
    projectionInput([{ nodeRef: "c1", element: searchHost() }]),
    { profile: dependantProfile(), usageProfile: singleFeatureProfile("label.queryTokenPresent"), usageTokens: TOKENS },
  );
  assert.equal(outcome.result.state, "selected", JSON.stringify(outcome.result));
  assert.equal(outcome.result.selectedRef, "c1");
  assert.equal(outcome.member.length, 1, "one member report per projected candidate");
  const candidate = outcome.request.candidates[0];
  assert.equal(typeof candidate.usageQuerySupport, "number",
    "the candidate the binder scored carries a real member support");
});

test("the composition entry keeps an abstained member null so the binder can reject it", () => {
  // labels: null leaves the label channel unmeasured, so the member's only
  // weighted feature is unmeasured and the head abstains.
  const outcome = bindSearchInputHostScope(
    projectionInput([{ nodeRef: "c1", element: element({ labels: null }) }]),
    { profile: dependantProfile(), usageProfile: singleFeatureProfile("label.queryTokenPresent"), usageTokens: TOKENS },
  );
  assert.equal(outcome.member[0].state, "unmeasured");
  assert.equal(outcome.member[0].querySupport, null);
  assert.equal(outcome.request.candidates[0].usageQuerySupport, null,
    "an abstained support must survive composition as null");
  assert.equal(outcome.result.state, "insufficient_observation");
  assert.equal(outcome.result.rejection, "unmeasured_candidate_fields");
});

test("an all-zero binder profile is not turned into a support dependency by composition", () => {
  // The member abstains, but an old binder profile reads neither support wire.
  // A missing support must not become a rejection for it: the guard is
  // profile-aware, so legacy calls keep their previous behaviour.
  const outcome = bindSearchInputHostScope(
    projectionInput([{ nodeRef: "c1", element: element({ labels: null }) }]),
    {
      profile: neutralSearchInputHostProfile(),
      usageProfile: singleFeatureProfile("label.queryTokenPresent"),
      usageTokens: TOKENS,
    },
  );
  assert.notEqual(outcome.result.rejection, "unmeasured_candidate_fields");
});

test("the composition entry passes the live evidence map to the member observation", () => {
  // The accessible name arrives on the evidence map, not the properties map.
  // A member reading accessibleName.queryTokenPresent must see it; the same
  // scope without evidence must abstain on that channel.
  const withEvidence = bindSearchInputHostScope(
    {
      ...projectionInput([{ nodeRef: "c1", element: element({ labels: [] }) }]),
      evidenceOf: () => ({ accessibleName: "搜索", accessibleNameCoverage: "complete" }),
    },
    {
      profile: neutralSearchInputHostProfile(),
      usageProfile: singleFeatureProfile("accessibleName.queryTokenPresent"),
      usageTokens: TOKENS,
    },
  );
  const withoutEvidence = bindSearchInputHostScope(
    projectionInput([{ nodeRef: "c1", element: element({ labels: [] }) }]),
    {
      profile: neutralSearchInputHostProfile(),
      usageProfile: singleFeatureProfile("accessibleName.queryTokenPresent"),
      usageTokens: TOKENS,
    },
  );
  assert.equal(withEvidence.member[0].state, "query_action",
    "a present accessible name makes the head decisive");
  assert.equal(withoutEvidence.member[0].state, "unmeasured",
    "no accessible name evidence leaves the channel unmeasured");
});
