import { performance } from "node:perf_hooks";
import { loadHandwired, type HandwiredModule, type HandwiredWire } from "./handwired.js";
import { buildLinearPolicyCircuit, type LinearPolicyCircuit } from "../nodes/trainable/linear-policy.js";
import {
  BASE_LABELS,
  BASE_WIRES,
  REASONING_LABELS,
  REASONING_WIRES,
  type BaseLabel,
  type BaseVector,
  type ReasoningLabel,
  type ReasoningVector,
} from "../adapters/cli/read-expectation-contract.js";

/** Weights stored per head/class, one row of `wireCount` coefficients. */
export type ReadProfile = Readonly<{
  schema: string;
  kind: "base" | "reasoning";
  headCount: number;
  wireCount: number;
  weights: readonly (readonly number[])[];
}>;

export type BaseEpisode = Readonly<{
  partition: "train" | "dev" | "verification";
  input: BaseVector;
  label: Readonly<Record<BaseLabel, 0 | 1>>;
  mask: Readonly<Record<BaseLabel, 0 | 1>>;
}>;

export type ReasoningEpisode = Readonly<{
  partition: "train" | "dev" | "verification";
  input: ReasoningVector;
  allowed: readonly ReasoningLabel[];
  soft: Readonly<Record<ReasoningLabel, number>>;
}>;

export type FitResult = Readonly<{
  profile: ReadProfile;
  trajectory: readonly FitStep[];
  evaluation: Readonly<{
    partitions: Readonly<Record<"train" | "dev" | "verification", unknown>>;
  }>;
  timing: Readonly<{ backendLoadMs: number; circuitBuildMs: number; fitMs: number; totalMs: number }>;
}>;

export type FitStep = Readonly<{ epoch: number; loss: number }>;

function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

function circuitFor(
  module: HandwiredModule,
  classCount: number,
  featureCount: number,
): LinearPolicyCircuit {
  return buildLinearPolicyCircuit(module, classCount, featureCount);
}

function flatWeights(weights: readonly (readonly number[])[]): number[] {
  return weights.flatMap(row => [...row]);
}

function packWeights(flat: readonly number[], headCount: number, wireCount: number): number[][] {
  return Array.from({ length: headCount }, (_, head) => flat.slice(head * wireCount, (head + 1) * wireCount));
}

/**
 * Validate an explicit continued-training start point and flatten it.
 *
 * A caller must pass a profile of the matching kind with the expected shapes,
 * so a stale or foreign profile cannot silently seed a fit. Omitting the
 * profile keeps the original all-zero start.
 */
function initialWeights(
  profile: ReadProfile | undefined,
  expectedKind: "base" | "reasoning",
  headCount: number,
  wireCount: number,
): Float64Array {
  if (profile === undefined) return new Float64Array(headCount * wireCount);
  const expectedSchema = expectedKind === "base" ? BASE_SCHEMA : REASONING_SCHEMA;
  if (profile.schema !== expectedSchema) {
    throw new TypeError(`initial profile schema must be ${expectedSchema}, received ${String(profile.schema)}`);
  }
  if (profile.kind !== expectedKind) {
    throw new TypeError(`initial profile kind must be ${expectedKind}, received ${String(profile.kind)}`);
  }
  if (profile.headCount !== headCount || profile.wireCount !== wireCount) {
    throw new TypeError(
      `initial profile shape must be ${headCount}x${wireCount}, received ${String(profile.headCount)}x${String(profile.wireCount)}`,
    );
  }
  if (profile.weights.length !== headCount || profile.weights.some(row => row.length !== wireCount)) {
    throw new TypeError("initial profile weights do not match its declared head and wire counts");
  }
  const flat = flatWeights(profile.weights);
  if (flat.some(value => !Number.isFinite(value))) throw new TypeError("initial profile weights must all be finite");
  return Float64Array.from(flat);
}

function wireSource(
  circuit: LinearPolicyCircuit,
  weights: readonly number[],
  features: readonly number[],
): Float32Array {
  const source = new Float32Array(circuit.circuit.sourceSize);
  circuit.parameters.forEach((wire, index) => { source[wire] = Math.fround(weights[index]!); });
  circuit.features.forEach((wire, index) => { source[wire] = Math.fround(features[index]!); });
  return source;
}

