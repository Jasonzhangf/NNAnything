import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  compileWorkflow,
  createWorkflowInputEvent,
  loadWorkflow,
  runWorkflow,
} from "nnanything";
import { BASIC_KIND_WIRE_NAMES } from "nnanything/browser";
import { parseBrowserWeightAsset } from "nnanything/browser-classify";
import {
  BASIC_KIND_TASK_ID,
  createTrainingNodeDefinitions,
  loadTrainingProfiles,
  prepareBasicKindSamples,
  readBasicKindTrainingRequest,
  validateBasicKindTrainingConfig,
} from "nnanything/training";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const EXPECTED_TRAINABLE_WIRES = Object.freeze([
  "neutral_same_rect_wrapper",
  "single_child_div",
  "neutral_single_child",
  "div_single_child",
  "neutral_presentation_leaf",
  "neutral_inherited_pointer_wrapper",
  "neutral_single_element_wrapper",
  "noninteractive_hidden_leaf",
  "svg_internal_part",
  "empty_border_extent",
  "nat_document_root",
  "role_presentational",
  "neutral_single_positive_wrapper",
  "neutral_coincident_layer_wrapper",
  "independent_graphic_content",
  "own_focus_target",
  "neutral_actual_focus",
  "neutral_focusable_control",
]);

function readJsonFile(file, label) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${label} ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`cannot parse ${label} ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--request", "--weight", "--recipe", "--out"].includes(flag) || value === undefined || value.startsWith("--")) {
      throw new Error("expected --request <prepared-request.json> --weight <current.weight.json> --recipe <t1.json> --out <run/t1>");
    }
    if (values.has(flag)) throw new Error(`duplicate argument ${flag}`);
    values.set(flag, value);
  }
  for (const flag of ["--request", "--weight", "--recipe", "--out"]) {
    if (!values.has(flag)) throw new Error(`missing required ${flag}`);
  }
  return {
    request: resolve(values.get("--request")),
    weight: resolve(values.get("--weight")),
    recipe: resolve(values.get("--recipe")),
    out: resolve(values.get("--out")),
  };
}

export function readStartProfile(weightPath) {
  const raw = readJsonFile(weightPath, "weight asset");
  let asset;
  try {
    asset = parseBrowserWeightAsset(raw, weightPath);
  } catch (error) {
    throw new Error(`weight asset is not compatible: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (asset.config.minScore !== 0.6 || asset.config.minMargin !== 0.15) {
    throw new Error(`weight asset threshold differs from minScore 0.6/minMargin 0.15: minScore=${asset.config.minScore}, minMargin=${asset.config.minMargin}`);
  }
  const topology = asset.profile.topology ?? "family_leaf_v1";
  if (topology !== "family_leaf_v1") {
    throw new Error(`weight asset topology must be family_leaf_v1, got ${topology}`);
  }
  return { asset, profile: asset.profile, profileId: asset.profile.id, sourceLabel: weightPath };
}

function sameWireSet(left, right) {
  const leftSet = new Set(left), rightSet = new Set(right);
  if (leftSet.size !== rightSet.size || left.length !== right.length) return false;
  return [...leftSet].every(wire => rightSet.has(wire));
}

