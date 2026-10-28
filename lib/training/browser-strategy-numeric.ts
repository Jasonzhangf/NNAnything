import { performance } from "node:perf_hooks";
import {
  STRATEGY_HEADS,
  STRATEGY_WIRES,
  type BrowserStrategyProfile,
  type StrategyCandidatePrediction,
  type StrategyEpisode,
  type StrategyFitInput,
  type StrategyFitResult,
} from "../adapters/browser/strategy-contract.js";
import {
  predictBrowserStrategy,
  validateBrowserStrategyProfile,
} from "../filters/browser-strategy.js";
import { validateBrowserSingleActionProfile } from "../filters/browser-single-action-policy.js";
import { validateFeedbackProfile } from "../filters/browser-feedback.js";
import { buildBrowserStrategyCircuit } from "../nodes/trainable/browser-strategy.js";
import type { LinearPolicyCircuit } from "../nodes/trainable/linear-policy.js";
import { loadHandwired, type HandwiredModule } from "./handwired.js";
import { readStrategyEpisodes } from "./browser-strategy-samples.js";
import { expectRecord } from "../core/schema.js";

interface ProjectedSet {
  readonly episode: StrategyEpisode;
  readonly candidates: readonly StrategyCandidatePrediction[];
  readonly expectedIndex: number;
}

interface FitTiming {
  backendLoadMs: number;
  circuitBuildMs: number;
  fitMs: number;
  totalMs: number;
  epochs: number;
  decisionSets: number;
  candidateRows: number;
  gradientCandidateEpochs: number;
  trainableParamCount: number;
}

