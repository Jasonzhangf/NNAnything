import {
  STRATEGY_HEADS,
  STRATEGY_WIRES,
} from "../../adapters/browser/strategy-contract.js";
import type { HandwiredModule } from "../../training/handwired.js";
import {
  buildLinearPolicyCircuit,
  type LinearPolicyCircuit,
} from "./linear-policy.js";

export function buildBrowserStrategyCircuit(module: HandwiredModule): LinearPolicyCircuit {
  return buildLinearPolicyCircuit(
    module,
    STRATEGY_HEADS.length,
    STRATEGY_WIRES.length,
  );
}
