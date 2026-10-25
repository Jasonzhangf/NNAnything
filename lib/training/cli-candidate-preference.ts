import { buildCliCommandCircuit } from "../nodes/trainable/cli-command-policy.js";
import {
  CLI_COMMAND_WIRES,
  validateCliCommandProfile,
  type CliCommandProfile,
} from "../filters/cli-command-policy.js";
import { loadHandwired } from "./handwired.js";

export type CliCandidatePreferenceInputRow = Readonly<{
  id: string;
  sourceGroup: string;
  partition: string;
  preferredName: string;
  otherName: string;
  preferredFeatures: readonly number[];
  otherFeatures: readonly number[];
  evidenceRefs: readonly string[];
}>;

export type CliCandidatePreferenceRow = CliCandidatePreferenceInputRow & Readonly<{
  delta: number;
}>;

export type CliCandidatePreferenceDataset = Readonly<{
  version: 1;
  rows: readonly CliCandidatePreferenceRow[];
  validPairCount: number;
  deltaZeroCount: number;
  deltaOneCount: number;
}>;

const NAME_WIRE = "search.nameNeedleSegment";
const NAME_COLUMN = CLI_COMMAND_WIRES.indexOf(NAME_WIRE);

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function features(value: unknown, label: string): readonly number[] {
  if (!Array.isArray(value) || value.length !== CLI_COMMAND_WIRES.length) {
    throw new TypeError(`${label} must contain ${CLI_COMMAND_WIRES.length} features`);
  }
  if (value.some(feature => typeof feature !== "number" || !Number.isFinite(feature))) {
    throw new TypeError(`${label} must contain finite features`);
  }
  return Object.freeze([...value] as number[]);
}

function evidenceRefs(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some(ref => typeof ref !== "string" || ref.length === 0)) {
    throw new TypeError(`${label} must contain non-empty evidence refs`);
  }
  return Object.freeze([...value] as string[]);
}

/**
 * Preference rows are candidate comparisons only. A row with zero difference on
 * the name-relation wire carries no gradient and is not a valid training row.
 */
export function prepareCliCandidatePreferenceDataset(value: unknown): CliCandidatePreferenceDataset {
  if (!Array.isArray(value)) throw new TypeError("preference rows must be an array");
  const rows: CliCandidatePreferenceRow[] = [];
  let deltaZeroCount = 0, deltaOneCount = 0;
  value.forEach((raw, index) => {
    if (typeof raw !== "object" || raw === null) throw new TypeError(`preference row ${index} must be an object`);
    const row = raw as Record<string, unknown>;
    const preferredFeatures = features(row.preferredFeatures, `preference row ${index} preferredFeatures`);
    const otherFeatures = features(row.otherFeatures, `preference row ${index} otherFeatures`);
    const delta = preferredFeatures[NAME_COLUMN]! - otherFeatures[NAME_COLUMN]!;
    if (delta === 0) {
      deltaZeroCount += 1;
      return;
    }
    if (delta === 1) deltaOneCount += 1;
    rows.push(Object.freeze({
      id: nonEmpty(row.id, `preference row ${index} id`),
      sourceGroup: nonEmpty(row.sourceGroup, `preference row ${index} sourceGroup`),
      partition: nonEmpty(row.partition, `preference row ${index} partition`),
      preferredName: nonEmpty(row.preferredName, `preference row ${index} preferredName`),
      otherName: nonEmpty(row.otherName, `preference row ${index} otherName`),
      preferredFeatures,
      otherFeatures,
      evidenceRefs: evidenceRefs(row.evidenceRefs ?? [], `preference row ${index} evidenceRefs`),
      delta,
    }));
  });
  if (rows.length === 0) {
    throw new TypeError("preference dataset has no valid rows: every pair has delta=0");
  }
  return Object.freeze({
    version: 1 as const,
    rows: Object.freeze(rows),
    validPairCount: rows.length,
    deltaZeroCount,
    deltaOneCount,
  });
}

export type CliCandidatePreferenceFitTiming = {
  backendLoadMs: number;
  circuitBuildMs: number;
  trainEpochGradMs: number;
  fitTotalMs: number;
  completedEpochs: number;
  processedRowCount: number;
  gradientRowEpochs: number;
  totalRowPasses: number;
  trainableParamCount: number;
};

function softplus(value: number): number {
  return value > 0 ? value + Math.log1p(Math.exp(-value)) : Math.log1p(Math.exp(value));
}

function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

