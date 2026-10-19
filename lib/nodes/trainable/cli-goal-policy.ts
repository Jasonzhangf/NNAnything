import { CLI_GOAL_ACTIONS, CLI_GOAL_WIRES } from "../../filters/cli-goal-policy.js";
import type {
  HandwiredCircuit,
  HandwiredModule,
  HandwiredTerms,
  HandwiredWire,
} from "../../training/handwired.js";

export interface CliGoalCircuit {
  readonly circuit: HandwiredCircuit;
  readonly parameterWires: readonly HandwiredWire[];
  readonly featureWires: readonly HandwiredWire[];
  readonly logitWires: readonly HandwiredWire[];
}

export function buildCliGoalCircuit(module: HandwiredModule): CliGoalCircuit {
  const parameterCount = CLI_GOAL_ACTIONS.length * CLI_GOAL_WIRES.length;
  const circuit = new module.Circuit(parameterCount + CLI_GOAL_WIRES.length);
  const parameterWires = Array.from({ length: parameterCount }, (_, index) => circuit.source(index));
  const featureWires = Array.from(
    { length: CLI_GOAL_WIRES.length },
    (_, index) => circuit.source(parameterCount + index),
  );
  for (const wire of featureWires) circuit.assumeRange(wire, 0, 1);
  const logitWires = CLI_GOAL_ACTIONS.map((_, actionIndex) => {
    const terms: [HandwiredWire, number][] = [];
    for (let wireIndex = 0; wireIndex < CLI_GOAL_WIRES.length; wireIndex += 1) {
      terms.push([
        circuit.multiply(
          parameterWires[actionIndex * CLI_GOAL_WIRES.length + wireIndex]!,
          featureWires[wireIndex]!,
        ),
        1,
      ]);
    }
    return circuit.affine(terms as HandwiredTerms);
  });
  return { circuit, parameterWires, featureWires, logitWires };
}
