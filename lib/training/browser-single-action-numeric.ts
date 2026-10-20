import {
  SINGLE_ACTION_CAPABILITY_HEADS,
  SINGLE_ACTION_CAPABILITY_WIRES,
  SINGLE_ACTION_RELATION_HEADS,
  SINGLE_ACTION_RELATION_WIRES,
  type BrowserSingleActionProfile,
  type SingleActionCapability,
  type SingleActionFitTiming,
  type SingleActionTeacherEpisode,
} from "../adapters/browser/single-action-contract.js";
import {
  predictBrowserSingleAction,
  singleActionCapabilityFeatures,
  singleActionRelationFeatures,
  validateBrowserSingleActionProfile,
} from "../filters/browser-single-action-policy.js";
import {
  buildBrowserSingleActionCapabilityCircuit,
  buildBrowserSingleActionRelationCircuit,
} from "../nodes/trainable/browser-single-action-policy.js";
import type { LinearPolicyCircuit } from "../nodes/trainable/linear-policy.js";
import { expectRecord } from "../core/schema.js";
import { loadHandwired, type HandwiredModule } from "./handwired.js";

export interface BrowserSingleActionFitTrajectoryEntry {
  readonly phase: "relation" | "capability";
  readonly epoch: number;
  readonly loss: number;
  readonly gradient: readonly number[];
  readonly weights: readonly number[];
}

export type BrowserSingleActionFitTrajectory = readonly BrowserSingleActionFitTrajectoryEntry[];

export interface BrowserSingleActionFitTiming extends SingleActionFitTiming {
  skippedRelationRows: number;
}

export interface FitBrowserSingleActionProfileInput {
  readonly initial: BrowserSingleActionProfile;
  readonly episodes: readonly SingleActionTeacherEpisode[];
  readonly handwiredRoot: string;
  readonly relationEpochs: number;
  readonly capabilityEpochs: number;
  readonly learningRate: number;
}

export interface FitBrowserSingleActionProfileResult {
  readonly profile: BrowserSingleActionProfile;
  readonly timing: BrowserSingleActionFitTiming;
  readonly trajectory: BrowserSingleActionFitTrajectory;
}

interface FitRow {
  readonly features: readonly number[];
  readonly expectedIndex: number;
}

interface BatchResult {
  readonly loss: number;
  readonly gradient: Float64Array;
}

const CONTROLS_KNOWN = SINGLE_ACTION_RELATION_WIRES.indexOf("controls.known");
const ENABLED_KNOWN = SINGLE_ACTION_RELATION_WIRES.indexOf("enabled.known");
const HIT_KNOWN = SINGLE_ACTION_RELATION_WIRES.indexOf("hit.known");

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function readEpisodes(value: unknown): readonly SingleActionTeacherEpisode[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError("Browser single action training episodes must be non-empty");
  const episodes = value.map((raw, index) => {
    const episode = expectRecord(raw, `browser single action episode ${index}`);
    nonEmptyString(episode.id, `browser single action episode ${index}.id`);
    nonEmptyString(episode.family, `browser single action episode ${index}.family`);
    if (episode.partition !== "train") {
      throw new TypeError("Browser single action fitter accepts only train episodes");
    }
    const teacher = expectRecord(episode.teacher, `browser single action episode ${index}.teacher`);
    if (!Array.isArray(teacher.providerRefs) || teacher.providerRefs.some(ref => typeof ref !== "string" || ref.length === 0)) {
      throw new TypeError(`browser single action episode ${index} providerRefs must be non-empty reference strings`);
    }
    if (!Array.isArray(teacher.unknownRefs) || teacher.unknownRefs.some(ref => typeof ref !== "string" || ref.length === 0)) {
      throw new TypeError(`browser single action episode ${index} unknownRefs must be reference strings`);
    }
    if (!SINGLE_ACTION_CAPABILITY_HEADS.includes(teacher.capability as SingleActionCapability)) {
      throw new TypeError(`browser single action episode ${index} capability is invalid`);
    }
    if (teacher.source !== "synthetic_projection" && teacher.source !== "observed_episode") {
      throw new TypeError(`browser single action episode ${index} source is invalid`);
    }
    const providers = new Set<string>();
    for (const ref of teacher.providerRefs as string[]) {
      if (providers.has(ref)) throw new TypeError(`browser single action episode ${index} providerRefs contains ${ref} twice`);
      providers.add(ref);
    }
    const unknowns = new Set<string>();
    for (const ref of teacher.unknownRefs as string[]) {
      if (providers.has(ref)) throw new TypeError(`browser single action episode ${index} provider and unknown references overlap at ${ref}`);
      if (unknowns.has(ref)) throw new TypeError(`browser single action episode ${index} unknownRefs contains ${ref} twice`);
      unknowns.add(ref);
    }
    const request = expectRecord(episode.request, `browser single action episode ${index}.request`);
    const state = expectRecord(request.state, `browser single action episode ${index}.request.state`);
    if (!Array.isArray(state.elements)) {
      throw new TypeError(`browser single action episode ${index}.request.state.elements must be an array`);
    }
    const elementRefs = new Set(state.elements.map((rawElement, elementIndex) =>
      nonEmptyString(
        expectRecord(rawElement, `browser single action episode ${index}.element ${elementIndex}`).ref,
        `browser single action episode ${index}.element ${elementIndex}.ref`,
      )));
    for (const ref of [...providers, ...unknowns]) {
      if (!elementRefs.has(ref)) {
        throw new TypeError(`browser single action episode ${index} teacher reference ${ref} is absent from the request`);
      }
    }
    return episode as unknown as SingleActionTeacherEpisode;
  });
  return Object.freeze(episodes);
}

