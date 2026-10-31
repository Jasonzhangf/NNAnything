import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BASIC_KIND_PROFILE,
} from "nnanything/browser-classify";
import {
  WEIBO_W0A_ROLE_HEADS,
  WEIBO_W0A_RELATION_HEADS,
  WEIBO_W0A_ROLE_WIRES,
  WEIBO_W0A_RELATION_WIRES,
} from "../dist/filters/weibo-filtered-dom-contract.js";
import {
  resolveRetainedNodesMap,
  extractWeiboRoleWires36,
} from "../dist/filters/weibo-filtered-dom-w0a.js";
import {
  SUPPORTED_WEIBO_HOSTS,
  resolveWeiboHrefObservation,
  resolveWeiboDirectTextObservation,
  normalizeWeiboAuthorUid,
  normalizeWeiboCanonicalPostId,
  normalizeWeiboSearchQuery,
  extractDeterministicWeiboSourceFamily,
  buildWeiboW0aRawCaptureFromLiveDom,
  applyDualTrackGoldAnnotations,
} from "../playground/browser/weibo-filtered-dom/w0a/build-w0a-capture-snapshot.mjs";
import {
  validateW0aDataset,
} from "../playground/browser/weibo-filtered-dom/w0a/validate-w0a-dataset.mjs";
import {
  evaluateW0aSnapshots,
} from "../playground/browser/weibo-filtered-dom/w0a/evaluate-w0a-independent.mjs";

const BASE_STYLE = Object.freeze({
  display: "block",
  visibility: "visible",
  position: "static",
  transform: "none",
  translate: "none",
  rotate: "none",
  scale: "none",
  perspective: "none",
  overflowX: "visible",
  overflowY: "visible",
  clipPath: "none",
  clip: "auto",
  opacity: "1",
  zIndex: "auto",
  pointerEvents: "auto",
  cursor: "auto",
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  borderTopStyle: "none",
  borderRightStyle: "none",
  borderBottomStyle: "none",
  borderLeftStyle: "none",
  borderTopColor: "rgba(0, 0, 0, 0)",
  borderRightColor: "rgba(0, 0, 0, 0)",
  borderBottomColor: "rgba(0, 0, 0, 0)",
  borderLeftColor: "rgba(0, 0, 0, 0)",
  borderTopLeftRadius: "0px",
  borderTopRightRadius: "0px",
  borderBottomLeftRadius: "0px",
  borderBottomRightRadius: "0px",
  backgroundColor: "rgba(0, 0, 0, 0)",
  backgroundImage: "none",
  backgroundClip: "border-box",
  maskImage: "none",
  webkitMaskImage: "none",
  backdropFilter: "none",
  webkitBackdropFilter: "none",
  filter: "none",
  mixBlendMode: "normal",
  isolation: "auto",
  contain: "none",
  content: "none",
});

function createTextNode(text) {
  return {
    nodeType: 3,
    textContent: text,
  };
}

function createSyntheticElement(
  tagName,
  {
    id = "",
    attrs = {},
    rect = { x: 20, y: 20, width: 320, height: 48 },
    styleOverrides = {},
    directText = null,
    children = [],
    extraProps = {},
  } = {},
) {
  const attrMap = new Map(Object.entries(attrs));
  const style = { ...BASE_STYLE, ...styleOverrides };
  const childNodes = [];
  if (typeof directText === "string") {
    childNodes.push(createTextNode(directText));
  }
  for (const child of children) {
    childNodes.push(child);
  }
  const el = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    namespaceURI: "http://www.w3.org/1999/xhtml",
    isContentEditable: false,
    tabIndex: -1,
    id,
    classList: [],
    parentElement: null,
    children: [...children],
    childNodes,
    childElementCount: children.length,
     __style: style,
    matches: () => false,
    querySelectorAll: () => [],
    hasAttribute: (name) => attrMap.has(name),
    getAttribute: (name) => (attrMap.has(name) ? attrMap.get(name) : null),
    getAttributeNames: () => [...attrMap.keys()],
    getBoundingClientRect: () => ({ ...rect }),
    getClientRects: () => (rect.width > 0 && rect.height > 0 ? [{ ...rect }] : []),
    ...extraProps,
  };
  for (const child of children) {
    child.parentElement = el;
  }
  return el;
}

