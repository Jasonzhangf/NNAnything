import type {
  HandwiredCircuit,
  HandwiredModule,
  HandwiredTerms,
  HandwiredWire,
} from "../../training/handwired.js";

export interface LinearPolicyCircuit {
  readonly circuit: HandwiredCircuit;
  readonly parameters: readonly HandwiredWire[];
  readonly features: readonly HandwiredWire[];
  readonly logits: readonly HandwiredWire[];
}

export function buildLinearPolicyCircuit(
  module: HandwiredModule,
  classCount: number,
  featureCount: number,
): LinearPolicyCircuit {
  if (!Number.isInteger(classCount) || classCount <= 0) {
    throw new TypeError("classCount must be a positive integer");
  }
  if (!Number.isInteger(featureCount) || featureCount <= 0) {
    throw new TypeError("featureCount must be a positive integer");
  }
  const parameterCount = classCount * featureCount;
  const circuit = new module.Circuit(parameterCount + featureCount);
  const parameters = Array.from({ length: parameterCount }, (_, index) => circuit.source(index));
  const features = Array.from({ length: featureCount }, (_, index) => circuit.source(parameterCount + index));
  for (const wire of features) circuit.assumeRange(wire, 0, 1);
  const logits = Array.from({ length: classCount }, (_, classIndex) => {
    const terms: HandwiredTerms = features.map((feature, featureIndex) => [
      circuit.multiply(parameters[classIndex * featureCount + featureIndex]!, feature),
      1,
    ]);
    return circuit.affine(terms);
  });
  return { circuit, parameters, features, logits };
}
