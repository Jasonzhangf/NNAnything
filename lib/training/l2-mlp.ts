/**
 * Experimental finite L2 four-head MLP.
 *
 * Each head is an independent dense MLP with two ReLU hidden layers and a
 * softmax readout. The single numeric backend is the existing Handwired
 * `Circuit`: parameters and observed features enter as source wires, hidden
 * units use `reglu([], 1, [[z, 1]], 0)` (1 * ReLU(z)), and dense layers use
 * `Circuit.multiply` plus `Circuit.affine`. Training and inference call the same
 * circuit builder, so the forward pass and the backpropagated gradient cannot
 * diverge.
 *
 * Parameter layout. `L2MlpHeadProfile.parameters` stores one head's dense
 * layers as row-major weights followed by the layer bias, in this order:
 *
 *   W1: hidden[0] x features.length   (row = output unit, column = input)
 *   b1: hidden[0]
 *   W2: hidden[1] x hidden[0]
 *   b2: hidden[1]
 *   W3: labels.length x hidden[1]
 *   b3: labels.length
 *
 * Heads appear in `L2_HEADS` order. The circuit source table is
 * `[all head parameters in the above order, then each head's feature wires in
 * L2_HEADS order]`.
 *
 * Initialization is deterministic: a mulberry32 stream seeded once per fit
 * draws Xavier-uniform weights, limit = sqrt(6 / (fanIn + fanOut)), and biases
 * from the same seeded stream. There are no random restarts. A supplied
 * warm-start profile is copied, never mutated, and must match the requested
 * head specs exactly.
 *
 * Training is full-batch gradient descent on the negative log of the summed
 * softmax probability over each row's allowed labels. `trainHeads` selects the
 * heads that update and defaults to all four when omitted. Selected heads share
 * equal weight (1 / trainedHeads.length) and are normalized by their own row
 * counts; frozen heads keep their parameters exactly and contribute no loss or
 * gradient. The trajectory records, for every completed epoch, the loss on the
 * parameters entering that epoch (before its update). Frozen heads report `null`
 * loss because they have no rows. `epochZero` is measured on the supplied
 * starting parameters and the real circuit before any update. An epoch cap is a
 * maximum: the only early stop is a declared checkpoint where every selected
 * head's train prediction falls inside its allowed set. Otherwise the fit
 * reports `epochs_exhausted` and never extends the budget.
 *
 * The gradient probe compares, at the starting parameters, the circuit gradient
 * of two active parameters per selected head with a central finite difference
 * (step 1e-3) using |analytic - numeric| <= 1e-3 + 1e-2 * |numeric|. Hidden
 * paths are checked when active; constant heads may only have readout gradients.
 * Failed coverage or tolerance rejects before training. Non-finite values raise
 * an error.
 */

import { open, readFile } from "node:fs/promises";
import { L2_HEADS } from "../adapters/l2/contracts.js";
import type {
  L2FitInput,
  L2FitReport,
  L2FitResult,
  L2Head,
  L2HeadSpec,
  L2MlpHeadProfile,
  L2MlpProfile,
  L2Prediction,
  L2Specs,
  L2TrainingEvent,
  L2TrainingPhase,
  L2TrainingState,
  L2Unit,
} from "../adapters/l2/contracts.js";
import {
  expectArray,
  expectFiniteNumber,
  expectNonEmptyString,
  expectRecord,
} from "../core/schema.js";
import {
  loadHandwired,
  type HandwiredCircuit,
  type HandwiredModule,
  type HandwiredWire,
} from "./handwired.js";

export type {
  L2ConditionState,
  L2FitInput,
  L2FitReport,
  L2FitResult,
  L2Head,
  L2HeadSpec,
  L2MlpHeadProfile,
  L2MlpProfile,
  L2Partition,
  L2Prediction,
  L2ScopedEvidence,
  L2Specs,
  L2TrainingRow,
  L2Unit,
} from "../adapters/l2/contracts.js";

const PROFILE_SCHEMA = "nnanything.l2.mlp.v1" as const;
const PROFILE_CALIBRATION = "uncalibrated" as const;
const PROFILE_ADOPTION = "not_applied" as const;
const PROBE_STEP = 1e-3;
const PROBE_ABSOLUTE_TOLERANCE = 1e-3;
const PROBE_RELATIVE_TOLERANCE = 1e-2;

type HeadCounts = Record<L2Head, number>;
type HeadScores = Record<L2Head, { readonly correct: number; readonly scored: number }>;

interface PreparedRow {
  readonly id: string;
  readonly sourceGroup: string;
  readonly head: L2Head;
  readonly features: readonly number[];
  readonly allowed: readonly number[];
}

interface L2HeadLayout {
  readonly spec: L2HeadSpec;
  readonly parameterOffset: number;
  readonly parameterCount: number;
  readonly parameterWires: readonly HandwiredWire[];
  readonly featureOffset: number;
  readonly featureWires: readonly HandwiredWire[];
  readonly hiddenActivationWires: readonly HandwiredWire[];
  readonly logitWires: readonly HandwiredWire[];
}

interface L2Graph {
  readonly circuit: HandwiredCircuit;
  readonly heads: Readonly<Record<L2Head, L2HeadLayout>>;
  readonly parameterCount: number;
}

interface ForwardResult {
  readonly values: Float32Array;
  readonly logits: readonly number[];
}

interface BatchResult {
  readonly lossByHead: Record<L2Head, number | null>;
  readonly meanLoss: number;
  readonly correctByHead: HeadCounts;
  readonly gradient: Float64Array | null;
  readonly positiveActivation: boolean;
}

interface FitPreparation {
  readonly handwiredRoot: string;
  readonly specs: L2Specs;
  readonly rows: readonly PreparedRow[];
  readonly counts: HeadCounts;
  readonly trainedHeads: readonly L2Head[];
  readonly seed: number;
  readonly learningRate: number;
  readonly epochs: number;
  readonly stopCheckpoints: ReadonlySet<number>;
  readonly initialProfile: L2MlpProfile | null;
}

