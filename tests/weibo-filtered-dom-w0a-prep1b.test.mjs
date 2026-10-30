import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WEIBO_W0A_ROLE_HEADS,
  WEIBO_W0A_RELATION_HEADS,
  WEIBO_W0A_POSITIVE_RELATION_HEADS,
  WEIBO_W0A_ROLE_WIRES,
  WEIBO_W0A_RELATION_WIRES,
} from "../dist/filters/weibo-filtered-dom-contract.js";
import {
  buildL1Wires16,
  resolveRetainedNodesMap,
  extractWeiboRoleWires36,
  generateWeiboCandidatePairs,
  extractWeiboRelationWires32,
  resolveActionableMediaWrapperRef,
  predictWeiboPairRelation,
} from "../dist/filters/weibo-filtered-dom-w0a.js";
import { validateW0aDataset } from "../playground/browser/weibo-filtered-dom/w0a/validate-w0a-dataset.mjs";
import {
  evaluateW0aSnapshots,
  runW0aStage2Evaluation,
} from "../playground/browser/weibo-filtered-dom/w0a/evaluate-w0a-independent.mjs";
import {
  runW0aStage1Training,
} from "../playground/browser/weibo-filtered-dom/w0a/train-w0a-role-relation.mjs";

const PREP1A_DIR =
  "/Volumes/Intel/playground/nnanything-runs/cli-foundation-concurrent-design-20261028/browser-stage1/w0a-prep1a-output";
const SMOKE_OUT_DIR =
  "/Volumes/Intel/playground/nnanything-runs/cli-foundation-concurrent-design-20261028/browser-stage1/w0a-prep1b-smoke-output";
const HANDWIRED_ROOT =
  process.env.NN_HANDWIRED_ROOT ?? "/Volumes/extension/code/handwired";

function makeSyntheticRetainedNode({
  slotIndex,
  nodeRef,
  rawParentRef = null,
  effectiveRetainedAncestorRef = null,
  bridgedIntermediateNodeRefs = [],
  collapsedWrapperHopCount = 0,
  judgmentStatus = "judged",
  basicKind = "container",
  tag = "div",
  role = null,
  rect = { x: 0, y: 0, width: 600, height: 400 },
  parentRect = { x: 0, y: 0, width: 800, height: 1000 },
  parentStatus = "present",
  ancestorBoundary = "complete",
  directChildrenStatus = "complete",
  childRefs = [],
  childElementCount = 0,
  positiveAreaChildCount = 0,
  shallowStructuralPeerRatio = 0.0,
  hrefPresent = false,
  hrefCoverage = "measured",
  directTextPresent = false,
  textCoverage = "measured",
  observedDirectText = null,
  observedPathname = null,
  goldRole = null,
  reviewStatus = "confirmed_gold",
}) {
  const l1Wires16 = buildL1Wires16({ judgmentStatus, basicKind });
  const positiveArea =
    rect && rect.width > 0 && rect.height > 0 ? true : rect === null ? null : false;
  const observationNode = {
    ref: nodeRef,
    parentRef: rawParentRef,
    index: slotIndex,
    tag,
    role,
    inputType: tag === "input" ? "search" : null,
    rect,
    clippedRect: rect,
    positiveArea,
    intrinsicSizePositive: positiveArea,
    hrefPresent,
    directTextPresent,
    nonFormatDirectTextPresent: directTextPresent,
    childElementCount,
    positiveAreaChildCount,
    graphicDescendantPresent: basicKind === "image" || basicKind === "video",
    disabled: false,
    contentEditable: false,
    pointerCursor: basicKind === "button" || basicKind === "link",
    borderOrBackgroundPresent: true,
    verticalOverflowScrollable: false,
    horizontalOverflowScrollable: false,
    coincidentChildPairRatio: 0,
    shallowStructuralPeerRatio,
    descendantTextPresent: directTextPresent,
    foreground: "visible",
    coverage: {
      geometry: rect ? "measured" : "unmeasured",
      clipping: rect ? "assessed" : "unassessed",
      foreground: "assessed",
      children: directChildrenStatus === "complete" ? "complete" : "partial",
    },
  };
  const itemObservation = {
    nodeRef,
    tag,
    role,
    inputType: observationNode.inputType,
    positiveArea,
    intrinsicSizePositive: positiveArea,
    hrefPresent,
    directTextPresent,
    nonFormatDirectTextPresent: directTextPresent,
    childElementCount,
    positiveAreaChildCount,
    graphicDescendantPresent: observationNode.graphicDescendantPresent,
    disabled: false,
    contentEditable: false,
    pointerCursor: observationNode.pointerCursor,
    borderOrBackgroundPresent: true,
    verticalOverflowScrollable: false,
    horizontalOverflowScrollable: false,
    coincidentChildPairRatio: 0,
    shallowStructuralPeerRatio,
    descendantTextPresent: directTextPresent,
  };
  const explorationInput = {
    version: "v1",
    nodeRef,
    identity: {
      tag,
      role,
      inputType: observationNode.inputType,
    },
    geometry: {
      rect,
      clippedRect: rect,
      parentRect,
    },
    containment: {
      parentRef: rawParentRef,
      parentStatus,
      childRefs,
      ancestorEdges: [],
      descendantEdges: [],
      ancestorBoundary,
      descendantBoundary: "complete",
    },
    childComposition: {
      directChildrenStatus,
      childElementCount,
      positiveAreaChildCount,
      coincidentChildPairRatio: 0,
      shallowStructuralPeerRatio,
      graphicDescendantPresent: observationNode.graphicDescendantPresent,
      descendantTextPresent: directTextPresent,
    },
    interactiveStates: {
      disabled: false,
      contentEditable: false,
      pointerCursor: observationNode.pointerCursor,
    },
    appearance: {
      positiveArea,
      intrinsicSizePositive: positiveArea,
      hrefPresent,
      directTextPresent,
      nonFormatDirectTextPresent: directTextPresent,
      borderOrBackgroundPresent: true,
      verticalOverflowScrollable: false,
      horizontalOverflowScrollable: false,
    },
    measurementCoverage: {
      geometry: rect ? "measured" : "unmeasured",
      clipping: rect ? "assessed" : "unassessed",
      foreground: "assessed",
      children: directChildrenStatus === "complete" ? "complete" : "partial",
      parentRect: parentRect ? "measured" : "unmeasured",
      hrefPresent: hrefCoverage,
      directTextPresent: textCoverage,
      nonFormatDirectTextPresent: textCoverage,
      childCounts: childElementCount !== null ? "measured" : "unmeasured",
      peerRatios: shallowStructuralPeerRatio !== null ? "measured" : "unmeasured",
    },
  };
  const sidecar = {
    observedDirectText,
    observedPathname,
  };
  const effectiveL1 =
    judgmentStatus === "judged"
      ? `judged:${basicKind}`
      : `${judgmentStatus}:${basicKind ?? "other"}`;

  const slotRow = {
    slotIndex,
    index: slotIndex,
    nodeRef,
    rawParentRef,
    disposition: "active_retained",
    inMainClassificationInput: true,
    effectiveL1,
    judgmentStatus,
    basicKind,
    l1Wires16,
    observationNode,
    itemObservation,
    explorationInput,
    sidecar,
  };
  const retainedRow = {
    slotIndex,
    index: slotIndex,
    nodeRef,
    rawParentRef,
    effectiveRetainedAncestorRef,
    bridgedIntermediateNodeRefs,
    collapsedWrapperHopCount,
    effectiveL1,
    judgmentStatus,
    basicKind,
    l1Wires16,
    observationNode,
    itemObservation,
    explorationInput,
    sidecar,
    roleAnnotation:
      goldRole !== null
        ? {
            reviewStatus,
            goldRole,
          }
        : undefined,
  };
  return { slotRow, retainedRow };
}

