import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyBA1TrainingEligibility,
  independentEvaluationDenominators,
  validateBA1EvaluatorGold,
} from "../dist/training/b-a1-sample-evaluator-skeleton.js";

test("only labeled selected/ambiguous rows are training-eligible", () => {
  assert.deepEqual(classifyBA1TrainingEligibility("labeled_selected"), { trainingEligible: true, evaluationClass: "semantic" });
  assert.deepEqual(classifyBA1TrainingEligibility("labeled_ambiguous"), { trainingEligible: true, evaluationClass: "semantic" });
  assert.deepEqual(classifyBA1TrainingEligibility("labeled_none"), { trainingEligible: false, evaluationClass: "none" });
  assert.deepEqual(classifyBA1TrainingEligibility("observation_missing"), { trainingEligible: false, evaluationClass: "insufficient" });
  assert.deepEqual(classifyBA1TrainingEligibility("unresolved_supervision"), { trainingEligible: false, evaluationClass: "unresolved" });
});

test("the semantic, contract-gate and aggregator-test families stay on separate denominators", () => {
  const skeleton = {
    semantic: [{ family: "model-semantic" }, { family: "model-semantic" }],
    contractGate: [{ family: "contract-gate" }],
    aggregatorTest: [{ family: "aggregator-test" }, { family: "aggregator-test" }, { family: "aggregator-test" }],
  };
  assert.deepEqual(independentEvaluationDenominators(skeleton), { semantic: 2, contract: 1, aggregator: 3 });
});

test("reject gold is a separate channel and is never a bound none", () => {
  assert.doesNotThrow(() => validateBA1EvaluatorGold({ kind: "reject", reason: "outside_scope", family: "A", group: "g1" }));
  assert.throws(() => validateBA1EvaluatorGold({ kind: "reject", reason: "outside_scope", selectedRef: "x", family: "A", group: "g1" }));
  assert.throws(() => validateBA1EvaluatorGold({ kind: "reject", reason: "made_up", family: "A", group: "g1" }));
});

test("bound gold enforces the selected / non-selected selectedRef rule", () => {
  assert.doesNotThrow(() => validateBA1EvaluatorGold({ kind: "bound", state: "selected", selectedRef: "c1", family: "A", group: "g1" }));
  assert.throws(() => validateBA1EvaluatorGold({ kind: "bound", state: "selected", selectedRef: null, family: "A", group: "g1" }));
  assert.doesNotThrow(() => validateBA1EvaluatorGold({ kind: "bound", state: "ambiguous", selectedRef: null, family: "A", group: "g1" }));
  assert.throws(() => validateBA1EvaluatorGold({ kind: "bound", state: "none", selectedRef: "c1", family: "A", group: "g1" }));
});
