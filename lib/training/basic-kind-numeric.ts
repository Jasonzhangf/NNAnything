import {
  BASIC_KIND_FAMILIES,
  BASIC_KIND_WIRE_NAMES,
  DEFAULT_BASIC_KIND_CONFIG,
  extractBasicKindWires,
  validateBasicKindProperties,
  validateBasicKindProfile,
  type BasicKindFamily,
  type BasicKindLabel,
  type BasicKindProfile,
  type BasicKindProperties,
  type BasicKindWeights,
  type BasicKindWireName,
  type BasicKindWireValue,
  type SpecificBasicKindLabel,
} from "../filters/basic-kinds.js";
import { expectArray, expectFiniteNumber, expectNonEmptyString, expectRecord } from "../core/schema.js";
import { loadHandwired, type HandwiredCircuit, type HandwiredModule, type HandwiredWire } from "./handwired.js";

export type BasicKindTrainingConfig = {
  taskId: string;
  minScore: number;
  minMargin: number;
  objective: { targetScore: number; rivalCeiling: number; otherGap: number };
  fit: { epochs: number; learningRate: number; anchorLambda: number };
};
export type BasicKindFitRow = { properties: BasicKindProperties; expectedLabel: BasicKindLabel };
export type FitProgress = {
  epoch: number;
  totalEpochs: number;
  loss: number;
  knownLoss: number;
  otherLoss: number;
  anchorLoss: number;
  sampleCount: number;
  projectedWeightCount: number;
};

type WeightAddress = { family: BasicKindFamily; wire: BasicKindWireName } | { leaf: SpecificBasicKindLabel; wire: BasicKindWireName };
type CircuitGraph = {
  circuit: HandwiredCircuit;
  weights: readonly { address: WeightAddress; base: number; wire: HandwiredWire }[];
  family: Readonly<Record<BasicKindFamily, { min: HandwiredWire; max: HandwiredWire }>>;
  leaf: Readonly<Record<SpecificBasicKindLabel, { min: HandwiredWire; max: HandwiredWire }>>;
  valueCells: readonly HandwiredWire[];
  maskCells: readonly HandwiredWire[];
};
type Inspected = {
  family: Readonly<Record<BasicKindFamily, { min: number; max: number }>>;
  leaf: Readonly<Record<SpecificBasicKindLabel, { min: number; max: number }>>;
  familyGradients: Readonly<Record<BasicKindFamily, Readonly<Partial<Record<BasicKindWireName, number>>>>>;
  leafGradients: Readonly<Record<SpecificBasicKindLabel, Readonly<Partial<Record<BasicKindWireName, number>>>>>;
  loss: number;
  knownLoss: number;
  otherLoss: number;
};

const familyNames = Object.keys(BASIC_KIND_FAMILIES) as BasicKindFamily[];
const leafNames = Object.values(BASIC_KIND_FAMILIES).flat() as SpecificBasicKindLabel[];
const specificLabels = new Set<string>(leafNames);
const knownConfig = DEFAULT_BASIC_KIND_CONFIG;

function nonnegativeInteger(value: unknown, label: string): number {
  const number = expectFiniteNumber(value, label);
  if (!Number.isInteger(number) || number < 0) throw new TypeError(`${label} must be a nonnegative integer`);
  return number;
}

function nonnegativeNumber(value: unknown, label: string): number {
  const number = expectFiniteNumber(value, label);
  if (number < 0) throw new TypeError(`${label} must be nonnegative`);
  return number;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new TypeError(`${label} has unsupported field ${key}`);
  }
}