const CHOOSE_INDEX = STRATEGY_HEADS.indexOf("choose");
const DEFER_INDEX = STRATEGY_HEADS.indexOf("defer");
const ZERO_NODE = "<zero>";

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative integer`);
  }
  return value;
}

function positiveLearningRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError("browser strategy learningRate must be positive and finite");
  }
  return value;
}

function projectDecisionSets(
  input: StrategyFitInput,
  initial: BrowserStrategyProfile,
  episodes: readonly StrategyEpisode[],
): readonly ProjectedSet[] {
  return episodes.map(episode => {
    const prediction = predictBrowserStrategy(episode.input, {
      profile: initial,
      atomicProfile: input.atomicProfile,
      feedbackProfile: input.feedbackProfile,
      registry: episode.registry,
      selection: episode.selection,
    });
    if (prediction.candidates.length === 0) {
      throw new TypeError(`strategy episode ${episode.id} has no eligible candidate rows: ${prediction.reason ?? "unknown reason"}`);
    }
    let expectedIndex = -1;
    if (episode.teacher.selectedSkillId !== null) {
      const rows = prediction.candidates
        .map((candidate, index) => ({ candidate, index }))
        .filter(({ candidate }) => candidate.skillId === episode.teacher.selectedSkillId);
      if (rows.length !== 1) {
        throw new TypeError(`strategy episode ${episode.id} teacher selection is not one eligible projected candidate`);
      }
      expectedIndex = rows[0]!.index;
      const selectedFeatures = JSON.stringify(rows[0]!.candidate.features);
      if (prediction.candidates.filter(candidate =>
        JSON.stringify(candidate.features) === selectedFeatures).length > 1) {
        throw new TypeError(`strategy episode ${episode.id} cannot select one of indistinguishable candidate rows`);
      }
    }
    return { episode, candidates: prediction.candidates, expectedIndex };
  });
}

function featureKey(candidate: StrategyCandidatePrediction): string {
  return JSON.stringify(candidate.features);
}

function assertFeasibleSupervision(sets: readonly ProjectedSet[]): void {
  const byDecisionSet = new Map<string, string>();
  const edges = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string): void => {
    const current = edges.get(from) ?? new Set<string>();
    current.add(to);
    edges.set(from, current);
  };
  const positives = new Set<string>();
  const nonPositives = new Set<string>();

  for (const set of sets) {
    const candidateKeys = set.candidates.map(featureKey).sort();
    const baseKey = JSON.stringify(candidateKeys);
    const expectedKey = set.expectedIndex < 0
      ? "DEFER"
      : featureKey(set.candidates[set.expectedIndex]!);
    const previous = byDecisionSet.get(baseKey);
    if (previous !== undefined && previous !== expectedKey) {
      throw new TypeError(
        `conflicting strategy decision sets for indistinguishable candidates: ${set.episode.id}`,
      );
    }
    byDecisionSet.set(baseKey, expectedKey);

    if (set.expectedIndex < 0) {
      for (const candidate of set.candidates) nonPositives.add(featureKey(candidate));
      continue;
    }
    const selected = set.candidates[set.expectedIndex]!;
    const selectedKey = featureKey(selected);
    positives.add(selectedKey);
    addEdge(selectedKey, ZERO_NODE);
    for (const candidate of set.candidates) {
      if (candidate === selected) continue;
      addEdge(selectedKey, featureKey(candidate));
    }
  }

  for (const key of positives) {
    if (nonPositives.has(key)) {
      throw new TypeError("conflicting strategy supervision requires one feature margin both positive and non-positive");
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): void => {
    if (visiting.has(node)) {
      throw new TypeError(`conflicting strategy preference cycle at ${node}`);
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const next of edges.get(node) ?? []) visit(next);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of edges.keys()) visit(node);
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

function evaluateCandidate(
  circuit: LinearPolicyCircuit,
  weights: readonly number[],
  features: readonly number[],
): { readonly values: Float32Array; readonly margin: number } {
  const values = circuit.circuit.evaluateReference(sourceFor(circuit, weights, features));
  const choose = values[circuit.logits[CHOOSE_INDEX]!]!;
  const defer = values[circuit.logits[DEFER_INDEX]!]!;
  const margin = choose - defer;
  if (!Number.isFinite(choose) || !Number.isFinite(defer) || !Number.isFinite(margin)) {
    throw new Error("Non-finite browser strategy candidate logits");
  }
  return { values, margin };
}

interface DecisionSetLoss {
  readonly loss: number;
  readonly marginGradients: Float64Array;
}

function squaredHingeSetLoss(
  margins: readonly number[],
  expectedIndex: number,
): DecisionSetLoss {
  const competitors = expectedIndex < 0 ? [] : [0];
  for (let index = 0; index < margins.length; index += 1) {
    if (index !== expectedIndex) competitors.push(margins[index]!);
  }
  const selectedMargin = expectedIndex < 0 ? 0 : margins[expectedIndex]!;
  const maximumCompetitorMargin = Math.max(...competitors);
  const deficit = Math.max(0, 1 + maximumCompetitorMargin - selectedMargin);
  const marginGradients = new Float64Array(margins.length);
  if (deficit === 0) return { loss: 0, marginGradients };

  if (expectedIndex >= 0) marginGradients[expectedIndex] = -deficit;
  const maximumCompetitors: number[] = [];
  for (let index = 0; index < margins.length; index += 1) {
    if (index !== expectedIndex && margins[index] === maximumCompetitorMargin) {
      maximumCompetitors.push(index);
    }
  }
  const fixedDeferSharesMaximum = expectedIndex >= 0 && maximumCompetitorMargin === 0;
  const maximumTermCount = maximumCompetitors.length + Number(fixedDeferSharesMaximum);
  for (const index of maximumCompetitors) {
    marginGradients[index] = deficit / maximumTermCount;
  }
  return { loss: 0.5 * deficit * deficit, marginGradients };
}

function evaluateEpoch(
  circuit: LinearPolicyCircuit,
  weights: readonly number[],
  sets: readonly ProjectedSet[],
  timing: FitTiming,
): { readonly loss: number; readonly gradient: Float64Array } {
  const gradient = new Float64Array(weights.length);
  let lossTotal = 0;
  for (const set of sets) {
    const evaluated = set.candidates.map(candidate =>
      evaluateCandidate(circuit, weights, candidate.features));
    const decisionLoss = squaredHingeSetLoss(
      evaluated.map(row => row.margin),
      set.expectedIndex,
    );
    if (!Number.isFinite(decisionLoss.loss)) throw new Error("Non-finite browser strategy loss");
    lossTotal += decisionLoss.loss;
    if (decisionLoss.loss === 0) continue;
    for (const [candidateIndex, row] of evaluated.entries()) {
      const chooseGradient = decisionLoss.marginGradients[candidateIndex]!;
      const outputGradients = new Float32Array(row.values.length);
      outputGradients[circuit.logits[CHOOSE_INDEX]!] = Math.fround(chooseGradient);
      outputGradients[circuit.logits[DEFER_INDEX]!] = Math.fround(-chooseGradient);
      const derivatives = circuit.circuit.backpropagateReference(row.values, outputGradients);
      circuit.parameters.forEach((wire, parameterIndex) => {
        gradient[parameterIndex] = gradient[parameterIndex]!
          + derivatives[wire]! / sets.length;
      });
      timing.gradientCandidateEpochs += 1;
    }
  }
  const loss = lossTotal / sets.length;
  if (!Number.isFinite(loss) || [...gradient].some(value => !Number.isFinite(value))) {
    throw new Error("Non-finite browser strategy fit");
  }
  return { loss, gradient };
}

function updateWeights(
  weights: readonly number[],
  gradient: Float64Array,
  learningRate: number,
): readonly number[] {
  return Object.freeze(weights.map((weight, index) => {
    const updated = Math.fround(weight - learningRate * gradient[index]!);
    if (!Number.isFinite(updated)) throw new Error("Non-finite browser strategy parameter");
    return updated;
  }));
}

function profileWithWeights(initial: BrowserStrategyProfile, weights: readonly number[]): BrowserStrategyProfile {
  return validateBrowserStrategyProfile({
    ...initial,
    weights: STRATEGY_HEADS.map((_, headIndex) =>
      weights.slice(headIndex * STRATEGY_WIRES.length, (headIndex + 1) * STRATEGY_WIRES.length)),
  });
}

function attachFailure(
  error: unknown,
  timing: FitTiming,
  trajectory: StrategyFitResult["trajectory"],
): never {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    Object.assign(error, { timing, trajectory });
    throw error;
  }
  const wrapped = new Error(String(error), { cause: error });
  Object.assign(wrapped, { timing, trajectory });
  throw wrapped;
}

export async function fitBrowserStrategyProfile(input: StrategyFitInput): Promise<StrategyFitResult> {
  const value = expectRecord(input, "browser strategy fit request");
  const started = performance.now();
  const timing: FitTiming = {
    backendLoadMs: 0,
    circuitBuildMs: 0,
    fitMs: 0,
    totalMs: 0,
    epochs: 0,
    decisionSets: 0,
    candidateRows: 0,
    gradientCandidateEpochs: 0,
    trainableParamCount: STRATEGY_HEADS.length * STRATEGY_WIRES.length,
  };
  const trajectory: StrategyFitResult["trajectory"][number][] = [];
  try {
    const initial = validateBrowserStrategyProfile(value.profile);
    validateBrowserSingleActionProfile(value.atomicProfile);
    validateFeedbackProfile(value.feedbackProfile);
    const episodes = readStrategyEpisodes(value.episodes);
    if (episodes.some(episode => episode.partition !== "train")) {
      throw new TypeError("browser strategy fitter accepts only train episodes");
    }
    if (typeof value.handwiredRoot !== "string" || value.handwiredRoot.length === 0) {
      throw new TypeError("browser strategy fit requires an explicit Handwired source root");
    }
    const epochs = positiveInteger(value.epochs, "browser strategy epochs");
    const learningRate = positiveLearningRate(value.learningRate);
    const sets = projectDecisionSets(input, initial, episodes);
    assertFeasibleSupervision(sets);
    timing.decisionSets = sets.length;
    timing.candidateRows = sets.reduce((sum, set) => sum + set.candidates.length, 0);

    let weights: readonly number[] = Object.freeze(initial.weights.flatMap(row => [...row]));
    if (epochs > 0) {
      let handwired: HandwiredModule | undefined;
      const backendStarted = performance.now();
      try {
        handwired = await loadHandwired(value.handwiredRoot);
      } finally {
        timing.backendLoadMs = performance.now() - backendStarted;
      }
      if (handwired === undefined) throw new Error("Handwired loader returned no module");

      const circuitStarted = performance.now();
      let circuit: LinearPolicyCircuit | undefined;
      try {
        circuit = buildBrowserStrategyCircuit(handwired);
      } finally {
        timing.circuitBuildMs = performance.now() - circuitStarted;
      }
      if (circuit === undefined) throw new Error("Browser strategy circuit builder returned no circuit");

      const fitStarted = performance.now();
      try {
        for (let epoch = 1; epoch <= epochs; epoch += 1) {
          const batch = evaluateEpoch(circuit, weights, sets, timing);
          weights = updateWeights(weights, batch.gradient, learningRate);
          trajectory.push(Object.freeze({
            epoch,
            loss: batch.loss,
            gradient: Object.freeze([...batch.gradient]),
            weights: Object.freeze([...weights]),
          }));
          timing.epochs = epoch;
        }
      } finally {
        timing.fitMs = performance.now() - fitStarted;
      }
    }
    return {
      profile: profileWithWeights(initial, weights),
      trajectory: Object.freeze(trajectory),
      timing,
    };
  } catch (error) {
    attachFailure(error, timing, Object.freeze(trajectory));
  } finally {
    timing.totalMs = performance.now() - started;
  }
}