test("1. Counterexamples 1-4: CE-Mask-Role-w23, CE-Mask-CandPair-B, CE-Mask-Rel-w22, CE-Mask-Rel-w06", () => {
  // CE-Mask-Role-w23: A_1 is article, B is intermediate subcontainer with 2 direct children c1, c2,
  // where c2 has directTextPresent=true but observedDirectText=null (like Source B).
  const rootFeed = makeSyntheticRetainedNode({
    slotIndex: 0,
    nodeRef: "feed",
    parentStatus: "root",
    basicKind: "list",
    shallowStructuralPeerRatio: 0.8,
    positiveAreaChildCount: 3,
    childElementCount: 3,
    childRefs: ["a1"],
  });
  const a1 = makeSyntheticRetainedNode({
    slotIndex: 1,
    nodeRef: "a1",
    rawParentRef: "feed",
    effectiveRetainedAncestorRef: "feed",
    tag: "article",
    basicKind: "listitem",
    rect: { x: 0, y: 0, width: 600, height: 400 },
    childElementCount: 2,
    positiveAreaChildCount: 2,
    childRefs: ["b"],
  });
  const b = makeSyntheticRetainedNode({
    slotIndex: 2,
    nodeRef: "b",
    rawParentRef: "a1",
    effectiveRetainedAncestorRef: "a1",
    basicKind: "container",
    rect: { x: 10, y: 80, width: 560, height: 200 },
    childElementCount: 2,
    positiveAreaChildCount: 2,
    childRefs: ["c1", "c2_u"],
  });
  const c1 = makeSyntheticRetainedNode({
    slotIndex: 3,
    nodeRef: "c1",
    rawParentRef: "b",
    effectiveRetainedAncestorRef: "b",
    basicKind: "link",
    tag: "a",
    hrefPresent: true,
    directTextPresent: true,
    observedDirectText: "@原作者",
    observedPathname: "/u/12345",
  });
  const c2_u = makeSyntheticRetainedNode({
    slotIndex: 4,
    nodeRef: "c2_u",
    rawParentRef: "b",
    effectiveRetainedAncestorRef: "b",
    basicKind: "text",
    hrefPresent: false,
    directTextPresent: true,
    observedDirectText: null, // Missing text string (Source B token-only)
  });

  const resolved1 = resolveRetainedNodesMap({
    slots: [rootFeed.slotRow, a1.slotRow, b.slotRow, c1.slotRow, c2_u.slotRow],
    retainedNodes: [
      rootFeed.retainedRow,
      a1.retainedRow,
      b.retainedRow,
      c1.retainedRow,
      c2_u.retainedRow,
    ],
  });
  const wiresU = extractWeiboRoleWires36("c2_u", resolved1);
  assert.equal(wiresU.w20_ancestor_and_subcontainer_text_known, 0);
  assert.equal(wiresU.w21_hop_to_nearest_repeating_item_1_to_2, 0);
  assert.equal(wiresU.w22_hop_to_nearest_repeating_item_3_to_4, 0);
  assert.equal(wiresU.w23_inside_second_level_nested_subcontainer, 0);
  assert.equal(wiresU.w29_text_string_known, 0);

  // Verify that when c2_u DOES have observedDirectText >= 24 chars, w20=1, w21=1, w23=1
  const c2_u_complete = makeSyntheticRetainedNode({
    slotIndex: 4,
    nodeRef: "c2_u",
    rawParentRef: "b",
    effectiveRetainedAncestorRef: "a1", // wait: keep b as parent so hops(u, a1)=2
    basicKind: "text",
    hrefPresent: false,
    directTextPresent: true,
    observedDirectText: "这是一段超过二十四个字符的被转发原帖完整正文内容用于验证w23激活",
  });
  // Fix effectiveRetainedAncestorRef of c2_u_complete to "b"
  const c2_u_fixed = {
    ...c2_u_complete,
    retainedRow: {
      ...c2_u_complete.retainedRow,
      effectiveRetainedAncestorRef: "b",
    },
  };
  const resolved1Complete = resolveRetainedNodesMap({
    slots: [rootFeed.slotRow, a1.slotRow, b.slotRow, c1.slotRow, c2_u_fixed.slotRow],
    retainedNodes: [
      rootFeed.retainedRow,
      a1.retainedRow,
      b.retainedRow,
      c1.retainedRow,
      c2_u_fixed.retainedRow,
    ],
  });
  const wiresUComplete = extractWeiboRoleWires36("c2_u", resolved1Complete);
  assert.equal(wiresUComplete.w20_ancestor_and_subcontainer_text_known, 1);
  assert.equal(wiresUComplete.w21_hop_to_nearest_repeating_item_1_to_2, 1);
  assert.equal(wiresUComplete.w23_inside_second_level_nested_subcontainer, 1);
  assert.equal(wiresUComplete.w29_text_string_known, 1);
  assert.equal(wiresUComplete.w31_text_len_long_ge_24, 1);

  // CE-Mask-CandPair-B: u and v share LCA within 2 hops, not satisfying Condition A, and v.rect === null
  const lcaRoot = makeSyntheticRetainedNode({
    slotIndex: 0,
    nodeRef: "lca",
    parentStatus: "root",
    basicKind: "container",
  });
  const subBtn = makeSyntheticRetainedNode({
    slotIndex: 1,
    nodeRef: "u_btn",
    rawParentRef: "lca",
    effectiveRetainedAncestorRef: "lca",
    basicKind: "button",
    rect: { x: 400, y: 20, width: 60, height: 32 },
  });
  const searchInpNoRect = makeSyntheticRetainedNode({
    slotIndex: 2,
    nodeRef: "v_inp",
    rawParentRef: "lca",
    effectiveRetainedAncestorRef: "lca",
    basicKind: "input",
    rect: null,
  });
  const resolvedCandB = resolveRetainedNodesMap({
    slots: [lcaRoot.slotRow, subBtn.slotRow, searchInpNoRect.slotRow],
    retainedNodes: [
      lcaRoot.retainedRow,
      subBtn.retainedRow,
      searchInpNoRect.retainedRow,
    ],
  });
  const genCandB = generateWeiboCandidatePairs(resolvedCandB);
  assert.equal(genCandB.pairGenerationBoundaryStatus, "incomplete_observation");
  assert.ok(
    genCandB.unassessedGeometryCandidatePairs.some(
      ([s, t]) => s === "u_btn" && t === "v_inp",
    ),
  );
  assert.ok(
    !genCandB.candidatePairs.some(
      (p) => p.sourceRef === "u_btn" && p.targetRef === "v_inp",
    ),
  );

  // CE-Mask-Rel-w22 & CE-Mask-Rel-w06 & CE-Rel-1:
  // Outer post v_outer, intermediate container w_repost inside v_outer, author u_author inside w_repost.
  const vOuter = makeSyntheticRetainedNode({
    slotIndex: 0,
    nodeRef: "v_outer",
    parentStatus: "root",
    tag: "article",
    basicKind: "listitem",
    rect: { x: 0, y: 0, width: 600, height: 400 },
  });
  const wRepostNoRect = makeSyntheticRetainedNode({
    slotIndex: 1,
    nodeRef: "w_repost",
    rawParentRef: "v_outer",
    effectiveRetainedAncestorRef: "v_outer",
    basicKind: "container",
    rect: null, // Unmeasured rect on potential intermediate container!
  });
  const uAuthor = makeSyntheticRetainedNode({
    slotIndex: 2,
    nodeRef: "u_author",
    rawParentRef: "w_repost",
    effectiveRetainedAncestorRef: "w_repost",
    basicKind: "link",
    tag: "a",
    rect: { x: 20, y: 120, width: 100, height: 24 },
    hrefPresent: null,
    hrefCoverage: "unmeasured", // Also tests CE-Mask-Rel-w06!
    directTextPresent: true,
    observedDirectText: "@原作者",
  });
  const resolvedRelMask = resolveRetainedNodesMap({
    slots: [vOuter.slotRow, wRepostNoRect.slotRow, uAuthor.slotRow],
    retainedNodes: [
      vOuter.retainedRow,
      wRepostNoRect.retainedRow,
      uAuthor.retainedRow,
    ],
  });
  const rolePredsRelMask = new Map([
    [
      "v_outer",
      {
        nodeRef: "v_outer",
        roleStatus: "judged",
        predRole: "post_root",
        topScore: 0.95,
        margin: 0.9,
        probabilities: {},
        logits: {},
      },
    ],
    [
      "w_repost",
      {
        nodeRef: "w_repost",
        roleStatus: "judged",
        predRole: "reposted_embedded_post",
        topScore: 0.95,
        margin: 0.9,
        probabilities: {},
        logits: {},
      },
    ],
    [
      "u_author",
      {
        nodeRef: "u_author",
        roleStatus: "judged",
        predRole: "post_body", // So w06 would check hrefPresent
        topScore: 0.95,
        margin: 0.9,
        probabilities: {},
        logits: {},
      },
    ],
  ]);
  const relWiresMask = extractWeiboRelationWires32(
    { sourceRef: "u_author", targetRef: "v_outer" },
    resolvedRelMask,
    rolePredsRelMask,
  );
  // CE-Mask-Rel-w06 assertions:
  assert.equal(relWiresMask.w01_endpoint_roles_and_link_props_known_mask, 0);
  assert.equal(relWiresMask.w06_pred_u_link_v_post, 0);
  assert.equal(relWiresMask.w11_endpoint_role_or_link_prop_unknown, 1);
  assert.equal(relWiresMask.w03_pred_u_body_v_post, 1);
  // CE-Mask-Rel-w22 assertions: u and v have rects (w21=1, w23=1), but w_repost has rect=null so w22=0, w24=0
  assert.equal(relWiresMask.w21_pair_geom_known, 1);
  assert.equal(relWiresMask.w23_u_bbox_contained_in_v_bbox, 1);
  assert.equal(relWiresMask.w22_contained_subbox_geom_and_roles_known_mask, 0);
  assert.equal(relWiresMask.w24_u_inside_predicted_repost_bbox_within_v, 0);
});

