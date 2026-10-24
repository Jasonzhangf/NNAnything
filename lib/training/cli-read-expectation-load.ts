import { readFile } from "node:fs/promises";
import { loadHandwired, type HandwiredModule } from "./handwired.js";
import { buildLinearPolicyCircuit } from "../nodes/trainable/linear-policy.js";
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
import type { ReadProfile } from "./cli-read-expectation-numeric.js";

const BASE_SCHEMA = "nnanything.cli-read-feedback.read-expectation.base.v1" as const;
const REASONING_SCHEMA = "nnanything.cli-read-feedback.read-expectation.reasoning.v1" as const;

/** A loaded pair of profiles plus the numeric backend needed to run them. */
export type ReadFeedbackUnit = Readonly<{
  module: HandwiredModule;
  base: ReadProfile;
  reasoning: ReadProfile;
  inferBase(input: BaseVector): Readonly<Record<BaseLabel, 0 | 1>>;
  inferReasoning(input: ReasoningVector): ReasoningLabel;
}>;

function validateProfile(value: unknown, kind: "base" | "reasoning"): ReadProfile {
  const record = value as { schema?: unknown; kind?: unknown; headCount?: unknown; wireCount?: unknown; weights?: unknown };
  const expectedSchema = kind === "base" ? BASE_SCHEMA : REASONING_SCHEMA;
  const expectedHeads = kind === "base" ? BASE_LABELS.length : REASONING_LABELS.length;
  const expectedWires = kind === "base" ? BASE_WIRES.length : REASONING_WIRES.length;
  if (record.schema !== expectedSchema) throw new TypeError(`profile schema must be ${expectedSchema}`);
  if (record.kind !== kind) throw new TypeError(`profile kind must be ${kind}`);
  if (record.headCount !== expectedHeads) throw new TypeError(`profile headCount must be ${expectedHeads}`);
  if (record.wireCount !== expectedWires) {
    throw new TypeError(`profile wireCount must be ${expectedWires}, received ${String(record.wireCount)}`);
  }
  if (!Array.isArray(record.weights) || record.weights.length !== expectedHeads) {
    throw new TypeError("profile weights must have one row per head");
  }
  for (const row of record.weights) {
    if (!Array.isArray(row) || row.length !== expectedWires || row.some(value => typeof value !== "number" || !Number.isFinite(value))) {
      throw new TypeError("each profile weight row must hold one finite number per wire");
    }
  }
  return Object.freeze({
    schema: expectedSchema,
    kind,
    headCount: expectedHeads,
    wireCount: expectedWires,
    weights: Object.freeze((record.weights as number[][]).map(row => Object.freeze([...row]))),
  });
}

export async function loadReadProfile(path: string, kind: "base" | "reasoning"): Promise<ReadProfile> {
  return validateProfile(JSON.parse(await readFile(path, "utf8")), kind);
}

function forward(
  module: HandwiredModule,
  profile: ReadProfile,
  features: readonly number[],
): readonly number[] {
  const circuit = buildLinearPolicyCircuit(module, profile.headCount, profile.wireCount);
  const source = new Float32Array(circuit.circuit.sourceSize);
  const flat = profile.weights.flat();
  circuit.parameters.forEach((wire, index) => { source[wire] = Math.fround(flat[index]!); });
  circuit.features.forEach((wire, index) => { source[wire] = Math.fround(features[index]!); });
  const values = circuit.circuit.evaluateReference(source);
  return circuit.logits.map(wire => values[wire]!);
}

function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const z = Math.exp(x);
  return z / (1 + z);
}

export async function readReadFeedbackUnit(input: Readonly<{ handwiredRoot: string; baseProfilePath: string; reasoningProfilePath: string }>): Promise<ReadFeedbackUnit> {
  const [module, base, reasoning] = await Promise.all([
    loadHandwired(input.handwiredRoot),
    loadReadProfile(input.baseProfilePath, "base"),
    loadReadProfile(input.reasoningProfilePath, "reasoning"),
  ]);
  return Object.freeze({
    module,
    base,
    reasoning,
    inferBase(vec: BaseVector) {
      const logits = forward(module, base, BASE_WIRES.map(wire => vec[wire]));
      const prediction = {} as Record<BaseLabel, 0 | 1>;
      BASE_LABELS.forEach((label, index) => {
        prediction[label] = sigmoid(logits[index]!) >= 0.5 ? 1 : 0;
      });
      return Object.freeze(prediction);
    },
    inferReasoning(vec: ReasoningVector) {
      const logits = forward(module, reasoning, REASONING_WIRES.map(wire => vec[wire]));
      let best = 0;
      for (let index = 1; index < logits.length; index += 1) {
        if (logits[index]! > logits[best]!) best = index;
      }
      return REASONING_LABELS[best]!;
    },
  });
}