export function readRecipe(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new TypeError("recipe must be a JSON object");
  const allowedTopLevel = new Set(["epochs", "learningRate", "anchorLambda", "trainableWires", "objective", "boundarySlack", "explicitUsage"]);
  for (const key of Object.keys(raw)) {
    if (!allowedTopLevel.has(key)) throw new TypeError(`recipe has unsupported field ${key}`);
  }

  const epochs = raw.epochs;
  if (!Number.isInteger(epochs) || epochs <= 0) throw new TypeError("recipe.epochs must be a positive integer");
  const learningRate = raw.learningRate;
  if (typeof learningRate !== "number" || !Number.isFinite(learningRate) || learningRate <= 0) throw new TypeError("recipe.learningRate must be a positive finite number");
  const anchorLambda = raw.anchorLambda;
  if (typeof anchorLambda !== "number" || !Number.isFinite(anchorLambda) || anchorLambda < 0) throw new TypeError("recipe.anchorLambda must be a nonnegative finite number");

  if (!Array.isArray(raw.trainableWires)) throw new TypeError("recipe.trainableWires must be an array");
  for (const wire of raw.trainableWires) {
    if (typeof wire !== "string" || !BASIC_KIND_WIRE_NAMES.includes(wire)) throw new TypeError(`recipe.trainableWires contains unregistered wire ${wire}`);
  }
  if (!sameWireSet(raw.trainableWires, EXPECTED_TRAINABLE_WIRES)) {
    throw new TypeError("recipe.trainableWires must be exactly the 16 ignore support wires plus neutral_actual_focus and neutral_focusable_control");
  }

  const objective = raw.objective;
  if (typeof objective !== "object" || objective === null || Array.isArray(objective)) throw new TypeError("recipe.objective must be an object");
  for (const key of Object.keys(objective)) {
    if (!["targetScore", "rivalCeiling", "otherGap"].includes(key)) throw new TypeError(`recipe.objective has unsupported field ${key}`);
  }
  if (objective.mode !== undefined || objective.boundarySlack !== undefined || raw.boundarySlack !== undefined) {
    throw new TypeError("boundarySlack/objective.mode require priority_decision_v1; family_leaf_v1 compatible objective does not use them");
  }
  const validatedObjective = validateBasicKindTrainingConfig({
    taskId: BASIC_KIND_TASK_ID,
    minScore: 0.6,
    minMargin: 0.15,
    objective,
    fit: { epochs: 1, learningRate: 0.01, anchorLambda: 0 },
  }).objective;

  if (!Array.isArray(raw.explicitUsage) || raw.explicitUsage.length === 0) {
    throw new TypeError("recipe.explicitUsage must be a nonempty array of {sampleId, usage}");
  }
  const seen = new Set();
  const explicitUsage = raw.explicitUsage.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) throw new TypeError(`recipe.explicitUsage[${index}] must be an object`);
    const sampleId = entry.sampleId;
    if (typeof sampleId !== "string" || sampleId.length === 0) throw new TypeError(`recipe.explicitUsage[${index}].sampleId must be a nonempty string`);
    if (entry.usage !== "train" && entry.usage !== "eval") throw new TypeError(`recipe.explicitUsage[${index}].usage must be train or eval`);
    if (seen.has(sampleId)) throw new TypeError(`recipe.explicitUsage contains duplicate sampleId ${sampleId}`);
    seen.add(sampleId);
    return { sampleId, usage: entry.usage };
  });

  return {
    epochs,
    learningRate,
    anchorLambda,
    trainableWires: [...EXPECTED_TRAINABLE_WIRES],
    objective: validatedObjective,
    explicitUsage,
  };
}

export function validateExplicitUsage(explicitUsage, includedSampleIds) {
  const included = new Set(includedSampleIds);
  const assigned = new Set();
  for (const entry of explicitUsage) {
    if (!included.has(entry.sampleId)) throw new TypeError(`explicitUsage has unknown or excluded sampleId ${entry.sampleId}`);
    if (assigned.has(entry.sampleId)) throw new TypeError(`explicitUsage has duplicate sampleId ${entry.sampleId}`);
    assigned.add(entry.sampleId);
  }
  for (const sampleId of included) {
    if (!assigned.has(sampleId)) throw new TypeError(`explicitUsage is missing included sampleId ${sampleId}`);
  }
}

function selectedCells(profile, wireNames) {
  const selected = [];
  const selectedAddresses = new Set();
  const pushGroup = (prefix, group, wire) => {
    const value = group[wire];
    if (value === undefined) return;
    const fullAddress = `${prefix}.${wire}`;
    selected.push({ fullAddress, baseValue: value });
    selectedAddresses.add(fullAddress);
  };
  for (const [family, weights] of Object.entries(profile.familyWeights)) {
    for (const wire of wireNames) pushGroup(`familyWeights.${family}`, weights, wire);
  }
  for (const [leaf, weights] of Object.entries(profile.leafWeights)) {
    for (const wire of wireNames) pushGroup(`leafWeights.${leaf}`, weights, wire);
  }
  return { selected, selectedAddresses };
}

export function enumerateTrainableCells(profile, wireNames) {
  const { selected } = selectedCells(profile, wireNames);
  const unselectedSample = [];
  const visit = (prefix, weights) => {
    for (const [wire, value] of Object.entries(weights)) {
      const fullAddress = `${prefix}.${wire}`;
      if (unselectedSample.length >= 8) return;
      if (!wireNames.includes(wire)) unselectedSample.push({ fullAddress, baseValue: value, selected: false });
    }
  };
  for (const [family, weights] of Object.entries(profile.familyWeights)) visit(`familyWeights.${family}`, weights);
  for (const [leaf, weights] of Object.entries(profile.leafWeights)) visit(`leafWeights.${leaf}`, weights);
  let sparseCellCount = 0;
  for (const group of [profile.familyWeights, profile.leafWeights]) {
    for (const weights of Object.values(group)) sparseCellCount += Object.keys(weights).length;
  }
  return {
    profileId: profile.id,
    wireCount: wireNames.length,
    registeredWireCount: BASIC_KIND_WIRE_NAMES.length,
    sparseCellCount,
    cellCount: selected.length,
    selected,
    unselectedSample,
  };
}

