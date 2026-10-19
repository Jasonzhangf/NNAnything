import { expectArray, expectFiniteNumber, expectNonEmptyString, expectRecord } from "../core/schema.js";
import {
  CLI_GOAL_ACTIONS,
  CLI_GOAL_WIRES,
  validateCliGoalProfile,
  type CliGoalAction,
  type CliGoalFeatures,
  type CliGoalFitRow,
  type CliGoalProfile,
} from "../filters/cli-goal-policy.js";
import { buildCliGoalCircuit, type CliGoalCircuit } from "../nodes/trainable/cli-goal-policy.js";
import { loadHandwired, type HandwiredModule } from "./handwired.js";

export interface CliGoalFitTiming {
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

export interface CliGoalEpochMetric {
  readonly epoch: number;
  readonly loss: number;
}

export interface FitCliGoalPolicyInput {
  readonly rows: readonly CliGoalFitRow[];
  readonly initial: CliGoalProfile;
  readonly handwiredRoot: string;
  readonly epochs: number;
  readonly learningRate: number;
}

export interface FitCliGoalPolicyResult {
  readonly profile: CliGoalProfile;
  readonly timing: CliGoalFitTiming;
  readonly trajectory: readonly CliGoalEpochMetric[];
}

interface ForwardResult {
  readonly values: Float32Array;
  readonly logits: readonly [number, number];
}

interface BatchResult {
  readonly loss: number;
  readonly gradient: Float64Array | null;
}

function readRows(value: unknown): readonly CliGoalFitRow[] {
  return expectArray(value, "rows").map((raw, index) => {
    const row = expectRecord(raw, `rows[${index}]`);
    if (Object.keys(row).some(key => key !== "features" && key !== "expected")) throw new TypeError(`rows[${index}] has unsupported field`);
    const rawFeatures = expectArray(row.features, `rows[${index}].features`);
    if (rawFeatures.length !== CLI_GOAL_WIRES.length) throw new TypeError(`rows[${index}].features must contain three values`);
    const features = rawFeatures.map((value, featureIndex) =>
      expectFiniteNumber(value, `rows[${index}].features[${featureIndex}]`),
    ) as [number, number, number];
    const expected = expectNonEmptyString(row.expected, `rows[${index}].expected`);
    if (!CLI_GOAL_ACTIONS.includes(expected as CliGoalAction)) throw new TypeError(`rows[${index}].expected is not a goal action`);
    return Object.freeze({ features: Object.freeze(features) as CliGoalFeatures, expected: expected as CliGoalAction });
  });
}

function sourceFor(circuit: CliGoalCircuit, weights: readonly number[], features: CliGoalFeatures): Float32Array {
  const source = new Float32Array(circuit.circuit.sourceSize);
  for (let index = 0; index < circuit.parameterWires.length; index += 1) {
    source[circuit.parameterWires[index]!] = Math.fround(weights[index]!);
  }
  for (let index = 0; index < circuit.featureWires.length; index += 1) {
    source[circuit.featureWires[index]!] = Math.fround(features[index]!);
  }
  return source;
}

function forward(circuit: CliGoalCircuit, weights: readonly number[], features: CliGoalFeatures): ForwardResult {
  const values = circuit.circuit.evaluateReference(sourceFor(circuit, weights, features));
  const logits = [values[circuit.logitWires[0]!]!, values[circuit.logitWires[1]!]!] as const;
  if (!logits.every(Number.isFinite)) throw new Error("Non-finite cli-goal logits");
  return { values, logits };
}

function softmaxCrossEntropy(logits: readonly [number, number], expectedIndex: number): { loss: number; probabilities: [number, number] } {
  const maximum = Math.max(logits[0], logits[1]);
  const first = Math.exp(logits[0] - maximum);
  const second = Math.exp(logits[1] - maximum);
  const denominator = first + second;
  const probabilities: [number, number] = [first / denominator, second / denominator];
  const loss = Math.log(denominator) + maximum - logits[expectedIndex]!;
  if (!Number.isFinite(loss) || !Number.isFinite(denominator) || denominator <= 0) throw new Error("Non-finite cli-goal loss");
  return { loss, probabilities };
}

function evaluateBatch(
  circuit: CliGoalCircuit,
  rows: readonly CliGoalFitRow[],
  weights: readonly number[],
  timing: CliGoalFitTiming,
  gradientPass: boolean,
): BatchResult {
  const gradient = gradientPass ? new Float64Array(weights.length) : null;
  let lossTotal = 0;
  for (const row of rows) {
    const evaluated = forward(circuit, weights, row.features);
    const expectedIndex = CLI_GOAL_ACTIONS.indexOf(row.expected);
    const { loss, probabilities } = softmaxCrossEntropy(evaluated.logits, expectedIndex);
    lossTotal += loss;
    timing.totalRowPasses += 1;
    if (gradient === null) continue;
    timing.gradientRowEpochs += 1;
    const outputGradients = new Float32Array(evaluated.values.length);
    for (let actionIndex = 0; actionIndex < CLI_GOAL_ACTIONS.length; actionIndex += 1) {
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
  if (!Number.isFinite(loss)) throw new Error("Non-finite cli-goal batch loss");
  if (gradient !== null) {
    for (let index = 0; index < gradient.length; index += 1) {
      gradient[index] = gradient[index]! / rows.length;
      if (!Number.isFinite(gradient[index]!)) throw new Error("Non-finite cli-goal gradient");
    }
  }
  return { loss, gradient };
}

function updateParameters(weights: number[], gradient: Float64Array, learningRate: number): void {
  for (let index = 0; index < weights.length; index += 1) {
    weights[index] = Math.fround(weights[index]! - learningRate * gradient[index]!);
    if (!Number.isFinite(weights[index]!)) throw new Error("Non-finite cli-goal parameter");
  }
}

function profileFromWeights(initial: CliGoalProfile, weights: readonly number[]): CliGoalProfile {
  return validateCliGoalProfile({
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

function attachTiming(error: unknown, completedEpochs: number, timing: CliGoalFitTiming): never {
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

export async function fitCliGoalPolicy(value: FitCliGoalPolicyInput): Promise<FitCliGoalPolicyResult> {
  const input = expectRecord(value, "fit request");
  const started = performance.now();
  const timing: CliGoalFitTiming = {
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
  const trajectory: CliGoalEpochMetric[] = [];
  try {
    const rows = readRows(input.rows);
    if (rows.length === 0) throw new TypeError("rows must not be empty");
    timing.processedRowCount = rows.length;
    const initial = validateCliGoalProfile(input.initial);
    const handwiredRoot = expectNonEmptyString(input.handwiredRoot, "handwiredRoot");
    const epochs = expectFiniteNumber(input.epochs, "epochs");
    if (!Number.isInteger(epochs) || epochs < 0) throw new TypeError("epochs must be a nonnegative integer");
    const learningRate = expectFiniteNumber(input.learningRate, "learningRate");
    if (learningRate <= 0) throw new TypeError("learningRate must be positive");
    if (epochs === 0) return { profile: structuredClone(initial), timing, trajectory };
    timing.trainableParamCount = CLI_GOAL_ACTIONS.length * CLI_GOAL_WIRES.length;

    const backendStarted = performance.now();
    let module: HandwiredModule | undefined;
    try {
      module = await loadHandwired(handwiredRoot);
    } finally {
      timing.backendLoadMs = performance.now() - backendStarted;
    }
    if (module === undefined) throw new Error("Handwired loader returned no module");

    const circuitStarted = performance.now();
    let circuit: CliGoalCircuit | undefined;
    try {
      circuit = buildCliGoalCircuit(module);
    } finally {
      timing.circuitBuildMs = performance.now() - circuitStarted;
    }
    if (circuit === undefined) throw new Error("cli-goal circuit builder returned no circuit");

    const weights = initial.weights.flatMap(row => [...row]);
    const baselineStarted = performance.now();
    try {
      evaluateBatch(circuit, rows, weights, timing, false);
    } finally {
      timing.baselineEvalMs = performance.now() - baselineStarted;
    }
    for (let epoch = 0; epoch < epochs; epoch += 1) {
      const trainStarted = performance.now();
      let batch: BatchResult;
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