function zeroCounts(): HeadCounts {
  return { R: 0, D: 0, E: 0, A: 0 };
}

function readNames(value: unknown, label: string): string[] {
  const names = expectArray(value, label).map((entry, index) =>
    expectNonEmptyString(entry, `${label}[${index}]`),
  );
  if (names.length === 0) throw new TypeError(`${label} must not be empty`);
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) throw new TypeError(`${label} contains duplicate name ${name}`);
    seen.add(name);
  }
  return names;
}

function readHidden(value: unknown, label: string): [number, number] {
  const widths = expectArray(value, label);
  if (widths.length !== 2) throw new TypeError(`${label} must contain two hidden widths`);
  const first = expectFiniteNumber(widths[0], `${label}[0]`);
  const second = expectFiniteNumber(widths[1], `${label}[1]`);
  for (const [index, width] of [first, second].entries()) {
    if (!Number.isInteger(width) || width <= 0) {
      throw new TypeError(`${label}[${index}] must be a positive integer width`);
    }
  }
  return [first, second];
}

function readSpec(value: unknown, label: string): L2HeadSpec {
  const record = expectRecord(value, label);
  return {
    features: readNames(record.features, `${label}.features`),
    labels: readNames(record.labels, `${label}.labels`),
    hidden: readHidden(record.hidden, `${label}.hidden`),
  };
}

function readSpecs(value: unknown): L2Specs {
  const record = expectRecord(value, "specs");
  const specs = {} as Record<L2Head, L2HeadSpec>;
  for (const head of L2_HEADS) specs[head] = readSpec(record[head], `specs.${head}`);
  return specs;
}

function copySpec(spec: L2HeadSpec): L2HeadSpec {
  return { features: [...spec.features], labels: [...spec.labels], hidden: [spec.hidden[0], spec.hidden[1]] };
}

function sameSpec(left: L2HeadSpec, right: L2HeadSpec): boolean {
  const equalList = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((entry, index) => entry === b[index]);
  return left.hidden[0] === right.hidden[0]
    && left.hidden[1] === right.hidden[1]
    && equalList(left.features, right.features)
    && equalList(left.labels, right.labels);
}

function parameterCountFor(spec: L2HeadSpec): number {
  const [hiddenOne, hiddenTwo] = spec.hidden;
  const inputs = spec.features.length;
  const labels = spec.labels.length;
  return hiddenOne * inputs + hiddenOne
    + hiddenTwo * hiddenOne + hiddenTwo
    + labels * hiddenTwo + labels;
}

function readParameters(value: unknown, label: string, expected: number): number[] {
  const raw = expectArray(value, label);
  if (raw.length !== expected) {
    throw new TypeError(`${label} must contain ${expected} values, received ${raw.length}`);
  }
  return raw.map((entry, index) => expectFiniteNumber(entry, `${label}[${index}]`));
}

export function validateL2Profile(value: unknown): L2MlpProfile {
  const record = expectRecord(value, "profile");
  if (record.schema !== PROFILE_SCHEMA) throw new TypeError(`profile schema must be ${PROFILE_SCHEMA}`);
  if (record.calibration !== PROFILE_CALIBRATION) throw new TypeError("profile calibration must be uncalibrated");
  if (record.adoption !== PROFILE_ADOPTION) throw new TypeError("profile adoption must be not_applied");
  const rawHeads = expectRecord(record.heads, "profile.heads");
  for (const key of Object.keys(rawHeads)) {
    if (!L2_HEADS.includes(key as L2Head)) throw new TypeError(`profile heads has unsupported head ${key}`);
  }
  const heads = {} as Record<L2Head, L2MlpHeadProfile>;
  for (const head of L2_HEADS) {
    const rawHead = expectRecord(rawHeads[head], `profile.heads.${head}`);
    const spec = readSpec(rawHead.spec, `profile.heads.${head}.spec`);
    heads[head] = {
      spec,
      parameters: readParameters(
        rawHead.parameters,
        `profile.heads.${head}.parameters`,
        parameterCountFor(spec),
      ),
    };
  }
  return {
    schema: PROFILE_SCHEMA,
    heads,
    calibration: PROFILE_CALIBRATION,
    adoption: PROFILE_ADOPTION,
  };
}

/** Every overlapping name needs a decision: true means same meaning, unit and
 * missing-value/mask convention; false explicitly resets that column or row.
 * There is deliberately no rename mapping or implicit same-name compatibility.
 */
export type L2MigrationCompatibility = Readonly<Record<L2Head, {
  readonly features: Readonly<Record<string, boolean>>;
  readonly labels: Readonly<Record<string, boolean>>;
}>>;

export interface L2MigrationNames {
  readonly retained: readonly string[];
  readonly removed: readonly string[];
  readonly added: readonly string[];
  readonly reset: readonly string[];
}

export interface L2MigrationHeadReport {
  readonly features: L2MigrationNames;
  readonly labels: L2MigrationNames;
  /** Algebraic guarantee for retained logits with equal compatible inputs,
   * subject to floating-point summation differences after reordering. */
  readonly retainedLogitsPreserved: boolean;
  readonly limitations: readonly string[];
}

export interface L2MigrationResult {
  readonly profile: L2MlpProfile;
  readonly report: {
    readonly heads: Readonly<Record<L2Head, L2MigrationHeadReport>>;
    readonly limitations: readonly string[];
  };
}