test("2. Counterexamples 5-8: CE-Rel-1, CE-Rel-Media-HrefUnmeasured, CE-Eval-Denom-1, CE-Eval-UnlabeledPair-1", () => {
  // CE-Rel-1 & CE-Rel-Media-HrefUnmeasured
  const vOuter = makeSyntheticRetainedNode({
    slotIndex: 0,
    nodeRef: "v_outer",
    parentStatus: "root",
    tag: "article",
    basicKind: "listitem",
    rect: { x: 0, y: 0, width: 600, height: 400 },
  });
  const wRepost = makeSyntheticRetainedNode({
    slotIndex: 1,
    nodeRef: "w_repost",
    rawParentRef: "v_outer",
    effectiveRetainedAncestorRef: "v_outer",
    basicKind: "container",
    rect: { x: 16, y: 100, width: 560, height: 240 },
  });
  const aWrap = makeSyntheticRetainedNode({
    slotIndex: 2,
    nodeRef: "a_wrap",
    rawParentRef: "w_repost",
    effectiveRetainedAncestorRef: "w_repost",
    tag: "a",
    basicKind: "other",
    judgmentStatus: "unknown", // Even if L1 is unknown:other and hrefPresent is null, tag==="a" resolves wrapper!
    hrefPresent: null,
    hrefCoverage: "unmeasured",
    rect: { x: 24, y: 150, width: 120, height: 120 },
  });
  const uImg = makeSyntheticRetainedNode({
    slotIndex: 3,
    nodeRef: "u_img",
    rawParentRef: "a_wrap",
    effectiveRetainedAncestorRef: "a_wrap",
    tag: "img",
    basicKind: "image",
    rect: { x: 24, y: 150, width: 120, height: 120 },
  });
  const resolvedMedia = resolveRetainedNodesMap({
    slots: [vOuter.slotRow, wRepost.slotRow, aWrap.slotRow, uImg.slotRow],
    retainedNodes: [
      vOuter.retainedRow,
      wRepost.retainedRow,
      aWrap.retainedRow,
      uImg.retainedRow,
    ],
  });
  assert.equal(resolveActionableMediaWrapperRef("u_img", resolvedMedia), "a_wrap");

  // Also test CE-Rel-1: w18=1 and w24=1 when w_repost has predRole="reposted_embedded_post" and positive rect
  const rolePredsMedia = new Map([
    [
      "v_outer",
      {
        nodeRef: "v_outer",
        roleStatus: "judged",
        predRole: "post_root",
        topScore: 0.95,
        margin: 0.9,
        probabilities: {},
        logits: {},
      },
    ],
    [
      "w_repost",
      {
        nodeRef: "w_repost",
        roleStatus: "judged",
        predRole: "reposted_embedded_post",
        topScore: 0.95,
        margin: 0.9,
        probabilities: {},
        logits: {},
      },
    ],
    [
      "a_wrap",
      {
        nodeRef: "a_wrap",
        roleStatus: "judged",
        predRole: "auxiliary_or_decor",
        topScore: 0.95,
        margin: 0.9,
        probabilities: {},
        logits: {},
      },
    ],
    [
      "u_img",
      {
        nodeRef: "u_img",
        roleStatus: "judged",
        predRole: "media_item",
        topScore: 0.95,
        margin: 0.9,
        probabilities: {},
        logits: {},
      },
    ],
  ]);
  const relWiresOuter = extractWeiboRelationWires32(
    { sourceRef: "u_img", targetRef: "v_outer" },
    resolvedMedia,
    rolePredsMedia,
  );
  assert.equal(relWiresOuter.w17_intervening_path_roles_all_judged_mask, 1);
  assert.equal(relWiresOuter.w18_intervening_predicted_repost_on_path, 1);
  assert.equal(relWiresOuter.w22_contained_subbox_geom_and_roles_known_mask, 1);
  assert.equal(relWiresOuter.w24_u_inside_predicted_repost_bbox_within_v, 1);

  const relWiresInner = extractWeiboRelationWires32(
    { sourceRef: "u_img", targetRef: "w_repost" },
    resolvedMedia,
    rolePredsMedia,
  );
  assert.equal(relWiresInner.w18_intervening_predicted_repost_on_path, 0);
  assert.equal(relWiresInner.w24_u_inside_predicted_repost_bbox_within_v, 0);

  // CE-Eval-Denom-1 & CE-Eval-UnlabeledPair-1:
  // Construct a synthetic snapshot with:
  // - 5 gold repost_of edges: 1 missed by candidate generation (hops=7), 3 predicted repost_of, 1 predicted unknown
  // - 1 confirmed unrelated pair predicted as repost_of
  // - 2 confirmed author_of edges (predicted author_of), 1 confirmed unrelated predicted author_of,
  //   and 2 unlabeled candidate pairs (1 predicted author_of, 1 predicted unrelated).
  const chainNodes = [];
  for (let i = 0; i <= 7; i += 1) {
    chainNodes.push(
      makeSyntheticRetainedNode({
        slotIndex: i,
        nodeRef: `n${i}`,
        rawParentRef: i === 0 ? null : `n${i - 1}`,
        effectiveRetainedAncestorRef: i === 0 ? null : `n${i - 1}`,
        parentStatus: i === 0 ? "root" : "present",
        basicKind: "container",
        rect: { x: 0, y: i * 700, width: 600, height: 100 }, // >600px vertical distance so Condition B doesn't match non-ancestors
        goldRole: i === 0 ? "post_root" : "reposted_embedded_post",
      }),
    );
  }
  const snapEvalCE = {
    snapshotId: "snap-eval-ce",
    usageScope: "diagnostic_development_only",
    trainingEligible: false,
    autoGold: false,
    filterRecallStatus: "UNVERIFIED",
    sourceFamily: {
      captureSessionId: "ce-sess",
      queryNormalized: "ce",
      canonicalPostIds: ["p1"],
      authorUids: ["u1"],
      pageKind: "mixed_search_and_reposts",
    },
    slots: chainNodes.map((x) => x.slotRow),
    retainedNodes: chainNodes.map((x) => x.retainedRow),
    // 5 gold repost_of edges:
    // n1->n0 (hops=1), n2->n0 (hops=2), n3->n0 (hops=3), n4->n0 (hops=4), and n7->n0 (hops=7, missed by Condition A<=6 & Condition B >600px!)
    // Plus 2 gold author_of edges: n5->n0 (hops=5), n6->n0 (hops=6)
    independentGoldRelations: [
      { sourceRef: "n1", targetRef: "n0", relation: "repost_of", reviewStatus: "confirmed_gold" },
      { sourceRef: "n2", targetRef: "n0", relation: "repost_of", reviewStatus: "confirmed_gold" },
      { sourceRef: "n3", targetRef: "n0", relation: "repost_of", reviewStatus: "confirmed_gold" },
      { sourceRef: "n4", targetRef: "n0", relation: "repost_of", reviewStatus: "confirmed_gold" },
      { sourceRef: "n7", targetRef: "n0", relation: "repost_of", reviewStatus: "confirmed_gold" },
      { sourceRef: "n5", targetRef: "n0", relation: "author_of", reviewStatus: "confirmed_gold" },
      { sourceRef: "n6", targetRef: "n0", relation: "author_of", reviewStatus: "confirmed_gold" },
    ],
    // Mark n2->n1 as confirmed unrelated (will be predicted repost_of -> FP=1 for repost_of),
    // n3->n1 as confirmed unrelated (will be predicted author_of -> FP=1 for author_of),
    // and leave n4->n1, n5->n1 UNREVIEWED (in P_unlabeled, where n4->n1 is predicted author_of).
    candidatePairAnnotations: [
      { sourceRef: "n2", targetRef: "n1", reviewStatus: "confirmed_gold", goldRelation: "unrelated" },
      { sourceRef: "n3", targetRef: "n1", reviewStatus: "confirmed_gold", goldRelation: "unrelated" },
      { sourceRef: "n4", targetRef: "n1", reviewStatus: "unreviewed", goldRelation: null },
      { sourceRef: "n5", targetRef: "n1", reviewStatus: "unreviewed", goldRelation: null },
    ],
  };

  // Use zero weights for roleProfile & relationProfile, and inject custom role/relation predictions?
  // Wait: evaluateW0aSnapshots calls predictWeiboPairRelation using relationProfile.
  // We can distinguish pairs by hops (w13: hops 1..2, w14: hops 3..4, w15: hops 5..6) and endpoint roles!
  // Let's give each node n0..n7 a distinct role via overrideRolePredictionsBySnapshot so relation wires uniquely identify pairs!
  const zeroRoleWeights = Array.from({ length: WEIBO_W0A_ROLE_HEADS.length }, () =>
    Array.from({ length: WEIBO_W0A_ROLE_WIRES.length }, () => 0),
  );
  const dummyRoleProfile = {
    profileId: "dummy-role",
    version: "w0a.v1",
    heads: [...WEIBO_W0A_ROLE_HEADS],
    wires: [...WEIBO_W0A_ROLE_WIRES],
    parameterCount: 396,
    minScore: 0.6,
    minMargin: 0.15,
    calibration: "uncalibrated",
    adoption: "not_applied",
    runKind: "synthetic_engineering_smoke_only",
    formalBenchmarkEligible: false,
    weights: zeroRoleWeights,
  };

  // Let's check what generateWeiboCandidatePairs produces on snapEvalCE:
  const resolvedCE = resolveRetainedNodesMap(snapEvalCE);
  const genCE = generateWeiboCandidatePairs(resolvedCE);
  // Confirm n7->n0 is truncated by hop limit (hops=7 > 6):
  assert.ok(
    genCE.truncatedHopCandidatePairs.some(([s, t]) => s === "n7" && t === "n0"),
  );
  assert.ok(
    !genCE.candidatePairs.some((p) => p.sourceRef === "n7" && p.targetRef === "n0"),
  );
});

