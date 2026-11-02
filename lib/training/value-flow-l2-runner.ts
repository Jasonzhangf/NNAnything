// Value-flow L2 constants re-export.
//
// The neutral contract in lib/adapters/cli/value-flow-contract.ts is the only
// owner of the H_R unit id, feature schema, feature names, label vocabulary,
// architecture and parameter count. This module re-exports those constants so
// existing training consumers keep working while the L3 optimizer remains
// NOT_READY. It performs no I/O and contains no training runner.

export {
  VALUE_FLOW_FEATURE_NAMES,
  VALUE_FLOW_FEATURE_SCHEMA,
  VALUE_FLOW_HR_ARCHITECTURE,
  VALUE_FLOW_HR_PARAMETER_COUNT,
  VALUE_FLOW_HR_UNIT_ID,
  VALUE_FLOW_LABELS,
} from "../adapters/cli/value-flow-contract.js";
export type { ValueFlowLabel, ValueFlowPartition } from "../adapters/cli/value-flow-contract.js";
