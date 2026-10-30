import type { Rect, ObservationNode } from "../adapters/browser/observation.js";
import type { ExplorationInputV1 } from "../adapters/browser/exploration-input.js";
import type { BasicKindMeasurements, BasicKindLabel, BasicKindStatus } from "./basic-kinds.js";

export const WEIBO_W0A_ROLE_HEADS = Object.freeze([
  "search_input",
  "search_submit",
  "result_list_root",
  "post_root",
  "reposted_embedded_post",
  "author_anchor",
  "timestamp_or_detail_anchor",
  "post_body",
  "expand_body_toggle",
  "media_item",
  "auxiliary_or_decor",
] as const);

export type WeiboNodeRole = typeof WEIBO_W0A_ROLE_HEADS[number];

export const WEIBO_W0A_CORE_ROLE_HEADS = Object.freeze([
  "search_input",
  "search_submit",
  "result_list_root",
  "post_root",
  "reposted_embedded_post",
  "author_anchor",
  "timestamp_or_detail_anchor",
  "post_body",
  "expand_body_toggle",
  "media_item",
] as const);

export type WeiboCoreNodeRole = typeof WEIBO_W0A_CORE_ROLE_HEADS[number];

export const WEIBO_W0A_RELATION_HEADS = Object.freeze([
  "author_of",
  "body_of",
  "detail_entry_of",
  "media_of",
  "link_of",
  "repost_of",
  "expand_toggle_of",
  "submits_input_of",
  "unrelated",
] as const);

export type WeiboPairRelation = typeof WEIBO_W0A_RELATION_HEADS[number];

export const WEIBO_W0A_POSITIVE_RELATION_HEADS = Object.freeze([
  "author_of",
  "body_of",
  "detail_entry_of",
  "media_of",
  "link_of",
  "repost_of",
  "expand_toggle_of",
  "submits_input_of",
] as const);

export type WeiboPositivePairRelation = typeof WEIBO_W0A_POSITIVE_RELATION_HEADS[number];

export const WEIBO_W0A_ROLE_WIRES = Object.freeze([
  "w00_bias_one",
  "w01_l1_judged_mask",
  "w02_l1_kind_button",
  "w03_l1_kind_input",
  "w04_l1_kind_select",
  "w05_l1_kind_image",
  "w06_l1_kind_video",
  "w07_l1_kind_audio",
  "w08_l1_kind_link",
  "w09_l1_kind_text",
  "w10_l1_kind_container",
  "w11_l1_kind_list",
  "w12_l1_kind_listitem",
  "w13_l1_kind_ignore",
  "w14_l1_kind_other",
  "w15_l1_status_unknown",
  "w16_l1_status_conflict",
  "w17_peer_ratio_known",
  "w18_has_repeating_structural_children",
  "w19_in_repeating_peer_parent",
  "w20_ancestor_and_subcontainer_text_known",
  "w21_hop_to_nearest_repeating_item_1_to_2",
  "w22_hop_to_nearest_repeating_item_3_to_4",
  "w23_inside_second_level_nested_subcontainer",
  "w24_rel_geom_in_container_known",
  "w25_in_container_top_quarter",
  "w26_in_container_bottom_fifth",
  "w27_width_spans_most_of_container",
  "w28_compact_inline_control_shape",
  "w29_text_string_known",
  "w30_text_len_short_1_to_16",
  "w31_text_len_long_ge_24",
  "w32_text_matches_datetime_regex",
  "w33_text_matches_expand_cue",
  "w34_href_url_parsed_known",
  "w35_has_multi_segment_http_href",
] as const);

export type WeiboRoleWireName = typeof WEIBO_W0A_ROLE_WIRES[number];