function migrationNames(
  oldNames: readonly string[], newNames: readonly string[], value: unknown, path: string,
): L2MigrationNames {
  const decisions = expectRecord(value, path);
  for (const name of Object.keys(decisions)) {
    if (!oldNames.includes(name) || !newNames.includes(name)) {
      throw new TypeError(`${path}.${name} is not a shared name`);
    }
    if (typeof decisions[name] !== "boolean") throw new TypeError(`${path}.${name} must be boolean`);
  }
  const shared = newNames.filter(name => oldNames.includes(name));
  for (const name of shared) {
    if (!Object.hasOwn(decisions, name)) throw new TypeError(`${path} needs explicit compatibility for ${name}`);
  }
  return {
    retained: shared.filter(name => decisions[name] === true),
    reset: shared.filter(name => decisions[name] === false),
    removed: oldNames.filter(name => !newNames.includes(name)),
    added: newNames.filter(name => !oldNames.includes(name)),
  };
}

/** Pure, offline parameter migration. Never trains, adopts or alters the source.
 * Hidden widths must match; hidden unit identities and ordering are preserved.
 * Upstream prediction columns require the same explicit semantic decisions as
 * raw inputs. Callers must mark changed prediction meanings incompatible.
 */
export function migrateL2Profile(
  profile: L2MlpProfile, targetSpecs: L2Specs, compatibility: L2MigrationCompatibility,
): L2MigrationResult {
  const source = validateL2Profile(profile);
  const targets = readSpecs(targetSpecs);
  const declarations = expectRecord(compatibility, "compatibility");
  const heads = {} as Record<L2Head, L2MlpHeadProfile>;
  const reports = {} as Record<L2Head, L2MigrationHeadReport>;
  for (const head of L2_HEADS) {
    const { spec: old, parameters: previous } = source.heads[head];
    const spec = targets[head];
    const [h1, h2] = old.hidden;
    if (spec.hidden[0] !== h1 || spec.hidden[1] !== h2) {
      throw new TypeError(`head ${head} hidden widths must remain ${h1},${h2}`);
    }
    const declaration = expectRecord(declarations[head], `compatibility.${head}`);
    const features = migrationNames(old.features, spec.features, declaration.features, `compatibility.${head}.features`);
    const labels = migrationNames(old.labels, spec.labels, declaration.labels, `compatibility.${head}.labels`);
    const parameters = Array<number>(parameterCountFor(spec)).fill(0);
    const oldInputs = old.features.length, newInputs = spec.features.length;
    for (const name of features.retained) {
      const from = old.features.indexOf(name), to = spec.features.indexOf(name);
      for (let row = 0; row < h1; row += 1) parameters[row * newInputs + to] = previous[row * oldInputs + from]!;
    }
    // The middle contiguous block is b1, W2, b2; its sizes do not change.
    const middleSize = h1 + h2 * h1 + h2;
    const oldMiddle = h1 * oldInputs, newMiddle = h1 * newInputs;
    for (let i = 0; i < middleSize; i += 1) parameters[newMiddle + i] = previous[oldMiddle + i]!;
    const oldW3 = oldMiddle + middleSize, newW3 = newMiddle + middleSize;
    for (const name of labels.retained) {
      const from = old.labels.indexOf(name), to = spec.labels.indexOf(name);
      for (let col = 0; col < h2; col += 1) parameters[newW3 + to * h2 + col] = previous[oldW3 + from * h2 + col]!;
      parameters[newW3 + spec.labels.length * h2 + to] = previous[oldW3 + old.labels.length * h2 + from]!;
    }
    const lostNonzero = [...features.removed, ...features.reset].filter(name => {
      const col = old.features.indexOf(name);
      return Array.from({ length: h1 }, (_, row) => previous[row * oldInputs + col]).some(weight => weight !== 0);
    });
    const limitations: string[] = [];
    if (lostNonzero.length > 0) limitations.push(`Removed or reset nonzero W1 columns: ${lostNonzero.join(", ")}; retained logits are not guaranteed unchanged.`);
    if (labels.reset.length > 0) limitations.push(`Semantically incompatible output rows reset: ${labels.reset.join(", ")}.`);
    if (labels.added.length || labels.removed.length || labels.reset.length) {
      limitations.push("Changed output labels can change the softmax denominator and selection even when retained logits agree.");
    }
    heads[head] = { spec, parameters };
    reports[head] = { features, labels, retainedLogitsPreserved: labels.retained.length > 0 && lostNonzero.length === 0, limitations };
  }
  return {
    profile: { schema: PROFILE_SCHEMA, heads, calibration: PROFILE_CALIBRATION, adoption: PROFILE_ADOPTION },
    report: {
      heads: reports,
      limitations: [
        "Retained-logit guarantees require equal values for semantically compatible inputs; reordered sums may differ by floating-point rounding.",
        "Changed upstream predictions can change downstream outputs even with unchanged downstream parameters; whole-chain behavior is not guaranteed.",
        "Semantic compatibility is declared by the caller, not inferred from names; no probability, calibration or adoption guarantee is made.",
      ],
    },
  };
}

function readTrainHeads(value: unknown): readonly L2Head[] {
  if (value === undefined) return [...L2_HEADS];
  const raw = expectArray(value, "trainHeads");
  if (raw.length === 0) throw new TypeError("trainHeads must not be empty");
  const seen = new Set<L2Head>();
  for (const [index, entry] of raw.entries()) {
    const text = expectNonEmptyString(entry, `trainHeads[${index}]`);
    if (!L2_HEADS.includes(text as L2Head)) {
      throw new TypeError(`trainHeads[${index}] ${text} is not an L2 head`);
    }
    if (seen.has(text as L2Head)) throw new TypeError(`trainHeads contains duplicate head ${text}`);
    seen.add(text as L2Head);
  }
  return L2_HEADS.filter(head => seen.has(head));
}

