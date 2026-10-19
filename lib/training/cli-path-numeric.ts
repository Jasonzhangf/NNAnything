import { expectArray, expectFiniteNumber, expectNonEmptyString, expectRecord } from "../core/schema.js";
import {
  PATH_ACTIONS,
  PATH_WIRES,
  validatePathProfile,
  type PathAction,
  type PathFitRow,
  type PathProfile,
} from "../filters/cli-path-controller.js";
import { buildPathCircuit, type PathCircuit } from "../nodes/trainable/cli-path-controller.js";
import { loadHandwired, type HandwiredModule } from "./handwired.js";

export interface FitTiming {
  backendLoadMs: number;
  circuitBuildMs: number;
  baselineEvalMs: number;
  trainEpochGradMs: number;
  finalEvalMs: number;
  fitTotalMs: number;
  completedEpochs: number;
  processedRowCount: number;
  gradientRowEpochs: number;
  totalRowPasses: number;
  trainableParamCount: number;
}

export interface EpochMetric {
  readonly epoch: number;
  readonly loss: number;
}

export interface FitPathControllerInput {
  readonly rows: readonly PathFitRow[];
  readonly initial: PathProfile;
  readonly handwiredRoot: string;
  readonly epochs: number;
  readonly learningRate: number;
}

export interface FitPathControllerResult {
  readonly profile: PathProfile;
  readonly timing: FitTiming;
  readonly trajectory: readonly EpochMetric[];
}

type BatchResult = {
  readonly loss: number;
  readonly gradient: Float64Array | null;
};

type ForwardResult = {
  readonly values: Float32Array;
  readonly logits: readonly number[];
};

function nonnegativeInteger(value: unknown, label: string): number {
  const number = expectFiniteNumber(value, label);
  if (!Number.isInteger(number) || number < 0) throw new TypeError(`${label} must be a nonnegative integer`);
  return number;
}

function readRows(value: readonly unknown[]): readonly PathFitRow[] {
  return value.map((raw, index) => {
    const row = expectRecord(raw, `rows[${index}]`);
    for (const key of Object.keys(row)) {
      if (key !== "features" && key !== "expected") throw new TypeError(`rows[${index}] has unsupported field ${key}`);
    }
    const rawFeatures = expectArray(row.features, `rows[${index}].features`);
    if (rawFeatures.length !== PATH_WIRES.length) {
      throw new TypeError(`rows[${index}].features must contain ${PATH_WIRES.length} values`);
    }
    const features = rawFeatures.map((feature, featureIndex) =>
      expectFiniteNumber(feature, `rows[${index}].features[${featureIndex}]`),
    );
    const expected = expectNonEmptyString(row.expected, `rows[${index}].expected`);
    if (!PATH_ACTIONS.includes(expected as PathAction)) {
      throw new TypeError(`rows[${index}].expected is not a path action`);
    }
    return { features, expected: expected as PathAction };
  });
}

function sourceFor(circuit: PathCircuit, weights: readonly number[], features: readonly number[]): Float32Array {
  const source = new Float32Array(circuit.circuit.sourceSize);
  for (let index = 0; index < circuit.parameterWires.length; index += 1) {
    source[circuit.parameterWires[index]!] = Math.fround(weights[index]!);
  }
  for (let index = 0; index < circuit.featureWires.length; index += 1) {
    source[circuit.featureWires[index]!] = Math.fround(features[index]!);
  }
  return source;
}

function forward(circuit: PathCircuit, weights: readonly number[], features: readonly number[]): ForwardResult {
  const values = circuit.circuit.evaluateReference(sourceFor(circuit, weights, features));
  const logits = circuit.logitWires.map(wire => values[wire]!);
  if (!logits.every(Number.isFinite)) throw new Error("Non-finite path-controller logits");
  return { values, logits };
}

function softmaxCrossEntropy(logits: readonly number[], expectedIndex: number): { loss: number; probabilities: number[] } {
  let maximum = Number.NEGATIVE_INFINITY;
  for (const logit of logits) maximum = Math.max(maximum, logit);
  const exponentials = logits.map(logit => Math.exp(logit - maximum));
  const denominator = exponentials.reduce((sum, value) => sum + value, 0);
  const loss = Math.log(denominator) + maximum - logits[expectedIndex]!;
  if (!Number.isFinite(loss) || !Number.isFinite(denominator) || denominator <= 0) {
    throw new Error("Non-finite path-controller loss");
  }
  return { loss, probabilities: exponentials.map(value => value / denominator) };
}

