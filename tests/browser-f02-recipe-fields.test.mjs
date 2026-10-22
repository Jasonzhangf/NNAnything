import assert from "node:assert/strict";
import { test } from "node:test";

import { assertRecipeFields, declareRecipeConditions } from "nnanything/browser-feedback";

// R5 failed because the recipe required an explicit rejection with unknown
// effects, but instantiation wrote effectKnowledge: "known" in both places.
function r5Case({ resultEffect = "known", nestedEffect = "known", receiptEffect = "known" } = {}) {
  return {
    result: {
      dispatchState: "dispatched",
      effectKnowledge: resultEffect,
      receipt: {
        dispatched: true,
        ok: false,
        effectKnowledge: nestedEffect,
        source: "r5-fixture",
        error: null,
      },
    },
    receipt: {
      dispatched: true,
      ok: false,
      effectKnowledge: receiptEffect,
      source: "r5-fixture",
      error: null,
    },
    teacher: { head: "execution_rejected" },
    prediction: { status: "predicted", head: "indeterminate" },
  };
}

test("declareRecipeConditions flattens nested recipe fields into dotted paths", () => {
  assert.deepEqual(
    declareRecipeConditions({ receipt: { effectKnowledge: "unknown" } }),
    [{ path: "receipt.effectKnowledge", expected: "unknown" }],
  );
  assert.deepEqual(
    declareRecipeConditions({ "receipt.effectKnowledge": "unknown" }),
    [{ path: "receipt.effectKnowledge", expected: "unknown" }],
  );
});

test("R5 recipe requires receipt.effectKnowledge unknown but instance says known", () => {
  const conditions = declareRecipeConditions({ receipt: { effectKnowledge: "unknown" } });
  assert.throws(
    () => assertRecipeFields(r5Case({ receiptEffect: "known" }), conditions),
    error => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /receipt\.effectKnowledge/);
      assert.match(error.message, /"unknown"/);
      assert.match(error.message, /"known"/);
      return true;
    },
  );
  const nested = declareRecipeConditions({ result: { receipt: { effectKnowledge: "unknown" } } });
  assert.throws(
    () => assertRecipeFields(r5Case({ nestedEffect: "known" }), nested),
    /recipe_field_mismatch:result\.receipt\.effectKnowledge/,
  );
});

test("recipe requiring unknown passes when receipt.effectKnowledge is unknown", () => {
  const conditions = declareRecipeConditions({ receipt: { effectKnowledge: "unknown" } });
  assert.doesNotThrow(() => assertRecipeFields(r5Case({ receiptEffect: "unknown" }), conditions));
});

test("result.effectKnowledge and receipt.effectKnowledge are checked independently", () => {
  const conditions = declareRecipeConditions({
    result: { effectKnowledge: "unknown", receipt: { effectKnowledge: "unknown" } },
    receipt: { effectKnowledge: "unknown" },
  });
  assert.doesNotThrow(() => assertRecipeFields(
    r5Case({ resultEffect: "unknown", nestedEffect: "unknown", receiptEffect: "unknown" }),
    conditions,
  ));
  assert.throws(
    () => assertRecipeFields(r5Case({ resultEffect: "known", nestedEffect: "unknown", receiptEffect: "unknown" }), conditions),
    /recipe_field_mismatch:result\.effectKnowledge/,
  );
  assert.throws(
    () => assertRecipeFields(r5Case({ resultEffect: "unknown", nestedEffect: "known", receiptEffect: "unknown" }), conditions),
    /recipe_field_mismatch:result\.receipt\.effectKnowledge/,
  );
  assert.throws(
    () => assertRecipeFields(r5Case({ resultEffect: "unknown", nestedEffect: "unknown", receiptEffect: "known" }), conditions),
    /recipe_field_mismatch:receipt\.effectKnowledge/,
  );
});

test("missing recipe path is reported as missing instead of being treated as unknown", () => {
  const conditions = declareRecipeConditions({ receipt: { effectKnowledge: "unknown" } });
  assert.throws(
    () => assertRecipeFields({ receipt: {} }, conditions),
    error => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /^recipe_field_missing:receipt\.effectKnowledge/);
      assert.match(error.message, /"unknown"/);
      return true;
    },
  );
  assert.throws(
    () => assertRecipeFields({}, conditions),
    error => error instanceof TypeError
      && /^recipe_field_missing:receipt\.effectKnowledge/.test(error.message),
  );
});

test("multiple conditions report the first mismatch with a clear path", () => {
  const conditions = [
    { path: "receipt.dispatched", expected: true },
    { path: "receipt.effectKnowledge", expected: "unknown" },
    { path: "result.effectKnowledge", expected: "unknown" },
  ];
  assert.throws(
    () => assertRecipeFields(r5Case(), conditions),
    error => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /^recipe_field_mismatch:receipt\.effectKnowledge/);
      assert.doesNotMatch(error.message, /result\.effectKnowledge/);
      return true;
    },
  );
});

test("assertion checks only declared fields and never mutates the instance or gold", () => {
  const instance = r5Case();
  const before = structuredClone(instance);
  const conditions = declareRecipeConditions({ receipt: { effectKnowledge: "unknown" } });
  assert.throws(() => assertRecipeFields(instance, conditions), TypeError);
  assert.deepEqual(instance, before);
  assert.equal(instance.teacher.head, "execution_rejected");
  assert.equal(instance.prediction.head, "indeterminate");

  const undeclared = structuredClone(instance);
  undeclared.teacher = { head: "indeterminate" };
  undeclared.receipt.effectKnowledge = "unknown";
  assert.doesNotThrow(() => assertRecipeFields(
    undeclared,
    declareRecipeConditions({ receipt: { effectKnowledge: "unknown" } }),
  ));
});