function readTrainingRows(
  value: unknown,
  specs: L2Specs,
  trainedHeads: readonly L2Head[],
): { rows: PreparedRow[]; counts: HeadCounts } {
  const rawRows = expectArray(value, "rows");
  if (rawRows.length === 0) throw new TypeError("rows must not be empty");
  const ids = new Set<string>();
  const trained = new Set<L2Head>(trainedHeads);
  const rows = rawRows.map((raw, index): PreparedRow => {
    const row = expectRecord(raw, `rows[${index}]`);
    const id = expectNonEmptyString(row.id, `rows[${index}].id`);
    if (ids.has(id)) throw new TypeError(`rows[${index}] repeats row id ${id}`);
    ids.add(id);
    const sourceGroup = expectNonEmptyString(row.sourceGroup, `rows[${index}].sourceGroup`);
    const partition = expectNonEmptyString(row.partition, `rows[${index}].partition`);
    if (partition !== "train") {
      throw new TypeError(`rows[${index}] partition ${partition} is not train; dev and verification rows are rejected`);
    }
    const headText = expectNonEmptyString(row.head, `rows[${index}].head`);
    if (!L2_HEADS.includes(headText as L2Head)) throw new TypeError(`rows[${index}].head ${headText} is not an L2 head`);
    const head = headText as L2Head;
    if (!trained.has(head)) {
      throw new TypeError(
        `rows[${index}] targets frozen head ${head}; trainHeads does not include it`,
      );
    }
    const spec = specs[head];
    const features = expectArray(row.features, `rows[${index}].features`).map((feature, featureIndex) =>
      expectFiniteNumber(feature, `rows[${index}].features[${featureIndex}]`),
    );
    if (features.length !== spec.features.length) {
      throw new TypeError(`rows[${index}].features must contain ${spec.features.length} values for head ${head}`);
    }
    const rawAllowed = expectArray(row.allowed, `rows[${index}].allowed`);
    if (rawAllowed.length === 0) throw new TypeError(`rows[${index}].allowed must not be empty`);
    const allowed = rawAllowed.map((label, allowedIndex) => {
      const text = expectNonEmptyString(label, `rows[${index}].allowed[${allowedIndex}]`);
      const labelIndex = spec.labels.indexOf(text);
      if (labelIndex < 0) throw new TypeError(`rows[${index}].allowed[${allowedIndex}] ${text} is not a label of head ${head}`);
      return labelIndex;
    });
    if (new Set(allowed).size !== allowed.length) throw new TypeError(`rows[${index}].allowed contains duplicate labels`);
    return { id, sourceGroup, head, features, allowed };
  });
  const counts = zeroCounts();
  for (const row of rows) counts[row.head] += 1;
  for (const head of trainedHeads) {
    if (counts[head] === 0) throw new TypeError(`head ${head} has no train rows`);
  }
  return { rows, counts };
}

function readCheckpoints(value: unknown): ReadonlySet<number> {
  const raw = expectArray(value, "stopCheckpoints");
  const checkpoints = new Set<number>();
  for (const [index, entry] of raw.entries()) {
    const checkpoint = expectFiniteNumber(entry, `stopCheckpoints[${index}]`);
    if (!Number.isInteger(checkpoint) || checkpoint <= 0) {
      throw new TypeError(`stopCheckpoints[${index}] must be a positive integer epoch`);
    }
    if (checkpoints.has(checkpoint)) throw new TypeError(`stopCheckpoints repeats checkpoint ${checkpoint}`);
    checkpoints.add(checkpoint);
  }
  return checkpoints;
}

/**
 * Validate a warm-start profile against the requested specs. Both the reference
 * loop and the accelerated backend go through this check, so opting into the
 * accelerated path cannot drop the ordered feature/label and hidden-size check.
 */
export function readWarmStartProfile(value: unknown, specs: L2Specs): L2MlpProfile {
  const profile = validateL2Profile(value);
  for (const head of L2_HEADS) {
    if (!sameSpec(profile.heads[head].spec, specs[head])) {
      throw new TypeError(`warm-start profile spec for head ${head} does not match the fit specs`);
    }
  }
  return profile;
}

function prepareFitInput(input: L2FitInput): FitPreparation {
  const record = expectRecord(input, "fit input");
  const handwiredRoot = expectNonEmptyString(record.handwiredRoot, "handwiredRoot");
  const specs = readSpecs(record.specs);
  const trainedHeads = readTrainHeads(record.trainHeads);
  const { rows, counts } = readTrainingRows(record.rows, specs, trainedHeads);
  const seed = expectFiniteNumber(record.seed, "seed");
  if (!Number.isInteger(seed) || seed < 0) throw new TypeError("seed must be a nonnegative integer");
  const learningRate = expectFiniteNumber(record.learningRate, "learningRate");
  if (learningRate <= 0) throw new TypeError("learningRate must be positive");
  const epochs = expectFiniteNumber(record.epochs, "epochs");
  if (!Number.isInteger(epochs) || epochs < 0) throw new TypeError("epochs must be a nonnegative integer");
  const stopCheckpoints = readCheckpoints(record.stopCheckpoints);
  const initialProfile = record.initialProfile === undefined ? null : readWarmStartProfile(record.initialProfile, specs);
  return {
    handwiredRoot,
    specs,
    rows,
    counts,
    trainedHeads,
    seed,
    learningRate,
    epochs,
    stopCheckpoints,
    initialProfile,
  };
}

function relu(circuit: HandwiredCircuit, wire: HandwiredWire): HandwiredWire {
  return circuit.reglu([], 1, [[wire, 1]], 0);
}

