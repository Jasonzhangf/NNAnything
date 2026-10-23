import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadWorkflow } from "nnanything";
import { DEFAULT_BASIC_KIND_PROFILE, migrateBasicKindProfile } from "nnanything/browser";

import {
  EXPECTED_TRAINABLE_WIRES,
  applyBindings,
  enumerateTrainableCells,
  readRecipe,
  readStartProfile,
  validateExplicitUsage,
} from "../playground/browser/focus-ignore/train.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const candidatePath = join(
  repositoryRoot,
  "training/weights/dom-basic-kinds/ignore-capability-20261021.weight.json",
);

function weightAsset(overrides = {}) {
  const profile = structuredClone(DEFAULT_BASIC_KIND_PROFILE);
  profile.id = "focus-ignore-file-start-test";
  return {
    targetOperator: "dom.basic_kinds",
    operatorVersion: "0.1.0",
    contractVersion: 1,
    taskId: "dom.basic-kinds.v1",
    profileId: profile.id,
    baseProfileId: "dom-basic-kinds-handwritten-v2",
    calibrated: false,
    compatibility: { taskId: "dom.basic-kinds.v1", minScore: 0.6, minMargin: 0.15 },
    profile,
    ...overrides,
  };
}

function validRecipe(overrides = {}) {
  return {
    epochs: 200,
    learningRate: 0.02,
    anchorLambda: 0.001,
    trainableWires: [...EXPECTED_TRAINABLE_WIRES],
    objective: { targetScore: 0.8, rivalCeiling: 0.4, otherGap: 0.05 },
    explicitUsage: [
      { sampleId: "s0", usage: "train" },
      { sampleId: "s1", usage: "eval" },
    ],
    ...overrides,
  };
}

test("file start consumer binds both fit and compare to the file profile, never DEFAULT", async () => {
  const root = await mkdtemp(join(tmpdir(), "nnanything-file-start-"));
  const weightPath = join(root, "current.weight.json");
  await writeFile(weightPath, JSON.stringify(weightAsset()));

  const start = readStartProfile(weightPath);
  assert.equal(start.profileId, "focus-ignore-file-start-test");
  assert.notEqual(start.profileId, DEFAULT_BASIC_KIND_PROFILE.id);
  assert.notEqual(start.profileId, "dom-basic-kinds-handwritten-v2");

  const definition = await loadWorkflow({
    configPath: join(repositoryRoot, "workflows/node-training.workflow.json"),
    allowedRoot: repositoryRoot,
  });
  applyBindings(definition, {
    profileId: start.profileId,
    target: {
      taskId: "dom.basic-kinds.v1",
      minScore: 0.6,
      minMargin: 0.15,
      objective: { targetScore: 0.8, rivalCeiling: 0.4, otherGap: 0.05 },
      fit: { epochs: 200, learningRate: 0.02, anchorLambda: 0.001 },
    },
    explicitUsage: validRecipe().explicitUsage,
  });
  assert.equal(definition.bindings["拟合目标节点参数"].profileId, start.profileId);
  assert.equal(definition.bindings["比较新旧节点在相同样本的输出"].profileId, start.profileId);
  assert.equal(definition.bindings["准备节点输入与期望输出"].config.inputScope, "candidate_qualified");

  await rm(root, { recursive: true, force: true });
});

test("file start consumer rejects bad or incompatible assets without DEFAULT fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "nnanything-file-start-bad-"));
  const invalid = join(root, "invalid.weight.json");
  await writeFile(invalid, "not json");
  assert.throws(() => readStartProfile(invalid), /weight asset/i);

  const wrongTask = join(root, "wrong-task.weight.json");
  await writeFile(wrongTask, JSON.stringify(weightAsset({ taskId: "other-task" })));
  assert.throws(() => readStartProfile(wrongTask), /task|compat/i);

  const wrongThreshold = join(root, "wrong-threshold.weight.json");
  await writeFile(wrongThreshold, JSON.stringify(weightAsset({
    compatibility: { taskId: "dom.basic-kinds.v1", minScore: 0.5, minMargin: 0.15 },
  })));
  assert.throws(() => readStartProfile(wrongThreshold), /minScore|threshold/i);

  await rm(root, { recursive: true, force: true });
});

test("recipe validation pins the fixed 18 wires and compatible objective", () => {
  const recipe = readRecipe(validRecipe());
  assert.equal(recipe.trainableWires.length, 18);
  assert.deepEqual(recipe.objective, { targetScore: 0.8, rivalCeiling: 0.4, otherGap: 0.05 });
  assert.deepEqual(recipe.explicitUsage, validRecipe().explicitUsage);

  assert.throws(
    () => readRecipe(validRecipe({ trainableWires: EXPECTED_TRAINABLE_WIRES.slice(0, 17) })),
    /trainableWires/,
  );
  assert.throws(
    () => readRecipe(validRecipe({ boundarySlack: 0.0001 })),
    /priority_decision_v1|boundarySlack/,
  );
});

test("recipe validation accepts the C-RivalCeiling-0.6 objective once the consumer adopts the public config validator", () => {
  const recipe = readRecipe(validRecipe({ objective: { targetScore: 0.8, rivalCeiling: 0.6, otherGap: 0.05 } }));
  assert.deepEqual(recipe.objective, { targetScore: 0.8, rivalCeiling: 0.6, otherGap: 0.05 });
  assert.deepEqual(readRecipe(validRecipe()).objective, { targetScore: 0.8, rivalCeiling: 0.4, otherGap: 0.05 });
});

test("trainable cell enumeration selects whole addresses by wire name and reports unselected cells", () => {
  const profile = migrateBasicKindProfile(structuredClone(DEFAULT_BASIC_KIND_PROFILE));
  const wires = ["neutral_actual_focus", "neutral_focusable_control", "own_focus_target"];
  const cells = enumerateTrainableCells(profile, wires);
  assert.equal(cells.wireCount, wires.length);
  assert.ok(cells.cellCount > 0);
  assert.equal(cells.selected.length, cells.cellCount);
  assert.ok(cells.selected.every(cell => wires.some(wire => cell.fullAddress.endsWith(`.${wire}`))));
  assert.ok(cells.unselectedSample.length > 0);
});

test("actual ignore candidate exposes the expected 78 trainable addresses", { skip: !existsSync(candidatePath) }, () => {
  const start = readStartProfile(candidatePath);
  const cells = enumerateTrainableCells(start.profile, EXPECTED_TRAINABLE_WIRES);
  assert.equal(cells.wireCount, 18);
  assert.equal(cells.cellCount, 78);
  assert.equal(cells.sparseCellCount, 301);
  assert.equal(cells.registeredWireCount, 81);
});

test("explicit usage coverage validation rejects missing and unknown sample ids", () => {
  const included = new Set(["s0", "s1"]);
  validateExplicitUsage(validRecipe().explicitUsage, included);
  assert.throws(
    () => validateExplicitUsage(
      [{ sampleId: "s0", usage: "train" }],
      included,
    ),
    /missing|s1/,
  );
  assert.throws(
    () => validateExplicitUsage(
      [
        { sampleId: "s0", usage: "train" },
        { sampleId: "s1", usage: "eval" },
        { sampleId: "s2", usage: "train" },
      ],
      included,
    ),
    /unknown|s2/,
  );
});