function buildOfflineWeiboCaptureFixtureDom({
  baseURI = "https://cdn.evil.example/assets/base-subpath",
  locationHref = "https://s.weibo.com/weibo?q=%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD",
} = {}) {
  let inputValueGetterCalls = 0;
  const searchInput = createSyntheticElement("INPUT", {
    attrs: {
      type: "text",
      placeholder: "搜索微博",
      role: "searchbox",
    },
    rect: { x: 24, y: 12, width: 260, height: 32 },
    styleOverrides: {
      borderTopWidth: "1px",
      borderTopStyle: "solid",
      borderTopColor: "rgb(200, 200, 200)",
      backgroundColor: "rgb(255, 255, 255)",
    },
  });
  Object.defineProperty(searchInput, "value", {
    get() {
      inputValueGetterCalls += 1;
      return "敏感未提交输入";
    },
  });

  // Author link (Branch D valid 1-segment /u/<uid> path)
  const authorLink = createSyntheticElement("A", {
    attrs: { href: "https://weibo.com/u/1642591402" },
    directText: "@测试科技博主",
    rect: { x: 40, y: 70, width: 120, height: 24 },
    styleOverrides: { cursor: "pointer" },
  });

  // Timestamp / canonical post link (Branch D valid 2-segment /<uid>/<bid> path)
  const timeLink = createSyntheticElement("A", {
    attrs: { href: "https://weibo.com/1642591402/Pabc123XY" },
    directText: "10分钟前",
    rect: { x: 170, y: 70, width: 90, height: 24 },
    styleOverrides: { cursor: "pointer" },
  });

  // Folded ignore wrapper around post body text (tests folded_ignore_wrapper bridging)
  const postBodyLeaf = createSyntheticElement("P", {
    directText:
      "这是一条关于人工智能与浏览器只读DOM语义过滤的完整微博正文内容，长度超过三十个字符以激活长文本与主体角色特征。",
    rect: { x: 40, y: 104, width: 520, height: 64 },
  });
  const foldedWrapper = createSyntheticElement("DIV", {
    rect: { x: 40, y: 104, width: 520, height: 64 },
    children: [postBodyLeaf],
  });

  // Excluded candidate inside the card (display: none -> zero rect, excluded_candidate)
  const excludedHiddenChild = createSyntheticElement("SPAN", {
    directText: "隐藏调试节点",
    rect: { x: 0, y: 0, width: 0, height: 0 },
    styleOverrides: { display: "none" },
  });

  // Branch B empty href="", Branch B whitespace href="   ", Branch C hash href="#repost"
  const emptyHrefAnchor = createSyntheticElement("A", {
    attrs: { href: "" },
    directText: "空链接锚点",
    rect: { x: 40, y: 180, width: 80, height: 22 },
    styleOverrides: { cursor: "pointer" },
  });
  const blankHrefAnchor = createSyntheticElement("A", {
    attrs: { href: "   " },
    directText: "空白链接锚点",
    rect: { x: 130, y: 180, width: 90, height: 22 },
    styleOverrides: { cursor: "pointer" },
  });
  const hashHrefAnchor = createSyntheticElement("A", {
    attrs: { href: "#repost" },
    directText: "转发 12",
    rect: { x: 230, y: 180, width: 80, height: 22 },
    styleOverrides: { cursor: "pointer" },
  });

  // L1 unknown:other candidate node: a generic custom tag with visible border/background
  // or structural ambiguity that remains an active_retained candidate
  const customUnknownNode = createSyntheticElement("SECTION", {
    attrs: { role: "region", "aria-label": "扩展卡片区" },
    rect: { x: 40, y: 210, width: 520, height: 36 },
    styleOverrides: {
      backgroundColor: "rgb(245, 246, 248)",
      borderTopWidth: "1px",
      borderTopStyle: "solid",
      borderTopColor: "rgb(220, 220, 220)",
    },
  });

  // Card 1: has >=3 positive-area children so w20_ancestor_within_2_has_3_children activates
  const postCard1 = createSyntheticElement("ARTICLE", {
    attrs: { role: "article" },
    rect: { x: 24, y: 60, width: 560, height: 200 },
    styleOverrides: {
      backgroundColor: "rgb(255, 255, 255)",
      borderTopWidth: "1px",
      borderTopStyle: "solid",
      borderTopColor: "rgb(230, 230, 230)",
    },
    children: [
      authorLink,
      timeLink,
      foldedWrapper,
      excludedHiddenChild,
      emptyHrefAnchor,
      blankHrefAnchor,
      hashHrefAnchor,
      customUnknownNode,
    ],
  });

  // Card 2 & Card 3: sibling ARTICLES with identical shallow child tag signatures
  // so shallowStructuralPeerRatio >= 0.5 (w17 = 1) is measured on live DOM
  const peerCard2Child1 = createSyntheticElement("A", {
    attrs: { href: "https://weibo.com/u/1642591402" },
    directText: "@测试科技博主",
    rect: { x: 40, y: 280, width: 120, height: 24 },
    styleOverrides: { cursor: "pointer" },
  });
  const peerCard2Child2 = createSyntheticElement("A", {
    attrs: { href: "https://weibo.com/1642591402/Pabc123XY" },
    directText: "8分钟前",
    rect: { x: 170, y: 280, width: 90, height: 24 },
    styleOverrides: { cursor: "pointer" },
  });
  const peerCard2Child3 = createSyntheticElement("DIV", {
    directText: "第二条同结构卡片摘要内容，用于构造成对同级浅层结构同伴。",
    rect: { x: 40, y: 312, width: 520, height: 48 },
  });
  const postCard2 = createSyntheticElement("ARTICLE", {
    attrs: { role: "article" },
    rect: { x: 24, y: 270, width: 560, height: 110 },
    styleOverrides: {
      backgroundColor: "rgb(255, 255, 255)",
      borderTopWidth: "1px",
      borderTopStyle: "solid",
      borderTopColor: "rgb(230, 230, 230)",
    },
    children: [peerCard2Child1, peerCard2Child2, peerCard2Child3],
  });

  const peerCard3Child1 = createSyntheticElement("A", {
    attrs: { href: "https://weibo.com/u/1642591402" },
    directText: "@测试科技博主",
    rect: { x: 40, y: 400, width: 120, height: 24 },
    styleOverrides: { cursor: "pointer" },
  });
  const peerCard3Child2 = createSyntheticElement("A", {
    attrs: { href: "https://weibo.com/1642591402/Pabc123XY" },
    directText: "5分钟前",
    rect: { x: 170, y: 400, width: 90, height: 24 },
    styleOverrides: { cursor: "pointer" },
  });
  const peerCard3Child3 = createSyntheticElement("DIV", {
    directText: "第三条同结构卡片摘要内容，确保同级结构重复比达到三分之二以上。",
    rect: { x: 40, y: 432, width: 520, height: 48 },
  });
  const postCard3 = createSyntheticElement("ARTICLE", {
    attrs: { role: "article" },
    rect: { x: 24, y: 390, width: 560, height: 110 },
    styleOverrides: {
      backgroundColor: "rgb(255, 255, 255)",
      borderTopWidth: "1px",
      borderTopStyle: "solid",
      borderTopColor: "rgb(230, 230, 230)",
    },
    children: [peerCard3Child1, peerCard3Child2, peerCard3Child3],
  });

  const feedMain = createSyntheticElement("MAIN", {
    attrs: { role: "main" },
    rect: { x: 16, y: 52, width: 580, height: 470 },
    children: [postCard1, postCard2, postCard3],
  });

  const body = createSyntheticElement("BODY", {
    rect: { x: 0, y: 0, width: 1280, height: 900 },
    children: [searchInput, feedMain],
  });

  const html = createSyntheticElement("HTML", {
    rect: { x: 0, y: 0, width: 1280, height: 900 },
    children: [body],
  });

  const document = {
    documentElement: html,
    body,
    baseURI,
    activeElement: null,
  };
  const window = {
    innerWidth: 1280,
    innerHeight: 900,
    location: { href: locationHref },
    getComputedStyle: (el) => el?.__style ?? BASE_STYLE,
  };

  return {
    document,
    window,
    getInputValueGetterCalls: () => inputValueGetterCalls,
    elements: {
      searchInput,
      authorLink,
      timeLink,
      foldedWrapper,
      postBodyLeaf,
      excludedHiddenChild,
      emptyHrefAnchor,
      blankHrefAnchor,
      hashHrefAnchor,
      customUnknownNode,
      postCard1,
      postCard2,
      postCard3,
    },
  };
}