function buildL2Graph(module: HandwiredModule, specs: L2Specs): L2Graph {
  const parameterCount = L2_HEADS.reduce((sum, head) => sum + parameterCountFor(specs[head]), 0);
  const featureCount = L2_HEADS.reduce((sum, head) => sum + specs[head].features.length, 0);
  const circuit = new module.Circuit(parameterCount + featureCount);
  const heads = {} as Record<L2Head, L2HeadLayout>;
  let parameterCursor = 0;
  let featureCursor = parameterCount;
  for (const head of L2_HEADS) {
    const spec = specs[head];
    const headParameterCount = parameterCountFor(spec);
    const parameterOffset = parameterCursor;
    const parameterWires = Array.from({ length: headParameterCount }, (_, index) =>
      circuit.source(parameterOffset + index),
    );
    parameterCursor += headParameterCount;
    const featureOffset = featureCursor;
    const featureWires = Array.from({ length: spec.features.length }, (_, index) =>
      circuit.source(featureOffset + index),
    );
    featureCursor += spec.features.length;

    let cursor = 0;
    const nextWire = (): HandwiredWire => {
      const wire = parameterWires[cursor];
      if (wire === undefined) throw new Error(`L2 parameter layout for head ${head} is inconsistent`);
      cursor += 1;
      return wire;
    };
    const matrix = (rows: number, columns: number): HandwiredWire[][] =>
      Array.from({ length: rows }, () => Array.from({ length: columns }, nextWire));
    const vector = (size: number): HandwiredWire[] => Array.from({ length: size }, nextWire);
    const dense = (
      weights: readonly (readonly HandwiredWire[])[],
      bias: readonly HandwiredWire[],
      inputs: readonly HandwiredWire[],
    ): HandwiredWire[] => weights.map((row, outputIndex) => {
      const terms: [HandwiredWire, number][] = [];
      for (let inputIndex = 0; inputIndex < inputs.length; inputIndex += 1) {
        terms.push([circuit.multiply(row[inputIndex]!, inputs[inputIndex]!), 1]);
      }
      terms.push([bias[outputIndex]!, 1]);
      return circuit.affine(terms);
    });

    const [hiddenOneSize, hiddenTwoSize] = spec.hidden;
    const firstWeights = matrix(hiddenOneSize, spec.features.length);
    const firstBias = vector(hiddenOneSize);
    const secondWeights = matrix(hiddenTwoSize, hiddenOneSize);
    const secondBias = vector(hiddenTwoSize);
    const readoutWeights = matrix(spec.labels.length, hiddenTwoSize);
    const readoutBias = vector(spec.labels.length);
    if (cursor !== headParameterCount) {
      throw new Error(`L2 parameter layout for head ${head} consumed ${cursor} of ${headParameterCount} values`);
    }

    const hiddenOne = dense(firstWeights, firstBias, featureWires);
    const hiddenOneActivated = hiddenOne.map(hidden => relu(circuit, hidden));
    const hiddenTwo = dense(secondWeights, secondBias, hiddenOneActivated);
    const hiddenTwoActivated = hiddenTwo.map(hidden => relu(circuit, hidden));
    const logitWires = dense(readoutWeights, readoutBias, hiddenTwoActivated);

    heads[head] = {
      spec,
      parameterOffset,
      parameterCount: headParameterCount,
      parameterWires,
      featureOffset,
      featureWires,
      hiddenActivationWires: [...hiddenOneActivated, ...hiddenTwoActivated],
      logitWires,
    };
  }
  return { circuit, heads, parameterCount };
}

function forward(
  graph: L2Graph,
  head: L2Head,
  parameters: readonly number[],
  features: readonly number[],
): ForwardResult {
  const layout = graph.heads[head];
  if (features.length !== layout.featureWires.length) {
    throw new TypeError(`head ${head} expects ${layout.featureWires.length} features, received ${features.length}`);
  }
  const source = new Float32Array(graph.circuit.sourceSize);
  for (let index = 0; index < layout.parameterCount; index += 1) {
    source[layout.parameterOffset + index] = parameters[layout.parameterOffset + index]!;
  }
  for (let index = 0; index < features.length; index += 1) {
    source[layout.featureOffset + index] = features[index]!;
  }
  const values = graph.circuit.evaluateReference(source);
  return { values, logits: layout.logitWires.map(wire => values[wire]!) };
}

function allowedLoss(logits: readonly number[], allowed: readonly number[]): { loss: number; logitGradient: number[] } {
  let maximum = Number.NEGATIVE_INFINITY;
  for (const logit of logits) maximum = Math.max(maximum, logit);
  const exponentials = logits.map(logit => Math.exp(logit - maximum));
  let total = 0;
  for (const value of exponentials) total += value;
  let allowedTotal = 0;
  for (const index of allowed) allowedTotal += exponentials[index]!;
  const allowedMass = allowedTotal / total;
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(allowedMass) || allowedMass <= 0) {
    throw new Error("L2 allowed-set softmax is non-finite");
  }
  const loss = -Math.log(allowedMass);
  if (!Number.isFinite(loss)) throw new Error("L2 allowed-set loss is non-finite");
  const allowedSet = new Set(allowed);
  const logitGradient = exponentials.map((value, index) =>
    value / total - (allowedSet.has(index) ? value / allowedTotal : 0),
  );
  return { loss, logitGradient };
}

function argmax(values: readonly number[]): number {
  let best = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index]! > values[best]!) best = index;
  }
  return best;
}