export function validateBasicKindTrainingConfig(value: unknown): BasicKindTrainingConfig {
  const input = expectRecord(value, "basic-kind training config");
  onlyKeys(input, ["taskId", "minScore", "minMargin", "objective", "fit"], "basic-kind training config");
  const taskId = expectNonEmptyString(input.taskId, "taskId");
  if (taskId !== knownConfig.taskId) throw new TypeError(`taskId must be ${knownConfig.taskId}`);
  const minScore = expectFiniteNumber(input.minScore, "minScore");
  const minMargin = expectFiniteNumber(input.minMargin, "minMargin");
  if (minScore <= 0 || minScore > 1) throw new TypeError("minScore must be in (0,1]");
  if (minMargin < 0 || minMargin > 1) throw new TypeError("minMargin must be in [0,1]");
  const objective = expectRecord(input.objective, "objective");
  onlyKeys(objective, ["targetScore", "rivalCeiling", "otherGap"], "objective");
  const targetScore = expectFiniteNumber(objective.targetScore, "targetScore");
  const rivalCeiling = expectFiniteNumber(objective.rivalCeiling, "rivalCeiling");
  const otherGap = expectFiniteNumber(objective.otherGap, "otherGap");
  if (targetScore <= 0 || targetScore > 1) throw new TypeError("targetScore must be in (0,1]");
  if (rivalCeiling < 0 || rivalCeiling >= targetScore) throw new TypeError("rivalCeiling must be in [0,targetScore)");
  if (targetScore < Math.max(minScore, minMargin)) throw new TypeError("targetScore must be at least minScore and minMargin");
  if (targetScore - rivalCeiling <= minMargin) throw new TypeError("targetScore - rivalCeiling must exceed minMargin");
  if (otherGap <= 0 || otherGap >= minScore) throw new TypeError("otherGap must be in (0,minScore)");
  const fit = expectRecord(input.fit, "fit");
  onlyKeys(fit, ["epochs", "learningRate", "anchorLambda"], "fit");
  const epochs = nonnegativeInteger(fit.epochs, "epochs");
  const learningRate = expectFiniteNumber(fit.learningRate, "learningRate");
  if (learningRate <= 0) throw new TypeError("learningRate must be positive");
  return {
    taskId,
    minScore,
    minMargin,
    objective: { targetScore, rivalCeiling, otherGap },
    fit: { epochs, learningRate, anchorLambda: nonnegativeNumber(fit.anchorLambda, "anchorLambda") },
  };
}

function sparsecells(profile: BasicKindProfile): readonly { address: WeightAddress; base: number }[] {
  const cells: { address: WeightAddress; base: number }[] = [];
  for (const family of familyNames) {
    const row = profile.familyWeights[family];
    for (const wire of BASIC_KIND_WIRE_NAMES) {
      const weight = row[wire];
      if (weight !== undefined) cells.push({ address: { family, wire }, base: weight });
    }
  }
  for (const leaf of leafNames) {
    const row = profile.leafWeights[leaf];
    for (const wire of BASIC_KIND_WIRE_NAMES) {
      const weight = row[wire];
      if (weight !== undefined) cells.push({ address: { leaf, wire }, base: weight });
    }
  }
  return cells;
}

function buildCircuit(module: HandwiredModule, profile: BasicKindProfile): CircuitGraph {
  const sparse = sparsecells(profile);
  const sourceSize = sparse.length + 2 * BASIC_KIND_WIRE_NAMES.length;
  const circuit = new module.Circuit(sourceSize);
  const weightWires = sparse.map((cell, index) => ({ ...cell, wire: circuit.source(index) }));
  const valueCells = BASIC_KIND_WIRE_NAMES.map((_, index) => circuit.source(sparse.length + index));
  const maskCells = BASIC_KIND_WIRE_NAMES.map((_, index) => circuit.source(sparse.length + BASIC_KIND_WIRE_NAMES.length + index));
  for (let index = 0; index < sparse.length; index++) circuit.assumeRange(circuit.source(index), -1, 1);
  for (const wire of [...valueCells, ...maskCells]) circuit.assumeRange(wire, 0, 1);
  const weightByAddress = new Map<string, HandwiredWire>();
  for (const item of weightWires) {
    const key = "family" in item.address ? `family:${item.address.family}:${item.address.wire}` : `leaf:${item.address.leaf}:${item.address.wire}`;
    weightByAddress.set(key, item.wire);
  }
  const wireIndex = new Map(BASIC_KIND_WIRE_NAMES.map((wire, index) => [wire, index]));
  const emitMultiply = (left: HandwiredWire, right: HandwiredWire) => circuit.multiply(left, right);
  const value = (wire: BasicKindWireName) => valueCells[wireIndex.get(wire)!]!;
  const mask = (wire: BasicKindWireName) => maskCells[wireIndex.get(wire)!]!;
  const rawTarget = (prefix: string, keys: readonly BasicKindWireName[]) => {
    const minTerms: [HandwiredWire, number][] = [];
    const maxTerms: [HandwiredWire, number][] = [];
    for (const wireName of keys) {
      const weight = weightByAddress.get(`${prefix}:${wireName}`)!;
      const observed = emitMultiply(weight, value(wireName));
      minTerms.push([observed, 1]);
      maxTerms.push([observed, 1]);
      const negative = circuit.reglu([], 1, [[weight, -1]], 0);
      const positive = circuit.reglu([], 1, [[weight, 1]], 0);
      minTerms.push([emitMultiply(negative, mask(wireName)), -1]);
      maxTerms.push([emitMultiply(positive, mask(wireName)), 1]);
    }
    return { min: circuit.affine(minTerms), max: circuit.affine(maxTerms) };
  };
  const family = Object.fromEntries(familyNames.map(target => {
    const keys = BASIC_KIND_WIRE_NAMES.filter(wire => profile.familyWeights[target][wire] !== undefined);
    return [target, rawTarget(`family:${target}`, keys)];
  })) as CircuitGraph["family"];
  const leaf = Object.fromEntries(leafNames.map(target => {
    const keys = BASIC_KIND_WIRE_NAMES.filter(wire => profile.leafWeights[target][wire] !== undefined);
    return [target, rawTarget(`leaf:${target}`, keys)];
  })) as CircuitGraph["leaf"];
  return {
    circuit,
    weights: weightWires.map(item => ({ address: item.address, base: item.base, wire: item.wire })),
    family,
    leaf,
    valueCells,
    maskCells,
  };
}