export const WEIBO_W0A_RELATION_WIRES = Object.freeze([
  "w00_bias_one",
  "w01_endpoint_roles_and_link_props_known_mask",
  "w02_pred_u_author_v_post",
  "w03_pred_u_body_v_post",
  "w04_pred_u_time_v_post",
  "w05_pred_u_media_v_post",
  "w06_pred_u_link_v_post",
  "w07_pred_u_repost_v_post_root",
  "w08_pred_u_expand_v_body",
  "w09_pred_u_submit_v_search_input",
  "w10_pred_u_or_v_auxiliary_decor",
  "w11_endpoint_role_or_link_prop_unknown",
  "w12_tree_path_known",
  "w13_v_is_ancestor_of_u_hops_1_to_2",
  "w14_v_is_ancestor_of_u_hops_3_to_4",
  "w15_v_is_ancestor_of_u_hops_5_to_6",
  "w16_u_and_v_share_parent_or_lca_le_2",
  "w17_intervening_path_roles_all_judged_mask",
  "w18_intervening_predicted_repost_on_path",
  "w19_intervening_predicted_post_root_on_path",
  "w20_intervening_path_role_unknown_or_conflict",
  "w21_pair_geom_known",
  "w22_contained_subbox_geom_and_roles_known_mask",
  "w23_u_bbox_contained_in_v_bbox",
  "w24_u_inside_predicted_repost_bbox_within_v",
  "w25_u_in_top_header_zone_of_v",
  "w26_u_in_middle_content_zone_of_v",
  "w27_u_inline_or_immediately_after_v",
  "w28_u_and_v_same_row_adjacent",
  "w29_vertical_gap_le_48px",
  "w30_vertical_gap_gt_240px",
  "w31_horizontal_overlap_ge_0_5_and_u_smaller",
] as const);

export type WeiboRelationWireName = typeof WEIBO_W0A_RELATION_WIRES[number];

export type WeiboSlotDisposition =
  | "active_retained"
  | "folded_ignore_wrapper"
  | "excluded_candidate";

export type WeiboJudgmentStatus = "judged" | "unknown" | "conflict";

export type WeiboReviewStatus =
  | "confirmed_gold"
  | "teacher_proposal"
  | "unreviewed";

export type PairGenerationBoundaryStatus =
  | "complete"
  | "truncated_by_hop_limit"
  | "incomplete_observation";

export interface WeiboNodeEvidenceSidecarV1 {
  readonly observedDirectText: string | null;
  readonly observedPathname: string | null;
  readonly rawHref?: string | null;
  readonly actionableWrapperRef?: string | null;
}

export interface WeiboSlotMappingRowV1 {
  readonly slotIndex: number;
  readonly index: number;
  readonly nodeRef: string;
  readonly rawParentRef: string | null;
  readonly disposition: WeiboSlotDisposition;
  readonly inMainClassificationInput: boolean;
  readonly effectiveL1: string;
  readonly judgmentStatus: BasicKindStatus;
  readonly basicKind: BasicKindLabel | null;
  readonly l1Wires16: Readonly<Record<string, number>> | null;
  readonly observationNode: ObservationNode;
  readonly itemObservation: { readonly nodeRef: string } & BasicKindMeasurements;
  readonly explorationInput: ExplorationInputV1;
  readonly sidecar?: WeiboNodeEvidenceSidecarV1;
}

export interface WeiboRetainedNodeV1 {
  readonly slotIndex: number;
  readonly index: number;
  readonly nodeRef: string;
  readonly rawParentRef: string | null;
  readonly effectiveRetainedAncestorRef: string | null;
  readonly bridgedIntermediateNodeRefs: readonly string[];
  readonly collapsedWrapperHopCount: number;
  readonly effectiveL1: string;
  readonly judgmentStatus: BasicKindStatus;
  readonly basicKind: BasicKindLabel | null;
  readonly l1Wires16: Readonly<Record<string, number>>;
  readonly observationNode?: ObservationNode;
  readonly itemObservation?: { readonly nodeRef: string } & BasicKindMeasurements;
  readonly explorationInput?: ExplorationInputV1;
  readonly sidecar?: WeiboNodeEvidenceSidecarV1;
  readonly roleAnnotation?: {
    readonly reviewStatus: WeiboReviewStatus;
    readonly goldRole: WeiboNodeRole | null;
  };
}

export interface WeiboIndependentGoldRelationV1 {
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly relation: WeiboPositivePairRelation;
  readonly reviewStatus: "confirmed_gold";
}

export interface WeiboCandidatePairAnnotationV1 {
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly reviewStatus: WeiboReviewStatus;
  readonly goldRelation: WeiboPairRelation | null;
}