/** Gradient probe: central finite difference against analytic gradient in f32. */
export function assertGradientMatches(
  module: HandwiredModule,
  classCount: number,
  featureCount: number,
  weights: readonly number[],
  features: readonly number[],
  lossAt: (values: Float32Array, logits: readonly HandwiredWire[]) => { loss: number; outputGradients: Float32Array },
  tolerance: Readonly<{ relative: number; absolute: number }> = { relative: 1e-3, absolute: 1e-5 },
): { maxRelative: number; passed: boolean } {
  const circuit = circuitFor(module, classCount, featureCount);
  const base = wireSource(circuit, weights, features);
  const values = circuit.circuit.evaluateReference(base);
  const { outputGradients } = lossAt(values, circuit.logits);
  const analytic = circuit.circuit.backpropagateReference(values, outputGradients);
  let maxRelative = 0;
  const step = 1e-2;
  for (const wire of circuit.parameters) {
    const plus = base.slice();
    plus[wire] = Math.fround(base[wire]! + step);
    const minus = base.slice();
    minus[wire] = Math.fround(base[wire]! - step);
    const lossPlus = lossAt(circuit.circuit.evaluateReference(plus), circuit.logits).loss;
    const lossMinus = lossAt(circuit.circuit.evaluateReference(minus), circuit.logits).loss;
    const numeric = (lossPlus - lossMinus) / (2 * step);
    const ref = analytic[wire]!;
    const denom = Math.max(Math.abs(ref), tolerance.absolute);
    const relative = Math.abs(numeric - ref) / denom;
    maxRelative = Math.max(maxRelative, relative);
  }
  return { maxRelative, passed: maxRelative <= tolerance.relative };
}

const BASE_SCHEMA = "nnanything.cli-read-feedback.read-expectation.base.v1" as const;
const REASONING_SCHEMA = "nnanything.cli-read-feedback.read-expectation.reasoning.v1" as const;

export type BaseFitInput = Readonly<{
  handwiredRoot: string;
  epochs: number;
  learningRate: number;
  episodes: readonly BaseEpisode[];
  stopCheckpoints: readonly number[];
  /**
   * Optional explicit start point for continued training. When omitted the fit
   * keeps its original all-zero start. When present the profile must match the
   * expected kind, head count and wire count; its weights seed the first epoch
   * unchanged, so epoch 0 forward reproduces the supplied profile.
   */
  initialProfile?: ReadProfile;
}>;

export type ReasoningFitInput = Readonly<{
  handwiredRoot: string;
  epochs: number;
  learningRate: number;
  episodes: readonly ReasoningEpisode[];
  stopCheckpoints: readonly number[];
  /** Same contract as `BaseFitInput.initialProfile`; omitted means all-zero. */
  initialProfile?: ReadProfile;
}>;

export type UnitFitResult = Readonly<{
  profile: ReadProfile;
  trajectory: readonly FitStep[];
  epochsCompleted: number;
  stopped: "satisfied" | "epochs_exhausted" | "non_finite";
  probe: Readonly<{ maxRelative: number; passed: boolean }>;
  headReport: readonly (Readonly<{ label: string; trainAccuracy: number; masked: number }>)[];
  /**
   * Present only when an `initialProfile` seeded the fit: the same head report
   * computed at the supplied weights before any gradient step. A caller compares
   * it with the loaded profile's own forward to prove epoch 0 reproduces the
   * captured version.
   */
  epochZero: readonly (Readonly<{ label: string; trainAccuracy: number; masked: number }>)[] | null;
  timing: Readonly<{ backendLoadMs: number; circuitBuildMs: number; fitMs: number; totalMs: number }>;
}>;

function finiteOrThrow(value: number, what: string): void {
  if (!Number.isFinite(value)) throw new Error(`Non-finite ${what}`);
}

