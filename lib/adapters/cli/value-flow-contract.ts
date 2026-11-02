// Neutral `nn-code value-flow` H_R contract.
//
// This module is the single source of truth for the trainable unit id,
// feature schema, ordered 15-dimension feature names, ordered 3-class label
// vocabulary, architecture and parameter count. It performs no I/O and must
// never scan a log pool or write files; the CLI normal startup path must not
// call the streaming or staging APIs.

export const VALUE_FLOW_HR_UNIT_ID = "cli.value-flow.candidate-relevance.v1" as const;
export const VALUE_FLOW_FEATURE_SCHEMA = "cli.value-flow.candidate-features.v1" as const;

export const VALUE_FLOW_FEATURE_NAMES = Object.freeze([
  "r00_dir_is_origin",
  "r01_dir_is_sink",
  "r02_same_dir_as_exported_module",
  "r03_is_test_or_fixture_path",
  "r04_same_line_has_call_open_paren",
  "r05_same_line_call_parens_closed",
  "r06_same_line_has_receive_or_return_prefix",
  "r07_same_line_is_standalone_stmt_prefix",
  "r08_same_line_has_comment_or_type_syntax",
  "r09_same_line_is_import_or_decl_header",
  "r10_same_line_arg_count_covers_target",
  "m00_mask_arg_count_observable",
  "m01_mask_multiline_receive_unobserved",
  "m02_mask_enclosing_block_comment_or_template_unknown",
  "m03_mask_cross_file_module_binding_unverified",
] as const);

export const VALUE_FLOW_LABELS = Object.freeze(["holds", "insufficient", "refuted"] as const);
export const VALUE_FLOW_HR_ARCHITECTURE = Object.freeze([15, 16, 16, 3] as const);
export const VALUE_FLOW_HR_PARAMETER_COUNT = 579 as const;

export type ValueFlowLabel = (typeof VALUE_FLOW_LABELS)[number];
export type ValueFlowPartition = "train" | "dev" | "verification";