export interface WeiboSourceFamilyIdentityV1 {
  readonly captureSessionId: string;
  readonly queryNormalized: string;
  readonly canonicalPostIds: readonly string[];
  readonly authorUids: readonly string[];
  readonly pageKind: "search_results" | "feed_with_reposts" | "mixed_search_and_reposts";
}

export interface WeiboFilteredDomSnapshotV1 {
  readonly snapshotId: string;
  readonly usageScope: "formal_benchmark" | "diagnostic_development_only" | "synthetic_engineering_smoke";
  readonly trainingEligible: boolean;
  readonly autoGold: boolean;
  readonly filterRecallStatus: "VERIFIED" | "UNVERIFIED";
  readonly partition?: "train" | "development" | "verification" | "demoted_seen_regression";
  readonly sourceFamily: WeiboSourceFamilyIdentityV1;
  readonly slots: readonly WeiboSlotMappingRowV1[];
  readonly retainedNodes: readonly WeiboRetainedNodeV1[];
  readonly independentGoldRelations: readonly WeiboIndependentGoldRelationV1[];
  readonly candidatePairAnnotations: readonly WeiboCandidatePairAnnotationV1[];
}

export interface WeiboCandidatePairV1 {
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly matchedByConditionA: boolean;
  readonly matchedByConditionB: boolean;
  readonly effectiveTreeHopsUtoV: number | null;
  readonly effectiveLcaHops: number | null;
  readonly verticalCenterDistancePx: number | null;
}

export interface WeiboCandidatePairGenerationResultV1 {
  readonly candidatePairs: readonly WeiboCandidatePairV1[];
  readonly unassessedGeometryCandidatePairs: readonly (readonly [string, string])[];
  readonly truncatedHopCandidatePairs: readonly (readonly [string, string])[];
  readonly pairGenerationBoundaryStatus: PairGenerationBoundaryStatus;
}

export interface WeiboRolePredictionV1 {
  readonly nodeRef: string;
  readonly roleStatus: WeiboJudgmentStatus;
  readonly predRole: WeiboNodeRole | null;
  readonly topScore: number;
  readonly margin: number;
  readonly probabilities: Readonly<Record<WeiboNodeRole, number>>;
  readonly logits: Readonly<Record<WeiboNodeRole, number>>;
}

export interface WeiboRelationPredictionV1 {
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly relationStatus: WeiboJudgmentStatus;
  readonly predRelation: WeiboPairRelation | null;
  readonly topScore: number;
  readonly margin: number;
  readonly probabilities: Readonly<Record<WeiboPairRelation, number>>;
  readonly logits: Readonly<Record<WeiboPairRelation, number>>;
  readonly actionableWrapperRef: string | null;
}

export interface WeiboLinearPolicyProfileV1<THead extends string, TWire extends string> {
  readonly profileId: string;
  readonly version: "w0a.v1";
  readonly heads: readonly THead[];
  readonly wires: readonly TWire[];
  readonly parameterCount: number;
  readonly minScore: number;
  readonly minMargin: number;
  readonly calibration: "uncalibrated";
  readonly adoption: "not_applied";
  readonly runKind: "formal_weibo_training" | "synthetic_engineering_smoke_only";
  readonly formalBenchmarkEligible: boolean;
  readonly weights: readonly (readonly number[])[];
}

export type WeiboRolePolicyProfileV1 = WeiboLinearPolicyProfileV1<WeiboNodeRole, WeiboRoleWireName>;
export type WeiboRelationPolicyProfileV1 = WeiboLinearPolicyProfileV1<WeiboPairRelation, WeiboRelationWireName>;

export interface WeiboUnitHeadTimingV1 {
  readonly featureExtractionMs: number;
  readonly circuitBuildMs: number;
  readonly forwardTotalMs: number;
  readonly lossTotalMs: number;
  readonly backwardTotalMs: number;
  readonly parameterUpdateTotalMs: number;
  readonly perEpochMeanMs: number;
  readonly weightSerializeMs: number;
  readonly subprocessReloadMs: number;
  readonly trainEvalMs: number;
  readonly devEvalMs: number;
  readonly totalWallMs: number;
}