function readBudget(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative integer`);
  }
  return value;
}

function readLearningRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError("learningRate must be positive and finite");
  }
  return value;
}

function sourceFor(
  circuit: LinearPolicyCircuit,
  weights: readonly number[],
  features: readonly number[],
): Float32Array {
  const source = new Float32Array(circuit.circuit.sourceSize);
  circuit.parameters.forEach((wire, index) => { source[wire] = Math.fround(weights[index]!); });
  circuit.features.forEach((wire, index) => { source[wire] = Math.fround(features[index]!); });
  return source;
}

function softmaxCrossEntropy(
  logits: readonly number[],
  expectedIndex: number,
): { readonly loss: number; readonly probabilities: readonly number[] } {
  const maximum = Math.max(...logits);
  const exps = logits.map(logit => Math.exp(logit - maximum));
  const denominator = exps.reduce((left, right) => left + right, 0);
  if (!Number.isFinite(denominator) || denominator <= 0) throw new Error("Non-finite browser single action softmax");
  const loss = Math.log(denominator) + maximum - logits[expectedIndex]!;
  if (!Number.isFinite(loss)) throw new Error("Non-finite browser single action loss");
  return {
    loss,
    probabilities: exps.map(value => value / denominator),
  };
}

function evaluateBatch(
  circuit: LinearPolicyCircuit,
  weights: readonly number[],
  rows: readonly FitRow[],
  timing: BrowserSingleActionFitTiming,
): BatchResult {
  const gradient = new Float64Array(weights.length);
  let lossTotal = 0;
  for (const row of rows) {
    const values = circuit.circuit.evaluateReference(sourceFor(circuit, weights, row.features));
    const logits = circuit.logits.map(wire => values[wire]!);
    if (!logits.every(Number.isFinite)) throw new Error("Non-finite browser single action logits");
    const evaluated = softmaxCrossEntropy(logits, row.expectedIndex);
    lossTotal += evaluated.loss;
    const outputGradients = new Float32Array(values.length);
    circuit.logits.forEach((wire, index) => {
      outputGradients[wire] = Math.fround(
        evaluated.probabilities[index]! - (index === row.expectedIndex ? 1 : 0),
      );
    });
    const sourceGradients = circuit.circuit.backpropagateReference(values, outputGradients);
    circuit.parameters.forEach((wire, index) => {
      gradient[index] = gradient[index]! + sourceGradients[wire]!;
    });
    timing.gradientRowEpochs += 1;
    timing.totalForwardRows += 1;
  }
  for (let index = 0; index < gradient.length; index += 1) {
    gradient[index] = gradient[index]! / rows.length;
    if (!Number.isFinite(gradient[index]!)) throw new Error("Non-finite browser single action gradient");
  }
  const loss = lossTotal / rows.length;
  if (!Number.isFinite(loss)) throw new Error("Non-finite browser single action batch loss");
  return { loss, gradient };
}

function updateWeights(weights: readonly number[], gradient: Float64Array, learningRate: number): number[] {
  return weights.map((weight, index) => {
    const updated = Math.fround(weight - learningRate * gradient[index]!);
    if (!Number.isFinite(updated)) throw new Error("Non-finite browser single action parameter");
    return updated;
  });
}

function fitStage(
  circuit: LinearPolicyCircuit,
  initialWeights: readonly number[],
  rows: readonly FitRow[],
  epochs: number,
  learningRate: number,
  phase: BrowserSingleActionFitTrajectoryEntry["phase"],
  timing: BrowserSingleActionFitTiming,
  trajectory: BrowserSingleActionFitTrajectoryEntry[],
): readonly number[] {
  let weights = initialWeights.map(weight => Math.fround(weight));
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const batch = evaluateBatch(circuit, weights, rows, timing);
    weights = updateWeights(weights, batch.gradient, learningRate);
    trajectory.push(Object.freeze({
      phase,
      epoch: epoch + 1,
      loss: batch.loss,
      gradient: Object.freeze([...batch.gradient]),
      weights: Object.freeze([...weights]),
    }));
  }
  return Object.freeze(weights);
}

function attachFailure(error: unknown, timing: BrowserSingleActionFitTiming, trajectory: BrowserSingleActionFitTrajectory): never {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    Object.assign(error, { timing, trajectory });
    throw error;
  }
  const wrapped = new Error(String(error), { cause: error });
  Object.assign(wrapped, { timing, trajectory });
  throw wrapped;
}

function relationRows(episodes: readonly SingleActionTeacherEpisode[], timing: BrowserSingleActionFitTiming): readonly FitRow[] {
  const rows: FitRow[] = [];
  for (const episode of episodes) {
    const providerRefs = new Set(episode.teacher.providerRefs);
    const unknownRefs = new Set(episode.teacher.unknownRefs);
    for (const element of episode.request.state.elements) {
      if (unknownRefs.has(element.ref)) {
        timing.skippedRelationRows += 1;
        continue;
      }
      const features = singleActionRelationFeatures(episode.request, element);
      if (features[CONTROLS_KNOWN] !== 1 || features[ENABLED_KNOWN] !== 1 || features[HIT_KNOWN] !== 1) {
        timing.skippedRelationRows += 1;
        continue;
      }
      rows.push({
        features,
        expectedIndex: SINGLE_ACTION_RELATION_HEADS.indexOf(providerRefs.has(element.ref) ? "actionable_provider" : "not_provider"),
      });
    }
  }
  if (rows.length === 0) throw new TypeError("Browser single action relation training requires at least one decisive element row");
  return Object.freeze(rows);
}

function profileWithWeights(
  initial: BrowserSingleActionProfile,
  relationWeights: readonly number[],
  capabilityWeights: readonly number[],
): BrowserSingleActionProfile {
  return validateBrowserSingleActionProfile({
    ...initial,
    relationWeights: SINGLE_ACTION_RELATION_HEADS.map((_, row) =>
      relationWeights.slice(row * SINGLE_ACTION_RELATION_WIRES.length, (row + 1) * SINGLE_ACTION_RELATION_WIRES.length)),
    capabilityWeights: SINGLE_ACTION_CAPABILITY_HEADS.map((_, row) =>
      capabilityWeights.slice(row * SINGLE_ACTION_CAPABILITY_WIRES.length, (row + 1) * SINGLE_ACTION_CAPABILITY_WIRES.length)),
  });
}

export async function fitBrowserSingleActionProfile(
  input: FitBrowserSingleActionProfileInput,
): Promise<FitBrowserSingleActionProfileResult> {
  const value = expectRecord(input, "browser single action fit request");
  const started = performance.now();
  const timing: BrowserSingleActionFitTiming = {
    backendLoadMs: 0,
    circuitBuildMs: 0,
    relationFitMs: 0,
    capabilityFitMs: 0,
    totalFitMs: 0,
    relationEpochs: 0,
    capabilityEpochs: 0,
    relationRows: 0,
    capabilityRows: 0,
    gradientRowEpochs: 0,
    totalForwardRows: 0,
    trainableParamCount:
      SINGLE_ACTION_RELATION_HEADS.length * SINGLE_ACTION_RELATION_WIRES.length
      + SINGLE_ACTION_CAPABILITY_HEADS.length * SINGLE_ACTION_CAPABILITY_WIRES.length,
    skippedRelationRows: 0,
  };
  const trajectory: BrowserSingleActionFitTrajectoryEntry[] = [];
  try {
    const initial = validateBrowserSingleActionProfile(value.initial);
    const episodes = readEpisodes(value.episodes);
    nonEmptyString(value.handwiredRoot, "handwiredRoot");
    const relationEpochs = readBudget(value.relationEpochs, "relationEpochs");
    const capabilityEpochs = readBudget(value.capabilityEpochs, "capabilityEpochs");
    const learningRate = readLearningRate(value.learningRate);
    const relationTrainingRows = relationRows(episodes, timing);
    const capabilityTrainingRows = episodes.map(episode => ({
      episode,
      features: [] as readonly number[],
      expectedIndex: SINGLE_ACTION_CAPABILITY_HEADS.indexOf(episode.teacher.capability),
    }));
    timing.relationRows = relationTrainingRows.length;
    timing.capabilityRows = capabilityTrainingRows.length;

    let handwired: HandwiredModule | null = null;
    if (relationEpochs > 0 || capabilityEpochs > 0) {
      const backendStarted = performance.now();
      try {
        handwired = await loadHandwired(value.handwiredRoot as string);
      } finally {
        timing.backendLoadMs = performance.now() - backendStarted;
      }
      if (handwired === null) throw new Error("Handwired loader returned no module");
    }

    let relationWeights: readonly number[] = initial.relationWeights.flatMap(row => [...row]);
    if (relationEpochs > 0) {
      const circuitStarted = performance.now();
      let circuit: LinearPolicyCircuit | undefined;
      try {
        circuit = buildBrowserSingleActionRelationCircuit(handwired!);
      } finally {
        timing.circuitBuildMs += performance.now() - circuitStarted;
      }
      if (circuit === undefined) throw new Error("Browser single action relation circuit builder returned no circuit");
      const fitStarted = performance.now();
      try {
        relationWeights = fitStage(
          circuit,
          relationWeights,
          relationTrainingRows,
          relationEpochs,
          learningRate,
          "relation",
          timing,
          trajectory,
        );
      } finally {
        timing.relationFitMs = performance.now() - fitStarted;
        timing.relationEpochs = trajectory.filter(entry => entry.phase === "relation").length;
      }
    }

    const relationProfile = profileWithWeights(initial, relationWeights, initial.capabilityWeights.flatMap(row => [...row]));
    const capabilityRows: FitRow[] = capabilityTrainingRows.map(({ episode, expectedIndex }) => {
      const studentRelations = predictBrowserSingleAction(episode.request, relationProfile).relations;
      return {
        features: singleActionCapabilityFeatures(episode.request, studentRelations),
        expectedIndex,
      };
    });

    let capabilityWeights: readonly number[] = initial.capabilityWeights.flatMap(row => [...row]);
    if (capabilityEpochs > 0) {
      const circuitStarted = performance.now();
      let circuit: LinearPolicyCircuit | undefined;
      try {
        circuit = buildBrowserSingleActionCapabilityCircuit(handwired!);
      } finally {
        timing.circuitBuildMs += performance.now() - circuitStarted;
      }
      if (circuit === undefined) throw new Error("Browser single action capability circuit builder returned no circuit");
      const fitStarted = performance.now();
      try {
        capabilityWeights = fitStage(
          circuit,
          capabilityWeights,
          capabilityRows,
          capabilityEpochs,
          learningRate,
          "capability",
          timing,
          trajectory,
        );
      } finally {
        timing.capabilityFitMs = performance.now() - fitStarted;
        timing.capabilityEpochs = trajectory.filter(entry => entry.phase === "capability").length;
      }
    }

    return {
      profile: profileWithWeights(initial, relationWeights, capabilityWeights),
      timing,
      trajectory: Object.freeze(trajectory),
    };
  } catch (error) {
    attachFailure(error, timing, Object.freeze(trajectory));
  } finally {
    timing.totalFitMs = performance.now() - started;
  }
}