function evaluateBatch(
  graph: L2Graph,
  parameters: readonly number[],
  rows: readonly PreparedRow[],
  counts: HeadCounts,
  trainedHeads: readonly L2Head[],
  withGradient: boolean,
): BatchResult {
  const lossSums = zeroCounts();
  const correct = zeroCounts();
  const gradient = withGradient ? new Float64Array(graph.parameterCount) : null;
  let positiveActivation = false;
  for (const row of rows) {
    const { values, logits } = forward(graph, row.head, parameters, row.features);
    for (const logit of logits) {
      if (!Number.isFinite(logit)) throw new Error(`L2 head ${row.head} logits for row ${row.id} are non-finite`);
    }
    const layout = graph.heads[row.head];
    if (!positiveActivation) {
      for (const wire of layout.hiddenActivationWires) {
        if (values[wire]! > 0) {
          positiveActivation = true;
          break;
        }
      }
    }
    let loss: number;
    let logitGradient: readonly number[];
    try {
      ({ loss, logitGradient } = allowedLoss(logits, row.allowed));
    } catch (error) {
      throw new Error(`L2 head ${row.head} loss for row ${row.id} is non-finite`, { cause: error });
    }
    lossSums[row.head] += loss;
    if (row.allowed.includes(argmax(logits))) correct[row.head] += 1;
    if (gradient === null) continue;
    const outputGradients = new Float32Array(values.length);
    for (let index = 0; index < logitGradient.length; index += 1) {
      outputGradients[layout.logitWires[index]!] = logitGradient[index]!;
    }
    const sourceGradient = graph.circuit.backpropagateReference(values, outputGradients);
    for (let index = 0; index < layout.parameterCount; index += 1) {
      gradient[layout.parameterOffset + index] = gradient[layout.parameterOffset + index]!
        + sourceGradient[layout.parameterWires[index]!]!;
    }
  }

  const lossByHead: Record<L2Head, number | null> = { R: null, D: null, E: null, A: null };
  let meanLoss = 0;
  const activeWeight = 1 / trainedHeads.length;
  const active = new Set<L2Head>(trainedHeads);
  for (const head of L2_HEADS) {
    if (!active.has(head)) {
      // Frozen heads have no rows in this fit. Null marks an unscored head
      // instead of fabricating a zero loss or a perfect score.
      continue;
    }
    if (counts[head] <= 0) throw new Error(`L2 head ${head} has no rows`);
    const mean = lossSums[head]! / counts[head]!;
    if (!Number.isFinite(mean)) throw new Error(`L2 head ${head} loss is non-finite`);
    lossByHead[head] = mean;
    meanLoss += mean * activeWeight;
  }
  if (!Number.isFinite(meanLoss)) throw new Error("L2 mean loss is non-finite");
  if (gradient !== null) {
    for (const head of trainedHeads) {
      const layout = graph.heads[head];
      const scale = activeWeight / counts[head]!;
      for (let index = 0; index < layout.parameterCount; index += 1) {
        gradient[layout.parameterOffset + index] = gradient[layout.parameterOffset + index]! * scale;
      }
    }
    for (let index = 0; index < gradient.length; index += 1) {
      if (!Number.isFinite(gradient[index]!)) throw new Error("L2 gradient is non-finite");
    }
  }
  return { lossByHead, meanLoss, correctByHead: correct, gradient, positiveActivation };
}

