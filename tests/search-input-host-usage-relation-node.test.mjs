// B-A1 m2 R2 red tests for the usage-relation member fitter.
//
// The fitter is not a free optimizer: the independent planner wrote the budget,
// learning rate and loss once, and these tests bind the contract the fitter must
// keep (class balance, deterministic bound, interval-consistent success).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  USAGE_FORM_FEATURE_NAMES,
  trainUsageRelation,
  validateUsageTokenTable,
  inferUsageRelation,
} from "../dist/search-input-host.js";

const tokens = validateUsageTokenTable({
  query: ["搜索", "查询", "检索", "search", "query"],
  field: ["备注", "简介", "昵称", "密码", "note", "评论", "回复"],
  negation: ["禁止", "不要", "无需"],
  writeSubmit: ["添加", "保存", "提交", "发送"],
});

function observation(overrides = {}) {
  return {
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
  };
}

/** One real-shaped positive and one negative row. */
const searchRow = {
  id: "s1",
  observation: observation({ placeholder: "搜索", placeholderCoverage: "complete" }),
  judgment: "search",
};
const editRow = {
  id: "e1",
  observation: observation({ placeholder: "备注", placeholderCoverage: "complete" }),
  judgment: "edit",
};

const RESOURCES = { tokens, learningRate: 0.5, maxEpochs: 400, margin: 1.0, checkpointInterval: 50 };

test("a fit with only one class is a construction error, never a silent constant", () => {
  assert.throws(
    () => trainUsageRelation({ rows: [searchRow, { ...searchRow, id: "s2" }] }, RESOURCES),
    /both classes/,
  );
});

test("non-finite budget parameters are rejected, not defaulted", () => {
  for (const bad of [
    { ...RESOURCES, learningRate: Number.NaN },
    { ...RESOURCES, maxEpochs: 0 },
    { ...RESOURCES, margin: Number.POSITIVE_INFINITY },
  ]) {
    assert.throws(() => trainUsageRelation({ rows: [searchRow, editRow] }, bad));
  }
});

test("the fit is deterministic and respects the written budget", () => {
  const once = trainUsageRelation({ rows: [searchRow, editRow] }, RESOURCES);
  const twice = trainUsageRelation({ rows: [searchRow, editRow] }, RESOURCES);
  assert.deepEqual(once.profile.queryWeights, twice.profile.queryWeights);
  assert.deepEqual(once.profile.fieldWeights, twice.profile.fieldWeights);
  assert.equal(once.fit.lossAfter < once.fit.lossBefore, true, "the margin loss must decrease");
  assert.ok(once.fit.stopEpoch === null || (once.fit.stopEpoch >= 1 && once.fit.stopEpoch <= 400),
    `stopEpoch must respect the budget, got ${once.fit.stopEpoch}`);
  assert.ok(once.fit.epochs <= 400, "never more gradient steps than the planner wrote");
  assert.equal(once.profile.calibration, "uncalibrated");
  assert.equal(once.profile.adoption, "not_applied");
});

test("success means no train row has an undetermined head at the fitted weights", () => {
  const result = trainUsageRelation({ rows: [searchRow, editRow] }, RESOURCES);
  for (const row of result.fit.rows) {
    assert.equal(row.undeterminedHead, false,
      `row ${row.id} must be decided at the fitted weights, otherwise training and inference disagree`);
  }
  // And the inference guard agrees: the fitted profile decides the same rows.
  const saved = result.profile;
  for (const row of [searchRow, editRow]) {
    const outcome = inferUsageRelation({ observation: row.observation, tokens }, { profile: saved });
    assert.notEqual(outcome.state, "unmeasured", `row ${row.id} must not abstain after a successful fit`);
  }
});

test("ambiguous rows are reported but excluded from the gradient", () => {
  const ambiguous = {
    id: "a1",
    observation: observation({ placeholder: "搜索", placeholderCoverage: "complete" }),
    judgment: "ambiguous",
  };
  const result = trainUsageRelation({ rows: [searchRow, editRow, ambiguous] }, RESOURCES);
  assert.equal(result.fit.excludedRowCount, 1);
  const report = result.fit.rows.find(row => row.id === "a1");
  assert.equal(report.inGradient, false, "ambiguous is a guard outcome, not a learnable polarity");
  assert.equal(report.judgment, "ambiguous");
});

test("the profile carries its own feature names so reload does not need the current order", () => {
  const result = trainUsageRelation({ rows: [searchRow, editRow] }, RESOURCES);
  const saved = result.profile;
  assert.deepEqual([...saved.features], [...USAGE_FORM_FEATURE_NAMES]);
  assert.equal(saved.queryWeights.length, 27);
  assert.equal(saved.fieldWeights.length, 27);
});