/** Full-batch gradient descent for the base unit: per-head sigmoid + BCE with mask. */
export async function fitReadFeedbackProfile(input: BaseFitInput): Promise<UnitFitResult> {
  const started = performance.now();
  const wireCount = BASE_WIRES.length;
  const headCount = BASE_LABELS.length;
  const rows = input.episodes.map(episode => ({
    features: BASE_WIRES.map(wire => episode.input[wire]),
    label: BASE_LABELS.map(label => episode.label[label]),
    mask: BASE_LABELS.map(label => episode.mask[label]),
  }));
  const module = await loadModule(input.handwiredRoot, started);
  const backendLoadMs = performance.now() - started;
  const circuit = circuitFor(module, headCount, wireCount);
  const circuitBuildMs = performance.now() - started - backendLoadMs;
  const initialFlat = initialWeights(input.initialProfile, "base", headCount, wireCount);
  let weights = initialFlat;
  // Epoch-0 forward at the supplied weights, before any gradient step. This is
  // what proves a continued fit starts from the captured candidate unchanged.
  const epochZero = input.initialProfile === undefined
    ? null
    : buildBaseReport(rows, initialFlat, headCount, wireCount, circuit, module);
  const trajectory: FitStep[] = [];
  let probe: { maxRelative: number; passed: boolean } = { maxRelative: Infinity, passed: false };
  const fitStarted = performance.now();
  const stopAt = new Set(input.stopCheckpoints);
  const required = new Set(input.stopCheckpoints);
  try {
    for (let epoch = 1; epoch <= input.epochs; epoch += 1) {
      const gradient = new Float64Array(headCount * wireCount);
      let loss = 0;
      for (const row of rows) {
        const source = wireSource(circuit, [...weights], row.features as number[]);
        const values = circuit.circuit.evaluateReference(source);
        const logits = circuit.logits.map(wire => values[wire]!);
        const outputs = logits.map(sigmoid);
        const outputGradients = new Float32Array(values.length);
        for (let head = 0; head < headCount; head += 1) {
          const y = row.label[head]!;
          const m = row.mask[head]!;
          if (m === 0) continue;
          const p = outputs[head]!;
          const clamped = Math.min(Math.max(p, 1e-7), 1 - 1e-7);
          loss += -(y * Math.log(clamped) + (1 - y) * Math.log(1 - clamped));
          outputGradients[circuit.logits[head]!] = Math.fround((p - y) / rows.length);
        }
        const derivatives = circuit.circuit.backpropagateReference(values, outputGradients);
        circuit.parameters.forEach((wire, index) => { gradient[index] = gradient[index]! + derivatives[wire]!; });
      }
      finiteOrThrow(loss, "loss");
      if ([...gradient].some(value => !Number.isFinite(value))) throw new Error("Non-finite gradient");
      if (epoch === 1) {
        const features = rows.length > 0 ? (rows[0]!.features as number[]) : new Array(wireCount).fill(0);
        probe = assertGradientMatches(module, headCount, wireCount, [...weights], features, (vals, logits) => {
          const lgs = logits.map(wire => vals[wire]!);
          const out = lgs.map(sigmoid);
          const og = new Float32Array(vals.length);
          let l = 0;
          for (let head = 0; head < headCount; head += 1) {
            const y = rows[0]!.label[head]!;
            const m = rows[0]!.mask[head]!;
            if (m === 0) continue;
            const p = out[head]!;
            const c = Math.min(Math.max(p, 1e-7), 1 - 1e-7);
            l += -(y * Math.log(c) + (1 - y) * Math.log(1 - c));
            og[logits[head]!] = Math.fround((p - y));
          }
          return { loss: l, outputGradients: og };
        });
      }
      weights = weights.map((weight, index) => Math.fround(weight - input.learningRate * gradient[index]!));
      if ([...weights].some(weight => !Number.isFinite(weight))) throw new Error("Non-finite weight");
      trajectory.push({ epoch, loss });
      if (required.has(epoch)) {
        const headReport = buildBaseReport(rows, weights, headCount, wireCount, circuit, module);
        const satisfied = headReport.every(report => report.trainAccuracy >= 1);
        if (satisfied) {
          return finish({
            profile: { schema: BASE_SCHEMA, kind: "base", headCount, wireCount, weights: packWeights([...weights], headCount, wireCount) },
            trajectory, epochsCompleted: epoch, stopped: "satisfied", probe, headReport, epochZero,
            timing: { backendLoadMs, circuitBuildMs, fitMs: performance.now() - fitStarted, totalMs: performance.now() - started },
          });
        }
      }
    }
    return finish({
      profile: { schema: BASE_SCHEMA, kind: "base", headCount, wireCount, weights: packWeights([...weights], headCount, wireCount) },
      trajectory, epochsCompleted: input.epochs, stopped: "epochs_exhausted", probe, epochZero,
      headReport: buildBaseReport(rows, weights, headCount, wireCount, circuit, module),
      timing: { backendLoadMs, circuitBuildMs, fitMs: performance.now() - fitStarted, totalMs: performance.now() - started },
    });
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    return finish({
      profile: { schema: BASE_SCHEMA, kind: "base", headCount, wireCount, weights: packWeights([...weights], headCount, wireCount) },
      trajectory, epochsCompleted: trajectory.length, stopped: "non_finite", probe, epochZero,
      headReport: buildBaseReport(rows, weights, headCount, wireCount, circuit, module),
      timing: { backendLoadMs, circuitBuildMs, fitMs: performance.now() - fitStarted, totalMs: performance.now() - started },
      error,
    });
  }
}

