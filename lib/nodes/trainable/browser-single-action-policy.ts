import {
  SINGLE_ACTION_CAPABILITY_HEADS,
  SINGLE_ACTION_CAPABILITY_WIRES,
  SINGLE_ACTION_RELATION_HEADS,
  SINGLE_ACTION_RELATION_WIRES,
} from "../../adapters/browser/single-action-contract.js";
import type { HandwiredModule } from "../../training/handwired.js";
import {
  buildLinearPolicyCircuit,
  type LinearPolicyCircuit,
} from "./linear-policy.js";

export function buildBrowserSingleActionRelationCircuit(module: HandwiredModule): LinearPolicyCircuit {
  return buildLinearPolicyCircuit(
    module,
    SINGLE_ACTION_RELATION_HEADS.length,
    SINGLE_ACTION_RELATION_WIRES.length,
  );
}

export function buildBrowserSingleActionCapabilityCircuit(module: HandwiredModule): LinearPolicyCircuit {
  return buildLinearPolicyCircuit(
    module,
    SINGLE_ACTION_CAPABILITY_HEADS.length,
    SINGLE_ACTION_CAPABILITY_WIRES.length,
  );
}
