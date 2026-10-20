import type { HandwiredModule, HandwiredTerms } from "../../training/handwired.js";

export function buildCliCommandCircuit(module: HandwiredModule, classCount: number, featureCount: number) {
  const parameterCount = classCount * featureCount;
  const circuit = new module.Circuit(parameterCount + featureCount);
  const parameters = Array.from({ length: parameterCount }, (_, index) => circuit.source(index));
  const features = Array.from({ length: featureCount }, (_, index) => circuit.source(parameterCount + index));
  for (const wire of features) circuit.assumeRange(wire, 0, 1);
  const logits = Array.from({ length: classCount }, (_, row) => circuit.affine(features.map((feature, column) => [
    circuit.multiply(parameters[row * featureCount + column]!, feature), 1,
  ]) as HandwiredTerms));
  return { circuit, parameters, features, logits };
}