export function buildRecipeTarget(recipe) {
  return {
    taskId: BASIC_KIND_TASK_ID,
    minScore: 0.6,
    minMargin: 0.15,
    objective: recipe.objective,
    fit: {
      epochs: recipe.epochs,
      learningRate: recipe.learningRate,
      anchorLambda: recipe.anchorLambda,
      trainableWires: recipe.trainableWires,
    },
  };
}

export function applyBindings(definition, input) {
  definition.bindings["准备节点输入与期望输出"].config = {
    taskId: BASIC_KIND_TASK_ID,
    inputScope: "candidate_qualified",
  };
  definition.bindings["按来源分组并划分用途"].config = {
    mode: "source_group_holdout",
    seed: 20261021,
    evalFraction: 0.3,
    allowInSampleEval: false,
    explicitUsage: input.explicitUsage,
  };
  definition.bindings["拟合目标节点参数"] = { config: input.target, profileId: input.profileId };
  definition.bindings["比较新旧节点在相同样本的输出"] = { config: input.target, profileId: input.profileId };
  definition.bindings["评估修复退化与证据不足"].config = { forbidGoldRegression: true };
  definition.bindings["保存候选参数与训练报告"].config = {
    weightsDirectory: "weights",
    resultsDirectory: "results",
  };
  return definition;
}

export function resolveHandwiredRoot(env = process.env) {
  const configured = env.HANDWIRED_ROOT;
  if (!configured) throw new Error("HANDWIRED_ROOT is required; no implicit backend search");
  if (!isAbsolute(configured)) throw new Error("HANDWIRED_ROOT must be an absolute path");
  const root = resolve(configured);
  const core = join(root, "src/runtime/numeric-ui-core.ts");
  if (!existsSync(core)) throw new Error(`Handwired core is missing: ${core}`);
  return root;
}

async function writeNewJson(path, value) {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArguments(argv);
  const recipe = readRecipe(readJsonFile(args.recipe, "recipe"));
  const handwiredRoot = resolveHandwiredRoot(env);
  const start = readStartProfile(args.weight);

  const request = readBasicKindTrainingRequest(readJsonFile(args.request, "prepared request"));
  const prepared = prepareBasicKindSamples(request, {
    taskId: BASIC_KIND_TASK_ID,
    inputScope: "candidate_qualified",
  });
  const includedSampleIds = prepared.rows.filter(row => row.included).map(row => row.sampleId);
  validateExplicitUsage(recipe.explicitUsage, new Set(includedSampleIds));

  const cells = enumerateTrainableCells(start.profile, recipe.trainableWires);
  await mkdir(args.out, { recursive: true });
  await writeNewJson(join(args.out, "trainable-cells.json"), {
    profileId: start.profileId,
    wireCount: cells.wireCount,
    registeredWireCount: cells.registeredWireCount,
    sparseCellCount: cells.sparseCellCount,
    cellCount: cells.cellCount,
    selected: cells.selected,
    unselectedSample: cells.unselectedSample,
  });

  const target = buildRecipeTarget(recipe);
  const definition = await loadWorkflow({
    configPath: join(repositoryRoot, "workflows/node-training.workflow.json"),
    allowedRoot: repositoryRoot,
  });
  applyBindings(definition, {
    profileId: start.profileId,
    target,
    explicitUsage: recipe.explicitUsage,
  });

  const compiled = compileWorkflow(definition, {
    nodeDefinitions: createTrainingNodeDefinitions({ handwiredRoot, allowedRoot: args.out }),
    grantedEffects: ["filesystem.read", "filesystem.write"],
    profiles: loadTrainingProfiles({ profileId: start.profileId, profile: start.profile }),
  });
  const runId = `focus-ignore-${basename(args.out)}-${randomUUID()}`;
  const result = await runWorkflow(compiled, createWorkflowInputEvent({
    runId,
    eventId: `${runId}:input`,
    port: compiled.entryArc.id,
    type: "training.request.v1",
    payload: request,
  }));
  if (result.status !== "completed") {
    throw new Error(`${result.error.category}: ${result.error.message}`);
  }
  const receipt = result.outputEvent.payload;
  console.log(JSON.stringify({
    profileId: start.profileId,
    trainableCells: cells.cellCount,
    summary: receipt.summary,
    persistStatus: receipt.persistStatus,
    candidateAdoption: receipt.candidateAdoption,
    calibrated: receipt.calibrated,
    stoppingReason: receipt.stoppingReason,
  }));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
