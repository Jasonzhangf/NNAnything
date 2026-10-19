import { PATH_ACTIONS, PATH_WIRES } from "../../filters/cli-path-controller.js";
import type {
  HandwiredCircuit,
  HandwiredModule,
  HandwiredTerms,
  HandwiredWire,
} from "../../training/handwired.js";

export interface PathCircuit {
  readonly circuit: HandwiredCircuit;
  readonly parameterWires: readonly HandwiredWire[];
  readonly featureWires: readonly HandwiredWire[];
  readonly logitWires: readonly HandwiredWire[];
}

/**
 * The circuit exposes one source wire for every learned parameter and one for
 * every observed feature. All logits are dynamic, so fitting can only change
 * the supplied parameters, never a hard-coded controller policy.
 */
export function buildPathCircuit(module: HandwiredModule): PathCircuit {
  const parameterCount = PATH_ACTIONS.length * PATH_WIRES.length;
  const circuit = new module.Circuit(parameterCount + PATH_WIRES.length);
  const parameterWires = Array.from({ length: parameterCount }, (_, index) => circuit.source(index));
  const featureWires = Array.from(
    { length: PATH_WIRES.length },
    (_, index) => circuit.source(parameterCount + index),
  );

  for (const featureWire of featureWires) circuit.assumeRange(featureWire, 0, 1);

  const logitWires = PATH_ACTIONS.map((_, actionIndex) => {
    const terms: [HandwiredWire, number][] = [];
    for (let wireIndex = 0; wireIndex < PATH_WIRES.length; wireIndex += 1) {
      const parameterWire = parameterWires[actionIndex * PATH_WIRES.length + wireIndex]!;
      const featureWire = featureWires[wireIndex]!;
      terms.push([circuit.multiply(parameterWire, featureWire), 1]);
    }
    return circuit.affine(terms as HandwiredTerms);
  });

  return { circuit, parameterWires, featureWires, logitWires };
}
