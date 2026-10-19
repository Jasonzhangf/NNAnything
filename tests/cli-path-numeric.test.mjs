import assert from "node:assert/strict";
import { test } from "node:test";

const handwiredRoot = "/Volumes/extension/code/handwired";

function features({ phase, absoluteInput = false, kind = null, stackEmpty = true }) {
  const start = phase === "start";
  const kindParent = kind === "parent" ? 1 : 0;
  const empty = stackEmpty ? 1 : 0;
  return [
    1,
    start ? 1 : 0,
    start ? 0 : 1,
    absoluteInput ? 1 : 0,
    kind === "current" ? 1 : 0,
    kindParent,
    kind === "name" ? 1 : 0,
    empty,
    kindParent * empty,
  ];
}

function toyRows() {
  return [
    { features: features({ phase: "start", absoluteInput: false }), expected: "START_FROM_CWD" },
    { features: features({ phase: "start", absoluteInput: true }), expected: "START_FROM_ROOT" },
    { features: features({ phase: "segment", kind: "name", stackEmpty: false }), expected: "PUSH_NAME" },
    { features: features({ phase: "segment", kind: "parent", stackEmpty: false }), expected: "POP_PARENT" },
    { features: features({ phase: "segment", kind: "current", stackEmpty: false }), expected: "STAY" },
    { features: features({ phase: "segment", kind: "parent", stackEmpty: true }), expected: "STAY" },
  ];
}

test("Handwired circuit exposes 45 parameters, 9 features and 5 dynamic logits", async () => {
  const { buildPathCircuit } = await import("../dist/nodes/trainable/cli-path-controller.js");
  const { loadHandwired } = await import("../dist/training/handwired.js");
  const module = await loadHandwired(handwiredRoot);
  const circuit = buildPathCircuit(module);
  assert.equal(circuit.parameterWires.length, 45);
  assert.equal(circuit.featureWires.length, 9);
  assert.equal(circuit.logitWires.length, 5);
});

test("real Handwired full-batch SGD changes parameters and lowers loss", async () => {
  const { fitPathController } = await import("../dist/training/cli-path-numeric.js");
  const { PATH_ACTIONS, scorePathActions, zeroPathProfile } = await import("../dist/filters/cli-path-controller.js");
  const initial = zeroPathProfile();
  const rows = toyRows();
  const result = await fitPathController({ rows, initial, handwiredRoot, epochs: 200, learningRate: 0.1 });
  assert.equal(result.trajectory.length, 200);
  assert.ok(result.trajectory.at(-1).loss < result.trajectory[0].loss);
  assert.notDeepEqual(result.profile.weights, initial.weights);
  assert.deepEqual(initial.weights, zeroPathProfile().weights);
  assert.equal(result.profile.calibration, "uncalibrated");
  assert.equal(result.profile.adoption, "not_applied");
  for (const row of rows) {
    const scores = scorePathActions(row.features, result.profile);
    assert.equal(PATH_ACTIONS[scores.indexOf(Math.max(...scores))], row.expected);
  }
  assert.equal(result.timing.trainableParamCount, 45);
  assert.equal(result.timing.processedRowCount, rows.length);
  assert.equal(result.timing.gradientRowEpochs, 200 * rows.length);
  assert.equal(result.timing.totalRowPasses, rows.length * (1 + 200 + 1));
});

test("epochs zero is a frozen control and missing backend preserves timing", async () => {
  const { fitPathController } = await import("../dist/training/cli-path-numeric.js");
  const { zeroPathProfile } = await import("../dist/filters/cli-path-controller.js");
  const initial = zeroPathProfile();
  const rows = toyRows();
  const frozen = await fitPathController({ rows, initial, handwiredRoot, epochs: 0, learningRate: 0.1 });
  assert.deepEqual(frozen.profile, initial);
  assert.equal(frozen.trajectory.length, 0);
  assert.equal(frozen.timing.completedEpochs, 0);
  assert.equal(frozen.timing.gradientRowEpochs, 0);
  assert.equal(frozen.timing.totalRowPasses, 0);
  assert.equal(frozen.timing.trainableParamCount, 0);
  const frozenWithoutBackend = await fitPathController({
    rows,
    initial,
    handwiredRoot: "/definitely/missing/handwired",
    epochs: 0,
    learningRate: 0.1,
  });
  assert.deepEqual(frozenWithoutBackend.profile, initial);
  assert.equal(frozenWithoutBackend.timing.backendLoadMs, 0);

  await assert.rejects(
    fitPathController({ rows, initial, handwiredRoot: "/definitely/missing/handwired", epochs: 1, learningRate: 0.1 }),
    error => {
      assert.match(error.message, /Handwired core is missing/);
      assert.equal(error.completedEpochs, 0);
      assert.equal(error.timing.processedRowCount, rows.length);
      assert.equal(error.timing.trainableParamCount, 45);
      assert.ok(error.timing.backendLoadMs > 0);
      assert.ok(error.timing.fitTotalMs > 0);
      return true;
    },
  );
});

test("fit boundary rejects malformed rows and controls with timing attached", async () => {
  const { fitPathController } = await import("../dist/training/cli-path-numeric.js");
  const { zeroPathProfile } = await import("../dist/filters/cli-path-controller.js");
  const valid = { features: Array(9).fill(0), expected: "STAY" };
  const base = {
    rows: [valid],
    initial: zeroPathProfile(),
    handwiredRoot,
    epochs: 1,
    learningRate: 0.1,
  };
  const cases = [
    { ...base, rows: [] },
    { ...base, rows: [{ features: [1], expected: "STAY" }] },
    { ...base, rows: [{ features: [1, 0, 0, 0, 0, 0, 0, 0, Number.NaN], expected: "STAY" }] },
    { ...base, rows: [{ features: Array(9).fill(0), expected: "NOT_AN_ACTION" }] },
    { ...base, epochs: -1 },
    { ...base, epochs: 1.5 },
    { ...base, learningRate: 0 },
    { ...base, handwiredRoot: "" },
  ];
  for (const value of cases) {
    await assert.rejects(fitPathController(value), error => {
      assert.ok(error.timing);
      assert.equal(error.completedEpochs, 0);
      return true;
    });
  }
});