test("Test 1: Offline DOM consumer end-to-end assembly covers 5-branch href, registry binding, live explorationInputs, and zero <input>.value reads", () => {
  // 1A. Direct 5-branch href unit verification (CE-Capture-Href-EmptyAndHash)
  const topicBaseURI = "https://s.weibo.com/weibo/topic";
  const b0 = resolveWeiboHrefObservation({
    hasHrefAttribute: null,
    rawHref: null,
    baseURI: topicBaseURI,
  });
  assert.equal(b0.hrefPresent, null);
  assert.equal(b0.measurementCoverageHrefPresent, "unmeasured");
  assert.equal(b0.observedPathname, null);

  const bA = resolveWeiboHrefObservation({
    hasHrefAttribute: false,
    rawHref: null,
    baseURI: topicBaseURI,
  });
  assert.equal(bA.hrefPresent, false);
  assert.equal(bA.measurementCoverageHrefPresent, "measured");
  assert.equal(bA.observedPathname, null);

  const bBEmpty = resolveWeiboHrefObservation({
    hasHrefAttribute: true,
    rawHref: "",
    baseURI: topicBaseURI,
  });
  assert.equal(bBEmpty.hrefPresent, true);
  assert.equal(bBEmpty.observedPathname, "");

  const bBBlank = resolveWeiboHrefObservation({
    hasHrefAttribute: true,
    rawHref: "   ",
    baseURI: topicBaseURI,
  });
  assert.equal(bBBlank.hrefPresent, true);
  assert.equal(bBBlank.observedPathname, "");

  const bCHash = resolveWeiboHrefObservation({
    hasHrefAttribute: true,
    rawHref: "#repost",
    baseURI: topicBaseURI,
  });
  assert.equal(bCHash.hrefPresent, true);
  assert.equal(bCHash.observedPathname, "");

  const bCJs = resolveWeiboHrefObservation({
    hasHrefAttribute: true,
    rawHref: "javascript:void(0)",
    baseURI: topicBaseURI,
  });
  assert.equal(bCJs.hrefPresent, true);
  assert.equal(bCJs.observedPathname, "");

  const bD = resolveWeiboHrefObservation({
    hasHrefAttribute: true,
    rawHref: "/1234567890/Pxyz987",
    baseURI: topicBaseURI,
  });
  assert.equal(bD.hrefPresent, true);
  assert.equal(bD.observedPathname, "/1234567890/Pxyz987");

  // 1B. End-to-end buildWeiboW0aRawCaptureFromLiveDom on offline DOM tree
  // Verify pageUrl is taken from window.location.href (not poisoned document.baseURI)
  const dom = buildOfflineWeiboCaptureFixtureDom({
    baseURI: "https://cdn.evil.example/assets/subpath",
    locationHref: "https://s.weibo.com/weibo?q=%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD",
  });

  const defaultProfileCapture = buildWeiboW0aRawCaptureFromLiveDom({
    document: dom.document,
    window: dom.window,
    snapshotId: "snap-capture1c-default-l1",
  });
  assert.equal(defaultProfileCapture.l1ProfileId, "dom-basic-kinds-handwritten-v2");

  const l1ProfileWithIgnore = {
    ...DEFAULT_BASIC_KIND_PROFILE,
    id: "dom-basic-kinds-handwritten-v2-ignore-fold",
    familyWeights: {
      ...DEFAULT_BASIC_KIND_PROFILE.familyWeights,
      structure: {
        ...DEFAULT_BASIC_KIND_PROFILE.familyWeights.structure,
        neutral_single_element_wrapper: 0.9,
      },
    },
    leafWeights: {
      ...DEFAULT_BASIC_KIND_PROFILE.leafWeights,
      container: {
        ...DEFAULT_BASIC_KIND_PROFILE.leafWeights.container,
        div_single_child: 0,
        neutral_single_element_wrapper: -0.3,
      },
      ignore: {
        ...DEFAULT_BASIC_KIND_PROFILE.leafWeights.ignore,
        neutral_single_element_wrapper: 0.95,
      },
    },
  };

  const rawCapture = buildWeiboW0aRawCaptureFromLiveDom({
    document: dom.document,
    window: dom.window,
    snapshotId: "snap-capture1c-001",
    l1Profile: l1ProfileWithIgnore,
    sourceFamily: {
      sourceFamilyId: "sf-capture1c-001",
      pageKind: "search_results",
      outerPostUrls: ["https://weibo.com/1642591402/Pabc123XY"],
      authorUrls: ["https://weibo.com/u/1642591402"],
    },
  });

  // Zero <input>.value reads under readContent: false
  assert.equal(dom.getInputValueGetterCalls(), 0);
  assert.equal(rawCapture.contract, "weibo.w0a.snapshot.v1");
  assert.equal(rawCapture.l1ProfileId, "dom-basic-kinds-handwritten-v2-ignore-fold");
  assert.equal(rawCapture.usageScope, "diagnostic_development_only");
  assert.equal(rawCapture.trainingEligible, false);
  assert.equal(rawCapture.autoGold, false);
  assert.equal(
    rawCapture.pageUrl,
    "https://s.weibo.com/weibo?q=%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD",
  );
  assert.equal(rawCapture.sourceFamily.queryNormalized, "人工智能");

  // Verify live explorationInputs are preserved with directChildrenStatus === "complete"
  for (const slot of rawCapture.slots) {
    assert.equal(
      slot.explorationInput.childComposition.directChildrenStatus,
      "complete",
    );
    assert.equal(
      slot.explorationInput.measurementCoverage.directChildren,
      "complete",
    );
  }

  // Verify dispositions: excluded_candidate, folded_ignore_wrapper, and active_retained (including unknown:other)
  const dispositions = new Set(rawCapture.slots.map((s) => s.sidecar.disposition));
  assert.ok(dispositions.has("excluded_candidate"), "must contain excluded_candidate slot");
  assert.ok(dispositions.has("folded_ignore_wrapper"), "must contain folded_ignore_wrapper slot");
  assert.ok(dispositions.has("active_retained"), "must contain active_retained slots");

  const unknownRetained = rawCapture.retainedNodes.find((n) =>
    n.effectiveL1.startsWith("unknown:"),
  );
  assert.ok(unknownRetained, "must preserve L1 unknown:other node in retainedNodes");

  // Verify descendant bridging across folded_ignore_wrapper and role wire extraction
  const resolvedMap = resolveRetainedNodesMap(rawCapture);
  const allSlotsByRef = new Map(rawCapture.slots.map((s) => [s.nodeRef, s]));

  const slotByDirectText = new Map(
    rawCapture.slots
      .filter((s) => s.sidecar.observedDirectText)
      .map((s) => [s.sidecar.observedDirectText.trim(), s]),
  );

  // Post body leaf inside folded_ignore_wrapper bridges up to the card container
  const bodySlot = slotByDirectText.get(
    "这是一条关于人工智能与浏览器只读DOM语义过滤的完整微博正文内容，长度超过三十个字符以激活长文本与主体角色特征。",
  );
  assert.ok(bodySlot, "postBodyLeaf must be bound via registry.resolveElement");
  assert.equal(bodySlot.sidecar.disposition, "active_retained");
  const bodyResolved = resolvedMap.get(bodySlot.nodeRef);
  assert.ok(bodyResolved);
  assert.equal(bodyResolved.collapsedWrapperHopCount, 1, "postBodyLeaf must bridge across 1 folded_ignore_wrapper");
  const bodyWires = extractWeiboRoleWires36(bodySlot.nodeRef, resolvedMap, allSlotsByRef);
  assert.equal(bodyWires.w20_ancestor_and_subcontainer_text_known, 1, "w20 must be 1 via bridged ancestor with complete text/href coverage");
  assert.equal(bodyWires.w34_href_url_parsed_known, 1, "non-link <p> has w34=1 (known no href)");
  assert.equal(bodyWires.w35_has_multi_segment_http_href, 0, "non-link <p> has w35=0");

  // Empty href="", blank href="   ", and hash href="#repost" must have observedPathname === "" and (w34, w35) = (0, 0)
  for (const label of ["空链接锚点", "空白链接锚点", "转发 12"]) {
    const anchorSlot = slotByDirectText.get(label);
    assert.ok(anchorSlot, `anchor slot ${label} must exist`);
    assert.equal(anchorSlot.itemObservation.hrefPresent, true);
    assert.equal(anchorSlot.sidecar.observedPathname, "");
    const wires = extractWeiboRoleWires36(anchorSlot.nodeRef, resolvedMap, allSlotsByRef);
    assert.equal(wires.w34_href_url_parsed_known, 0, `${label} must have w34=0`);
    assert.equal(wires.w35_has_multi_segment_http_href, 0, `${label} must have w35=0`);
  }

  // Valid 2-segment post link has observedPathname === "/1642591402/Pabc123XY" and (w34, w35) = (1, 1)
  const timeSlot = slotByDirectText.get("10分钟前");
  assert.ok(timeSlot);
  assert.equal(timeSlot.sidecar.observedPathname, "/1642591402/Pabc123XY");
  const timeWires = extractWeiboRoleWires36(timeSlot.nodeRef, resolvedMap, allSlotsByRef);
  assert.equal(timeWires.w34_href_url_parsed_known, 1);
  assert.equal(timeWires.w35_has_multi_segment_http_href, 1);
  assert.equal(timeWires.w20_ancestor_and_subcontainer_text_known, 1);

  // Verify w17_peer_ratio_known and w19_in_repeating_peer_parent activate on sibling peer cards
  const anyW19Active = rawCapture.retainedNodes.some((n) => {
    const w = extractWeiboRoleWires36(n.nodeRef, resolvedMap, allSlotsByRef);
    return w.w17_peer_ratio_known === 1 && w.w19_in_repeating_peer_parent === 1;
  });
  assert.equal(anyW19Active, true, "w17 and w19 must activate when live explorationInputs and itemObservations are preserved");

  // Verify explicit file-based l1ProfilePath error handling (never falls back to default weights)
  assert.throws(
    () =>
      buildWeiboW0aRawCaptureFromLiveDom({
        document: dom.document,
        window: dom.window,
        snapshotId: "snap-bad-profile",
        l1ProfilePath: "/nonexistent/path/to/l1-profile.json",
      }),
    /ENOENT/,
  );
});