export function cliCandidatePreferenceLoss(margin: number): number {
  if (!Number.isFinite(margin)) throw new TypeError("preference margin must be finite");
  return softplus(-margin);
}

export type CliCandidatePreferenceEvaluationRow = Readonly<{
  id: string;
  partition: string;
  preferredName: string;
  otherName: string;
  preferredUtility: number;
  otherUtility: number;
  margin: number;
  correct: boolean;
}>;

/**
 * Re-executes the fitted profile on the row features without learning. The
 * applicable execution check for the preference task is a positive margin for
 * every valid comparison row.
 */
export async function evaluateCliCandidateNamePreference(input: Readonly<{
  profile: CliCommandProfile;
  rows: readonly CliCandidatePreferenceInputRow[];
  handwiredRoot: string;
}>) {
  const profile = validateCliCommandProfile(input.profile);
  const prepared = prepareCliCandidatePreferenceDataset(input.rows);
  const inspectRow = profile.heads.indexOf("entry.inspect");
  if (inspectRow < 0) throw new TypeError("entry.inspect head is required for candidate preference evaluation");
  const rows = prepared.rows;
  if (rows.length === 0) return Object.freeze({ count: 0, correct: 0, rows: Object.freeze([]) });
  const module = await loadHandwired(input.handwiredRoot);
  const graph = buildCliCommandCircuit(module, profile.heads.length, profile.wires.length);
  const weights = profile.weights.flatMap(row => [...row]);
  const evaluateUtility = (features: readonly number[]): number => {
    const source = new Float32Array(graph.circuit.sourceSize);
    graph.parameters.forEach((wire, index) => { source[wire] = Math.fround(weights[index]!); });
    graph.features.forEach((wire, index) => { source[wire] = features[index]!; });
    return graph.circuit.evaluateReference(source)[graph.logits[inspectRow]!]!;
  };
  const evaluated = rows.map(row => {
    const preferredUtility = evaluateUtility(row.preferredFeatures);
    const otherUtility = evaluateUtility(row.otherFeatures);
    const margin = preferredUtility - otherUtility;
    if (!Number.isFinite(margin)) throw new Error("Non-finite candidate preference margin");
    return Object.freeze({
      id: row.id,
      partition: row.partition,
      preferredName: row.preferredName,
      otherName: row.otherName,
      preferredUtility,
      otherUtility,
      margin,
      correct: margin > 0,
    });
  });
  return Object.freeze({
    count: evaluated.length,
    correct: evaluated.filter(row => row.correct).length,
    rows: Object.freeze(evaluated),
  });
}

/**
 * Fits exactly one parameter: the entry.inspect row of
 * search.nameNeedleSegment. Evaluation and backpropagation use the same
 * Handwired circuit as command training; all other 309 weights stay frozen.
 */