function buildBaseReport(
  rows: readonly (Readonly<{ features: readonly number[]; label: readonly number[]; mask: readonly number[] }>)[],
  weights: Float64Array,
  headCount: number,
  wireCount: number,
  circuit: LinearPolicyCircuit,
  module: HandwiredModule,
): readonly (Readonly<{ label: string; trainAccuracy: number; masked: number }>)[] {
  return BASE_LABELS.map((label, head) => {
    let correct = 0;
    let total = 0;
    let masked = 0;
    for (const row of rows) {
      if (row.mask[head] === 0) { masked += 1; continue; }
      const source = wireSource(circuit, [...weights], row.features as number[]);
      const values = circuit.circuit.evaluateReference(source);
      const logit = values[circuit.logits[head]!]!;
      const prediction = sigmoid(logit) >= 0.5 ? 1 : 0;
      if (prediction === row.label[head]!) correct += 1;
      total += 1;
    }
    void module;
    return Object.freeze({ label, trainAccuracy: total === 0 ? 1 : correct / total, masked });
  });
}

/** Full-batch gradient descent for the reasoning unit: softmax + CE over the allowed set. */
export async function fitReadReasoningProfile(input: ReasoningFitInput): Promise<UnitFitResult> {
  const started = performance.now();
  const wireCount = REASONING_WIRES.length;
  const headCount = REASONING_LABELS.length;
  const rows = input.episodes.map(episode => ({
    features: REASONING_WIRES.map(wire => episode.input[wire]),
    target: REASONING_LABELS.map(label => (episode.allowed.includes(label) ? 1 / episode.allowed.length : 0)),
    allowed: episode.allowed,
  }));
  const module = await loadModule(input.handwiredRoot, started);
  const backendLoadMs = performance.now() - started;
  const circuit = circuitFor(module, headCount, wireCount);
  const circuitBuildMs = performance.now() - started - backendLoadMs;
  const initialFlat = initialWeights(input.initialProfile, "reasoning", headCount, wireCount);
  let weights = initialFlat;
  const epochZero = input.initialProfile === undefined
    ? null
    : buildReasoningReport(rows, initialFlat, headCount, wireCount, circuit);
  const trajectory: FitStep[] = [];
  let probe: { maxRelative: number; passed: boolean } = { maxRelative: Infinity, passed: false };
  const fitStarted = performance.now();
  const required = new Set(input.stopCheckpoints);
  try {
    for (let epoch = 1; epoch <= input.epochs; epoch += 1) {
      const gradient = new Float64Array(headCount * wireCount);
      let loss = 0;
      for (const row of rows) {
        const source = wireSource(circuit, [...weights], row.features as number[]);
        const values = circuit.circuit.evaluateReference(source);
        const logits = circuit.logits.map(wire => values[wire]!);
        const maximum = Math.max(...logits);
        const exps = logits.map(logit => Math.exp(logit - maximum));
        const total = exps.reduce((a, b) => a + b, 0);
        for (let head = 0; head < headCount; head += 1) {
          const target = row.target[head]!;
          if (target === 0) continue;
          loss += -target * Math.log(Math.max(exps[head]! / total, 1e-9));
        }
        const outputGradients = new Float32Array(values.length);
        circuit.logits.forEach((wire, index) => {
          outputGradients[wire] = Math.fround(exps[index]! / total - row.target[index]!);
        });
        const derivatives = circuit.circuit.backpropagateReference(values, outputGradients);
        circuit.parameters.forEach((wire, index) => { gradient[index] = gradient[index]! + derivatives[wire]!; });
      }
      finiteOrThrow(loss, "loss");
      if ([...gradient].some(value => !Number.isFinite(value))) throw new Error("Non-finite gradient");
      if (epoch === 1 && rows.length > 0) {
        const row = rows[0]!;
        probe = assertGradientMatches(module, headCount, wireCount, [...weights], row.features as number[], (vals, logits) => {
          const lgs = logits.map(wire => vals[wire]!);
          const maximum = Math.max(...lgs);
          const exps = lgs.map(logit => Math.exp(logit - maximum));
          const total = exps.reduce((a, b) => a + b, 0);
          const og = new Float32Array(vals.length);
          logits.forEach((wire, index) => { og[wire] = Math.fround(exps[index]! / total - row.target[index]!); });
          return { loss: Math.log(total) + maximum - lgs[row.target.findIndex(value => value > 0)]!, outputGradients: og };
        });
      }
      weights = weights.map((weight, index) => Math.fround(weight - input.learningRate * gradient[index]!));
      if ([...weights].some(weight => !Number.isFinite(weight))) throw new Error("Non-finite weight");
      trajectory.push({ epoch, loss });
      if (required.has(epoch)) {
        const headReport = buildReasoningReport(rows, weights, headCount, wireCount, circuit);
        if (headReport.every(report => report.trainAccuracy >= 1)) {
          return finish({
            profile: { schema: REASONING_SCHEMA, kind: "reasoning", headCount, wireCount, weights: packWeights([...weights], headCount, wireCount) },
            trajectory, epochsCompleted: epoch, stopped: "satisfied", probe, headReport, epochZero,
            timing: { backendLoadMs, circuitBuildMs, fitMs: performance.now() - fitStarted, totalMs: performance.now() - started },
          });
        }
      }
    }
    return finish({
      profile: { schema: REASONING_SCHEMA, kind: "reasoning", headCount, wireCount, weights: packWeights([...weights], headCount, wireCount) },
      trajectory, epochsCompleted: input.epochs, stopped: "epochs_exhausted", probe, epochZero,
      headReport: buildReasoningReport(rows, weights, headCount, wireCount, circuit),
      timing: { backendLoadMs, circuitBuildMs, fitMs: performance.now() - fitStarted, totalMs: performance.now() - started },
    });
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    return finish({
      profile: { schema: REASONING_SCHEMA, kind: "reasoning", headCount, wireCount, weights: packWeights([...weights], headCount, wireCount) },
      trajectory, epochsCompleted: trajectory.length, stopped: "non_finite", probe, epochZero,
      headReport: buildReasoningReport(rows, weights, headCount, wireCount, circuit),
      timing: { backendLoadMs, circuitBuildMs, fitMs: performance.now() - fitStarted, totalMs: performance.now() - started },
      error,
    });
  }
}

