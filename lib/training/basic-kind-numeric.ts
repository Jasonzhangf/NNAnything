import {
  BASIC_KIND_FAMILIES,
  BASIC_KIND_WIRE_NAMES,
  DEFAULT_BASIC_KIND_CONFIG,
  PRIORITY_BASIC_KIND_STAGES,
  basicKindFamilySupportGate,
  basicKindLeafSupportGate,
  classifyBasicKind,
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
  objective: {
    targetScore: number;
    rivalCeiling: number;
    otherGap: number;
    mode?: "priority_decision_v1";
    boundarySlack?: number;
  };
  fit: {
    epochs: number;
    learningRate: number;
    anchorLambda: number;
    trainableWires?: readonly BasicKindWireName[];
    stopWhen?: "objective_feasible";
  };
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

export interface BasicKindFitTiming {
  backendLoadMs: number;
  circuitBuildMs: number;
  baselineEvalMs: number;
  trainEpochGradMs: number;
  postEpochEvalMs: number;
  finalEvalMs: number;
  fitTotalMs: number;
  completedEpochs: number;
  processedRowCount: number;
  gradientRowEpochs: number;
  totalRowPasses: number;
  trainableParamCount: number;
  totalSparseCells?: number;
}

type WeightAddress = { family: BasicKindFamily; wire: BasicKindWireName } | { leaf: SpecificBasicKindLabel; wire: BasicKindWireName };
type CircuitGraph = {
  circuit: HandwiredCircuit;
  priority: boolean;
  weights: readonly { address: WeightAddress; base: number; wire: HandwiredWire }[];
  family: Readonly<Record<BasicKindFamily, { min: HandwiredWire; max: HandwiredWire }>>;
  leaf: Readonly<Record<SpecificBasicKindLabel, { min: HandwiredWire; max: HandwiredWire }>>;
  priorityFamilyGates: Readonly<Record<BasicKindFamily, HandwiredWire>> | null;
  priorityLeafGates: Readonly<Record<SpecificBasicKindLabel, HandwiredWire>> | null;
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
type StoppingReason = "objective_feasible" | "epoch_limit";

const familyNames = Object.keys(BASIC_KIND_FAMILIES) as BasicKindFamily[];
const leafNames = Object.values(BASIC_KIND_FAMILIES).flat() as SpecificBasicKindLabel[];
const specificLabels = new Set<string>(leafNames);
const wireNames = new Set<string>(BASIC_KIND_WIRE_NAMES);
const knownConfig = DEFAULT_BASIC_KIND_CONFIG;
const familyByLeaf = {} as Record<SpecificBasicKindLabel, BasicKindFamily>;
for (const family of familyNames) {
  for (const label of BASIC_KIND_FAMILIES[family]) familyByLeaf[label] = family;
}
const priorityStageIndexByLabel = new Map<SpecificBasicKindLabel, number>();
for (const [stageIndex, stage] of PRIORITY_BASIC_KIND_STAGES.entries()) {
  for (const label of stage.labels) priorityStageIndexByLabel.set(label as SpecificBasicKindLabel, stageIndex);
}
const priorityLeavesByStage: readonly (readonly SpecificBasicKindLabel[])[] = PRIORITY_BASIC_KIND_STAGES.map(
  stage => stage.labels as readonly SpecificBasicKindLabel[],
);

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

function decisionObjective(config: BasicKindTrainingConfig): boolean {
  return config.objective.mode === "priority_decision_v1";
}

function optionalTrainableWires(value: unknown): readonly BasicKindWireName[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError("fit.trainableWires must be an array of registered wire names");
  return value.map((wire, index) => {
    if (typeof wire !== "string" || !wireNames.has(wire)) {
      throw new TypeError(`fit.trainableWires[${index}] must be a registered wire name`);
    }
    return wire as BasicKindWireName;
  });
}

function hasTrainableWire(config: BasicKindTrainingConfig, wire: BasicKindWireName): boolean {
  return config.fit.trainableWires === undefined || config.fit.trainableWires.includes(wire);
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
  onlyKeys(objective, ["targetScore", "rivalCeiling", "otherGap", "mode", "boundarySlack"], "objective");
  const targetScore = expectFiniteNumber(objective.targetScore, "targetScore");
  const rivalCeiling = expectFiniteNumber(objective.rivalCeiling, "rivalCeiling");
  const otherGap = expectFiniteNumber(objective.otherGap, "otherGap");
  if (targetScore <= 0 || targetScore > 1) throw new TypeError("targetScore must be in (0,1]");
  if (rivalCeiling < 0 || rivalCeiling >= targetScore) throw new TypeError("rivalCeiling must be in [0,targetScore)");
  if (targetScore < Math.max(minScore, minMargin)) throw new TypeError("targetScore must be at least minScore and minMargin");
  if (targetScore - rivalCeiling <= minMargin) throw new TypeError("targetScore - rivalCeiling must exceed minMargin");
  if (otherGap <= 0 || otherGap >= minScore) throw new TypeError("otherGap must be in (0,minScore)");
  const mode = objective.mode;
  if (mode !== undefined && mode !== "priority_decision_v1") {
    throw new TypeError("objective.mode must be priority_decision_v1");
  }
  if (objective.boundarySlack !== undefined && mode === undefined) {
    throw new TypeError("objective.boundarySlack requires objective.mode priority_decision_v1");
  }
  const boundarySlack = mode === "priority_decision_v1"
    ? (objective.boundarySlack === undefined ? 0.0001 : expectFiniteNumber(objective.boundarySlack, "boundarySlack"))
    : undefined;
  if (boundarySlack !== undefined && (boundarySlack <= 0 || boundarySlack >= minScore)) {
    throw new TypeError("boundarySlack must be in (0,minScore)");
  }
  const fit = expectRecord(input.fit, "fit");
  onlyKeys(fit, ["epochs", "learningRate", "anchorLambda", "trainableWires", "stopWhen"], "fit");
  const epochs = nonnegativeInteger(fit.epochs, "epochs");
  const learningRate = expectFiniteNumber(fit.learningRate, "learningRate");
  if (learningRate <= 0) throw new TypeError("learningRate must be positive");
  const stopWhen = fit.stopWhen;
  if (stopWhen !== undefined && stopWhen !== "objective_feasible") {
    throw new TypeError("fit.stopWhen must be objective_feasible");
  }
  if (stopWhen === "objective_feasible" && mode !== "priority_decision_v1") {
    throw new TypeError("fit.stopWhen objective_feasible requires objective.mode priority_decision_v1");
  }
  const trainableWires = optionalTrainableWires(fit.trainableWires);
  return {
    taskId,
    minScore,
    minMargin,
    objective: {
      targetScore,
      rivalCeiling,
      otherGap,
      ...(mode === undefined ? {} : { mode }),
      ...(boundarySlack === undefined ? {} : { boundarySlack }),
    },
    fit: {
      epochs,
      learningRate,
      anchorLambda: nonnegativeNumber(fit.anchorLambda, "anchorLambda"),
      ...(trainableWires === undefined ? {} : { trainableWires }),
      ...(stopWhen === undefined ? {} : { stopWhen }),
    },
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
  const priority = profile.topology === "priority_staged_v1";
  const gateCount = priority ? familyNames.length + leafNames.length : 0;
  const sourceSize = sparse.length + 2 * BASIC_KIND_WIRE_NAMES.length + gateCount;
  const circuit = new module.Circuit(sourceSize);
  const weightWires = sparse.map((cell, index) => ({ ...cell, wire: circuit.source(index) }));
  const valueCells = BASIC_KIND_WIRE_NAMES.map((_, index) => circuit.source(sparse.length + index));
  const maskCells = BASIC_KIND_WIRE_NAMES.map((_, index) => circuit.source(sparse.length + BASIC_KIND_WIRE_NAMES.length + index));
  const gateOffset = sparse.length + 2 * BASIC_KIND_WIRE_NAMES.length;
  const priorityFamilyGates = priority
    ? Object.fromEntries(familyNames.map((family, index) => [family, circuit.source(gateOffset + index)])) as CircuitGraph["priorityFamilyGates"]
    : null;
  const priorityLeafGates = priority
    ? Object.fromEntries(leafNames.map((leaf, index) => [leaf, circuit.source(gateOffset + familyNames.length + index)])) as CircuitGraph["priorityLeafGates"]
    : null;
  for (let index = 0; index < sparse.length; index++) circuit.assumeRange(circuit.source(index), -1, 1);
  for (const wire of [...valueCells, ...maskCells]) circuit.assumeRange(wire, 0, 1);
  if (priorityFamilyGates !== null) {
    for (const wire of Object.values(priorityFamilyGates)) circuit.assumeRange(wire, 0, 1);
  }
  if (priorityLeafGates !== null) {
    for (const wire of Object.values(priorityLeafGates)) circuit.assumeRange(wire, 0, 1);
  }
  const weightByAddress = new Map<string, HandwiredWire>();
  for (const item of weightWires) {
    const key = "family" in item.address ? `family:${item.address.family}:${item.address.wire}` : `leaf:${item.address.leaf}:${item.address.wire}`;
    weightByAddress.set(key, item.wire);
  }
  const wireIndex = new Map(BASIC_KIND_WIRE_NAMES.map((wire, index) => [wire, index]));
  const emitMultiply = (left: HandwiredWire, right: HandwiredWire) => circuit.multiply(left, right);
  const value = (wire: BasicKindWireName) => valueCells[wireIndex.get(wire)!]!;
  const mask = (wire: BasicKindWireName) => maskCells[wireIndex.get(wire)!]!;
  const rawTarget = (prefix: string, keys: readonly BasicKindWireName[], gate: HandwiredWire | null) => {
    const minTerms: [HandwiredWire, number][] = [];
    const maxTerms: [HandwiredWire, number][] = [];
    for (const wireName of keys) {
      const weight = weightByAddress.get(`${prefix}:${wireName}`)!;
      const observedValue = gate === null ? value(wireName) : emitMultiply(value(wireName), gate);
      const missingMask = gate === null ? mask(wireName) : emitMultiply(mask(wireName), gate);
      const observed = emitMultiply(weight, observedValue);
      minTerms.push([observed, 1]);
      maxTerms.push([observed, 1]);
      const negative = circuit.reglu([], 1, [[weight, -1]], 0);
      const positive = circuit.reglu([], 1, [[weight, 1]], 0);
      minTerms.push([emitMultiply(negative, missingMask), -1]);
      maxTerms.push([emitMultiply(positive, missingMask), 1]);
    }
    return { min: circuit.affine(minTerms), max: circuit.affine(maxTerms) };
  };
  const family = Object.fromEntries(familyNames.map(target => {
    const keys = BASIC_KIND_WIRE_NAMES.filter(wire => profile.familyWeights[target][wire] !== undefined);
    return [target, rawTarget(`family:${target}`, keys, priorityFamilyGates?.[target] ?? null)];
  })) as CircuitGraph["family"];
  const leaf = Object.fromEntries(leafNames.map(target => {
    const keys = BASIC_KIND_WIRE_NAMES.filter(wire => profile.leafWeights[target][wire] !== undefined);
    return [target, rawTarget(`leaf:${target}`, keys, priorityLeafGates?.[target] ?? null)];
  })) as CircuitGraph["leaf"];
  return {
    circuit,
    priority,
    weights: weightWires.map(item => ({ address: item.address, base: item.base, wire: item.wire })),
    family,
    leaf,
    priorityFamilyGates,
    priorityLeafGates,
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
  if (graph.priorityFamilyGates !== null) {
    for (const family of familyNames) {
      source[graph.priorityFamilyGates[family]] = basicKindFamilySupportGate(wires, family);
    }
  }
  if (graph.priorityLeafGates !== null) {
    for (const leaf of leafNames) {
      source[graph.priorityLeafGates[leaf]] = basicKindLeafSupportGate(wires, leaf);
    }
  }
  return source;
}

function stageLoss(values: Float32Array, targets: readonly string[], outputs: Readonly<Record<string, { min: HandwiredWire; max: HandwiredWire }>>, expected: string, target: number, rival: number, gradients: Float32Array) {
  let loss = 0;
  const expectedScore = values[outputs[expected]!.min]!;
  const deficit = Math.max(0, target - expectedScore);
  loss += deficit ** 2;
  if (deficit > 0) gradients[outputs[expected]!.min] = Math.fround(gradients[outputs[expected]!.min]! + 2 * (expectedScore - target));
  for (const candidate of targets) {
    if (candidate === expected) continue;
    const excess = Math.max(0, values[outputs[candidate]!.max]! - rival);
    loss += excess ** 2;
    if (excess > 0) gradients[outputs[candidate]!.max] = Math.fround(gradients[outputs[candidate]!.max]! + 2 * excess);
  }
  return loss;
}

function deficitLoss(values: Float32Array, output: { min: HandwiredWire; max: HandwiredWire }, target: number, gradients: Float32Array): number {
  const expectedScore = values[output.min]!;
  const deficit = Math.max(0, target - expectedScore);
  if (deficit > 0) gradients[output.min] = Math.fround(gradients[output.min]! + 2 * (expectedScore - target));
  return deficit ** 2;
}

function excessLoss(values: Float32Array, output: { min: HandwiredWire; max: HandwiredWire }, rival: number, gradients: Float32Array): number {
  const excess = Math.max(0, values[output.max]! - rival);
  if (excess > 0) gradients[output.max] = Math.fround(gradients[output.max]! + 2 * excess);
  return excess ** 2;
}

type Endpoint = { value: number; wire: HandwiredWire };

function effectiveLowerEndpoint(
  values: Float32Array,
  family: { min: HandwiredWire; max: HandwiredWire },
  leaf: { min: HandwiredWire; max: HandwiredWire },
): Endpoint {
  const familyValue = values[family.min]!;
  const leafValue = values[leaf.min]!;
  return familyValue < leafValue ? { value: familyValue, wire: family.min } : { value: leafValue, wire: leaf.min };
}

function effectiveUpperEndpoint(
  values: Float32Array,
  family: { min: HandwiredWire; max: HandwiredWire },
  leaf: { min: HandwiredWire; max: HandwiredWire },
): Endpoint {
  const familyValue = values[family.max]!;
  const leafValue = values[leaf.max]!;
  return familyValue < leafValue ? { value: familyValue, wire: family.max } : { value: leafValue, wire: leaf.max };
}

function addGradient(gradients: Float32Array, wire: HandwiredWire, value: number): void {
  gradients[wire] = Math.fround(gradients[wire]! + value);
}

function effectiveUpperExcess(
  values: Float32Array,
  graph: CircuitGraph,
  label: SpecificBasicKindLabel,
  threshold: number,
  gradients: Float32Array,
): { loss: number; excess: number } {
  const endpoint = effectiveUpperEndpoint(values, graph.family[familyByLeaf[label]], graph.leaf[label]);
  const excess = Math.max(0, endpoint.value - threshold);
  if (excess > 0) addGradient(gradients, endpoint.wire, 2 * excess);
  return { loss: excess ** 2, excess };
}

function priorityDecisionKnownLoss(
  values: Float32Array,
  wires: Readonly<Record<BasicKindWireName, BasicKindWireValue>>,
  expectedLabel: SpecificBasicKindLabel,
  graph: CircuitGraph,
  config: BasicKindTrainingConfig,
  gradients: Float32Array,
): number {
  const slack = config.objective.boundarySlack!;
  const expectedFamily = familyByLeaf[expectedLabel];
  const expectedStage = priorityStageIndexByLabel.get(expectedLabel);
  if (expectedStage === undefined) throw new TypeError(`priority stage is missing for ${expectedLabel}`);
  const target = effectiveLowerEndpoint(values, graph.family[expectedFamily], graph.leaf[expectedLabel]);
  const targetThreshold = config.minScore + slack;
  const targetDeficit = Math.max(0, targetThreshold - target.value);
  if (targetDeficit > 0) addGradient(gradients, target.wire, -2 * targetDeficit);
  let loss = targetDeficit ** 2;

  const earlierThreshold = config.minScore - slack;
  for (let stage = 0; stage < expectedStage; stage++) {
    for (const label of priorityLeavesByStage[stage] ?? []) {
      if (basicKindLeafSupportGate(wires, label) !== 1) continue;
      loss += effectiveUpperExcess(values, graph, label, earlierThreshold, gradients).loss;
    }
  }

  const clampedTarget = Math.max(0, Math.min(1, target.value));
  const sameStageThreshold = clampedTarget - config.minMargin - slack;
  for (const label of priorityLeavesByStage[expectedStage] ?? []) {
    if (label === expectedLabel || basicKindLeafSupportGate(wires, label) !== 1) continue;
    const competitor = effectiveUpperExcess(values, graph, label, sameStageThreshold, gradients);
    loss += competitor.loss;
    if (competitor.excess > 0 && target.value > 0 && target.value < 1) {
      addGradient(gradients, target.wire, -2 * competitor.excess);
    }
  }
  return loss;
}

function priorityDecisionOtherLoss(
  values: Float32Array,
  wires: Readonly<Record<BasicKindWireName, BasicKindWireValue>>,
  graph: CircuitGraph,
  config: BasicKindTrainingConfig,
  gradients: Float32Array,
): number {
  const threshold = config.minScore - config.objective.boundarySlack!;
  let loss = 0;
  for (const label of leafNames) {
    if (basicKindLeafSupportGate(wires, label) !== 1) continue;
    loss += effectiveUpperExcess(values, graph, label, threshold, gradients).loss;
  }
  return loss;
}

function priorityKnownLoss(
  values: Float32Array,
  expectedLabel: SpecificBasicKindLabel,
  graph: CircuitGraph,
  config: BasicKindTrainingConfig,
  gradients: Float32Array,
): number {
  const expectedFamily = familyByLeaf[expectedLabel];
  const expectedStage = priorityStageIndexByLabel.get(expectedLabel);
  if (expectedStage === undefined) throw new TypeError(`priority stage is missing for ${expectedLabel}`);
  let loss = 0;
  loss += deficitLoss(values, graph.family[expectedFamily], config.objective.targetScore, gradients);
  loss += deficitLoss(values, graph.leaf[expectedLabel], config.objective.targetScore, gradients);

  const rivalFamilies = new Set<BasicKindFamily>();
  for (let stage = 0; stage <= expectedStage; stage++) {
    for (const label of priorityLeavesByStage[stage] ?? []) {
      const family = familyByLeaf[label];
      if (family !== expectedFamily) rivalFamilies.add(family);
    }
  }
  for (const family of rivalFamilies) loss += excessLoss(values, graph.family[family], config.objective.rivalCeiling, gradients);

  for (const label of priorityLeavesByStage[expectedStage] ?? []) {
    if (label !== expectedLabel) loss += excessLoss(values, graph.leaf[label], config.objective.rivalCeiling, gradients);
  }
  if (expectedLabel === "ignore") {
    for (const label of priorityLeavesByStage[expectedStage - 1] ?? []) {
      loss += excessLoss(values, graph.leaf[label], config.objective.rivalCeiling, gradients);
    }
  }
  return loss;
}

function priorityOtherLoss(values: Float32Array, graph: CircuitGraph, config: BasicKindTrainingConfig, gradients: Float32Array): number {
  const threshold = config.minScore - config.objective.otherGap;
  let loss = 0;
  for (const family of familyNames) loss += excessLoss(values, graph.family[family], threshold, gradients);
  for (const leaf of leafNames) loss += excessLoss(values, graph.leaf[leaf], threshold, gradients);
  return loss;
}

function evaluateGraph(
  graph: CircuitGraph,
  source: Float32Array,
  wires: Readonly<Record<BasicKindWireName, BasicKindWireValue>>,
  expectedLabel: BasicKindLabel,
  config: BasicKindTrainingConfig,
) {
  if (decisionObjective(config) && !graph.priority) {
    throw new TypeError("objective.mode priority_decision_v1 requires profile.topology priority_staged_v1");
  }
  const values = graph.circuit.evaluateReference(source);
  const gradients = new Float32Array(values.length);
  const familyExpected = expectedLabel === "other" ? null : familyNames.find(family => BASIC_KIND_FAMILIES[family].includes(expectedLabel as never))!;
  let knownLoss = 0;
  let otherLoss = 0;
  if (familyExpected === null) {
    if (graph.priority && decisionObjective(config)) {
      otherLoss = priorityDecisionOtherLoss(values, wires, graph, config, gradients);
    } else if (graph.priority) otherLoss = priorityOtherLoss(values, graph, config, gradients);
    else {
      const threshold = config.minScore - config.objective.otherGap;
      for (const family of familyNames) {
        const excess = Math.max(0, values[graph.family[family].max]! - threshold);
        otherLoss += excess ** 2;
        if (excess > 0) gradients[graph.family[family].max] = Math.fround(gradients[graph.family[family].max]! + 2 * excess);
      }
    }
  } else if (graph.priority && decisionObjective(config)) {
    knownLoss = priorityDecisionKnownLoss(values, wires, expectedLabel as SpecificBasicKindLabel, graph, config, gradients);
  } else if (graph.priority) {
    knownLoss = priorityKnownLoss(values, expectedLabel as SpecificBasicKindLabel, graph, config, gradients);
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
  const evaluated = evaluateGraph(graph, source, wires, expectedLabel, config);
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

function verifyObjectiveFeasibleRows(
  rows: readonly BasicKindFitRow[],
  config: BasicKindTrainingConfig,
  profile: BasicKindProfile,
): void {
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const judgment = classifyBasicKind(
      row.properties,
      { taskId: config.taskId, minScore: config.minScore, minMargin: config.minMargin },
      profile,
    );
    if (judgment.basicKind !== row.expectedLabel || judgment.judgmentStatus !== "judged") {
      throw new Error(
        `priority_decision_v1 numerical feasibility disagrees with public classification at row ${index}: `
        + `expected ${row.expectedLabel}/judged, got ${judgment.basicKind}/${judgment.judgmentStatus}`,
      );
    }
  }
}

function attachFitTiming(error: unknown, completedEpochs: number, timing: BasicKindFitTiming): never {
  timing.completedEpochs = completedEpochs;
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    try {
      Object.assign(error, { completedEpochs, timing });
      throw error;
    } catch (assigned) {
      if (assigned === error) throw assigned;
    }
  }
  const wrapped = new Error(String(error), { cause: error });
  Object.assign(wrapped, { completedEpochs, timing });
  throw wrapped;
}

export async function fitBasicKinds(value: {
  handwiredRoot: string;
  rows: readonly BasicKindFitRow[];
  baseProfile: BasicKindProfile;
  config: BasicKindTrainingConfig;
  candidateId: string;
  onProgress?: (progress: FitProgress) => void;
}): Promise<{
  profile: BasicKindProfile;
  trajectory: FitProgress[];
  lossBefore: number;
  lossAfter: number;
  timing: BasicKindFitTiming;
  stoppingReason: StoppingReason;
}> {
  const fitStarted = performance.now();
  const timing: BasicKindFitTiming = {
    backendLoadMs: 0,
    circuitBuildMs: 0,
    baselineEvalMs: 0,
    trainEpochGradMs: 0,
    postEpochEvalMs: 0,
    finalEvalMs: 0,
    fitTotalMs: 0,
    completedEpochs: 0,
    processedRowCount: 0,
    gradientRowEpochs: 0,
    totalRowPasses: 0,
    trainableParamCount: 0,
    totalSparseCells: 0,
  };
  const trajectory: FitProgress[] = [];
  try {
    const backendStarted = performance.now();
    let module: HandwiredModule | undefined;
    try {
      module = await loadHandwired(value.handwiredRoot);
    } finally {
      timing.backendLoadMs = performance.now() - backendStarted;
    }
    if (module === undefined) throw new Error("Handwired loader returned no module");
    const rows = readRows(value.rows);
    timing.processedRowCount = rows.length;
    const base = validateBasicKindProfile(value.baseProfile);
    const candidateId = expectNonEmptyString(value.candidateId, "candidateId");
    const config = validateBasicKindTrainingConfig(value.config);
    if (candidateId === base.id) throw new TypeError("candidateId must differ from baseProfile.id");
    if (rows.length === 0) throw new TypeError("rows must not be empty");

    const circuitStarted = performance.now();
    let graph: CircuitGraph;
    try {
      graph = buildCircuit(module, base);
    } finally {
      timing.circuitBuildMs = performance.now() - circuitStarted;
    }
    timing.totalSparseCells = graph.weights.length;
    timing.trainableParamCount = graph.weights.filter(item => hasTrainableWire(config, item.address.wire)).length;

    const weights = graph.weights.map(item => item.base);
    const firstMoment = new Float64Array(weights.length);
    const secondMoment = new Float64Array(weights.length);
    let step = 0;
    const evaluateAll = (current: readonly number[], gradientPass: boolean) => {
      const gradient = new Float64Array(weights.length);
      let known = 0, other = 0, anchor = 0;
      let feasible = true;
      for (const row of rows) {
        const wires = extractBasicKindWires(row.properties);
        const source = sourceFor(graph, current, wires);
        const evaluated = evaluateGraph(graph, source, wires, row.expectedLabel, config);
        timing.totalRowPasses++;
        if (gradientPass) timing.gradientRowEpochs++;
        known += evaluated.knownLoss;
        other += evaluated.otherLoss;
        if (evaluated.knownLoss + evaluated.otherLoss > 0) feasible = false;
        for (let index = 0; index < weights.length; index++) gradient[index] = gradient[index]! + evaluated.gradients[graph.weights[index]!.wire]! / rows.length;
      }
      for (let index = 0; index < weights.length; index++) {
        const address = graph.weights[index]!.address;
        const wire = address.wire;
        if (!hasTrainableWire(config, wire)) {
          gradient[index] = 0;
          continue;
        }
        const difference = current[index]! - graph.weights[index]!.base;
        anchor += config.fit.anchorLambda / 2 * difference ** 2;
        gradient[index] = gradient[index]! + config.fit.anchorLambda * difference;
      }
      const knownLoss = known / rows.length, otherLoss = other / rows.length;
      if (![knownLoss, otherLoss, anchor, knownLoss + otherLoss + anchor].every(Number.isFinite)
        || !gradient.every(Number.isFinite)) throw new Error("Non-finite training loss or gradient");
      return { gradient, knownLoss, otherLoss, anchorLoss: anchor, feasible };
    };

    const baselineStarted = performance.now();
    let before;
    try {
      before = evaluateAll(weights, false);
    } finally {
      timing.baselineEvalMs = performance.now() - baselineStarted;
    }
    const lossBefore = before.knownLoss + before.otherLoss + before.anchorLoss;
    let stoppingReason: StoppingReason = "epoch_limit";
    if (config.fit.stopWhen === "objective_feasible" && before.feasible) {
      const baselineProfile = profileFromWeights(base, graph, weights, candidateId);
      verifyObjectiveFeasibleRows(rows, config, baselineProfile);
      stoppingReason = "objective_feasible";
    }
    for (let epoch = 0; epoch < config.fit.epochs && stoppingReason === "epoch_limit"; epoch++) {
      const trainStarted = performance.now();
      let state;
      let projectedWeightCount = 0;
      try {
        state = evaluateAll(weights, true);
        const firstDecay = 0.9, secondDecay = 0.999, epsilon = 1e-8;
        step++;
        const firstCorrection = 1 - firstDecay ** step;
        const secondCorrection = 1 - secondDecay ** step;
        for (let index = 0; index < weights.length; index++) {
          const address = graph.weights[index]!.address;
          const wire = address.wire;
          if (!hasTrainableWire(config, wire)) continue;
          firstMoment[index] = firstDecay * firstMoment[index]! + (1 - firstDecay) * state.gradient[index]!;
          secondMoment[index] = secondDecay * secondMoment[index]! + (1 - secondDecay) * state.gradient[index]! ** 2;
          const next = weights[index]! - config.fit.learningRate * (firstMoment[index]! / firstCorrection) / (Math.sqrt(secondMoment[index]! / secondCorrection) + epsilon);
          if (![firstMoment[index]!, secondMoment[index]!, next].every(Number.isFinite)) throw new Error("Non-finite training optimizer state");
          if (next < -1 || next > 1) projectedWeightCount++;
          weights[index] = Math.fround(Math.max(-1, Math.min(1, next)));
        }
      } finally {
        timing.trainEpochGradMs += performance.now() - trainStarted;
      }
      const postEpochStarted = performance.now();
      let next;
      try {
        next = evaluateAll(weights, false);
      } finally {
        timing.postEpochEvalMs += performance.now() - postEpochStarted;
      }
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
      timing.completedEpochs = trajectory.length;
      value.onProgress?.(progress);
      if (config.fit.stopWhen === "objective_feasible" && next.feasible) {
        const candidate = profileFromWeights(base, graph, weights, candidateId);
        verifyObjectiveFeasibleRows(rows, config, candidate);
        stoppingReason = "objective_feasible";
      }
    }
    const finalStarted = performance.now();
    let after;
    try {
      after = evaluateAll(weights, false);
    } finally {
      timing.finalEvalMs = performance.now() - finalStarted;
    }
    const profile = profileFromWeights(base, graph, weights, candidateId);
    validateBasicKindProfile(profile);
    timing.fitTotalMs = performance.now() - fitStarted;
    return {
      profile,
      trajectory,
      lossBefore,
      lossAfter: after.knownLoss + after.otherLoss + after.anchorLoss,
      timing,
      stoppingReason,
    };
  } catch (error) {
    timing.fitTotalMs = performance.now() - fitStarted;
    attachFitTiming(error, trajectory.length, timing);
  }
}

function profileFromWeights(base: BasicKindProfile, graph: CircuitGraph, weights: readonly number[], id = base.id): BasicKindProfile {
  const familyWeights = structuredClone(base.familyWeights) as Record<BasicKindFamily, BasicKindWeights>;
  const leafWeights = structuredClone(base.leafWeights) as Record<SpecificBasicKindLabel, BasicKindWeights>;
  for (let index = 0; index < graph.weights.length; index++) {
    const item = graph.weights[index]!;
    const row = "family" in item.address ? familyWeights[item.address.family] : leafWeights[item.address.leaf];
    (row as Record<BasicKindWireName, number>)[item.address.wire] = weights[index]!;
  }
  return {
    id,
    ...(base.topology === undefined ? {} : { topology: base.topology }),
    familyWeights,
    leafWeights,
  };
}
