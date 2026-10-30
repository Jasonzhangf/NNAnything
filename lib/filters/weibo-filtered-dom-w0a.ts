import type { Rect } from "../adapters/browser/observation.js";
import type { ExplorationInputV1 } from "../adapters/browser/exploration-input.js";
import type { BasicKindMeasurements, BasicKindLabel, BasicKindStatus } from "./basic-kinds.js";
import {
  WEIBO_W0A_ROLE_HEADS,
  WEIBO_W0A_RELATION_HEADS,
  WEIBO_W0A_ROLE_WIRES,
  WEIBO_W0A_RELATION_WIRES,
  type WeiboNodeRole,
  type WeiboPairRelation,
  type WeiboRoleWireName,
  type WeiboRelationWireName,
  type WeiboNodeEvidenceSidecarV1,
  type WeiboSlotMappingRowV1,
  type WeiboRetainedNodeV1,
  type WeiboCandidatePairV1,
  type WeiboCandidatePairGenerationResultV1,
  type PairGenerationBoundaryStatus,
  type WeiboRolePredictionV1,
  type WeiboRelationPredictionV1,
  type WeiboRolePolicyProfileV1,
  type WeiboRelationPolicyProfileV1,
} from "./weibo-filtered-dom-contract.js";

export const DATETIME_REGEX =
  /^(?:\d+\s*(?:秒|分钟|小时|天)前|刚刚|今天\s*\d{1,2}:\d{2}|昨天\s*\d{1,2}:\d{2}|(?:\d{4}[-年])?\d{1,2}[-月]\d{1,2}日?(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?)$/u;

export const EXPAND_CUE_REGEX = /^(\.\.\.)?(?:展开|展开全文|全文)$/u;

export const L1_LEAF_ORDER = Object.freeze([
  "button",
  "input",
  "select",
  "image",
  "video",
  "audio",
  "link",
  "text",
  "container",
  "list",
  "listitem",
  "ignore",
] as const);

export interface WeiboResolvedNodeV1 {
  readonly nodeRef: string;
  readonly slotIndex: number;
  readonly rawParentRef: string | null;
  readonly effectiveRetainedAncestorRef: string | null;
  readonly bridgedIntermediateNodeRefs: readonly string[];
  readonly collapsedWrapperHopCount: number;
  readonly judgmentStatus: BasicKindStatus;
  readonly basicKind: BasicKindLabel | null;
  readonly l1Wires16: Readonly<Record<string, number>>;
  readonly tag: string | null;
  readonly role: string | null;
  readonly rect: Rect | null;
  readonly parentRect: Rect | null;
  readonly positiveArea: boolean | null;
  readonly itemObservation: { readonly nodeRef: string } & BasicKindMeasurements;
  readonly explorationInput: ExplorationInputV1;
  readonly sidecar: WeiboNodeEvidenceSidecarV1;
}

function isPositiveRect(rect: Rect | null | undefined): rect is Rect {
  return (
    rect !== null &&
    rect !== undefined &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function rectArea(rect: Rect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function intersectionArea(a: Rect, b: Rect): number {
  const xOverlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const yOverlap = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return xOverlap * yOverlap;
}

export function buildL1Wires16(judgment: {
  readonly judgmentStatus: BasicKindStatus | null | undefined;
  readonly basicKind: BasicKindLabel | null | undefined;
}): Readonly<Record<string, number>> {
  const wires: Record<string, number> = {
    w01_l1_judged_mask: 0,
    w02_l1_kind_button: 0,
    w03_l1_kind_input: 0,
    w04_l1_kind_select: 0,
    w05_l1_kind_image: 0,
    w06_l1_kind_video: 0,
    w07_l1_kind_audio: 0,
    w08_l1_kind_link: 0,
    w09_l1_kind_text: 0,
    w10_l1_kind_container: 0,
    w11_l1_kind_list: 0,
    w12_l1_kind_listitem: 0,
    w13_l1_kind_ignore: 0,
    w14_l1_kind_other: 0,
    w15_l1_status_unknown: 0,
    w16_l1_status_conflict: 0,
  };
  const status = judgment.judgmentStatus ?? null;
  const kind = judgment.basicKind ?? null;
  if (status === "judged") {
    wires.w01_l1_judged_mask = 1;
    if (kind === "other") {
      wires.w14_l1_kind_other = 1;
    } else if (kind !== null) {
      const idx = (L1_LEAF_ORDER as readonly string[]).indexOf(kind);
      if (idx >= 0) {
        const key = `w${String(idx + 2).padStart(2, "0")}_l1_kind_${kind}`;
        wires[key] = 1;
      }
    }
  } else if (status === "unknown") {
    wires.w15_l1_status_unknown = 1;
  } else if (status === "conflict") {
    wires.w16_l1_status_conflict = 1;
  }
  return Object.freeze(wires);
}

export function resolveRetainedNodesMap(input: {
  readonly slots?: readonly WeiboSlotMappingRowV1[];
  readonly retainedNodes: readonly WeiboRetainedNodeV1[];
}): ReadonlyMap<string, WeiboResolvedNodeV1> {
  const slotByRef = new Map<string, WeiboSlotMappingRowV1>();
  if (input.slots) {
    for (const s of input.slots) slotByRef.set(s.nodeRef, s);
  }
  const map = new Map<string, WeiboResolvedNodeV1>();
  for (const r of input.retainedNodes) {
    const slot = slotByRef.get(r.nodeRef);
    const observationNode = r.observationNode ?? slot?.observationNode;
    const itemObservation = r.itemObservation ?? slot?.itemObservation;
    const explorationInput = r.explorationInput ?? slot?.explorationInput;
    if (!observationNode || !itemObservation || !explorationInput) {
      throw new Error(`Retained node ${r.nodeRef} is missing observationNode, itemObservation, or explorationInput`);
    }
    const sidecar: WeiboNodeEvidenceSidecarV1 = r.sidecar ?? slot?.sidecar ?? {
      observedDirectText: null,
      observedPathname: null,
    };
    const rect = explorationInput.geometry.rect;
    const positiveArea = rect === null ? null : rect.width > 0 && rect.height > 0;
    const l1Wires16 = r.l1Wires16 ?? buildL1Wires16({ judgmentStatus: r.judgmentStatus, basicKind: r.basicKind });
    map.set(r.nodeRef, {
      nodeRef: r.nodeRef,
      slotIndex: r.slotIndex,
      rawParentRef: r.rawParentRef,
      effectiveRetainedAncestorRef: r.effectiveRetainedAncestorRef,
      bridgedIntermediateNodeRefs: r.bridgedIntermediateNodeRefs,
      collapsedWrapperHopCount: r.collapsedWrapperHopCount,
      judgmentStatus: r.judgmentStatus,
      basicKind: r.basicKind,
      l1Wires16,
      tag: observationNode.tag,
      role: observationNode.role,
      rect,
      parentRect: explorationInput.geometry.parentRect,
      positiveArea,
      itemObservation,
      explorationInput,
      sidecar,
    });
  }
  return map;
}

interface CachedAncestorInfo {
  readonly ancestors: readonly { readonly ref: string; readonly hops: number; readonly node: WeiboResolvedNodeV1 }[];
  readonly ancestorSet: ReadonlySet<string>;
  readonly completeToRoot: boolean;
  readonly truncatedByHops: boolean;
}

const fullAncestorCache = new WeakMap<
  ReadonlyMap<string, WeiboResolvedNodeV1>,
  Map<string, CachedAncestorInfo>
>();

function getCachedFullAncestors(
  node: WeiboResolvedNodeV1,
  byRef: ReadonlyMap<string, WeiboResolvedNodeV1>,
): CachedAncestorInfo {
  let mapForByRef = fullAncestorCache.get(byRef);
  if (!mapForByRef) {
    mapForByRef = new Map<string, CachedAncestorInfo>();
    fullAncestorCache.set(byRef, mapForByRef);
  }
  const existing = mapForByRef.get(node.nodeRef);
  if (existing) return existing;

  const ancestors: { readonly ref: string; readonly hops: number; readonly node: WeiboResolvedNodeV1 }[] = [];
  const ancestorSet = new Set<string>();
  const seen = new Set<string>([node.nodeRef]);
  let cursor: WeiboResolvedNodeV1 = node;
  let hops = 0;
  let truncatedByHops = false;
  let missingParent = false;
  while (cursor.effectiveRetainedAncestorRef !== null) {
    if (hops >= 64) {
      truncatedByHops = true;
      break;
    }
    const nextRef = cursor.effectiveRetainedAncestorRef;
    if (seen.has(nextRef)) {
      throw new Error(`Cycle in effectiveRetainedAncestorRef at ${nextRef}`);
    }
    seen.add(nextRef);
    const parentNode = byRef.get(nextRef);
    if (!parentNode) {
      missingParent = true;
      break;
    }
    hops += 1;
    ancestors.push({ ref: nextRef, hops, node: parentNode });
    ancestorSet.add(nextRef);
    cursor = parentNode;
  }
  const rootParentStatus = cursor.explorationInput.containment.parentStatus;
  const completeToRoot =
    !truncatedByHops &&
    !missingParent &&
    rootParentStatus === "root" &&
    node.explorationInput.containment.parentStatus !== "missing_parent_observation" &&
    node.explorationInput.containment.parentStatus !== "unknown" &&
    node.explorationInput.containment.ancestorBoundary !== "incomplete_observation" &&
    node.explorationInput.containment.ancestorBoundary !== "unknown";
  const result: CachedAncestorInfo = {
    ancestors,
    ancestorSet,
    completeToRoot,
    truncatedByHops,
  };
  mapForByRef.set(node.nodeRef, result);
  return result;
}

// Compute effective retained ancestor chain: returns list of { ancestorRef, hops }
function getEffectiveAncestors(
  node: WeiboResolvedNodeV1,
  byRef: ReadonlyMap<string, WeiboResolvedNodeV1>,
  maxHops = 64,
): {
  readonly ancestors: readonly { readonly ref: string; readonly hops: number; readonly node: WeiboResolvedNodeV1 }[];
  readonly completeToRoot: boolean;
  readonly truncatedByHops: boolean;
} {
  const full = getCachedFullAncestors(node, byRef);
  if (maxHops >= 64 || full.ancestors.length <= maxHops) {
    return full;
  }
  return {
    ancestors: full.ancestors.slice(0, maxHops),
    completeToRoot: false,
    truncatedByHops: true,
  };
}

function isRepeatingItemCandidate(
  candidate: WeiboResolvedNodeV1,
  byRef: ReadonlyMap<string, WeiboResolvedNodeV1>,
): boolean {
  if (candidate.tag === "article" || candidate.role === "article") return true;
  const parentRef = candidate.effectiveRetainedAncestorRef ?? candidate.rawParentRef;
  if (parentRef === null) return false;
  const parent = byRef.get(parentRef);
  if (!parent) return false;
  const ratio = parent.itemObservation.shallowStructuralPeerRatio;
  return typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0.5;
}

export function extractWeiboRoleWires36(
  nodeRef: string,
  byRef: ReadonlyMap<string, WeiboResolvedNodeV1>,
  allSlotsByRef?: ReadonlyMap<string, WeiboSlotMappingRowV1>,
): Readonly<Record<WeiboRoleWireName, number>> {
  const node = byRef.get(nodeRef);
  if (!node) throw new Error(`Unknown retained nodeRef ${nodeRef}`);

  const out: Record<WeiboRoleWireName, number> = {
    w00_bias_one: 1,
    w01_l1_judged_mask: node.l1Wires16.w01_l1_judged_mask ?? 0,
    w02_l1_kind_button: node.l1Wires16.w02_l1_kind_button ?? 0,
    w03_l1_kind_input: node.l1Wires16.w03_l1_kind_input ?? 0,
    w04_l1_kind_select: node.l1Wires16.w04_l1_kind_select ?? 0,
    w05_l1_kind_image: node.l1Wires16.w05_l1_kind_image ?? 0,
    w06_l1_kind_video: node.l1Wires16.w06_l1_kind_video ?? 0,
    w07_l1_kind_audio: node.l1Wires16.w07_l1_kind_audio ?? 0,
    w08_l1_kind_link: node.l1Wires16.w08_l1_kind_link ?? 0,
    w09_l1_kind_text: node.l1Wires16.w09_l1_kind_text ?? 0,
    w10_l1_kind_container: node.l1Wires16.w10_l1_kind_container ?? 0,
    w11_l1_kind_list: node.l1Wires16.w11_l1_kind_list ?? 0,
    w12_l1_kind_listitem: node.l1Wires16.w12_l1_kind_listitem ?? 0,
    w13_l1_kind_ignore: 0, // Folded out of active retained nodes per Section 2.1(2)
    w14_l1_kind_other: node.l1Wires16.w14_l1_kind_other ?? 0,
    w15_l1_status_unknown: node.l1Wires16.w15_l1_status_unknown ?? 0,
    w16_l1_status_conflict: node.l1Wires16.w16_l1_status_conflict ?? 0,
    w17_peer_ratio_known: 0,
    w18_has_repeating_structural_children: 0,
    w19_in_repeating_peer_parent: 0,
    w20_ancestor_and_subcontainer_text_known: 0,
    w21_hop_to_nearest_repeating_item_1_to_2: 0,
    w22_hop_to_nearest_repeating_item_3_to_4: 0,
    w23_inside_second_level_nested_subcontainer: 0,
    w24_rel_geom_in_container_known: 0,
    w25_in_container_top_quarter: 0,
    w26_in_container_bottom_fifth: 0,
    w27_width_spans_most_of_container: 0,
    w28_compact_inline_control_shape: 0,
    w29_text_string_known: 0,
    w30_text_len_short_1_to_16: 0,
    w31_text_len_long_ge_24: 0,
    w32_text_matches_datetime_regex: 0,
    w33_text_matches_expand_cue: 0,
    w34_href_url_parsed_known: 0,
    w35_has_multi_segment_http_href: 0,
  };

  // w17..w19: peer ratio known mask
  const parentRef = node.effectiveRetainedAncestorRef ?? node.rawParentRef;
  const parentNode = parentRef !== null ? byRef.get(parentRef) : undefined;
  const selfPeerRatio = node.itemObservation.shallowStructuralPeerRatio ?? null;
  const parentPeerRatio = parentNode ? (parentNode.itemObservation.shallowStructuralPeerRatio ?? null) : null;
  const selfPosChildCount = node.itemObservation.positiveAreaChildCount ?? null;

  if (
    selfPeerRatio !== null &&
    selfPosChildCount !== null &&
    (parentRef === null || parentPeerRatio !== null)
  ) {
    out.w17_peer_ratio_known = 1;
    out.w18_has_repeating_structural_children =
      selfPeerRatio >= 0.5 && selfPosChildCount >= 2 ? 1 : 0;
    out.w19_in_repeating_peer_parent =
      parentPeerRatio !== null && parentPeerRatio >= 0.5 ? 1 : 0;
  }

  // w20..w23: ancestor chain (1..4 hops) & second-level nested subcontainer with child text strings
  const { ancestors } = getEffectiveAncestors(node, byRef, 4);
  const ancestorBoundary = node.explorationInput.containment.ancestorBoundary;
  const boundaryOk =
    ancestorBoundary === "complete" || ancestorBoundary === "hop_limit_reached";

  const repeatingAncestorEntry = ancestors.find(
    (entry) => entry.hops <= 4 && isRepeatingItemCandidate(entry.node, byRef),
  );
  const pathToCheck = repeatingAncestorEntry
    ? ancestors.filter((entry) => entry.hops <= repeatingAncestorEntry.hops)
    : ancestors.filter((entry) => entry.hops <= 4);

  // Per Section 3.1(2): w20 requires at least 1 observed ancestor on the 1..4 hop path
  // AND every node on the path to have measured peerRatio, tag, rect, positiveArea, childElementCount, and directChildrenStatus === "complete"
  let w20Known = boundaryOk && pathToCheck.length > 0;
  if (w20Known) {
    for (const entry of pathToCheck) {
      const a = entry.node;
      if (
        (a.itemObservation.shallowStructuralPeerRatio ?? null) === null ||
        a.tag === null ||
        a.rect === null ||
        a.positiveArea === null ||
        (a.itemObservation.childElementCount ?? null) === null ||
        a.explorationInput.childComposition.directChildrenStatus !== "complete"
      ) {
        w20Known = false;
        break;
      }
    }
  }

  // Check intermediate subcontainers B (1 <= hops(u, B) < h_1) direct children for hrefPresent, directTextPresent, and observedDirectText
  const intermediateEntries = repeatingAncestorEntry
    ? ancestors.filter((entry) => entry.hops >= 1 && entry.hops < repeatingAncestorEntry.hops)
    : [];

  if (w20Known && repeatingAncestorEntry) {
    for (const entry of intermediateEntries) {
      const b = entry.node;
      const childRefs = b.explorationInput.containment.childRefs;
      for (const cRef of childRefs) {
        const cResolved = byRef.get(cRef);
        const cSlot = allSlotsByRef?.get(cRef);
        const cItem = cResolved?.itemObservation ?? cSlot?.itemObservation;
        const cExp = cResolved?.explorationInput ?? cSlot?.explorationInput;
        const cSidecar = cResolved?.sidecar ?? cSlot?.sidecar;
        if (!cItem || !cExp) {
          w20Known = false;
          break;
        }
        if (
          cExp.measurementCoverage.hrefPresent !== "measured" ||
          cExp.measurementCoverage.directTextPresent !== "measured" ||
          typeof cItem.hrefPresent !== "boolean" ||
          typeof cItem.directTextPresent !== "boolean"
        ) {
          w20Known = false;
          break;
        }
        if (
          cItem.directTextPresent === true &&
          typeof cSidecar?.observedDirectText !== "string"
        ) {
          w20Known = false;
          break;
        }
      }
      if (!w20Known) break;
    }
  }

  if (w20Known) {
    out.w20_ancestor_and_subcontainer_text_known = 1;
    if (repeatingAncestorEntry) {
      const h1 = repeatingAncestorEntry.hops;
      out.w21_hop_to_nearest_repeating_item_1_to_2 = h1 === 1 || h1 === 2 ? 1 : 0;
      out.w22_hop_to_nearest_repeating_item_3_to_4 = h1 === 3 || h1 === 4 ? 1 : 0;
      const a1Rect = repeatingAncestorEntry.node.rect;
      const a1Area = a1Rect ? rectArea(a1Rect) : 0;
      if (a1Area > 0) {
        for (const entry of intermediateEntries) {
          const b = entry.node;
          if (!b.positiveArea || !b.rect) continue;
          const ratio = rectArea(b.rect) / a1Area;
          const bChildCount = b.itemObservation.childElementCount ?? 0;
          if (ratio < 0.15 || ratio > 0.85 || bChildCount < 2) continue;
          let hasShortOrLink = false;
          let hasLongText = false;
          for (const cRef of b.explorationInput.containment.childRefs) {
            const cResolved = byRef.get(cRef);
            const cSlot = allSlotsByRef?.get(cRef);
            const cItem = cResolved?.itemObservation ?? cSlot?.itemObservation;
            const cSidecar = cResolved?.sidecar ?? cSlot?.sidecar;
            if (!cItem) continue;
            const textLen =
              cItem.directTextPresent === true && typeof cSidecar?.observedDirectText === "string"
                ? cSidecar.observedDirectText.trim().length
                : 0;
            if (cItem.hrefPresent === true || (textLen >= 1 && textLen <= 16)) {
              hasShortOrLink = true;
            }
            if (textLen >= 24) {
              hasLongText = true;
            }
          }
          if (hasShortOrLink && hasLongText) {
            out.w23_inside_second_level_nested_subcontainer = 1;
            break;
          }
        }
      }
    }
  }

  // w24..w28: relative geometry in container A_1 or parentRect
  const refRect =
    repeatingAncestorEntry && isPositiveRect(repeatingAncestorEntry.node.rect)
      ? repeatingAncestorEntry.node.rect
      : isPositiveRect(node.parentRect)
        ? node.parentRect
        : null;
  if (isPositiveRect(node.rect) && isPositiveRect(refRect)) {
    out.w24_rel_geom_in_container_known = 1;
    const relCenterY = (node.rect.y + node.rect.height / 2 - refRect.y) / refRect.height;
    const widthRatio = node.rect.width / refRect.width;
    const heightRatio = node.rect.height / refRect.height;
    out.w25_in_container_top_quarter = relCenterY <= 0.25 ? 1 : 0;
    out.w26_in_container_bottom_fifth = relCenterY >= 0.8 ? 1 : 0;
    out.w27_width_spans_most_of_container = widthRatio >= 0.65 ? 1 : 0;
    out.w28_compact_inline_control_shape = widthRatio <= 0.25 && heightRatio <= 0.18 ? 1 : 0;
  }

  // w29..w33: direct text string known mask and lexical cues
  const textCoverage = node.explorationInput.measurementCoverage.directTextPresent;
  const directTextPresent = node.itemObservation.directTextPresent ?? null;
  const observedText = node.sidecar.observedDirectText;
  if (
    textCoverage === "measured" &&
    (directTextPresent === false ||
      (directTextPresent === true && typeof observedText === "string"))
  ) {
    out.w29_text_string_known = 1;
    if (directTextPresent === true && typeof observedText === "string") {
      const trimmed = observedText.trim();
      const len = trimmed.length;
      out.w30_text_len_short_1_to_16 = len >= 1 && len <= 16 ? 1 : 0;
      out.w31_text_len_long_ge_24 = len >= 24 ? 1 : 0;
      out.w32_text_matches_datetime_regex = DATETIME_REGEX.test(trimmed) ? 1 : 0;
      out.w33_text_matches_expand_cue = len <= 6 && EXPAND_CUE_REGEX.test(trimmed) ? 1 : 0;
    }
  }

  // w34..w35: href URL parsed known mask
  const hrefCoverage = node.explorationInput.measurementCoverage.hrefPresent;
  const hrefPresent = node.itemObservation.hrefPresent ?? null;
  const observedPathname = node.sidecar.observedPathname;
  if (
    hrefCoverage === "measured" &&
    (hrefPresent === false ||
      (hrefPresent === true &&
        typeof observedPathname === "string" &&
        observedPathname.startsWith("/")))
  ) {
    out.w34_href_url_parsed_known = 1;
    if (hrefPresent === true && typeof observedPathname === "string") {
      const segments = observedPathname.split("/").filter(Boolean);
      out.w35_has_multi_segment_http_href = segments.length >= 2 ? 1 : 0;
    }
  }

  return Object.freeze(out);
}

function isContainerLikeForConditionA(node: WeiboResolvedNodeV1): boolean {
  if (node.judgmentStatus === "unknown" || node.judgmentStatus === "conflict") return true;
  return (
    node.basicKind === "container" ||
    node.basicKind === "list" ||
    node.basicKind === "listitem" ||
    node.basicKind === "other"
  );
}

export function generateWeiboCandidatePairs(
  byRef: ReadonlyMap<string, WeiboResolvedNodeV1>,
): WeiboCandidatePairGenerationResultV1 {
  const nodes = [...byRef.values()].sort((a, b) => a.slotIndex - b.slotIndex);
  const ancestorInfoByRef = new Map<
    string,
    ReturnType<typeof getEffectiveAncestors>
  >();
  let anyIncompleteAncestry = false;
  let anyTruncatedByHops = false;

  for (const node of nodes) {
    const info = getEffectiveAncestors(node, byRef, 64);
    ancestorInfoByRef.set(node.nodeRef, info);
    const parentStatus = node.explorationInput.containment.parentStatus;
    if (
      parentStatus === "missing_parent_observation" ||
      parentStatus === "unknown" ||
      !info.completeToRoot
    ) {
      anyIncompleteAncestry = true;
    }
    if (info.truncatedByHops) {
      anyTruncatedByHops = true;
    }
  }

  const candidatePairs: WeiboCandidatePairV1[] = [];
  const unassessedGeometryCandidatePairs: [string, string][] = [];
  const truncatedHopCandidatePairs: [string, string][] = [];

  for (const u of nodes) {
    const uAnc = ancestorInfoByRef.get(u.nodeRef)!;
    const uAncMap = new Map<string, number>();
    uAncMap.set(u.nodeRef, 0);
    for (const entry of uAnc.ancestors) {
      uAncMap.set(entry.ref, entry.hops);
    }

    for (const v of nodes) {
      if (u.nodeRef === v.nodeRef) continue;
      const vAnc = ancestorInfoByRef.get(v.nodeRef)!;

      // Check if v is an effective ancestor of u
      const hopsUtoV = uAncMap.get(v.nodeRef) ?? null;
      const vIsAncestorOfU = hopsUtoV !== null && hopsUtoV >= 1;
      let matchedA = false;
      if (vIsAncestorOfU && isContainerLikeForConditionA(v)) {
        if (hopsUtoV >= 1 && hopsUtoV <= 6) {
          matchedA = true;
        } else if (hopsUtoV > 6) {
          truncatedHopCandidatePairs.push([u.nodeRef, v.nodeRef]);
          anyTruncatedByHops = true;
        }
      }

      // Check LCA hops between u and v
      let lcaHops: number | null = null;
      const vAncMap = new Map<string, number>();
      vAncMap.set(v.nodeRef, 0);
      for (const entry of vAnc.ancestors) {
        vAncMap.set(entry.ref, entry.hops);
      }

      // Exclude strict ancestor/descendant from Condition B LCA pairing if u is ancestor of v or v is ancestor of u?
      // Wait: Section 3.2(0) says:
      // Condition B: u and v do not satisfy Condition A, but share an effective LCA with hops(u, LCA) <= 4 and hops(v, LCA) <= 4, and |Delta y| <= 600px.
      for (const [ancRef, hopsFromU] of uAncMap.entries()) {
        if (hopsFromU > 4) continue;
        const hopsFromV = vAncMap.get(ancRef);
        if (hopsFromV !== undefined && hopsFromV <= 4) {
          const maxHops = Math.max(hopsFromU, hopsFromV);
          if (lcaHops === null || maxHops < lcaHops) {
            lcaHops = maxHops;
          }
        }
      }

      let matchedB = false;
      let verticalDist: number | null = null;
      if (!matchedA && lcaHops !== null && lcaHops <= 4) {
        if (u.rect === null || v.rect === null) {
          unassessedGeometryCandidatePairs.push([u.nodeRef, v.nodeRef]);
        } else {
          verticalDist = Math.abs(
            u.rect.y + u.rect.height / 2 - (v.rect.y + v.rect.height / 2),
          );
          if (verticalDist <= 600) {
            matchedB = true;
          }
        }
      } else if (matchedA && u.rect !== null && v.rect !== null) {
        verticalDist = Math.abs(
          u.rect.y + u.rect.height / 2 - (v.rect.y + v.rect.height / 2),
        );
      }

      if (matchedA || matchedB) {
        candidatePairs.push({
          sourceRef: u.nodeRef,
          targetRef: v.nodeRef,
          matchedByConditionA: matchedA,
          matchedByConditionB: matchedB,
          effectiveTreeHopsUtoV: vIsAncestorOfU ? hopsUtoV : null,
          effectiveLcaHops: lcaHops,
          verticalCenterDistancePx: verticalDist,
        });
      }
    }
  }

  let pairGenerationBoundaryStatus: PairGenerationBoundaryStatus = "complete";
  if (anyIncompleteAncestry || unassessedGeometryCandidatePairs.length > 0) {
    pairGenerationBoundaryStatus = "incomplete_observation";
  } else if (anyTruncatedByHops) {
    pairGenerationBoundaryStatus = "truncated_by_hop_limit";
  }

  return {
    candidatePairs,
    unassessedGeometryCandidatePairs,
    truncatedHopCandidatePairs,
    pairGenerationBoundaryStatus,
  };
}

function isPostLikeRole(role: WeiboNodeRole | null): boolean {
  return role === "post_root" || role === "reposted_embedded_post";
}

function isSubtreeDescendant(
  candidate: WeiboResolvedNodeV1,
  ancestorRef: string,
  byRef: ReadonlyMap<string, WeiboResolvedNodeV1>,
): boolean {
  return getCachedFullAncestors(candidate, byRef).ancestorSet.has(ancestorRef);
}

export function extractWeiboRelationWires32(
  pair: { readonly sourceRef: string; readonly targetRef: string },
  byRef: ReadonlyMap<string, WeiboResolvedNodeV1>,
  rolePredictionsByRef: ReadonlyMap<string, WeiboRolePredictionV1>,
): Readonly<Record<WeiboRelationWireName, number>> {
  const u = byRef.get(pair.sourceRef);
  const v = byRef.get(pair.targetRef);
  if (!u || !v) {
    throw new Error(`Unknown candidate pair endpoints (${pair.sourceRef}, ${pair.targetRef})`);
  }
  const predU = rolePredictionsByRef.get(u.nodeRef);
  const predV = rolePredictionsByRef.get(v.nodeRef);
  if (!predU || !predV) {
    throw new Error(`Missing role predictions for (${u.nodeRef}, ${v.nodeRef})`);
  }

  const out: Record<WeiboRelationWireName, number> = {
    w00_bias_one: 1,
    w01_endpoint_roles_and_link_props_known_mask: 0,
    w02_pred_u_author_v_post: 0,
    w03_pred_u_body_v_post: 0,
    w04_pred_u_time_v_post: 0,
    w05_pred_u_media_v_post: 0,
    w06_pred_u_link_v_post: 0,
    w07_pred_u_repost_v_post_root: 0,
    w08_pred_u_expand_v_body: 0,
    w09_pred_u_submit_v_search_input: 0,
    w10_pred_u_or_v_auxiliary_decor: 0,
    w11_endpoint_role_or_link_prop_unknown: 0,
    w12_tree_path_known: 0,
    w13_v_is_ancestor_of_u_hops_1_to_2: 0,
    w14_v_is_ancestor_of_u_hops_3_to_4: 0,
    w15_v_is_ancestor_of_u_hops_5_to_6: 0,
    w16_u_and_v_share_parent_or_lca_le_2: 0,
    w17_intervening_path_roles_all_judged_mask: 0,
    w18_intervening_predicted_repost_on_path: 0,
    w19_intervening_predicted_post_root_on_path: 0,
    w20_intervening_path_role_unknown_or_conflict: 0,
    w21_pair_geom_known: 0,
    w22_contained_subbox_geom_and_roles_known_mask: 0,
    w23_u_bbox_contained_in_v_bbox: 0,
    w24_u_inside_predicted_repost_bbox_within_v: 0,
    w25_u_in_top_header_zone_of_v: 0,
    w26_u_in_middle_content_zone_of_v: 0,
    w27_u_inline_or_immediately_after_v: 0,
    w28_u_and_v_same_row_adjacent: 0,
    w29_vertical_gap_le_48px: 0,
    w30_vertical_gap_gt_240px: 0,
    w31_horizontal_overlap_ge_0_5_and_u_smaller: 0,
  };

  // w01..w11: endpoint roles and link boolean measurements (Section 3.2(2) r6.1)
  const rolesJudged =
    predU.roleStatus === "judged" &&
    predU.predRole !== null &&
    predV.roleStatus === "judged" &&
    predV.predRole !== null;
  const linkPropsMeasured =
    u.explorationInput.measurementCoverage.hrefPresent === "measured" &&
    u.explorationInput.measurementCoverage.directTextPresent === "measured" &&
    typeof u.itemObservation.hrefPresent === "boolean" &&
    typeof u.itemObservation.directTextPresent === "boolean";

  const w01 = rolesJudged && linkPropsMeasured ? 1 : 0;
  out.w01_endpoint_roles_and_link_props_known_mask = w01;
  out.w11_endpoint_role_or_link_prop_unknown = w01 === 0 ? 1 : 0;

  if (rolesJudged) {
    const roleU = predU.predRole!;
    const roleV = predV.predRole!;
    const vPostLike = isPostLikeRole(roleV);
    out.w02_pred_u_author_v_post = roleU === "author_anchor" && vPostLike ? 1 : 0;
    out.w03_pred_u_body_v_post = roleU === "post_body" && vPostLike ? 1 : 0;
    out.w04_pred_u_time_v_post = roleU === "timestamp_or_detail_anchor" && vPostLike ? 1 : 0;
    out.w05_pred_u_media_v_post = roleU === "media_item" && vPostLike ? 1 : 0;
    out.w07_pred_u_repost_v_post_root =
      roleU === "reposted_embedded_post" && roleV === "post_root" ? 1 : 0;
    out.w08_pred_u_expand_v_body =
      roleU === "expand_body_toggle" && roleV === "post_body" ? 1 : 0;
    out.w09_pred_u_submit_v_search_input =
      roleU === "search_submit" && roleV === "search_input" ? 1 : 0;
    out.w10_pred_u_or_v_auxiliary_decor =
      roleU === "auxiliary_or_decor" || roleV === "auxiliary_or_decor" ? 1 : 0;

    if (w01 === 1) {
      out.w06_pred_u_link_v_post =
        u.itemObservation.hrefPresent === true &&
        u.itemObservation.directTextPresent === true &&
        roleU !== "author_anchor" &&
        roleU !== "timestamp_or_detail_anchor" &&
        roleU !== "auxiliary_or_decor" &&
        vPostLike
          ? 1
          : 0;
    }
  }

  // w12..w20: tree path & intervening container role masks
  const uAnc = getEffectiveAncestors(u, byRef, 16);
  const vAnc = getEffectiveAncestors(v, byRef, 16);
  const treePathKnown = uAnc.completeToRoot && vAnc.completeToRoot;
  if (treePathKnown) {
    out.w12_tree_path_known = 1;
    const uAncIdx = uAnc.ancestors.findIndex((entry) => entry.ref === v.nodeRef);
    const vAncIdx = vAnc.ancestors.findIndex((entry) => entry.ref === u.nodeRef);
    let interveningRefs: string[] = [];

    if (uAncIdx >= 0) {
      const hops = uAnc.ancestors[uAncIdx]!.hops;
      out.w13_v_is_ancestor_of_u_hops_1_to_2 = hops >= 1 && hops <= 2 ? 1 : 0;
      out.w14_v_is_ancestor_of_u_hops_3_to_4 = hops >= 3 && hops <= 4 ? 1 : 0;
      out.w15_v_is_ancestor_of_u_hops_5_to_6 = hops >= 5 && hops <= 6 ? 1 : 0;
      if (hops <= 2) out.w16_u_and_v_share_parent_or_lca_le_2 = 1;
      interveningRefs = uAnc.ancestors.slice(0, uAncIdx).map((e) => e.ref);
    } else if (vAncIdx >= 0) {
      const hops = vAnc.ancestors[vAncIdx]!.hops;
      if (hops <= 2) out.w16_u_and_v_share_parent_or_lca_le_2 = 1;
      interveningRefs = vAnc.ancestors.slice(0, vAncIdx).map((e) => e.ref);
    } else {
      // Find LCA
      const vMap = new Map<string, number>();
      for (let i = 0; i < vAnc.ancestors.length; i += 1) {
        vMap.set(vAnc.ancestors[i]!.ref, i);
      }
      let lcaUIdx = -1;
      let lcaVIdx = -1;
      for (let i = 0; i < uAnc.ancestors.length; i += 1) {
        const ref = uAnc.ancestors[i]!.ref;
        const j = vMap.get(ref);
        if (j !== undefined) {
          lcaUIdx = i;
          lcaVIdx = j;
          break;
        }
      }
      if (lcaUIdx >= 0 && lcaVIdx >= 0) {
        const hopsU = uAnc.ancestors[lcaUIdx]!.hops;
        const hopsV = vAnc.ancestors[lcaVIdx]!.hops;
        if (Math.max(hopsU, hopsV) <= 2) {
          out.w16_u_and_v_share_parent_or_lca_le_2 = 1;
        }
        interveningRefs = [
          ...uAnc.ancestors.slice(0, lcaUIdx).map((e) => e.ref),
          uAnc.ancestors[lcaUIdx]!.ref,
          ...vAnc.ancestors.slice(0, lcaVIdx).map((e) => e.ref),
        ];
      }
    }

    let allInterveningJudged = true;
    let hasRepostOnPath = false;
    let hasPostRootOnPath = false;
    for (const wRef of interveningRefs) {
      const predW = rolePredictionsByRef.get(wRef);
      if (!predW || predW.roleStatus !== "judged" || predW.predRole === null) {
        allInterveningJudged = false;
        break;
      }
      if (predW.predRole === "reposted_embedded_post") hasRepostOnPath = true;
      if (predW.predRole === "post_root") hasPostRootOnPath = true;
    }

    if (allInterveningJudged) {
      out.w17_intervening_path_roles_all_judged_mask = 1;
      out.w18_intervening_predicted_repost_on_path = hasRepostOnPath ? 1 : 0;
      out.w19_intervening_predicted_post_root_on_path = hasPostRootOnPath ? 1 : 0;
      out.w20_intervening_path_role_unknown_or_conflict = 0;
    } else {
      out.w17_intervening_path_roles_all_judged_mask = 0;
      out.w18_intervening_predicted_repost_on_path = 0;
      out.w19_intervening_predicted_post_root_on_path = 0;
      out.w20_intervening_path_role_unknown_or_conflict = 1;
    }
  }

  // w21..w31: pair geometry and contained subbox geometry/role mask (CE-Mask-Rel-w22)
  if (isPositiveRect(u.rect) && isPositiveRect(v.rect)) {
    const ru = u.rect;
    const rv = v.rect;
    const areaU = rectArea(ru);
    const areaV = rectArea(rv);
    out.w21_pair_geom_known = 1;

    const uContainedInV = intersectionArea(ru, rv) / areaU >= 0.85;
    out.w23_u_bbox_contained_in_v_bbox = uContainedInV ? 1 : 0;

    const yCenterU = ru.y + ru.height / 2;
    const yCenterV = rv.y + rv.height / 2;
    if (uContainedInV) {
      out.w25_u_in_top_header_zone_of_v =
        yCenterU >= rv.y && yCenterU <= rv.y + 0.25 * rv.height ? 1 : 0;
      out.w26_u_in_middle_content_zone_of_v =
        yCenterU > rv.y + 0.2 * rv.height && yCenterU <= rv.y + 0.8 * rv.height ? 1 : 0;
    }

    const ox = Math.max(0, Math.min(ru.x + ru.width, rv.x + rv.width) - Math.max(ru.x, rv.x));
    const gx = Math.max(0, ru.x - (rv.x + rv.width), rv.x - (ru.x + ru.width));
    const gy = Math.max(0, ru.y - (rv.y + rv.height), rv.y - (ru.y + ru.height));

    const afterDeltaY = ru.y - (rv.y + rv.height);
    const inlineBottomDelta = Math.abs(ru.y + ru.height - (rv.y + rv.height));
    out.w27_u_inline_or_immediately_after_v =
      ox > 0 && ((afterDeltaY >= -8 && afterDeltaY <= 32) || inlineBottomDelta <= 16) ? 1 : 0;
    out.w28_u_and_v_same_row_adjacent =
      Math.abs(yCenterU - yCenterV) <= 24 && gx <= 96 ? 1 : 0;
    out.w29_vertical_gap_le_48px = gy <= 48 ? 1 : 0;
    out.w30_vertical_gap_gt_240px = gy > 240 ? 1 : 0;
    out.w31_horizontal_overlap_ge_0_5_and_u_smaller =
      ox / Math.min(ru.width, rv.width) >= 0.5 && areaU < areaV ? 1 : 0;

    // Potential intermediate containers C_potential(u, v) for w22 & w24
    let allPotentialGeomKnown = true;
    const iBboxNodes: WeiboResolvedNodeV1[] = [];
    for (const z of byRef.values()) {
      if (z.nodeRef === u.nodeRef || z.nodeRef === v.nodeRef) continue;
      const isContainerKind =
        z.judgmentStatus !== "judged" ||
        z.basicKind === "container" ||
        z.basicKind === "list" ||
        z.basicKind === "listitem" ||
        z.basicKind === "other";
      if (!isContainerKind && !isSubtreeDescendant(z, v.nodeRef, byRef)) continue;

      if (!isPositiveRect(z.rect)) {
        allPotentialGeomKnown = false;
        break;
      }
      const rz = z.rect;
      const areaZ = rectArea(rz);
      if (
        areaZ > 0 &&
        intersectionArea(ru, rz) / areaU >= 0.85 &&
        intersectionArea(rz, rv) / areaZ >= 0.85
      ) {
        iBboxNodes.push(z);
      }
    }

    if (allPotentialGeomKnown) {
      let allIBboxRolesJudged = true;
      let anyRepostInBbox = false;
      for (const wNode of iBboxNodes) {
        const predW = rolePredictionsByRef.get(wNode.nodeRef);
        if (!predW || predW.roleStatus !== "judged" || predW.predRole === null) {
          allIBboxRolesJudged = false;
          break;
        }
        if (predW.predRole === "reposted_embedded_post") {
          anyRepostInBbox = true;
        }
      }
      if (allIBboxRolesJudged) {
        out.w22_contained_subbox_geom_and_roles_known_mask = 1;
        out.w24_u_inside_predicted_repost_bbox_within_v = anyRepostInBbox ? 1 : 0;
      }
    }
  }

  return Object.freeze(out);
}

export function softmaxProbabilities(logits: readonly number[]): number[] {
  const maxLogit = Math.max(...logits);
  const exps = logits.map((x) => Math.exp(x - maxLogit));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

export function classifyFromProbabilities<THead extends string>(
  heads: readonly THead[],
  logits: readonly number[],
  minScore = 0.6,
  minMargin = 0.15,
): {
  readonly status: "judged" | "unknown" | "conflict";
  readonly predHead: THead | null;
  readonly topScore: number;
  readonly margin: number;
  readonly probabilities: Readonly<Record<THead, number>>;
  readonly logitsRecord: Readonly<Record<THead, number>>;
} {
  const probs = softmaxProbabilities(logits);
  let bestIdx = 0;
  let secondIdx = -1;
  for (let i = 1; i < logits.length; i += 1) {
    if (logits[i]! > logits[bestIdx]!) {
      secondIdx = bestIdx;
      bestIdx = i;
    } else if (secondIdx < 0 || logits[i]! > logits[secondIdx]!) {
      secondIdx = i;
    }
  }
  const topScore = logits[bestIdx] ?? 0;
  const secondScore = secondIdx >= 0 ? (logits[secondIdx] ?? 0) : 0;
  const margin = topScore - secondScore;

  let status: "judged" | "unknown" | "conflict";
  let predHead: THead | null = null;
  if (topScore < minScore) {
    status = "unknown";
  } else if (margin < minMargin) {
    status = "conflict";
  } else {
    status = "judged";
    predHead = heads[bestIdx] ?? null;
  }

  const probabilities = Object.fromEntries(
    heads.map((h, idx) => [h, probs[idx] ?? 0]),
  ) as Record<THead, number>;
  const logitsRecord = Object.fromEntries(
    heads.map((h, idx) => [h, logits[idx] ?? 0]),
  ) as Record<THead, number>;

  return {
    status,
    predHead,
    topScore,
    margin,
    probabilities: Object.freeze(probabilities),
    logitsRecord: Object.freeze(logitsRecord),
  };
}

export function resolveActionableMediaWrapperRef(
  mediaNodeRef: string,
  byRef: ReadonlyMap<string, WeiboResolvedNodeV1>,
): string | null {
  const node = byRef.get(mediaNodeRef);
  if (!node) return null;
  const parentRef = node.effectiveRetainedAncestorRef ?? node.rawParentRef;
  if (parentRef === null) return null;
  const parent = byRef.get(parentRef);
  if (!parent) return null;
  if (
    parent.basicKind === "link" ||
    parent.tag === "a" ||
    parent.itemObservation.hrefPresent === true
  ) {
    return parent.nodeRef;
  }
  return null;
}

export function predictWeiboNodeRole(
  nodeRef: string,
  roleWires: Readonly<Record<WeiboRoleWireName, number>>,
  profile: WeiboRolePolicyProfileV1,
): WeiboRolePredictionV1 {
  const vec = WEIBO_W0A_ROLE_WIRES.map((w) => roleWires[w] ?? 0);
  const logits = profile.weights.map((row) =>
    row.reduce((acc, weight, idx) => acc + Math.fround(weight) * Math.fround(vec[idx] ?? 0), 0),
  );
  const res = classifyFromProbabilities(
    WEIBO_W0A_ROLE_HEADS,
    logits,
    profile.minScore,
    profile.minMargin,
  );
  return {
    nodeRef,
    roleStatus: res.status,
    predRole: res.predHead,
    topScore: res.topScore,
    margin: res.margin,
    probabilities: res.probabilities,
    logits: res.logitsRecord,
  };
}

export function predictWeiboPairRelation(
  pair: { readonly sourceRef: string; readonly targetRef: string },
  relationWires: Readonly<Record<WeiboRelationWireName, number>>,
  profile: WeiboRelationPolicyProfileV1,
  byRef: ReadonlyMap<string, WeiboResolvedNodeV1>,
): WeiboRelationPredictionV1 {
  const vec = WEIBO_W0A_RELATION_WIRES.map((w) => relationWires[w] ?? 0);
  const logits = profile.weights.map((row) =>
    row.reduce((acc, weight, idx) => acc + Math.fround(weight) * Math.fround(vec[idx] ?? 0), 0),
  );
  const res = classifyFromProbabilities(
    WEIBO_W0A_RELATION_HEADS,
    logits,
    profile.minScore,
    profile.minMargin,
  );
  const actionableWrapperRef =
    res.status === "judged" && res.predHead === "media_of"
      ? resolveActionableMediaWrapperRef(pair.sourceRef, byRef)
      : null;
  return {
    sourceRef: pair.sourceRef,
    targetRef: pair.targetRef,
    relationStatus: res.status,
    predRelation: res.predHead,
    topScore: res.topScore,
    margin: res.margin,
    probabilities: res.probabilities,
    logits: res.logitsRecord,
    actionableWrapperRef,
  };
}