function buildReasoningReport(
  rows: readonly (Readonly<{ features: readonly number[]; target: readonly number[]; allowed: readonly ReasoningLabel[] }>)[],
  weights: Float64Array,
  headCount: number,
  wireCount: number,
  circuit: LinearPolicyCircuit,
): readonly (Readonly<{ label: string; trainAccuracy: number; masked: number }>)[] {
  let allowedHits = 0;
  let scored = 0;
  for (const row of rows) {
    if (row.features.length === 0) continue;
    const source = wireSource(circuit, [...weights], row.features as number[]);
    const values = circuit.circuit.evaluateReference(source);
    const logits = circuit.logits.map(wire => values[wire]!);
    let best = 0;
    for (let index = 1; index < logits.length; index += 1) if (logits[index]! > logits[best]!) best = index;
    const predicted = REASONING_LABELS[best]!;
    if (row.allowed.includes(predicted)) allowedHits += 1;
    scored += 1;
  }
  void headCount; void wireCount;
  const overall = scored === 0 ? 1 : allowedHits / scored;
  return REASONING_LABELS.map(label => Object.freeze({ label, trainAccuracy: overall, masked: 0 }));
}

async function loadModule(handwiredRoot: string, started: number): Promise<HandwiredModule> {
  void started;
  return loadHandwired(handwiredRoot);
}

function finish(result: Omit<UnitFitResult, "timing"> & { timing: UnitFitResult["timing"]; error?: Error }): UnitFitResult {
  const { error, ...rest } = result;
  void error;
  return Object.freeze(rest);
}