function sourceFor(graph: CircuitGraph, weights: readonly number[], wires: Readonly<Record<BasicKindWireName, BasicKindWireValue>>): Float32Array {
  const sparseCount = graph.weights.length;
  const source = new Float32Array(graph.circuit.sourceSize);
  for (let index = 0; index < sparseCount; index++) source[index] = Math.fround(weights[index]!);
  for (let index = 0; index < BASIC_KIND_WIRE_NAMES.length; index++) {
    const wire = BASIC_KIND_WIRE_NAMES[index]!;
    const current = wires[wire];
    source[sparseCount + index] = current === null ? 0 : current;
    source[sparseCount + BASIC_KIND_WIRE_NAMES.length + index] = current === null ? 1 : 0;
  }
  return source;
}

function stageLoss(values: Float32Array, targets: readonly string[], outputs: Readonly<Record<string, { min: HandwiredWire; max: HandwiredWire }>>, expected: string, target: number, rival: number, gradients: Float32Array) {
  let loss = 0;
  const expectedScore = values[outputs[expected]!.min]!;
  loss += (expectedScore - target) ** 2;
  gradients[outputs[expected]!.min] = Math.fround(gradients[outputs[expected]!.min]! + 2 * (expectedScore - target));
  for (const candidate of targets) {
    if (candidate === expected) continue;
    const excess = Math.max(0, values[outputs[candidate]!.max]! - rival);
    loss += excess ** 2;
    if (excess > 0) gradients[outputs[candidate]!.max] = Math.fround(gradients[outputs[candidate]!.max]! + 2 * excess);
  }
  return loss;
}

function evaluateGraph(graph: CircuitGraph, source: Float32Array, expectedLabel: BasicKindLabel, config: BasicKindTrainingConfig) {
  const values = graph.circuit.evaluateReference(source);
  const gradients = new Float32Array(values.length);
  const familyExpected = expectedLabel === "other" ? null : familyNames.find(family => BASIC_KIND_FAMILIES[family].includes(expectedLabel as never))!;
  let knownLoss = 0;
  let otherLoss = 0;
  if (familyExpected === null) {
    const threshold = config.minScore - config.objective.otherGap;
    for (const family of familyNames) {
      const excess = Math.max(0, values[graph.family[family].max]! - threshold);
      otherLoss += excess ** 2;
      if (excess > 0) gradients[graph.family[family].max] = Math.fround(gradients[graph.family[family].max]! + 2 * excess);
    }
  } else {
    knownLoss += stageLoss(values, familyNames, graph.family, familyExpected, config.objective.targetScore, config.objective.rivalCeiling, gradients);
    knownLoss += stageLoss(values, BASIC_KIND_FAMILIES[familyExpected], graph.leaf, expectedLabel as SpecificBasicKindLabel, config.objective.targetScore, config.objective.rivalCeiling, gradients);
  }
  const backpropagated = graph.circuit.backpropagateReference(values, gradients);
  const family = Object.fromEntries(familyNames.map(name => [name, { min: values[graph.family[name].min]!, max: values[graph.family[name].max]! }])) as Inspected["family"];
  const leaf = Object.fromEntries(leafNames.map(name => [name, { min: values[graph.leaf[name].min]!, max: values[graph.leaf[name].max]! }])) as Inspected["leaf"];
  return { values, gradients: backpropagated, family, leaf, knownLoss, otherLoss };
}

