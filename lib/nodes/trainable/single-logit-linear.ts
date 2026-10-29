import type { HandwiredCircuit, HandwiredModule, HandwiredTerms, HandwiredWire } from "../../training/handwired.js";

export type SingleLogitLinearCircuit = Readonly<{
  circuit: HandwiredCircuit;
  parameters: readonly HandwiredWire[];
  features: readonly HandwiredWire[];
  logitWire: HandwiredWire;
}>;

export function buildSingleLogitLinearCircuit(
  module: HandwiredModule,
  featureCount = 4,
): SingleLogitLinearCircuit {
  if (!Number.isInteger(featureCount) || featureCount <= 0) {
    throw new TypeError("featureCount must be a positive integer");
  }
  const circuit = new module.Circuit(featureCount * 2);
  const parameters = Array.from({ length: featureCount }, (_, index) => circuit.source(index));
  const features = Array.from({ length: featureCount }, (_, index) => circuit.source(featureCount + index));
  for (const wire of features) circuit.assumeRange(wire, 0, 1);
  const terms: HandwiredTerms = features.map((feature, index) => [
    circuit.multiply(parameters[index]!, feature),
    1,
  ]);
  const logitWire = circuit.affine(terms);
  return Object.freeze({
    circuit,
    parameters: Object.freeze(parameters),
    features: Object.freeze(features),
    logitWire,
  });
}