export async function fitCliCandidateNamePreference(input: Readonly<{
  initial: CliCommandProfile;
  rows: readonly CliCandidatePreferenceInputRow[];
  handwiredRoot: string;
  epochs: number;
  learningRate: number;
}>) {
  const started = performance.now(), initial = validateCliCommandProfile(input.initial);
  if (!Number.isInteger(input.epochs) || input.epochs < 0 || !Number.isFinite(input.learningRate) || input.learningRate <= 0) {
    throw new TypeError("Invalid preference training budget");
  }
  const prepared = prepareCliCandidatePreferenceDataset(input.rows);
  const rows = prepared.rows;
  const inspectRow = initial.heads.indexOf("entry.inspect");
  if (inspectRow < 0) throw new TypeError("entry.inspect head is required for candidate preference training");
  const trainIndex = inspectRow * initial.wires.length + NAME_COLUMN;
  const timing: CliCandidatePreferenceFitTiming = {
    backendLoadMs: 0,
    circuitBuildMs: 0,
    trainEpochGradMs: 0,
    fitTotalMs: 0,
    completedEpochs: 0,
    processedRowCount: rows.length,
    gradientRowEpochs: 0,
    totalRowPasses: 0,
    trainableParamCount: 1,
  };
  const weights = initial.weights.flatMap(row => [...row]);
  const initialWeights = [...weights];
  const parameterBefore = weights[trainIndex]!;
  let initialGradient = 0;
  let initialLoss = 0, finalLoss = 0;
  const trajectory: { epoch: number; loss: number }[] = [];
  try {
    if (input.epochs > 0) {
      const backendStarted = performance.now();
      const module = await loadHandwired(input.handwiredRoot);
      timing.backendLoadMs = performance.now() - backendStarted;
      const buildStarted = performance.now();
      const graph = buildCliCommandCircuit(module, initial.heads.length, initial.wires.length);
      timing.circuitBuildMs = performance.now() - buildStarted;
      const evaluateUtility = (features: readonly number[]): number => {
        const source = new Float32Array(graph.circuit.sourceSize);
        graph.parameters.forEach((wire, index) => { source[wire] = Math.fround(weights[index]!); });
        graph.features.forEach((wire, index) => { source[wire] = features[index]!; });
        return graph.circuit.evaluateReference(source)[graph.logits[inspectRow]!]!;
      };
      const backpropUtilityGradient = (features: readonly number[], outputGradient: number): number => {
        const source = new Float32Array(graph.circuit.sourceSize);
        graph.parameters.forEach((wire, index) => { source[wire] = Math.fround(weights[index]!); });
        graph.features.forEach((wire, index) => { source[wire] = features[index]!; });
        const values = graph.circuit.evaluateReference(source);
        const gradient = new Float32Array(values.length);
        gradient[graph.logits[inspectRow]!] = Math.fround(outputGradient);
        const sourceGradient = graph.circuit.backpropagateReference(values, gradient);
        return sourceGradient[graph.parameters[trainIndex]!]!;
      };
      for (let epoch = 0; epoch < input.epochs; epoch += 1) {
        const epochStarted = performance.now(), gradient = new Float64Array(weights.length);
        let totalLoss = 0;
        for (const row of rows) {
          const preferredUtility = evaluateUtility(row.preferredFeatures);
          const otherUtility = evaluateUtility(row.otherFeatures);
          const margin = preferredUtility - otherUtility;
          const loss = cliCandidatePreferenceLoss(margin);
          if (!Number.isFinite(loss)) throw new Error("Non-finite candidate preference loss");
          totalLoss += loss;
          const dMargin = -sigmoid(-margin);
          gradient[trainIndex] = gradient[trainIndex]!
            + backpropUtilityGradient(row.preferredFeatures, dMargin)
            + backpropUtilityGradient(row.otherFeatures, -dMargin);
          timing.gradientRowEpochs += 1;
          timing.totalRowPasses += 1;
        }
        if (epoch === 0) {
          initialGradient = gradient[trainIndex]! / rows.length;
          initialLoss = totalLoss / rows.length;
        }
        weights[trainIndex] = weights[trainIndex]! - input.learningRate * gradient[trainIndex]! / rows.length;
        if (!Number.isFinite(weights[trainIndex])) throw new Error("Non-finite candidate preference weight");
        timing.completedEpochs += 1;
        timing.trainEpochGradMs += performance.now() - epochStarted;
        trajectory.push({ epoch: epoch + 1, loss: totalLoss / rows.length });
      }
      finalLoss = rows.reduce((sum, row) =>
        sum + cliCandidatePreferenceLoss(evaluateUtility(row.preferredFeatures) - evaluateUtility(row.otherFeatures)),
        0,
      ) / rows.length;
    }
    const parameterAfter = weights[trainIndex]!;
    const frozenDelta = weights.reduce(
      (maximum, weight, index) => index === trainIndex ? maximum : Math.max(maximum, Math.abs(weight - initialWeights[index]!)),
      0,
    );
    if (frozenDelta !== 0) throw new Error("Candidate preference training changed a frozen parameter");
    const profile = validateCliCommandProfile({
      ...initial,
      weights: initial.heads.map((_, index) => initial.wires.map((__, column) => {
        const flat = index * initial.wires.length + column;
        return weights[flat]!;
      })),
    });
    return Object.freeze({
      profile,
      initialProfile: initial,
      initialGradient,
      initialLoss,
      finalLoss,
      parameterBefore,
      parameterAfter,
      trainableParameter: Object.freeze({
        head: "entry.inspect" as const,
        wire: NAME_WIRE,
        index: trainIndex,
      }),
      validPairCount: prepared.validPairCount,
      deltaZeroCount: prepared.deltaZeroCount,
      deltaOneCount: prepared.deltaOneCount,
      frozenParameterCount: initial.heads.length * initial.wires.length - 1,
      frozenDelta,
      trajectory: Object.freeze(trajectory.map(point => Object.freeze(point))),
      timing,
    });
  } catch (error) {
    if (error && typeof error === "object") Object.assign(error, { timing });
    throw error;
  } finally {
    timing.fitTotalMs = performance.now() - started;
  }
}