function gradientMap(graph: CircuitGraph, gradients: Float32Array, stage: "family" | "leaf") {
  const result: Record<string, Partial<Record<BasicKindWireName, number>>> = {};
  for (let index = 0; index < graph.weights.length; index++) {
    const item = graph.weights[index]!;
    const currentStage = "family" in item.address ? "family" : "leaf";
    if (currentStage !== stage) continue;
    const name = "family" in item.address ? item.address.family : item.address.leaf;
    (result[name] ??= {})[item.address.wire] = gradients[item.wire]!;
  }
  return result as Inspected["familyGradients"] | Inspected["leafGradients"];
}

async function inspectWithModule(module: HandwiredModule, value: unknown, expectedLabel: BasicKindLabel, profile: BasicKindProfile, config: BasicKindTrainingConfig): Promise<Inspected> {
  const properties = validateBasicKindProperties(value);
  if (expectedLabel !== "other" && !specificLabels.has(expectedLabel)) throw new TypeError("expectedLabel is not a basic kind label");
  const current = validateBasicKindProfile(profile);
  const wires = extractBasicKindWires(properties);
  const graph = buildCircuit(module, current);
  const source = sourceFor(graph, graph.weights.map(item => item.base), wires);
  const evaluated = evaluateGraph(graph, source, expectedLabel, config);
  return {
    family: evaluated.family,
    leaf: evaluated.leaf,
    familyGradients: gradientMap(graph, evaluated.gradients, "family") as Inspected["familyGradients"],
    leafGradients: gradientMap(graph, evaluated.gradients, "leaf") as Inspected["leafGradients"],
    loss: evaluated.knownLoss + evaluated.otherLoss,
    knownLoss: evaluated.knownLoss,
    otherLoss: evaluated.otherLoss,
  };
}

export async function inspectBasicKindNumericSample(value: {
  handwiredRoot: string;
  properties: unknown;
  expectedLabel: BasicKindLabel;
  profile: BasicKindProfile;
  config?: BasicKindTrainingConfig;
}): Promise<Inspected> {
  const module = await loadHandwired(value.handwiredRoot);
  const config = value.config === undefined ? validateBasicKindTrainingConfig({
    taskId: knownConfig.taskId,
    minScore: knownConfig.minScore,
    minMargin: knownConfig.minMargin,
    objective: { targetScore: 0.8, rivalCeiling: 0.4, otherGap: 0.05 },
    fit: { epochs: 0, learningRate: 0.01, anchorLambda: 0 },
  }) : validateBasicKindTrainingConfig(value.config);
  return inspectWithModule(module, value.properties, value.expectedLabel, value.profile, config);
}

function readRows(value: unknown): readonly BasicKindFitRow[] {
  return expectArray(value, "rows").map((row, index) => {
    const record = expectRecord(row, `rows[${index}]`);
    onlyKeys(record, ["properties", "expectedLabel"], `rows[${index}]`);
    const label = expectNonEmptyString(record.expectedLabel, `rows[${index}].expectedLabel`);
    if (label !== "other" && !specificLabels.has(label)) throw new TypeError(`rows[${index}].expectedLabel is not a basic kind label`);
    return { properties: validateBasicKindProperties(record.properties), expectedLabel: label as BasicKindLabel };
  });
}