test("3. Real 1792 retained nodes from W0a-Prep-1A: extract 36-dim role wires, candidate pairs, 32-dim relation wires, and persist diagnostic summary", () => {
  const snapAPath = join(PREP1A_DIR, "snapshot-001.prep.json");
  const snapBPath = join(PREP1A_DIR, "weibo-current-inputs.prep.json");
  assert.ok(existsSync(snapAPath), "snapshot-001.prep.json must exist");
  assert.ok(existsSync(snapBPath), "weibo-current-inputs.prep.json must exist");

  const snapA = JSON.parse(readFileSync(snapAPath, "utf8"));
  const snapB = JSON.parse(readFileSync(snapBPath, "utf8"));
  assert.equal(snapA.retainedNodes.length, 867);
  assert.equal(snapB.retainedNodes.length, 925);

  const analyzePrep1aSnapshot = (snap) => {
    const allSlotsByRef = new Map(snap.slots.map((s) => [s.nodeRef, s]));
    const resolvedMap = resolveRetainedNodesMap({
      slots: snap.slots,
      retainedNodes: snap.retainedNodes,
    });
    const wireActivationCounts = Object.fromEntries(
      WEIBO_W0A_ROLE_WIRES.map((w) => [w, 0]),
    );
    const rolePredsByRef = new Map();
    const zeroRoleProfile = {
      profileId: "zero-role",
      version: "w0a.v1",
      heads: [...WEIBO_W0A_ROLE_HEADS],
      wires: [...WEIBO_W0A_ROLE_WIRES],
      parameterCount: 396,
      minScore: 0.6,
      minMargin: 0.15,
      calibration: "uncalibrated",
      adoption: "not_applied",
      runKind: "synthetic_engineering_smoke_only",
      formalBenchmarkEligible: false,
      weights: Array.from({ length: WEIBO_W0A_ROLE_HEADS.length }, () =>
        Array.from({ length: WEIBO_W0A_ROLE_WIRES.length }, () => 0),
      ),
    };

    for (const rNode of snap.retainedNodes) {
      const w36 = extractWeiboRoleWires36(rNode.nodeRef, resolvedMap, allSlotsByRef);
      for (const wName of WEIBO_W0A_ROLE_WIRES) {
        if (w36[wName] !== 0) wireActivationCounts[wName] += 1;
      }
      // Verify masks on Prep-1A data:
      // w17 (peer_ratio_known) must be 0 because positiveAreaChildCount is null
      assert.equal(w36.w17_peer_ratio_known, 0);
      assert.equal(w36.w18_has_repeating_structural_children, 0);
      assert.equal(w36.w19_in_repeating_peer_parent, 0);
      // w20 (ancestor_and_subcontainer_text_known) must be 0 because directChildrenStatus is "unknown"
      assert.equal(w36.w20_ancestor_and_subcontainer_text_known, 0);
      assert.equal(w36.w21_hop_to_nearest_repeating_item_1_to_2, 0);
      assert.equal(w36.w22_hop_to_nearest_repeating_item_3_to_4, 0);
      assert.equal(w36.w23_inside_second_level_nested_subcontainer, 0);
      // w29 (text_string_known) and w34 (href_url_parsed_known) on Source B must be 0 when directTextPresent===true or hrefPresent===true because strings are redacted
      if (snap.sourceId === "weibo-current-inputs") {
        const resolvedNode = resolvedMap.get(rNode.nodeRef);
        if (resolvedNode.itemObservation.directTextPresent === true) {
          assert.equal(w36.w29_text_string_known, 0);
        }
        assert.equal(w36.w35_has_multi_segment_http_href, 0);
      }

      rolePredsByRef.set(rNode.nodeRef, {
        nodeRef: rNode.nodeRef,
        roleStatus: "unknown",
        predRole: null,
        topScore: 1 / 11,
        margin: 0,
        probabilities: {},
        logits: {},
      });
    }

    // Verify w24..w28 (relative geometry in container) activates on real nodes!
    assert.ok(
      wireActivationCounts.w24_rel_geom_in_container_known > 0,
      "w24_rel_geom_in_container_known must activate on real Prep-1A nodes",
    );

    const pairGen = generateWeiboCandidatePairs(resolvedMap);
    assert.ok(pairGen.candidatePairs.length > 0, "candidatePairs must be non-empty");

    const relWireActivationCounts = Object.fromEntries(
      WEIBO_W0A_RELATION_WIRES.map((w) => [w, 0]),
    );
    for (const cand of pairGen.candidatePairs) {
      const rw32 = extractWeiboRelationWires32(cand, resolvedMap, rolePredsByRef);
      for (const rwName of WEIBO_W0A_RELATION_WIRES) {
        if (rw32[rwName] !== 0) relWireActivationCounts[rwName] += 1;
      }
    }

    return {
      sourceId: snap.sourceId,
      retainedCount: snap.retainedNodes.length,
      roleWireActivationCounts: wireActivationCounts,
      candidatePairCount: pairGen.candidatePairs.length,
      unassessedGeometryPairCount: pairGen.unassessedGeometryCandidatePairs.length,
      truncatedHopPairCount: pairGen.truncatedHopCandidatePairs.length,
      pairGenerationBoundaryStatus: pairGen.pairGenerationBoundaryStatus,
      relationWireActivationCounts: relWireActivationCounts,
    };
  };

  const diagA = analyzePrep1aSnapshot(snapA);
  const diagB = analyzePrep1aSnapshot(snapB);
  assert.equal(diagA.retainedCount + diagB.retainedCount, 1792);

  mkdirSync(SMOKE_OUT_DIR, { recursive: true });
  const diagPath = join(SMOKE_OUT_DIR, "prep1a-1792-wires-diagnostic.json");
  if (!existsSync(diagPath)) {
    writeFileSync(
      diagPath,
      `${JSON.stringify(
        {
          kind: "nnanything.w0a.prep1a-1792-wires-diagnostic.v1",
          totalRetainedNodes: 1792,
          sources: [diagA, diagB],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
  assert.ok(existsSync(diagPath));
  const persistedDiag = JSON.parse(readFileSync(diagPath, "utf8"));
  assert.equal(persistedDiag.totalRetainedNodes, 1792);
});

test("4. Dataset validator: rejects real Prep-1A diagnostic files even with --allow-synthetic-engineering-smoke, and rejects leakage/unlabeled/zero-denominator", () => {
  const snapA = JSON.parse(
    readFileSync(join(PREP1A_DIR, "snapshot-001.prep.json"), "utf8"),
  );
  const snapB = JSON.parse(
    readFileSync(join(PREP1A_DIR, "weibo-current-inputs.prep.json"), "utf8"),
  );

  // Even when allowSyntheticEngineeringSmoke is true, Prep-1A files MUST be rejected!
  const resPrep1A = validateW0aDataset({
    trainSnapshots: [snapA],
    devSnapshots: [snapB],
    allowSyntheticEngineeringSmoke: true,
  });
  assert.equal(resPrep1A.valid, false);
  const codes = new Set(resPrep1A.violations.map((v) => v.code));
  assert.ok(codes.has("DIAGNOSTIC_OR_INELIGIBLE_SNAPSHOT_FORBIDDEN"));
  assert.ok(codes.has("UNCONFIRMED_ROLE_LABELS_PRESENT"));
  assert.ok(codes.has("UNLABELED_CANDIDATE_PAIRS_PRESENT"));
  assert.ok(codes.has("UNVERIFIED_ZERO_GOLD_DENOMINATOR"));
});

function buildSeparableSyntheticSnapshot({
  snapshotId,
  captureSessionId,
  queryNormalized,
  postId,
  authorUid,
}) {
  // Construct a synthetic page containing all 11 role heads and all 8 positive relation heads
  // plus confirmed unrelated pairs (including embedded repost author/body -> outer post_root)
  // with balanced class counts so both Unit W0-Role (11x36) and Unit W0-Rel (9x32) converge
  // to 100% precision/recall in 200 epochs at lr=0.1.
  const nodes = [];
  let slotIdx = 0;
  const addNode = (spec) => {
    const built = makeSyntheticRetainedNode({
      slotIndex: slotIdx++,
      ...spec,
    });
    nodes.push(built);
    return built;
  };
  const independentGoldRelations = [];

  // 1. Three search boxes (search_input: 3, search_submit: 3, submits_input_of: 3)
  for (let i = 1; i <= 3; i += 1) {
    const baseY = i * 2000;
    addNode({
      nodeRef: `n_search_input_${i}`,
      parentStatus: "root",
      basicKind: "input",
      tag: "input",
      rect: { x: 20, y: baseY + 10, width: 520, height: 36 },
      parentRect: { x: 0, y: baseY, width: 600, height: 50 },
      directTextPresent: false,
      hrefPresent: false,
      goldRole: "search_input",
    });
    addNode({
      nodeRef: `n_search_submit_${i}`,
      rawParentRef: `n_search_input_${i}`,
      effectiveRetainedAncestorRef: `n_search_input_${i}`,
      basicKind: "button",
      tag: "button",
      rect: { x: 550, y: baseY + 10, width: 60, height: 36 },
      parentRect: { x: 0, y: baseY, width: 600, height: 50 },
      directTextPresent: true,
      observedDirectText: "搜索",
      hrefPresent: false,
      goldRole: "search_submit",
    });
    independentGoldRelations.push({
      sourceRef: `n_search_submit_${i}`,
      targetRef: `n_search_input_${i}`,
      relation: "submits_input_of",
      reviewStatus: "confirmed_gold",
    });
  }

  // 2. Two standalone result_list_root nodes (result_list_root: 2, no descendants to avoid 20+ redundant ->list_root unrelated pairs)
  for (let i = 1; i <= 2; i += 1) {
    const baseY = 10000 + i * 2000;
    addNode({
      nodeRef: `n_list_root_${i}`,
      parentStatus: "root",
      basicKind: "list",
      tag: "div",
      rect: { x: 0, y: baseY, width: 700, height: 100 },
      parentRect: { x: 0, y: baseY, width: 700, height: 100 },
      shallowStructuralPeerRatio: 0.85,
      positiveAreaChildCount: 4,
      childElementCount: 4,
      childRefs: [],
      goldRole: "result_list_root",
    });
  }

  // 3. Three main post_root cards (post_root: 3) so every one of the 8 positive relation heads
  // has EXACTLY 3 gold examples per snapshot (author_of: 3, body_of: 3, detail_entry_of: 3,
  // media_of: 3, link_of: 3, repost_of: 3, expand_toggle_of: 3, submits_input_of: 3).
  for (let i = 1; i <= 3; i += 1) {
    const baseY = i * 100000;
    const postRef = `n_post_main_${i}`;
    const childRefs = [
      `n_time_${i}`,
      `n_media_${i}`,
      `n_link_${i}`,
      `n_repost_${i}`,
    ];
    if (i <= 2) {
      childRefs.push(`n_author_${i}`, `n_body_${i}`, `n_aux_${i}`);
    }
    addNode({
      nodeRef: postRef,
      parentStatus: "root",
      basicKind: "listitem",
      tag: "article",
      rect: { x: 10, y: baseY, width: 680, height: 40000 },
      parentRect: { x: 0, y: baseY, width: 700, height: 40000 },
      shallowStructuralPeerRatio: 0.2,
      positiveAreaChildCount: childRefs.length,
      childElementCount: childRefs.length,
      childRefs,
      goldRole: "post_root",
    });

    if (i <= 2) {
      // author_anchor (top quarter: offset +1000)
      addNode({
        nodeRef: `n_author_${i}`,
        rawParentRef: postRef,
        effectiveRetainedAncestorRef: postRef,
        basicKind: "link",
        tag: "a",
        rect: { x: 24, y: baseY + 1000, width: 100, height: 24 },
        parentRect: { x: 10, y: baseY, width: 680, height: 40000 },
        hrefPresent: true,
        observedPathname: `/u/${authorUid}_${i}`,
        directTextPresent: true,
        observedDirectText: `@博主_${authorUid}_${i}`,
        goldRole: "author_anchor",
      });
      independentGoldRelations.push({
        sourceRef: `n_author_${i}`,
        targetRef: postRef,
        relation: "author_of",
        reviewStatus: "confirmed_gold",
      });

      // post_body (middle zone: offset +9000) + expand_body_toggle child
      addNode({
        nodeRef: `n_body_${i}`,
        rawParentRef: postRef,
        effectiveRetainedAncestorRef: postRef,
        basicKind: "text",
        tag: "div",
        rect: { x: 24, y: baseY + 9000, width: 620, height: 90 },
        parentRect: { x: 10, y: baseY, width: 680, height: 40000 },
        hrefPresent: false,
        directTextPresent: true,
        observedDirectText:
          "这是一条测试微博的完整主贴正文内容长度超过二十四个字符用于验证角色与关系训练",
        childElementCount: 1,
        positiveAreaChildCount: 1,
        childRefs: [`n_expand_${i}`],
        goldRole: "post_body",
      });
      independentGoldRelations.push({
        sourceRef: `n_body_${i}`,
        targetRef: postRef,
        relation: "body_of",
        reviewStatus: "confirmed_gold",
      });

      addNode({
        nodeRef: `n_expand_${i}`,
        rawParentRef: `n_body_${i}`,
        effectiveRetainedAncestorRef: `n_body_${i}`,
        basicKind: "button",
        tag: "span",
        rect: { x: 500, y: baseY + 9065, width: 56, height: 20 },
        parentRect: { x: 24, y: baseY + 9000, width: 620, height: 90 },
        hrefPresent: false,
        directTextPresent: true,
        observedDirectText: "...展开",
        goldRole: "expand_body_toggle",
      });
      independentGoldRelations.push({
        sourceRef: `n_expand_${i}`,
        targetRef: `n_body_${i}`,
        relation: "expand_toggle_of",
        reviewStatus: "confirmed_gold",
      });

      // auxiliary_or_decor (bottom fifth: offset +38000)
      addNode({
        nodeRef: `n_aux_${i}`,
        rawParentRef: postRef,
        effectiveRetainedAncestorRef: postRef,
        basicKind: "other",
        tag: "div",
        rect: { x: 24, y: baseY + 38000, width: 80, height: 18 },
        parentRect: { x: 10, y: baseY, width: 680, height: 40000 },
        hrefPresent: false,
        directTextPresent: true,
        observedDirectText: "来自客户端",
        goldRole: "auxiliary_or_decor",
      });
    }

    // timestamp_or_detail_anchor (top quarter: offset +3000)
    addNode({
      nodeRef: `n_time_${i}`,
      rawParentRef: postRef,
      effectiveRetainedAncestorRef: postRef,
      basicKind: "link",
      tag: "a",
      rect: { x: 140, y: baseY + 3000, width: 90, height: 20 },
      parentRect: { x: 10, y: baseY, width: 680, height: 40000 },
      hrefPresent: true,
      observedPathname: `/${authorUid}/${postId}_${i}`,
      directTextPresent: true,
      observedDirectText: "10分钟前",
      goldRole: "timestamp_or_detail_anchor",
    });
    independentGoldRelations.push({
      sourceRef: `n_time_${i}`,
      targetRef: postRef,
      relation: "detail_entry_of",
      reviewStatus: "confirmed_gold",
    });

    // media_item (middle zone: offset +11000)
    addNode({
      nodeRef: `n_media_${i}`,
      rawParentRef: postRef,
      effectiveRetainedAncestorRef: postRef,
      basicKind: "image",
      tag: "img",
      rect: { x: 24, y: baseY + 11000, width: 160, height: 120 },
      parentRect: { x: 10, y: baseY, width: 680, height: 40000 },
      hrefPresent: false,
      directTextPresent: false,
      goldRole: "media_item",
    });
    independentGoldRelations.push({
      sourceRef: `n_media_${i}`,
      targetRef: postRef,
      relation: "media_of",
      reviewStatus: "confirmed_gold",
    });

    // In-post fulltext/topic link (`link_of` to post_root)
    addNode({
      nodeRef: `n_link_${i}`,
      rawParentRef: postRef,
      effectiveRetainedAncestorRef: postRef,
      basicKind: "button",
      tag: "a",
      rect: { x: 24, y: baseY + 13000, width: 80, height: 24 },
      parentRect: { x: 10, y: baseY, width: 680, height: 40000 },
      hrefPresent: true,
      observedPathname: `/status/${postId}_${i}`,
      directTextPresent: true,
      observedDirectText: "...全文",
      goldRole: "expand_body_toggle",
    });
    independentGoldRelations.push({
      sourceRef: `n_link_${i}`,
      targetRef: postRef,
      relation: "link_of",
      reviewStatus: "confirmed_gold",
    });

    // reposted_embedded_post (middle zone: offset +24000..32000)
    const hasEmbeddedChildren = i === 1;
    addNode({
      nodeRef: `n_repost_${i}`,
      rawParentRef: postRef,
      effectiveRetainedAncestorRef: postRef,
      basicKind: "container",
      tag: "div",
      rect: { x: 24, y: baseY + 24000, width: 600, height: 8000 },
      parentRect: { x: 10, y: baseY, width: 680, height: 40000 },
      shallowStructuralPeerRatio: 0.0,
      positiveAreaChildCount: hasEmbeddedChildren ? 2 : 0,
      childElementCount: hasEmbeddedChildren ? 2 : 0,
      childRefs: hasEmbeddedChildren ? ["n_repost_author_1", "n_repost_body_1"] : [],
      goldRole: "reposted_embedded_post",
    });
    independentGoldRelations.push({
      sourceRef: `n_repost_${i}`,
      targetRef: postRef,
      relation: "repost_of",
      reviewStatus: "confirmed_gold",
    });

    if (hasEmbeddedChildren) {
      addNode({
        nodeRef: "n_repost_author_1",
        rawParentRef: "n_repost_1",
        effectiveRetainedAncestorRef: "n_repost_1",
        basicKind: "link",
        tag: "a",
        rect: { x: 32, y: baseY + 24500, width: 90, height: 20 },
        parentRect: { x: 24, y: baseY + 24000, width: 600, height: 8000 },
        hrefPresent: true,
        observedPathname: `/u/orig_${authorUid}_1`,
        directTextPresent: true,
        observedDirectText: `@原作者_${authorUid}_1`,
        goldRole: "author_anchor",
      });
      independentGoldRelations.push({
        sourceRef: "n_repost_author_1",
        targetRef: "n_repost_1",
        relation: "author_of",
        reviewStatus: "confirmed_gold",
      });

      addNode({
        nodeRef: "n_repost_body_1",
        rawParentRef: "n_repost_1",
        effectiveRetainedAncestorRef: "n_repost_1",
        basicKind: "text",
        tag: "div",
        rect: { x: 32, y: baseY + 25800, width: 540, height: 70 },
        parentRect: { x: 24, y: baseY + 24000, width: 600, height: 8000 },
        hrefPresent: false,
        directTextPresent: true,
        observedDirectText:
          "这是被转发内嵌原帖的正文内容长度同样超过二十四个字符用于验证转发框与外层卡片隔离",
        childElementCount: 1,
        positiveAreaChildCount: 1,
        childRefs: ["n_expand_3"],
        goldRole: "post_body",
      });
      independentGoldRelations.push({
        sourceRef: "n_repost_body_1",
        targetRef: "n_repost_1",
        relation: "body_of",
        reviewStatus: "confirmed_gold",
      });

      addNode({
        nodeRef: "n_expand_3",
        rawParentRef: "n_repost_body_1",
        effectiveRetainedAncestorRef: "n_repost_body_1",
        basicKind: "button",
        tag: "span",
        rect: { x: 500, y: baseY + 25845, width: 56, height: 20 },
        parentRect: { x: 32, y: baseY + 25800, width: 540, height: 70 },
        hrefPresent: false,
        directTextPresent: true,
        observedDirectText: "...展开",
        goldRole: "expand_body_toggle",
      });
      independentGoldRelations.push({
        sourceRef: "n_expand_3",
        targetRef: "n_repost_body_1",
        relation: "expand_toggle_of",
        reviewStatus: "confirmed_gold",
      });
    }
  }

  const slots = nodes.map((n) => n.slotRow);
  const retainedNodes = nodes.map((n) => n.retainedRow);

  const goldRelByKey = new Map(
    independentGoldRelations.map((r) => [
      `${r.sourceRef}->${r.targetRef}`,
      r.relation,
    ]),
  );

  const resolvedMap = resolveRetainedNodesMap({ slots, retainedNodes });
  const pairGen = generateWeiboCandidatePairs(resolvedMap);
  const candidatePairAnnotations = pairGen.candidatePairs.map((cand) => {
    const key = `${cand.sourceRef}->${cand.targetRef}`;
    return {
      sourceRef: cand.sourceRef,
      targetRef: cand.targetRef,
      reviewStatus: "confirmed_gold",
      goldRelation: goldRelByKey.get(key) ?? "unrelated",
    };
  });

  return {
    snapshotId,
    usageScope: "synthetic_engineering_smoke",
    trainingEligible: true,
    autoGold: false,
    filterRecallStatus: "VERIFIED",
    sourceFamily: {
      captureSessionId,
      queryNormalized,
      canonicalPostIds: [postId],
      authorUids: [authorUid],
      pageKind: "mixed_search_and_reposts",
    },
    slots,
    retainedNodes,
    independentGoldRelations,
    candidatePairAnnotations,
  };
}

test("5. Full Stage 1 4-step cascade training, subprocess reload parity, 12 timing fields, stage-failure not_run stopping, and Stage 2 verification gate", async () => {
  mkdirSync(SMOKE_OUT_DIR, { recursive: true });
  const trainSnapshots = [
    buildSeparableSyntheticSnapshot({
      snapshotId: "smoke-train-1",
      captureSessionId: "sess-train-1",
      queryNormalized: "q-train-1",
      postId: "post-t1",
      authorUid: "uid-t1",
    }),
    buildSeparableSyntheticSnapshot({
      snapshotId: "smoke-train-2",
      captureSessionId: "sess-train-2",
      queryNormalized: "q-train-2",
      postId: "post-t2",
      authorUid: "uid-t2",
    }),
  ];
  const devSnapshots = [
    buildSeparableSyntheticSnapshot({
      snapshotId: "smoke-dev-1",
      captureSessionId: "sess-dev-1",
      queryNormalized: "q-dev-1",
      postId: "post-d1",
      authorUid: "uid-d1",
    }),
  ];

  const trainPath = join(SMOKE_OUT_DIR, "smoke-train.snapshots.json");
  const devPath = join(SMOKE_OUT_DIR, "smoke-dev.snapshots.json");
  if (!existsSync(trainPath)) {
    writeFileSync(trainPath, `${JSON.stringify(trainSnapshots, null, 2)}\n`, "utf8");
  }
  if (!existsSync(devPath)) {
    writeFileSync(devPath, `${JSON.stringify(devSnapshots, null, 2)}\n`, "utf8");
  }

  // 5a. Preserve existing smoke candidate in SMOKE_OUT_DIR without overwriting; only run if missing
  const stage1ReportPath = join(SMOKE_OUT_DIR, "stage1-training-report.json");
  const report = existsSync(stage1ReportPath)
    ? JSON.parse(readFileSync(stage1ReportPath, "utf8"))
    : await runW0aStage1Training({
        trainPath,
        devPath,
        handwiredRoot: HANDWIRED_ROOT,
        outDir: SMOKE_OUT_DIR,
        allowSyntheticEngineeringSmoke: true,
      });

  assert.equal(report.stage1Passed, true, `Stage 1 failed: ${JSON.stringify(report.steps, null, 2)}`);
  assert.equal(report.runKind, "synthetic_engineering_smoke_only");
  assert.equal(report.formalBenchmarkEligible, false);
  assert.equal(report.oneShotHoldoutConsumed, false);
  assert.equal(report.steps.datasetValidation.status, "passed");
  assert.equal(report.steps.stepA_roleFit.status, "passed");
  assert.equal(report.steps.stepB_roleReloadAndCascade.status, "passed");
  assert.equal(report.steps.stepB_roleReloadAndCascade.perRowParityMatched, true);
  assert.equal(report.steps.stepB_roleReloadAndCascade.maxAbsScoreDiff, 0);
  assert.equal(report.steps.stepC_relationFit.status, "passed");
  assert.equal(report.steps.stepD_fullReloadAndStage1Gate.status, "passed");
  assert.equal(report.steps.stepD_fullReloadAndStage1Gate.perRowParityMatched, true);
  assert.equal(report.steps.stepD_fullReloadAndStage1Gate.maxAbsScoreDiff, 0);

  // Verify all 12 timing fields exist and are finite nonnegative numbers on both units
  const expectedTimingKeys = [
    "featureExtractionMs",
    "circuitBuildMs",
    "forwardTotalMs",
    "lossTotalMs",
    "backwardTotalMs",
    "parameterUpdateTotalMs",
    "perEpochMeanMs",
    "weightSerializeMs",
    "subprocessReloadMs",
    "trainEvalMs",
    "devEvalMs",
    "totalWallMs",
  ];
  for (const key of expectedTimingKeys) {
    assert.equal(typeof report.roleTimingMs[key], "number", `Missing roleTimingMs.${key}`);
    assert.ok(Number.isFinite(report.roleTimingMs[key]) && report.roleTimingMs[key] >= 0);
    assert.equal(
      typeof report.relationTimingMs[key],
      "number",
      `Missing relationTimingMs.${key}`,
    );
    assert.ok(
      Number.isFinite(report.relationTimingMs[key]) && report.relationTimingMs[key] >= 0,
    );
  }

  // 5b. Verify Stage 2 evaluate-w0a-independent.mjs CLI blocks one_shot_verification
  // because runKind === "synthetic_engineering_smoke_only" (not formal_weibo_training)
  const blockedVerifReportPath = join(
    SMOKE_OUT_DIR,
    "blocked-one-shot-verification-report.json",
  );
  if (!existsSync(blockedVerifReportPath)) {
    let blockedExitNonZero = false;
    try {
      execFileSync(
        process.execPath,
        [
          "playground/browser/weibo-filtered-dom/w0a/evaluate-w0a-independent.mjs",
          "--dataset-path",
          devPath,
          "--split-kind",
          "one_shot_verification",
          "--role-weights",
          join(SMOKE_OUT_DIR, "weights/role-policy.w0a.json"),
          "--relation-weights",
          join(SMOKE_OUT_DIR, "weights/relation-policy.w0a.json"),
          "--out-report",
          blockedVerifReportPath,
        ],
        { stdio: "pipe" },
      );
    } catch {
      blockedExitNonZero = true;
    }
    assert.equal(blockedExitNonZero, true);
  }
  const blockedVerifReport = JSON.parse(readFileSync(blockedVerifReportPath, "utf8"));
  assert.equal(blockedVerifReport.verificationGateBlocked, true);
  assert.equal(blockedVerifReport.oneShotHoldoutConsumed, false);

  // 5c. Verify Stage 2 evaluate-w0a-independent.mjs CLI succeeds on development_diagnostic
  const devEvalReportPath = join(SMOKE_OUT_DIR, "dev-diagnostic-eval-report.json");
  if (!existsSync(devEvalReportPath)) {
    execFileSync(
      process.execPath,
      [
        "playground/browser/weibo-filtered-dom/w0a/evaluate-w0a-independent.mjs",
        "--dataset-path",
        devPath,
        "--split-kind",
        "development_diagnostic",
        "--role-weights",
        join(SMOKE_OUT_DIR, "weights/role-policy.w0a.json"),
        "--relation-weights",
        join(SMOKE_OUT_DIR, "weights/relation-policy.w0a.json"),
        "--out-report",
        devEvalReportPath,
      ],
      { stdio: "pipe" },
    );
  }
  const devEvalReport = JSON.parse(readFileSync(devEvalReportPath, "utf8"));
  assert.equal(devEvalReport.verificationPassed, true);
  assert.equal(devEvalReport.relationMetrics.repostAuthorContaminationRate, 0);

  // 5d. Verify Step B parity failure stops immediately and marks Step C and Step D as "not_run"
  const failStepBOutDir = join(SMOKE_OUT_DIR, "stepb-parity-failure-receipt");
  const failStepBReportPath = join(failStepBOutDir, "stage1-training-report.json");
  const failStepBReport = existsSync(failStepBReportPath)
    ? JSON.parse(readFileSync(failStepBReportPath, "utf8"))
    : await runW0aStage1Training({
        trainPath,
        devPath,
        handwiredRoot: HANDWIRED_ROOT,
        outDir: failStepBOutDir,
        allowSyntheticEngineeringSmoke: true,
        roleWeightsMutatorForTest: (roleWeightsPath) => {
          const raw = JSON.parse(readFileSync(roleWeightsPath, "utf8"));
          raw.weights[0][0] += 0.5; // Tamper on-disk weight so subprocess reload differs from in-memory
          writeFileSync(roleWeightsPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
        },
      });
  assert.equal(failStepBReport.stage1Passed, false);
  assert.equal(failStepBReport.steps.stepA_roleFit.status, "passed");
  assert.equal(failStepBReport.steps.stepB_roleReloadAndCascade.status, "failed");
  assert.equal(failStepBReport.steps.stepC_relationFit.status, "not_run");
  assert.equal(failStepBReport.steps.stepD_fullReloadAndStage1Gate.status, "not_run");
});

test("6. Audit Findings F1 & F2: conflicting gold relation/role rejection before Step A fitting, and Stage 2 one_shot_verification pre-scoring dataset & disjointness gate", async () => {
  const baseTrain1 = buildSeparableSyntheticSnapshot({
    snapshotId: "f1-train-1",
    captureSessionId: "f1-sess-t1",
    queryNormalized: "f1-q-t1",
    postId: "f1-post-t1",
    authorUid: "f1-uid-t1",
  });
  const baseDev1 = buildSeparableSyntheticSnapshot({
    snapshotId: "f1-dev-1",
    captureSessionId: "f1-sess-d1",
    queryNormalized: "f1-q-d1",
    postId: "f1-post-d1",
    authorUid: "f1-uid-d1",
  });

  // --- F1a: Mutate n_search_submit_1 -> n_search_input_1 in candidatePairAnnotations to "unrelated"
  // while independentGoldRelations keeps "submits_input_of" (confirmed_gold) ---
  const mutatedTrain = structuredClone(baseTrain1);
  const targetPa = mutatedTrain.candidatePairAnnotations.find(
    (pa) =>
      pa.sourceRef === "n_search_submit_1" && pa.targetRef === "n_search_input_1",
  );
  assert.ok(targetPa);
  targetPa.goldRelation = "unrelated";

  const valConflict = validateW0aDataset({
    trainSnapshots: [mutatedTrain],
    devSnapshots: [baseDev1],
    allowSyntheticEngineeringSmoke: true,
  });
  assert.equal(valConflict.valid, false);
  assert.ok(
    valConflict.violations.some(
      (v) =>
        v.code === "CONFLICTING_GOLD_RELATION_ANNOTATIONS" &&
        v.pairKey === "n_search_submit_1->n_search_input_1" &&
        v.independentRelation === "submits_input_of" &&
        v.candidatePairRelation === "unrelated",
    ),
  );

  // Also verify duplicate nodeRef role conflict and positive candidatePairAnnotation missing from independentGoldRelations
  const mutatedDupRole = structuredClone(baseTrain1);
  mutatedDupRole.retainedNodes.push(structuredClone(mutatedDupRole.retainedNodes[0]));
  const valDupRole = validateW0aDataset({
    trainSnapshots: [mutatedDupRole],
    devSnapshots: [baseDev1],
    allowSyntheticEngineeringSmoke: true,
  });
  assert.equal(valDupRole.valid, false);
  assert.ok(
    valDupRole.violations.some((v) => v.code === "CONFLICTING_GOLD_ROLE_ANNOTATIONS"),
  );

  const mutatedMissingIndep = structuredClone(baseTrain1);
  mutatedMissingIndep.independentGoldRelations =
    mutatedMissingIndep.independentGoldRelations.filter(
      (r) =>
        !(
          r.sourceRef === "n_search_submit_1" &&
          r.targetRef === "n_search_input_1"
        ),
    );
  const valMissingIndep = validateW0aDataset({
    trainSnapshots: [mutatedMissingIndep],
    devSnapshots: [baseDev1],
    allowSyntheticEngineeringSmoke: true,
  });
  assert.equal(valMissingIndep.valid, false);
  assert.ok(
    valMissingIndep.violations.some(
      (v) =>
        v.code === "CONFLICTING_GOLD_RELATION_ANNOTATIONS" &&
        v.pairKey === "n_search_submit_1->n_search_input_1",
    ),
  );

  // --- F1b: Direct evaluateW0aSnapshots call also rejects conflicting gold annotations ---
  const roleProfile = JSON.parse(
    readFileSync(join(SMOKE_OUT_DIR, "weights/role-policy.w0a.json"), "utf8"),
  );
  const relationProfile = JSON.parse(
    readFileSync(join(SMOKE_OUT_DIR, "weights/relation-policy.w0a.json"), "utf8"),
  );
  assert.throws(
    () =>
      evaluateW0aSnapshots({
        snapshots: [mutatedTrain],
        roleProfile,
        relationProfile,
      }),
    /CONFLICTING_GOLD_RELATION_ANNOTATIONS/,
  );

  // --- F1c: Prove runW0aStage1Training stops at datasetValidation BEFORE Step A numerical fitting ---
  const f1ReceiptDir = join(SMOKE_OUT_DIR, "f1-conflicting-gold-stopped-receipt");
  mkdirSync(f1ReceiptDir, { recursive: true });
  const f1TrainPath = join(f1ReceiptDir, "conflicting-train.snapshots.json");
  const f1DevPath = join(f1ReceiptDir, "clean-dev.snapshots.json");
  writeFileSync(f1TrainPath, `${JSON.stringify([mutatedTrain], null, 2)}\n`, "utf8");
  writeFileSync(f1DevPath, `${JSON.stringify([baseDev1], null, 2)}\n`, "utf8");

  const f1Stage1Report = await runW0aStage1Training({
    trainPath: f1TrainPath,
    devPath: f1DevPath,
    handwiredRoot: HANDWIRED_ROOT,
    outDir: f1ReceiptDir,
    allowSyntheticEngineeringSmoke: true,
  });
  assert.equal(f1Stage1Report.stage1Passed, false);
  assert.equal(f1Stage1Report.failureReason, "DATASET_VALIDATION_FAILED");
  assert.equal(f1Stage1Report.steps.datasetValidation.status, "failed");
  assert.ok(
    f1Stage1Report.steps.datasetValidation.violations.some(
      (v) => v.code === "CONFLICTING_GOLD_RELATION_ANNOTATIONS",
    ),
  );
  assert.equal(f1Stage1Report.steps.stepA_roleFit.status, "not_run");
  assert.equal(f1Stage1Report.steps.stepB_roleReloadAndCascade.status, "not_run");
  assert.equal(f1Stage1Report.steps.stepC_relationFit.status, "not_run");
  assert.equal(f1Stage1Report.steps.stepD_fullReloadAndStage1Gate.status, "not_run");
  assert.equal(existsSync(join(f1ReceiptDir, "weights/role-policy.w0a.json")), false);

  // --- F2: Stage 2 one_shot_verification pre-scoring dataset eligibility, Table 4.1 scale & disjointness gate ---
  const f2Dir = join(SMOKE_OUT_DIR, "f2-stage2-admission-fixtures");
  const f2WeightsDir = join(f2Dir, "weights");
  mkdirSync(f2WeightsDir, { recursive: true });

  const formalRoleWeightsPath = join(f2WeightsDir, "role-policy.w0a.json");
  const formalRelWeightsPath = join(f2WeightsDir, "relation-policy.w0a.json");
  writeFileSync(
    formalRoleWeightsPath,
    `${JSON.stringify(
      {
        ...roleProfile,
        profileId: "weibo.w0a.role-policy.v1",
        runKind: "formal_weibo_training",
        formalBenchmarkEligible: true,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(
    formalRelWeightsPath,
    `${JSON.stringify(
      {
        ...relationProfile,
        profileId: "weibo.w0a.relation-policy.v1",
        runKind: "formal_weibo_training",
        formalBenchmarkEligible: true,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // Build formal-scale synthetic train (14 pages, 6 families -> >= 42 post_root, >= 14 reposted_embedded_post, >= 14 other heads)
  // and dev (7 pages, 3 families -> >= 21 post_root, >= 7 reposted_embedded_post, >= 7 other heads)
  const buildFormalSnapshot = (prefix, idx, familyIdx) => {
    const snap = buildSeparableSyntheticSnapshot({
      snapshotId: `${prefix}-page-${idx}`,
      captureSessionId: `${prefix}-sess-f${familyIdx}`,
      queryNormalized: `${prefix}-query-f${familyIdx}`,
      postId: `${prefix}-post-f${familyIdx}`,
      authorUid: `${prefix}-uid-f${familyIdx}`,
    });
    snap.usageScope = "formal_weibo_benchmark";
    snap.trainingEligible = true;
    // Also set spoofed caller sourceFamilyId to prove validator ignores caller sourceFamilyId
    snap.sourceFamily.sourceFamilyId = `caller-spoof-${prefix}-${idx}`;
    return snap;
  };

  const formalTrainSnapshots = Array.from({ length: 14 }, (_, i) =>
    buildFormalSnapshot("train", i + 1, (i % 6) + 1),
  );
  const formalDevSnapshots = Array.from({ length: 7 }, (_, i) =>
    buildFormalSnapshot("dev", i + 1, (i % 3) + 1),
  );
  const formalTrainPath = join(f2Dir, "formal-train.snapshots.json");
  const formalDevPath = join(f2Dir, "formal-dev.snapshots.json");
  writeFileSync(
    formalTrainPath,
    `${JSON.stringify(formalTrainSnapshots, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    formalDevPath,
    `${JSON.stringify(formalDevSnapshots, null, 2)}\n`,
    "utf8",
  );

  const mockFormalStage1ReportPath = join(f2Dir, "stage1-training-report.json");
  writeFileSync(
    mockFormalStage1ReportPath,
    `${JSON.stringify(
      {
        kind: "nnanything.w0a.stage1-training-report.v1",
        runKind: "formal_weibo_training",
        formalBenchmarkEligible: true,
        allowSyntheticEngineeringSmoke: false,
        oneShotHoldoutConsumed: false,
        stage1Passed: true,
        trainPath: formalTrainPath,
        devPath: formalDevPath,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // Ensure the persistent cited receipts in SMOKE_OUT_DIR exist (without overwriting if already consumed)
  const ineligibleVerifPath = join(f2Dir, "ineligible-verification.snapshots.json");
  writeFileSync(
    ineligibleVerifPath,
    `${JSON.stringify([baseDev1], null, 2)}\n`,
    "utf8",
  );
  const f2aPersistentReportPath = join(
    SMOKE_OUT_DIR,
    "f2-verification-ineligible-consumed-report.json",
  );
  if (!existsSync(f2aPersistentReportPath)) {
    runW0aStage2Evaluation({
      datasetPath: ineligibleVerifPath,
      splitKind: "one_shot_verification",
      roleWeights: formalRoleWeightsPath,
      relationWeights: formalRelWeightsPath,
      stage1Report: mockFormalStage1ReportPath,
      outReport: f2aPersistentReportPath,
    });
  }

  const leakyVerifSnapshots = Array.from({ length: 7 }, (_, i) =>
    buildFormalSnapshot("verif", i + 1, (i % 3) + 1),
  );
  leakyVerifSnapshots[0].sourceFamily.sourceFamilyId = "completely-disjoint-spoof-id";
  leakyVerifSnapshots[0].sourceFamily.canonicalPostIds = ["train-post-f1"];
  const leakyVerifPath = join(f2Dir, "leaky-verification.snapshots.json");
  writeFileSync(
    leakyVerifPath,
    `${JSON.stringify(leakyVerifSnapshots, null, 2)}\n`,
    "utf8",
  );
  const f2bPersistentReportPath = join(
    SMOKE_OUT_DIR,
    "f2-verification-leakage-consumed-report.json",
  );
  if (!existsSync(f2bPersistentReportPath)) {
    runW0aStage2Evaluation({
      datasetPath: leakyVerifPath,
      splitKind: "one_shot_verification",
      roleWeights: formalRoleWeightsPath,
      relationWeights: formalRelWeightsPath,
      stage1Report: mockFormalStage1ReportPath,
      outReport: f2bPersistentReportPath,
    });
  }

  const cleanVerifSnapshots = Array.from({ length: 7 }, (_, i) =>
    buildFormalSnapshot("verif-clean", i + 1, (i % 3) + 1),
  );
  const cleanVerifPath = join(f2Dir, "clean-verification.snapshots.json");
  writeFileSync(
    cleanVerifPath,
    `${JSON.stringify(cleanVerifSnapshots, null, 2)}\n`,
    "utf8",
  );
  const f2cPersistentReportPath = join(f2Dir, "clean-verification-eval-report.json");
  if (!existsSync(f2cPersistentReportPath)) {
    runW0aStage2Evaluation({
      datasetPath: cleanVerifPath,
      splitKind: "one_shot_verification",
      roleWeights: formalRoleWeightsPath,
      relationWeights: formalRelWeightsPath,
      stage1Report: mockFormalStage1ReportPath,
      outReport: f2cPersistentReportPath,
    });
  }

  // Fresh deterministic test directory to verify first-time consumption AND second-time replay rejection
  // (append-only ledger + non-overwriting receipts across admission failure, threshold failure, and pass)
  const freshRoot = mkdtempSync(join(tmpdir(), "w0a-stage2-oneshot-"));
  try {
    const freshStage1ReportPath = join(freshRoot, "stage1-training-report.json");
    writeFileSync(
      freshStage1ReportPath,
      readFileSync(mockFormalStage1ReportPath, "utf8"),
      "utf8",
    );

    // F2a: Pass an ineligible / undersized verification split (synthetic_engineering_smoke + 1 page < Table 4.1 minPages=4)
    const freshIneligiblePath = join(freshRoot, "ineligible-verification.snapshots.json");
    writeFileSync(
      freshIneligiblePath,
      `${JSON.stringify([baseDev1], null, 2)}\n`,
      "utf8",
    );
    const f2aReportPath = join(freshRoot, "f2a-ineligible-report.json");
    const f2aRes = runW0aStage2Evaluation({
      datasetPath: freshIneligiblePath,
      splitKind: "one_shot_verification",
      roleWeights: formalRoleWeightsPath,
      relationWeights: formalRelWeightsPath,
      stage1Report: freshStage1ReportPath,
      outReport: f2aReportPath,
    });
    assert.equal(f2aRes.passed, false);
    assert.equal(f2aRes.receiptPath, f2aReportPath);
    assert.equal(f2aRes.report.verificationGateBlocked, false);
    assert.equal(f2aRes.report.verificationDatasetValidationFailed, true);
    assert.equal(f2aRes.report.oneShotHoldoutConsumed, true);
    assert.equal(f2aRes.report.verificationPassed, false);
    assert.equal(f2aRes.report.formalBenchmarkEligible, false);
    assert.equal(f2aRes.report.roleMetrics, undefined); // Must stop BEFORE scoring!
    const f2aCodes = new Set(
      f2aRes.report.datasetValidation.violations.map((v) => v.code),
    );
    assert.ok(f2aCodes.has("SYNTHETIC_SMOKE_FORBIDDEN_WITHOUT_FLAG"));
    assert.ok(f2aCodes.has("BELOW_MIN_SOURCE_FAMILIES"));
    assert.ok(f2aCodes.has("BELOW_MIN_SNAPSHOT_PAGES"));
    assert.ok(f2aCodes.has("BELOW_MIN_POST_ROOT_COUNT"));

    // Verify replay of F2a is rejected BEFORE opening/scoring and does NOT overwrite f2aReportPath
    const f2aOriginalContent = readFileSync(f2aReportPath, "utf8");
    // Corrupt freshIneligiblePath on disk to prove the replay check rejects BEFORE reading the dataset file
    writeFileSync(freshIneligiblePath, "{NOT_VALID_JSON", "utf8");
    const f2aReplaySameOut = runW0aStage2Evaluation({
      datasetPath: freshIneligiblePath,
      splitKind: "one_shot_verification",
      roleWeights: formalRoleWeightsPath,
      relationWeights: formalRelWeightsPath,
      stage1Report: freshStage1ReportPath,
      outReport: f2aReportPath,
    });
    assert.equal(f2aReplaySameOut.passed, false);
    assert.equal(f2aReplaySameOut.report.alreadyConsumedReplayRejected, true);
    assert.equal(f2aReplaySameOut.report.verificationGateBlocked, true);
    assert.equal(f2aReplaySameOut.report.oneShotHoldoutConsumed, true);
    assert.equal(f2aReplaySameOut.report.roleMetrics, undefined);
    assert.equal(f2aReplaySameOut.report.priorConsumedReceiptPath, f2aReportPath);
    assert.notEqual(f2aReplaySameOut.receiptPath, f2aReportPath);
    assert.equal(existsSync(f2aReplaySameOut.receiptPath), true);
    assert.equal(readFileSync(f2aReportPath, "utf8"), f2aOriginalContent);

    // Also verify replay of F2a with a brand-new outReport path is still rejected via the durable ledger
    const f2aReplayNewOutPath = join(freshRoot, "f2a-replay-different-out.json");
    const f2aReplayNewOut = runW0aStage2Evaluation({
      datasetPath: freshIneligiblePath,
      splitKind: "one_shot_verification",
      roleWeights: formalRoleWeightsPath,
      relationWeights: formalRelWeightsPath,
      stage1Report: freshStage1ReportPath,
      outReport: f2aReplayNewOutPath,
    });
    assert.equal(f2aReplayNewOut.passed, false);
    assert.equal(f2aReplayNewOut.report.alreadyConsumedReplayRejected, true);
    assert.equal(f2aReplayNewOut.report.priorConsumedReceiptPath, f2aReportPath);

    // F2b: Pass a formal-scale verification split (7 pages, 3 families) that spoofs sourceFamilyId
    // but shares canonicalPostIds with train[0] -> must fail with CROSS_PARTITION_SOURCE_FAMILY_LEAKAGE before scoring
    const freshLeakyPath = join(freshRoot, "leaky-verification.snapshots.json");
    writeFileSync(
      freshLeakyPath,
      `${JSON.stringify(leakyVerifSnapshots, null, 2)}\n`,
      "utf8",
    );
    const f2bReportPath = join(freshRoot, "f2b-leakage-report.json");
    const f2bRes = runW0aStage2Evaluation({
      datasetPath: freshLeakyPath,
      splitKind: "one_shot_verification",
      roleWeights: formalRoleWeightsPath,
      relationWeights: formalRelWeightsPath,
      stage1Report: freshStage1ReportPath,
      outReport: f2bReportPath,
    });
    assert.equal(f2bRes.passed, false);
    assert.equal(f2bRes.report.verificationGateBlocked, false);
    assert.equal(f2bRes.report.verificationDatasetValidationFailed, true);
    assert.equal(f2bRes.report.oneShotHoldoutConsumed, true);
    assert.equal(f2bRes.report.verificationPassed, false);
    assert.equal(f2bRes.report.formalBenchmarkEligible, false);
    assert.equal(f2bRes.report.roleMetrics, undefined); // Stopped before scoring!
    assert.ok(
      f2bRes.report.datasetValidation.violations.some(
        (v) =>
          v.code === "CROSS_PARTITION_SOURCE_FAMILY_LEAKAGE" &&
          v.splits.includes("train") &&
          v.splits.includes("verification"),
      ),
    );

    // F2c: Clean, disjoint, formal-scale verification split passes dataset admission and proceeds to scoring
    const freshCleanPath = join(freshRoot, "clean-verification.snapshots.json");
    writeFileSync(
      freshCleanPath,
      `${JSON.stringify(cleanVerifSnapshots, null, 2)}\n`,
      "utf8",
    );
    const f2cReportPath = join(freshRoot, "clean-verification-eval-report.json");
    const f2cRes = runW0aStage2Evaluation({
      datasetPath: freshCleanPath,
      splitKind: "one_shot_verification",
      roleWeights: formalRoleWeightsPath,
      relationWeights: formalRelWeightsPath,
      stage1Report: freshStage1ReportPath,
      outReport: f2cReportPath,
    });
    assert.equal(f2cRes.passed, true);
    assert.equal(f2cRes.receiptPath, f2cReportPath);
    assert.equal(f2cRes.report.verificationGateBlocked, false);
    assert.equal(f2cRes.report.verificationDatasetValidationFailed, false);
    assert.equal(f2cRes.report.oneShotHoldoutConsumed, true);
    assert.equal(f2cRes.report.verificationPassed, true);
    assert.equal(f2cRes.report.formalBenchmarkEligible, true);
    assert.equal(f2cRes.report.datasetValidation.valid, true);

    // Delete freshCleanPath after first consumption to prove second invocation via API and CLI
    // rejects BEFORE attempting to open/score the holdout and preserves f2cReportPath unchanged
    const f2cOriginalContent = readFileSync(f2cReportPath, "utf8");
    rmSync(freshCleanPath, { force: true });
    const f2cReplayRes = runW0aStage2Evaluation({
      datasetPath: freshCleanPath,
      splitKind: "one_shot_verification",
      roleWeights: formalRoleWeightsPath,
      relationWeights: formalRelWeightsPath,
      stage1Report: freshStage1ReportPath,
      outReport: f2cReportPath,
    });
    assert.equal(f2cReplayRes.passed, false);
    assert.equal(f2cReplayRes.report.alreadyConsumedReplayRejected, true);
    assert.equal(f2cReplayRes.report.verificationGateBlocked, true);
    assert.equal(f2cReplayRes.report.oneShotHoldoutConsumed, true);
    assert.equal(f2cReplayRes.report.roleMetrics, undefined);
    assert.notEqual(f2cReplayRes.receiptPath, f2cReportPath);
    assert.equal(existsSync(f2cReplayRes.receiptPath), true);
    assert.equal(readFileSync(f2cReportPath, "utf8"), f2cOriginalContent);

    // Also invoke CLI subprocess on the already-consumed clean holdout -> must exit non-zero and preserve f2cReportPath
    let cliReplayExitedNonZero = false;
    try {
      execFileSync(
        process.execPath,
        [
          "playground/browser/weibo-filtered-dom/w0a/evaluate-w0a-independent.mjs",
          "--dataset-path",
          freshCleanPath,
          "--split-kind",
          "one_shot_verification",
          "--role-weights",
          formalRoleWeightsPath,
          "--relation-weights",
          formalRelWeightsPath,
          "--stage1-report",
          freshStage1ReportPath,
          "--out-report",
          f2cReportPath,
        ],
        { stdio: "pipe" },
      );
    } catch {
      cliReplayExitedNonZero = true;
    }
    assert.equal(cliReplayExitedNonZero, true);
    assert.equal(readFileSync(f2cReportPath, "utf8"), f2cOriginalContent);
    assert.equal(existsSync(`${f2cReportPath}.replay-rejected-2.json`), true);

    // F2d: Threshold-failing one_shot_verification split is also durably consumed and rejects replay
    const zeroRoleWeightsPath = join(freshRoot, "zero-role-policy.w0a.json");
    writeFileSync(
      zeroRoleWeightsPath,
      `${JSON.stringify(
        {
          ...roleProfile,
          profileId: "weibo.w0a.role-policy.v1",
          runKind: "formal_weibo_training",
          formalBenchmarkEligible: true,
          weights: roleProfile.weights.map((row) => row.map(() => 0)),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const thresholdFailVerifPath = join(freshRoot, "threshold-fail-verification.snapshots.json");
    writeFileSync(
      thresholdFailVerifPath,
      `${JSON.stringify(cleanVerifSnapshots, null, 2)}\n`,
      "utf8",
    );
    const f2dReportPath = join(freshRoot, "threshold-fail-eval-report.json");
    const f2dRes = runW0aStage2Evaluation({
      datasetPath: thresholdFailVerifPath,
      splitKind: "one_shot_verification",
      roleWeights: zeroRoleWeightsPath,
      relationWeights: formalRelWeightsPath,
      stage1Report: freshStage1ReportPath,
      outReport: f2dReportPath,
    });
    assert.equal(f2dRes.passed, false);
    assert.equal(f2dRes.report.verificationGateBlocked, false);
    assert.equal(f2dRes.report.verificationDatasetValidationFailed, false);
    assert.equal(f2dRes.report.oneShotHoldoutConsumed, true);
    assert.equal(f2dRes.report.verificationPassed, false);
    assert.equal(
      f2dRes.report.partitionStatus,
      "failed_one_shot_verification_do_not_reuse_if_inspected",
    );
    const f2dOriginalContent = readFileSync(f2dReportPath, "utf8");
    const f2dReplayRes = runW0aStage2Evaluation({
      datasetPath: thresholdFailVerifPath,
      splitKind: "one_shot_verification",
      roleWeights: formalRoleWeightsPath,
      relationWeights: formalRelWeightsPath,
      stage1Report: freshStage1ReportPath,
      outReport: f2dReportPath,
    });
    assert.equal(f2dReplayRes.passed, false);
    assert.equal(f2dReplayRes.report.alreadyConsumedReplayRejected, true);
    assert.equal(f2dReplayRes.report.roleMetrics, undefined);
    assert.equal(readFileSync(f2dReportPath, "utf8"), f2dOriginalContent);

    // Check append-only ledger in freshRoot has strictly accumulated all open/complete/replay events
    const ledgerPath = join(freshRoot, "one-shot-verification-consumed.jsonl");
    assert.equal(existsSync(ledgerPath), true);
    const ledgerLines = readFileSync(ledgerPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(ledgerLines.length >= 12);
    assert.ok(ledgerLines.some((e) => e.event === "holdout_opened_and_consumed"));
    assert.ok(ledgerLines.some((e) => e.event === "holdout_consumption_completed"));
    assert.ok(ledgerLines.some((e) => e.event === "replay_rejected_before_open"));
  } finally {
    rmSync(freshRoot, { recursive: true, force: true });
  }
});