test("Test 2: applyDualTrackGoldAnnotations reuses single assertConsistentSnapshotGold, preserves rawSnapshot on conflict/rejection, and promotes valid snapshot", () => {
  const dom = buildOfflineWeiboCaptureFixtureDom();
  const rawSnapshot = buildWeiboW0aRawCaptureFromLiveDom({
    document: dom.document,
    window: dom.window,
    snapshotId: "snap-capture1c-gold",
    sourceFamily: {
      sourceFamilyId: "sf-gold-001",
      pageKind: "search_results",
      outerPostUrls: ["https://weibo.com/1642591402/Pabc123XY"],
      authorUrls: ["https://weibo.com/u/1642591402"],
    },
  });

  const rawSnapshotBeforeJson = JSON.stringify(rawSnapshot);

  // 2A. Role annotation conflict (array goldRole) is rejected by single assertConsistentSnapshotGold
  // and leaves rawSnapshot completely untouched.
  const firstNodeRef = rawSnapshot.retainedNodes[0].nodeRef;
  assert.throws(
    () =>
      applyDualTrackGoldAnnotations({
        rawSnapshot,
        roleAnnotationsByNodeRef: {
          [firstNodeRef]: {
            reviewStatus: "confirmed_gold",
            goldRole: ["post_root", "post_body"],
          },
        },
        promoteToFormalBenchmark: false,
      }),
    /CONFLICTING_GOLD_ROLE_ANNOTATIONS/,
  );
  assert.equal(JSON.stringify(rawSnapshot), rawSnapshotBeforeJson);

  // 2B. Dual-track relation conflict (positive relation in independentGoldRelations
  // vs "unrelated" override in candidatePairAnnotations) is rejected and preserves rawSnapshot.
  const samplePair = rawSnapshot.candidatePairAnnotations[0];
  assert.ok(samplePair, "fixture must generate at least one candidate pair");
  assert.throws(
    () =>
      applyDualTrackGoldAnnotations({
        rawSnapshot,
        independentGoldRelations: [
          {
            sourceRef: samplePair.sourceRef,
            targetRef: samplePair.targetRef,
            relation: "author_of",
            reviewStatus: "confirmed_gold",
          },
        ],
        conflictingCandidatePairOverrides: [
          {
            sourceRef: samplePair.sourceRef,
            targetRef: samplePair.targetRef,
            goldRelation: "unrelated",
            reviewStatus: "confirmed_gold",
          },
        ],
        promoteToFormalBenchmark: false,
      }),
    /CONFLICTING_GOLD_RELATION_ANNOTATIONS/,
  );
  assert.equal(JSON.stringify(rawSnapshot), rawSnapshotBeforeJson);

  // 2C. Incomplete annotations or "unknown" identity cannot be promoted to formal_benchmark
  assert.throws(
    () =>
      applyDualTrackGoldAnnotations({
        rawSnapshot,
        roleAnnotationsByNodeRef: {
          [firstNodeRef]: "post_root",
        },
        promoteToFormalBenchmark: true,
      }),
    /W0A_PROMOTION_REJECTED_INCOMPLETE_OR_UNKNOWN_IDENTITY/,
  );
  assert.equal(JSON.stringify(rawSnapshot), rawSnapshotBeforeJson);

  // 2D. Complete, consistent dual-track annotations promote cleanly and preserve
  // an out-of-candidate-pool gold edge for FN recall accounting.
  const roleAnnotationsByNodeRef = {};
  for (const node of rawSnapshot.retainedNodes) {
    roleAnnotationsByNodeRef[node.nodeRef] = "auxiliary_or_decor";
  }
  roleAnnotationsByNodeRef[samplePair.sourceRef] = "post_root";
  roleAnnotationsByNodeRef[samplePair.targetRef] = "author_anchor";

  // Find a pair of retained nodes NOT in candidatePairAnnotations to serve as an un-recalled gold edge
  const candKeySet = new Set(
    rawSnapshot.candidatePairAnnotations.map((p) => `${p.sourceRef}->${p.targetRef}`),
  );
  let unRecalledPair = null;
  for (const u of rawSnapshot.retainedNodes) {
    for (const v of rawSnapshot.retainedNodes) {
      if (u.nodeRef !== v.nodeRef && !candKeySet.has(`${u.nodeRef}->${v.nodeRef}`)) {
        unRecalledPair = { sourceRef: u.nodeRef, targetRef: v.nodeRef };
        break;
      }
    }
    if (unRecalledPair) break;
  }
  assert.ok(unRecalledPair, "must find a retained node pair outside P_cand");

  const independentGoldRelations = [
    {
      sourceRef: samplePair.sourceRef,
      targetRef: samplePair.targetRef,
      relation: "author_of",
      reviewStatus: "confirmed_gold",
    },
    {
      sourceRef: unRecalledPair.sourceRef,
      targetRef: unRecalledPair.targetRef,
      relation: "detail_entry_of",
      reviewStatus: "confirmed_gold",
    },
  ];
  const reviewedNegativeCandidatePairs = rawSnapshot.candidatePairAnnotations
    .filter(
      (p) =>
        !(p.sourceRef === samplePair.sourceRef && p.targetRef === samplePair.targetRef),
    )
    .map((p) => `${p.sourceRef}->${p.targetRef}`);

  const { snapshot: promoted, consistency } = applyDualTrackGoldAnnotations({
    rawSnapshot,
    roleAnnotationsByNodeRef,
    independentGoldRelations,
    reviewedNegativeCandidatePairs,
    promoteToFormalBenchmark: true,
  });

  // Raw snapshot remains diagnostic_development_only
  assert.equal(rawSnapshot.usageScope, "diagnostic_development_only");
  assert.equal(rawSnapshot.trainingEligible, false);

  // Promoted snapshot is formal_benchmark and reuses assertConsistentSnapshotGold return
  assert.equal(promoted.usageScope, "formal_benchmark");
  assert.equal(promoted.trainingEligible, true);
  assert.equal(promoted.autoGold, false);
  assert.deepEqual(consistency.violations, []);
  assert.equal(consistency.indepByKey.size, 2);

  // Evaluate with zero weights to confirm the out-of-candidate-pool gold edge is counted in recall denominator & FN
  const zeroRoleWeights = {
    version: "w0a.v1",
    heads: [...WEIBO_W0A_ROLE_HEADS],
    wires: [...WEIBO_W0A_ROLE_WIRES],
    weights: Array.from({ length: WEIBO_W0A_ROLE_HEADS.length }, () =>
      Array.from({ length: WEIBO_W0A_ROLE_WIRES.length }, () => 0),
    ),
    calibration: "uncalibrated",
    adoption: "not_applied",
  };
  const zeroRelWeights = {
    version: "w0a.v1",
    heads: [...WEIBO_W0A_RELATION_HEADS],
    wires: [...WEIBO_W0A_RELATION_WIRES],
    weights: Array.from({ length: WEIBO_W0A_RELATION_HEADS.length }, () =>
      Array.from({ length: WEIBO_W0A_RELATION_WIRES.length }, () => 0),
    ),
    calibration: "uncalibrated",
    adoption: "not_applied",
  };
  const evalResult = evaluateW0aSnapshots({
    snapshots: [promoted],
    roleProfile: zeroRoleWeights,
    relationProfile: zeroRelWeights,
  });
  assert.equal(evalResult.relationMetrics.totalIndependentGoldEdges, 2);
  assert.equal(evalResult.relationMetrics.totalInPoolGoldEdges, 1);
  assert.equal(evalResult.relationMetrics.perHead.detail_entry_of.missedByCandidateGenerationCount, 1);
  assert.ok(evalResult.relationMetrics.perHead.detail_entry_of.fn >= 1);
});