export async function fitBasicKinds(value: {
  handwiredRoot: string;
  rows: readonly BasicKindFitRow[];
  baseProfile: BasicKindProfile;
  config: BasicKindTrainingConfig;
  candidateId: string;
  onProgress?: (progress: FitProgress) => void;
}): Promise<{ profile: BasicKindProfile; trajectory: FitProgress[]; lossBefore: number; lossAfter: number }> {
  const module = await loadHandwired(value.handwiredRoot);
  const rows = readRows(value.rows);
  const base = validateBasicKindProfile(value.baseProfile);
  const candidateId = expectNonEmptyString(value.candidateId, "candidateId");
  const config = validateBasicKindTrainingConfig(value.config);
  if (candidateId === base.id) throw new TypeError("candidateId must differ from baseProfile.id");
  if (rows.length === 0) throw new TypeError("rows must not be empty");
  const graph = buildCircuit(module, base);
  const weights = graph.weights.map(item => item.base);
  const firstMoment = new Float64Array(weights.length);
  const secondMoment = new Float64Array(weights.length);
  let step = 0;
  const evaluateAll = (current: readonly number[]) => {
    const gradient = new Float64Array(weights.length);
    let known = 0, other = 0, anchor = 0;
    for (const row of rows) {
      const wires = extractBasicKindWires(row.properties);
      const source = sourceFor(graph, current, wires);
      const evaluated = evaluateGraph(graph, source, row.expectedLabel, config);
      known += evaluated.knownLoss;
      other += evaluated.otherLoss;
      for (let index = 0; index < weights.length; index++) gradient[index] = gradient[index]! + evaluated.gradients[graph.weights[index]!.wire]! / rows.length;
    }
    for (let index = 0; index < weights.length; index++) {
      const difference = current[index]! - graph.weights[index]!.base;
      anchor += config.fit.anchorLambda / 2 * difference ** 2;
      gradient[index] = gradient[index]! + config.fit.anchorLambda * difference;
    }
    return { gradient, knownLoss: known / rows.length, otherLoss: other / rows.length, anchorLoss: anchor };
  };
  const before = evaluateAll(weights);
  const lossBefore = before.knownLoss + before.otherLoss + before.anchorLoss;
  const trajectory: FitProgress[] = [];
  for (let epoch = 0; epoch < config.fit.epochs; epoch++) {
    const state = evaluateAll(weights);
    const firstDecay = 0.9, secondDecay = 0.999, epsilon = 1e-8;
    step++;
    const firstCorrection = 1 - firstDecay ** step;
    const secondCorrection = 1 - secondDecay ** step;
    let projectedWeightCount = 0;
    for (let index = 0; index < weights.length; index++) {
      firstMoment[index] = firstDecay * firstMoment[index]! + (1 - firstDecay) * state.gradient[index]!;
      secondMoment[index] = secondDecay * secondMoment[index]! + (1 - secondDecay) * state.gradient[index]! ** 2;
      const next = weights[index]! - config.fit.learningRate * (firstMoment[index]! / firstCorrection) / (Math.sqrt(secondMoment[index]! / secondCorrection) + epsilon);
      if (next < -1 || next > 1) projectedWeightCount++;
      weights[index] = Math.fround(Math.max(-1, Math.min(1, next)));
    }
    const next = evaluateAll(weights);
    const progress = {
      epoch: epoch + 1,
      totalEpochs: config.fit.epochs,
      loss: next.knownLoss + next.otherLoss + next.anchorLoss,
      knownLoss: next.knownLoss,
      otherLoss: next.otherLoss,
      anchorLoss: next.anchorLoss,
      sampleCount: rows.length,
      projectedWeightCount,
    };
    trajectory.push(progress);
    value.onProgress?.(progress);
  }
  const after = evaluateAll(weights);
  const profile = profileFromWeights(base, graph, weights, candidateId);
  validateBasicKindProfile(profile);
  return { profile, trajectory, lossBefore, lossAfter: after.knownLoss + after.otherLoss + after.anchorLoss };
}

function profileFromWeights(base: BasicKindProfile, graph: CircuitGraph, weights: readonly number[], id = base.id): BasicKindProfile {
  const familyWeights = structuredClone(base.familyWeights) as Record<BasicKindFamily, BasicKindWeights>;
  const leafWeights = structuredClone(base.leafWeights) as Record<SpecificBasicKindLabel, BasicKindWeights>;
  for (let index = 0; index < graph.weights.length; index++) {
    const item = graph.weights[index]!;
    const row = "family" in item.address ? familyWeights[item.address.family] : leafWeights[item.address.leaf];
    (row as Record<BasicKindWireName, number>)[item.address.wire] = weights[index]!;
  }
  return { id, familyWeights, leafWeights };
}