function evaluateBatch(
  circuit: PathCircuit,
  rows: readonly PathFitRow[],
  weights: readonly number[],
  timing: FitTiming,
  gradientPass: boolean,
): BatchResult {
  const gradient = gradientPass ? new Float64Array(weights.length) : null;
  let lossTotal = 0;
  for (const row of rows) {
    const evaluated = forward(circuit, weights, row.features);
    const expectedIndex = PATH_ACTIONS.indexOf(row.expected);
    const { loss, probabilities } = softmaxCrossEntropy(evaluated.logits, expectedIndex);
    lossTotal += loss;
    timing.totalRowPasses += 1;
    if (gradient === null) continue;
    timing.gradientRowEpochs += 1;
    const outputGradients = new Float32Array(evaluated.values.length);
    for (let actionIndex = 0; actionIndex < PATH_ACTIONS.length; actionIndex += 1) {
      outputGradients[circuit.logitWires[actionIndex]!] = Math.fround(
        probabilities[actionIndex]! - (actionIndex === expectedIndex ? 1 : 0),
      );
    }
    const sourceGradients = circuit.circuit.backpropagateReference(evaluated.values, outputGradients);
    for (let parameterIndex = 0; parameterIndex < circuit.parameterWires.length; parameterIndex += 1) {
      gradient[parameterIndex] = gradient[parameterIndex]!
        + sourceGradients[circuit.parameterWires[parameterIndex]!]!;
    }
  }

  const loss = lossTotal / rows.length;
  if (!Number.isFinite(loss)) throw new Error("Non-finite path-controller batch loss");
  if (gradient !== null) {
    for (let index = 0; index < gradient.length; index += 1) {
      gradient[index] = gradient[index]! / rows.length;
      if (!Number.isFinite(gradient[index]!)) throw new Error("Non-finite path-controller gradient");
    }
  }
  return { loss, gradient };
}

function updateParameters(weights: number[], gradient: Float64Array, learningRate: number): void {
  for (let index = 0; index < weights.length; index += 1) {
    const updated = weights[index]! - learningRate * gradient[index]!;
    if (!Number.isFinite(updated)) throw new Error("Non-finite path-controller parameter update");
    weights[index] = Math.fround(updated);
    if (!Number.isFinite(weights[index]!)) throw new Error("Non-finite path-controller parameter");
  }
}

function profileFromWeights(initial: PathProfile, weights: readonly number[]): PathProfile {
  return validatePathProfile({
    contract: initial.contract,
    actions: initial.actions,
    wires: initial.wires,
    weights: PATH_ACTIONS.map((_, actionIndex) =>
      PATH_WIRES.map((_, wireIndex) => weights[actionIndex * PATH_WIRES.length + wireIndex]!),
    ),
    calibration: initial.calibration,
    adoption: initial.adoption,
  });
}

function attachFitTiming(error: unknown, completedEpochs: number, timing: FitTiming): never {
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

export async function fitPathController(value: FitPathControllerInput): Promise<FitPathControllerResult> {
  const fitStarted = performance.now();
  const timing: FitTiming = {
    backendLoadMs: 0,
    circuitBuildMs: 0,
    baselineEvalMs: 0,
    trainEpochGradMs: 0,
    finalEvalMs: 0,
    fitTotalMs: 0,
    completedEpochs: 0,
    processedRowCount: 0,
    gradientRowEpochs: 0,
    totalRowPasses: 0,
    trainableParamCount: 0,
  };
  const trajectory: EpochMetric[] = [];
  try {
    const rawRows = expectArray(value.rows, "rows");
    timing.processedRowCount = rawRows.length;
    const rows = readRows(rawRows);
    if (rows.length === 0) throw new TypeError("rows must not be empty");
    const handwiredRoot = expectNonEmptyString(value.handwiredRoot, "handwiredRoot");
    const epochs = nonnegativeInteger(value.epochs, "epochs");
    const learningRate = expectFiniteNumber(value.learningRate, "learningRate");
    if (learningRate <= 0) throw new TypeError("learningRate must be positive");
    const initial = validatePathProfile(value.initial);
    const startingProfile = structuredClone(initial);

    if (epochs === 0) {
      return { profile: startingProfile, timing, trajectory };
    }
    timing.trainableParamCount = PATH_ACTIONS.length * PATH_WIRES.length;

    const backendStarted = performance.now();
    let module: HandwiredModule | undefined;
    try {
      module = await loadHandwired(handwiredRoot);
    } finally {
      timing.backendLoadMs = performance.now() - backendStarted;
    }
    if (module === undefined) throw new Error("Handwired loader returned no module");

    const circuitStarted = performance.now();
    let circuit: PathCircuit | undefined;
    try {
      circuit = buildPathCircuit(module);
    } finally {
      timing.circuitBuildMs = performance.now() - circuitStarted;
    }
    if (circuit === undefined) throw new Error("Path circuit builder returned no circuit");

    const weights = startingProfile.weights.flatMap(row => [...row]);
    const baselineStarted = performance.now();
    try {
      evaluateBatch(circuit, rows, weights, timing, false);
    } finally {
      timing.baselineEvalMs = performance.now() - baselineStarted;
    }

    for (let epoch = 0; epoch < epochs; epoch += 1) {
      const trainStarted = performance.now();
      let result: BatchResult;
      try {
        result = evaluateBatch(circuit, rows, weights, timing, true);
        updateParameters(weights, result.gradient!, learningRate);
      } finally {
        timing.trainEpochGradMs += performance.now() - trainStarted;
      }
      trajectory.push({ epoch: epoch + 1, loss: result.loss });
      timing.completedEpochs = trajectory.length;
    }

    const finalStarted = performance.now();
    try {
      evaluateBatch(circuit, rows, weights, timing, false);
    } finally {
      timing.finalEvalMs = performance.now() - finalStarted;
    }
    return { profile: profileFromWeights(initial, weights), timing, trajectory };
  } catch (error) {
    return attachFitTiming(error, trajectory.length, timing);
  } finally {
    timing.fitTotalMs = performance.now() - fitStarted;
  }
}
