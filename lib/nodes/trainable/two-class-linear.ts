import type {
  HandwiredCircuit,
  HandwiredModule,
  HandwiredTerms,
  HandwiredWire,
} from "../../training/handwired.js";

export interface TwoClassLinearCircuit {
  readonly circuit: HandwiredCircuit;
  readonly parameterWires: readonly HandwiredWire[];
  readonly featureWires: readonly HandwiredWire[];
  readonly logitWires: readonly [HandwiredWire, HandwiredWire];
}

export function buildTwoClassLinearCircuit(module: HandwiredModule, featureCount: number): TwoClassLinearCircuit {
  if (!Number.isInteger(featureCount) || featureCount <= 0) throw new TypeError("featureCount must be a positive integer");
  const parameterCount = 2 * featureCount;
  const circuit = new module.Circuit(parameterCount + featureCount);
  const parameterWires = Array.from({ length: parameterCount }, (_, index) => circuit.source(index));
  const featureWires = Array.from({ length: featureCount }, (_, index) => circuit.source(parameterCount + index));
  for (const wire of featureWires) circuit.assumeRange(wire, 0, 1);
  const logitWires = [0, 1].map(classIndex => {
    const terms: [HandwiredWire, number][] = [];
    for (let featureIndex = 0; featureIndex < featureCount; featureIndex += 1) {
      terms.push([
        circuit.multiply(
          parameterWires[classIndex * featureCount + featureIndex]!,
          featureWires[featureIndex]!,
        ),
        1,
      ]);
    }
    return circuit.affine(terms as HandwiredTerms);
  }) as [HandwiredWire, HandwiredWire];
  return { circuit, parameterWires, featureWires, logitWires };
}