function updateParameters(
  graph: L2Graph,
  parameters: number[],
  gradient: Float64Array,
  learningRate: number,
  trainedHeads: readonly L2Head[],
): void {
  // Frozen heads are skipped entirely so their stored values stay bit-exact.
  for (const head of trainedHeads) {
    const layout = graph.heads[head];
    for (let index = layout.parameterOffset; index < layout.parameterOffset + layout.parameterCount; index += 1) {
      const updated = Math.fround(parameters[index]! - learningRate * gradient[index]!);
      if (!Number.isFinite(updated)) throw new Error("L2 parameter update is non-finite");
      parameters[index] = updated;
    }
  }
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function initializeParameters(specs: L2Specs, seed: number): number[] {
  const random = mulberry32(seed);
  const parameters: number[] = [];
  for (const head of L2_HEADS) {
    const spec = specs[head];
    const layers: readonly { readonly fanIn: number; readonly fanOut: number }[] = [
      { fanIn: spec.features.length, fanOut: spec.hidden[0] },
      { fanIn: spec.hidden[0], fanOut: spec.hidden[1] },
      { fanIn: spec.hidden[1], fanOut: spec.labels.length },
    ];
    for (const layer of layers) {
      const limit = Math.sqrt(6 / (layer.fanIn + layer.fanOut));
      for (let index = 0; index < layer.fanIn * layer.fanOut; index += 1) {
        parameters.push(Math.fround((random() * 2 - 1) * limit));
      }
      for (let index = 0; index < layer.fanOut; index += 1) {
        parameters.push(Math.fround((random() * 2 - 1) * limit));
      }
    }
  }
  return parameters;
}

function flattenProfile(profile: L2MlpProfile): number[] {
  return L2_HEADS.flatMap(head => [...profile.heads[head].parameters]);
}

function profileFromParameters(specs: L2Specs, parameters: readonly number[]): L2MlpProfile {
  const heads = {} as Record<L2Head, L2MlpHeadProfile>;
  let cursor = 0;
  for (const head of L2_HEADS) {
    const spec = specs[head];
    const count = parameterCountFor(spec);
    heads[head] = { spec: copySpec(spec), parameters: parameters.slice(cursor, cursor + count) };
    cursor += count;
  }
  return validateL2Profile({
    schema: PROFILE_SCHEMA,
    heads,
    calibration: PROFILE_CALIBRATION,
    adoption: PROFILE_ADOPTION,
  });
}

function scoreSnapshot(batch: BatchResult, counts: HeadCounts): HeadScores {
  const scores = {} as Record<L2Head, { correct: number; scored: number }>;
  for (const head of L2_HEADS) {
    scores[head] = { correct: batch.correctByHead[head], scored: counts[head] };
  }
  return scores;
}

function probeGradient(
  graph: L2Graph,
  parameters: readonly number[],
  rows: readonly PreparedRow[],
  counts: HeadCounts,
  trainedHeads: readonly L2Head[],
  gradient: Float64Array,
): { checked: number; passed: boolean; maxAbsoluteError: number } {
  const selected: number[] = [];
  for (const head of trainedHeads) {
    const layout = graph.heads[head];
    const selectedBeforeHead = selected.length;
    const firstLayerEnd = (layout.spec.features.length + 1) * layout.spec.hidden[0];
    const readoutStart = layout.parameterCount - (layout.spec.hidden[1] + 1) * layout.spec.labels.length;
    // Check both the path through the hidden layers and the final readout.
    for (const [start, end] of [[0, firstLayerEnd], [readoutStart, layout.parameterCount]]) {
      let best = -1;
      let bestMagnitude = 0;
      for (let index = start!; index < end!; index += 1) {
        const globalIndex = layout.parameterOffset + index;
        const magnitude = Math.abs(gradient[globalIndex]!);
        if (magnitude > bestMagnitude) {
          bestMagnitude = magnitude;
          best = globalIndex;
        }
      }
      if (best >= 0 && bestMagnitude > 0) selected.push(best);
    }
    // A constant diagnostic head can have zero hidden gradient. Check a second
    // active readout parameter instead; do not invent a nonzero hidden gradient.
    while (selected.length - selectedBeforeHead < 2) {
      let best = -1;
      let magnitude = 0;
      for (let index = layout.parameterOffset; index < layout.parameterOffset + layout.parameterCount; index++) {
        if (!selected.includes(index) && Math.abs(gradient[index]!) > magnitude) {
          best = index;
          magnitude = Math.abs(gradient[index]!);
        }
      }
      if (best < 0) break;
      selected.push(best);
    }
  }
  let maxAbsoluteError = 0;
  let passed = selected.length === 2 * trainedHeads.length;
  for (const index of selected) {
    const plus = [...parameters];
    const minus = [...parameters];
    plus[index] = Math.fround(plus[index]! + PROBE_STEP);
    minus[index] = Math.fround(minus[index]! - PROBE_STEP);
    const plusLoss = evaluateBatch(graph, plus, rows, counts, trainedHeads, false).meanLoss;
    const minusLoss = evaluateBatch(graph, minus, rows, counts, trainedHeads, false).meanLoss;
    if (!Number.isFinite(plusLoss) || !Number.isFinite(minusLoss)) {
      throw new Error("L2 gradient probe loss is non-finite");
    }
    const numeric = (plusLoss - minusLoss) / (2 * PROBE_STEP);
    const analytic = gradient[index]!;
    const error = Math.abs(numeric - analytic);
    maxAbsoluteError = Math.max(maxAbsoluteError, error);
    const tolerance = PROBE_ABSOLUTE_TOLERANCE + PROBE_RELATIVE_TOLERANCE * Math.abs(numeric);
    if (!Number.isFinite(error) || error > tolerance) passed = false;
  }
  return { checked: selected.length, passed, maxAbsoluteError };
}

/**
 * Public L2 fit entry. A non-reference backend, or any restartable/observable
 * option, is routed to the backend module so all three backends share one
 * progress, checkpoint and resume contract. The reference loop below stays the
 * numerical baseline.
 */
export async function fitL2Mlp(input: L2FitInput): Promise<L2FitResult> {
  const requested = (input as { readonly computeBackend?: string }).computeBackend;
  const restartable = (input as { readonly checkpointPath?: unknown }).checkpointPath !== undefined
    || (input as { readonly resume?: unknown }).resume === true;
  if (restartable && requested === undefined) {
    // Defaults never change compute path. Checkpoint/resume lives in the
    // experimental backends, so the caller must name the backend it wants
    // instead of being routed there implicitly.
    throw Object.assign(
      new TypeError(
        "checkpointPath/resume require an explicit computeBackend (\"batch-cpu\" or \"gpu\"); the default fitL2Mlp path keeps the handwired reference loop",
      ),
      { kind: "resume" as const, phase: "initialize" as const },
    );
  }
  if (requested === "batch-cpu" || requested === "gpu" || restartable) {
    const { runBackendFit } = await import("./l2-mlp-backend.js");
    const result = await runBackendFit(input);
    const report: L2FitReport = {
      ...result.report,
      backend: result.backend,
      device: result.device,
      resumedFromStep: result.resumedFromStep ?? null,
      lastPersistedStep: result.lastPersistedStep ?? null,
      timing: { ...(result.timings ?? {}) },
    };
    return { profile: result.profile, report };
  }
  const prepared = prepareFitInput(input);
  const warmStart = prepared.initialProfile !== null;
  const workingParameters = warmStart
    ? flattenProfile(prepared.initialProfile!)
    : initializeParameters(prepared.specs, prepared.seed);
  const startingParameters = [...workingParameters];
  const trajectory: { epoch: number; loss: Record<L2Head, number | null> }[] = [];
  let epochsCompleted = 0;
  let phase = "epoch_zero";
  const startedAt = Date.now();
  let state: L2TrainingState = "init";
  const emit = (
    eventPhase: L2TrainingPhase,
    stageStatus: "start" | "end" | "failed",
    extra: Partial<L2TrainingEvent> = {},
  ): void => {
    if (input.onProgress === undefined) return;
    input.onProgress({
      type: "phase",
      runId: `l2-reference-${startedAt}`,
      state,
      phase: eventPhase,
      stageStatus,
      trainedHeads: [...prepared.trainedHeads],
      completedUpdates: epochsCompleted,
      totalUpdates: prepared.epochs,
      elapsedMs: Date.now() - startedAt,
      device: "handwired-reference",
      lastPersistedStep: null,
      ...extra,
    });
  };
  emit("initialize", "start");
  try {
    emit("initialize", "end");
    emit("data_prepare", "start");
    emit("data_prepare", "end");
    emit("device_load", "start");
    const module = await loadHandwired(prepared.handwiredRoot);
    const graph = buildL2Graph(module, prepared.specs);
    state = "running";
    emit("device_load", "end", { device: "handwired-reference" });
    emit("first_compute", "start");
    const initialBatch = evaluateBatch(
      graph, workingParameters, prepared.rows, prepared.counts, prepared.trainedHeads, true,
    );
    if (!initialBatch.positiveActivation) {
      throw new Error("L2 initialization produced all-zero ReLU activations");
    }
    if (!initialBatch.gradient!.some(value => value !== 0)) {
      throw new Error("L2 fit has no nonzero gradient at the starting parameters");
    }
    phase = "gradient_probe";
    const gradientProbe = probeGradient(
      graph, workingParameters, prepared.rows, prepared.counts, prepared.trainedHeads,
      initialBatch.gradient!,
    );
    if (!gradientProbe.passed) {
      throw new Error(`L2 gradient probe failed before training: ${JSON.stringify(gradientProbe)}`);
    }

    emit("first_compute", "end");
    phase = "training";
    let finalBatch = initialBatch;
    let stopped: "satisfied" | "epochs_exhausted" = "epochs_exhausted";
    for (let epoch = 1; epoch <= prepared.epochs; epoch += 1) {
      const batch = evaluateBatch(
        graph, workingParameters, prepared.rows, prepared.counts, prepared.trainedHeads, true,
      );
      trajectory.push({ epoch, loss: { ...batch.lossByHead } });
      updateParameters(
        graph, workingParameters, batch.gradient!, prepared.learningRate, prepared.trainedHeads,
      );
      epochsCompleted = epoch;
      if (input.onProgress !== undefined) {
        input.onProgress({
          type: "step",
          runId: `l2-reference-${startedAt}`,
          state: "running",
          phase: "update",
          trainedHeads: [...prepared.trainedHeads],
          completedUpdates: epochsCompleted,
          totalUpdates: prepared.epochs,
          lossWindow: "pre_update",
          recentMeanLoss: batch.meanLoss,
          recentLossByHead: { ...batch.lossByHead },
          elapsedMs: Date.now() - startedAt,
          device: "handwired-reference",
          lastPersistedStep: null,
        });
      }
      if (prepared.stopCheckpoints.has(epoch)) {
        phase = `checkpoint:${epoch}`;
        finalBatch = evaluateBatch(
          graph, workingParameters, prepared.rows, prepared.counts, prepared.trainedHeads, false,
        );
        if (prepared.trainedHeads.every(head => finalBatch.correctByHead[head] === prepared.counts[head])) {
          stopped = "satisfied";
          break;
        }
        phase = "training";
      }
    }

    phase = "final";
    emit("evaluate", "start");
    if (stopped !== "satisfied") {
      finalBatch = evaluateBatch(
        graph, workingParameters, prepared.rows, prepared.counts, prepared.trainedHeads, false,
      );
    }
    emit("evaluate", "end");
    state = "completed";
    emit("complete", "end");
    let changedParameters = 0;
    for (let index = 0; index < workingParameters.length; index += 1) {
      if (Math.fround(startingParameters[index]!) !== Math.fround(workingParameters[index]!)) changedParameters += 1;
    }
    const report: L2FitReport = {
      trainedHeads: [...prepared.trainedHeads],
      initialization: warmStart ? "warm_start" : "pretraining",
      fittedRows: prepared.rows.length,
      fittedByHead: { ...prepared.counts },
      epochZero: scoreSnapshot(initialBatch, prepared.counts),
      final: scoreSnapshot(finalBatch, prepared.counts),
      epochsCompleted,
      stopped,
      trajectory,
      parameterCount: graph.parameterCount,
      changedParameters,
      gradientProbe,
    };
    return { profile: profileFromParameters(prepared.specs, workingParameters), report };
  } catch (error) {
    if (error !== null && (typeof error === "object" || typeof error === "function")) {
      try {
        Object.assign(error, { epochsCompleted, phase });
      } catch {
        // A frozen error keeps its original message; the fit still fails.
      }
    }
    throw error;
  }
}

function specsFromProfile(profile: L2MlpProfile): L2Specs {
  const specs = {} as Record<L2Head, L2HeadSpec>;
  for (const head of L2_HEADS) specs[head] = profile.heads[head].spec;
  return specs;
}

export async function createL2Unit(profile: L2MlpProfile, handwiredRoot: string): Promise<L2Unit> {
  const validated = validateL2Profile(profile);
  const root = expectNonEmptyString(handwiredRoot, "handwiredRoot");
  const module = await loadHandwired(root);
  const graph = buildL2Graph(module, specsFromProfile(validated));
  const stored = validateL2Profile(validated);
  const parameters = flattenProfile(stored);
  return {
    profile: stored,
    infer(head: L2Head, features: readonly number[]): L2Prediction {
      if (!L2_HEADS.includes(head)) throw new TypeError(`head ${String(head)} is not an L2 head`);
      const spec = stored.heads[head].spec;
      const vector = expectArray(features, "features").map((feature, index) =>
        expectFiniteNumber(feature, `features[${index}]`),
      );
      if (vector.length !== spec.features.length) {
        throw new TypeError(`head ${head} expects ${spec.features.length} features, received ${vector.length}`);
      }
      const { logits } = forward(graph, head, parameters, vector);
      for (const logit of logits) {
        if (!Number.isFinite(logit)) throw new Error(`L2 head ${head} logits are non-finite`);
      }
      return { head, label: spec.labels[argmax(logits)]!, logits };
    },
  };
}

export async function readL2Profile(path: string): Promise<L2MlpProfile> {
  const filePath = expectNonEmptyString(path, "profile path");
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`L2 profile could not be read: ${filePath}`, { cause: error });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new SyntaxError(`L2 profile is not valid JSON: ${filePath}`, { cause: error });
  }
  return validateL2Profile(raw);
}

export async function saveL2Profile(path: string, profile: L2MlpProfile): Promise<void> {
  const filePath = expectNonEmptyString(path, "profile path");
  const validated = validateL2Profile(profile);
  const handle = await open(filePath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}
