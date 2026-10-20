import { buildLinearPolicyCircuit } from "./linear-policy.js";
import type { HandwiredModule } from "../../training/handwired.js";
import { FEEDBACK_HEADS, FEEDBACK_WIRES } from "../../adapters/browser/feedback-contract.js";
export function buildBrowserFeedbackCircuit(module: HandwiredModule) {
  return buildLinearPolicyCircuit(module, FEEDBACK_HEADS.length, FEEDBACK_WIRES.length);
}
