import { expectNonEmptyString, expectRecord } from "../core/schema.js";
import {
  CWD_RELATION_ACTIONS,
  CWD_RELATION_WIRES,
  readCwdRelationFitRows,
  validateCwdRelationProfile,
  type CwdRelationAction,
  type CwdRelationFeatures,
  type CwdRelationProfile,
} from "../filters/cwd-relation.js";
import { buildTwoClassLinearCircuit, type TwoClassLinearCircuit } from "../nodes/trainable/two-class-linear.js";
import { loadHandwired, type HandwiredModule } from "./handwired.js";

export interface CwdRelationFitTiming {
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

export interface FitCwdRelationInput {
  readonly rows: readonly Readonly<{ features: CwdRelationFeatures; expected: CwdRelationAction }>[];
  readonly initial: CwdRelationProfile;
  readonly handwiredRoot: string;
  readonly epochs: number;
  readonly learningRate: number;
}

export interface FitCwdRelationResult {
  readonly profile: CwdRelationProfile;
  readonly timing: CwdRelationFitTiming;
  readonly trajectory: readonly Readonly<{ epoch: number; loss: number }>[];
}

interface ForwardResult {
  readonly values: Float32Array;
  readonly logits: readonly [number, number];
}

function sourceFor(circuit: TwoClassLinearCircuit, weights: readonly number[], features: CwdRelationFeatures): Float32Array {
  const source = new Float32Array(circuit.circuit.sourceSize);
  for (let index = 0; index < circuit.parameterWires.length; index += 1) {
    source[circuit.parameterWires[index]!] = Math.fround(weights[index]!);
  }
  for (let index = 0; index < circuit.featureWires.length; index += 1) {
    source[circuit.featureWires[index]!] = Math.fround(features[index]!);
  }
  return source;
}

function forward(circuit: TwoClassLinearCircuit, weights: readonly number[], features: CwdRelationFeatures): ForwardResult {
  const values = circuit.circuit.evaluateReference(sourceFor(circuit, weights, features));
  const logits = [values[circuit.logitWires[0]!]!, values[circuit.logitWires[1]!]!] as const;
  if (!logits.every(Number.isFinite)) throw new Error("Non-finite CWD relation logits");
  return { values, logits };
}

function softmaxCrossEntropy(logits: readonly [number, number], expectedIndex: number): { loss: number; probabilities: [number, number] } {
  const maximum = Math.max(logits[0], logits[1]);
  const first = Math.exp(logits[0] - maximum);
  const second = Math.exp(logits[1] - maximum);
  const denominator = first + second;
  const probabilities: [number, number] = [first / denominator, second / denominator];
  const loss = Math.log(denominator) + maximum - logits[expectedIndex]!;
  if (!Number.isFinite(loss) || !Number.isFinite(denominator) || denominator <= 0) throw new Error("Non-finite CWD relation loss");
  return { loss, probabilities };
}

function evaluateBatch(
  circuit: TwoClassLinearCircuit,
  rows: FitCwdRelationInput["rows"],
  weights: readonly number[],
  timing: CwdRelationFitTiming,
  gradientPass: boolean,
): { loss: number; gradient: Float64Array | null } {
  const gradient = gradientPass ? new Float64Array(weights.length) : null;
  let lossTotal = 0;
  for (const row of rows) {
    const evaluated = forward(circuit, weights, row.features);
    const expectedIndex = CWD_RELATION_ACTIONS.indexOf(row.expected);
    const { loss, probabilities } = softmaxCrossEntropy(evaluated.logits, expectedIndex);
    lossTotal += loss;
    timing.totalRowPasses += 1;
    if (gradient === null) continue;
    timing.gradientRowEpochs += 1;
    const outputGradients = new Float32Array(evaluated.values.length);
    for (let classIndex = 0; classIndex < CWD_RELATION_ACTIONS.length; classIndex += 1) {
      outputGradients[circuit.logitWires[classIndex]!] = Math.fround(
        probabilities[classIndex]! - (classIndex === expectedIndex ? 1 : 0),
      );
    }
    const sourceGradients = circuit.circuit.backpropagateReference(evaluated.values, outputGradients);
    for (let parameterIndex = 0; parameterIndex < circuit.parameterWires.length; parameterIndex += 1) {
      gradient[parameterIndex] = gradient[parameterIndex]! + sourceGradients[circuit.parameterWires[parameterIndex]!]!;
    }
  }
  const loss = lossTotal / rows.length;
  if (!Number.isFinite(loss)) throw new Error("Non-finite CWD relation batch loss");
  if (gradient !== null) {
    for (let index = 0; index < gradient.length; index += 1) {
      gradient[index] = gradient[index]! / rows.length;
      if (!Number.isFinite(gradient[index]!)) throw new Error("Non-finite CWD relation gradient");
    }
  }
  return { loss, gradient };
}

function updateParameters(weights: number[], gradient: Float64Array, learningRate: number): void {
  for (let index = 0; index < weights.length; index += 1) {
    weights[index] = Math.fround(weights[index]! - learningRate * gradient[index]!);
    if (!Number.isFinite(weights[index]!)) throw new Error("Non-finite CWD relation parameter");
  }
}

function profileFromWeights(initial: CwdRelationProfile, weights: readonly number[]): CwdRelationProfile {
  return validateCwdRelationProfile({
    contract: initial.contract,
    actions: initial.actions,
    wires: initial.wires,
    weights: [
      [weights[0]!, weights[1]!, weights[2]!],
      [weights[3]!, weights[4]!, weights[5]!],
    ],
    calibration: initial.calibration,
    adoption: initial.adoption,
  });
}

function attachTiming(error: unknown, completedEpochs: number, timing: CwdRelationFitTiming): never {
  timing.completedEpochs = completedEpochs;
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    Object.assign(error, { completedEpochs, timing });
    throw error;
  }
  const wrapped = new Error(String(error), { cause: error });
  Object.assign(wrapped, { completedEpochs, timing });
  throw wrapped;
}