test("Test 3: CE-SourceFamily-UrlNorm verifies SUPPORTED_WEIBO_HOSTS allowlist, supported subset URLs, single-decode query, and partition leakage rejection", () => {
  // Positive 1: Same author across supported Weibo subdomains (/u/<uid> vs /<uid>/<bid>)
  assert.ok(SUPPORTED_WEIBO_HOSTS.has("weibo.com"));
  assert.ok(SUPPORTED_WEIBO_HOSTS.has("s.weibo.com"));
  assert.equal(
    normalizeWeiboAuthorUid("https://weibo.com/u/1642591402?topnav=1&wvr=6"),
    "uid:1642591402",
  );
  assert.equal(
    normalizeWeiboAuthorUid("https://s.weibo.com/1642591402/Pabc123XY#repost"),
    "uid:1642591402",
  );

  // Positive 2: Same post across supported subdomains / outer post and embedded reposted post
  assert.equal(
    normalizeWeiboCanonicalPostId("https://weibo.com/1642591402/Pabc123XY?from=page_100"),
    "post:1642591402/Pabc123XY",
  );
  assert.equal(
    normalizeWeiboCanonicalPostId("https://s.weibo.com/1642591402/Pabc123XY/?type=repost#comment"),
    "post:1642591402/Pabc123XY",
  );

  // Negative 1: Unsupported hostnames (evil.example and subdomain spoof weibo.com.evil.example) -> "unknown"
  assert.equal(
    normalizeWeiboAuthorUid("https://evil.example/u/1642591402"),
    "unknown",
  );
  assert.equal(
    normalizeWeiboAuthorUid("https://weibo.com.evil.example/u/1642591402"),
    "unknown",
  );
  assert.equal(
    normalizeWeiboCanonicalPostId("https://evil.example/1642591402/Pabc123XY"),
    "unknown",
  );
  assert.equal(
    normalizeWeiboCanonicalPostId("https://weibo.com.evil.example/1642591402/Pabc123XY"),
    "unknown",
  );

  // Negative 2: /n/<screenName> outside supported experimental subset -> "unknown"
  assert.equal(
    normalizeWeiboAuthorUid("https://weibo.com/n/%E5%A4%AE%E8%A7%86%E6%96%B0%E9%97%BB"),
    "unknown",
  );

  // Negative 3: /detail/<mid> and pure numeric second segment /<uid>/<numericMid> -> "unknown"
  assert.equal(
    normalizeWeiboCanonicalPostId("https://m.weibo.cn/detail/5091234567890123"),
    "unknown",
  );
  assert.equal(
    normalizeWeiboCanonicalPostId("https://weibo.com/1642591402/5091234567890123"),
    "unknown",
  );

  // Negative 4: Single-decode search query semantics (no double decode of ?q=%252F, literal %, and invalid path %)
  const qEncodedPercent2F = normalizeWeiboSearchQuery({
    pageKind: "search_results",
    pageUrl: "https://s.weibo.com/weibo?q=%252F",
  });
  const qSlash = normalizeWeiboSearchQuery({
    pageKind: "search_results",
    pageUrl: "https://s.weibo.com/weibo?q=%2F",
  });
  assert.equal(qEncodedPercent2F, "%2f");
  assert.equal(qSlash, "/");
  assert.notEqual(qEncodedPercent2F, qSlash);

  const qLiteralPercent = normalizeWeiboSearchQuery({
    pageKind: "search_results",
    pageUrl: "https://s.weibo.com/weibo?q=100%25",
  });
  assert.equal(qLiteralPercent, "100%");

  const qInvalidPathEncoding = normalizeWeiboSearchQuery({
    pageKind: "search_results",
    pageUrl: "https://s.weibo.com/weibo/100%",
  });
  assert.equal(qInvalidPathEncoding, "unknown");

  const qUnsupportedHost = normalizeWeiboSearchQuery({
    pageKind: "search_results",
    pageUrl: "https://evil.example/weibo?q=test",
  });
  assert.equal(qUnsupportedHost, "unknown");

  // feed_with_reposts explicit captureSessionId positive & negative cases
  assert.equal(
    normalizeWeiboSearchQuery({
      pageKind: "feed_with_reposts",
      captureSessionId: "sess-20261030-alpha",
    }),
    "__non_search__:sess-20261030-alpha",
  );
  assert.equal(
    normalizeWeiboSearchQuery({
      pageKind: "feed_with_reposts",
      captureSessionId: "   ",
    }),
    "unknown",
  );
  assert.equal(
    normalizeWeiboSearchQuery({
      pageKind: "feed_with_reposts",
    }),
    "unknown",
  );

  // End-to-end partition validation integration with validateW0aDataset:
  // (a) Shared embedded reposted post across train & dev triggers CROSS_PARTITION_SOURCE_FAMILY_LEAKAGE
  // (b) Unsupported host /detail/ URL producing "unknown" triggers UNVERIFIED_IDENTITY_OVERLAP_RISK
  const sfTrain = extractDeterministicWeiboSourceFamily({
    sourceFamilyId: "sf-train-1",
    pageKind: "search_results",
    pageUrl: "https://s.weibo.com/weibo?q=topicA",
    outerPostUrls: ["https://weibo.com/1642591402/Pabc123XY?from=page_100"],
    authorUrls: ["https://weibo.com/u/1642591402"],
  });
  const sfDevOverlap = extractDeterministicWeiboSourceFamily({
    sourceFamilyId: "sf-dev-1",
    pageKind: "feed_with_reposts",
    captureSessionId: "sess-dev-1",
    outerPostUrls: ["https://weibo.com/2222222222/Pdef456UV"],
    embeddedOrigPostUrls: ["https://s.weibo.com/1642591402/Pabc123XY/?type=repost#comment"],
    authorUrls: ["https://weibo.com/u/2222222222"],
  });
  const sfUnknown = extractDeterministicWeiboSourceFamily({
    sourceFamilyId: "sf-ver-unknown",
    pageKind: "search_results",
    pageUrl: "https://s.weibo.com/weibo?q=topicC",
    outerPostUrls: ["https://evil.example/1642591402/Pabc123XY"],
    authorUrls: ["https://weibo.com/n/%E5%A4%AE%E8%A7%86%E6%96%B0%E9%97%BB"],
  });

  assert.deepEqual(sfTrain.canonicalPostIds, ["post:1642591402/Pabc123XY"]);
  assert.ok(sfDevOverlap.canonicalPostIds.includes("post:1642591402/Pabc123XY"));
  assert.deepEqual(sfUnknown.canonicalPostIds, ["unknown"]);
  assert.deepEqual(sfUnknown.authorUids, ["unknown"]);

  const minimalSnapshot = (id, sf) => ({
    contract: "weibo.w0a.snapshot.v1",
    snapshotId: id,
    usageScope: "formal_benchmark",
    trainingEligible: true,
    autoGold: false,
    sourceFamily: sf,
    slots: [],
    retainedNodes: [],
    independentGoldRelations: [],
    candidatePairAnnotations: [],
  });

  const validationReport = validateW0aDataset({
    trainSnapshots: [minimalSnapshot("s-train", sfTrain)],
    devSnapshots: [minimalSnapshot("s-dev", sfDevOverlap)],
    verificationSnapshots: [minimalSnapshot("s-ver", sfUnknown)],
    allowSyntheticEngineeringSmoke: true,
  });

  assert.equal(validationReport.valid, false);
  const violationCodes = new Set(validationReport.violations.map((v) => v.code));
  assert.ok(
    violationCodes.has("CROSS_PARTITION_SOURCE_FAMILY_LEAKAGE"),
    "shared post across train outer post and dev embedded repost must trigger CROSS_PARTITION_SOURCE_FAMILY_LEAKAGE",
  );
  assert.ok(
    violationCodes.has("UNVERIFIED_IDENTITY_OVERLAP_RISK"),
    "unsupported host or /n/ author URL normalized to 'unknown' must trigger UNVERIFIED_IDENTITY_OVERLAP_RISK",
  );
});