export async function fitCwdRelation(input: FitCwdRelationInput): Promise<FitCwdRelationResult> {
  const value = expectRecord(input, "CWD relation fit request");
  const started = performance.now();
  const timing: CwdRelationFitTiming = {
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
  const trajectory: { epoch: number; loss: number }[] = [];
  try {
    const rows = readCwdRelationFitRows(value.rows);
    if (!rows.length) throw new TypeError("CWD relation rows must not be empty");
    timing.processedRowCount = rows.length;
    const initial = validateCwdRelationProfile(value.initial);
    const handwiredRoot = expectNonEmptyString(value.handwiredRoot, "handwiredRoot");
    if (typeof value.epochs !== "number" || !Number.isInteger(value.epochs) || value.epochs < 0) {
      throw new TypeError("epochs must be a nonnegative integer");
    }
    const epochs = value.epochs;
    if (typeof value.learningRate !== "number" || !Number.isFinite(value.learningRate) || value.learningRate <= 0) {
      throw new TypeError("learningRate must be positive finite");
    }
    const learningRate = value.learningRate;
    if (epochs === 0) return { profile: structuredClone(initial), timing, trajectory };
    timing.trainableParamCount = CWD_RELATION_ACTIONS.length * CWD_RELATION_WIRES.length;

    const backendStarted = performance.now();
    let module: HandwiredModule | undefined;
    try {
      module = await loadHandwired(handwiredRoot);
    } finally {
      timing.backendLoadMs = performance.now() - backendStarted;
    }
    if (module === undefined) throw new Error("Handwired loader returned no module");

    const circuitStarted = performance.now();
    let circuit: TwoClassLinearCircuit | undefined;
    try {
      circuit = buildTwoClassLinearCircuit(module, CWD_RELATION_WIRES.length);
    } finally {
      timing.circuitBuildMs = performance.now() - circuitStarted;
    }
    if (circuit === undefined) throw new Error("CWD relation circuit builder returned no circuit");

    const weights = initial.weights.flatMap(row => [...row]);
    const baselineStarted = performance.now();
    try {
      evaluateBatch(circuit, rows, weights, timing, false);
    } finally {
      timing.baselineEvalMs = performance.now() - baselineStarted;
    }
    for (let epoch = 0; epoch < epochs; epoch += 1) {
      const trainStarted = performance.now();
      let batch: { loss: number; gradient: Float64Array | null };
      try {
        batch = evaluateBatch(circuit, rows, weights, timing, true);
        updateParameters(weights, batch.gradient!, learningRate);
      } finally {
        timing.trainEpochGradMs += performance.now() - trainStarted;
      }
      trajectory.push({ epoch: epoch + 1, loss: batch.loss });
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
    return attachTiming(error, trajectory.length, timing);
  } finally {
    timing.fitTotalMs = performance.now() - started;
  }
}
