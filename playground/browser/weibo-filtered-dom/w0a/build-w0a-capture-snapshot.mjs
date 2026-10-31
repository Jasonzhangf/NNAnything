#!/usr/bin/env node
// W0a-Capture-1C-Code offline read-only snapshot builder, deterministic Weibo
// source-family URL normalizer, and dual-track gold annotation promoter.
//
// Strictly adheres to Section 6.3 of emma-weibo-filtered-dom-training-design.md (r7.4):
// 1. 5-branch href measurement & observedPathname resolution (empty href="" and
//    fragment href="#..." never inherit document.baseURI.pathname).
// 2. Live DOM read-only assembly via observeLiveDom (readContent: false, zero
//    <input>.value collection), binding raw DOM text/href via the shared
//    StableNodeRefRegistry (liveSnapshot.resolveElement(nodeRef)), preserving
//    live explorationInputs (directChildrenStatus: "complete"), and recording
//    explicit validated l1ProfileId.
// 3. Deterministic Weibo URL normalization with exact SUPPORTED_WEIBO_HOSTS
//    allowlist check first, supported experimental subset (5-20 digit UID,
//    8-12 char alphanumeric bid with >=1 ASCII letter), single-decode search
//    query normalization, and pageUrl sourced from window.location.href /
//    explicit pageUrl (never document.baseURI).
// 4. Dual-track gold annotation promotion reusing a single
//    assertConsistentSnapshotGold call while preserving the unpromoted raw
//    capture package on rejection.

import { readFileSync } from "node:fs";
import {
  createStableNodeRefRegistry,
  observeLiveDom,
  observeCandidates,
  checkCandidates,
  createFocusSpec,
  classifyBasicKind,
  classifyBasicKindBatch,
  DEFAULT_BASIC_KIND_CONFIG,
  DEFAULT_BASIC_KIND_PROFILE,
  validateBasicKindConfig,
  validateBasicKindProfile,
  shapeAppearanceMeasurements,
  validateExplorationInput,
} from "nnanything/browser-classify";
import {
  WEIBO_W0A_ROLE_HEADS,
  WEIBO_W0A_RELATION_HEADS,
  WEIBO_W0A_POSITIVE_RELATION_HEADS,
} from "../../../../dist/filters/weibo-filtered-dom-contract.js";
import {
  resolveRetainedNodesMap,
  generateWeiboCandidatePairs,
} from "../../../../dist/filters/weibo-filtered-dom-w0a.js";
import {
  buildL1Wires16,
  computeRetainedNodes,
  describeSlotOutcome,
} from "./convert-existing-filtered-dom.mjs";
import {
  assertConsistentSnapshotGold,
} from "./validate-w0a-dataset.mjs";

export const SUPPORTED_WEIBO_HOSTS = Object.freeze(
  new Set([
    "weibo.com",
    "www.weibo.com",
    "s.weibo.com",
    "m.weibo.cn",
    "weibo.cn",
  ]),
);

const NON_HTTP_PSEUDO_SCHEME_RE = /^(?:javascript|mailto|tel|data|blob|about):/i;
const UID_PATH_A1_RE = /^\/u\/(\d{5,20})\/?$/;
const UID_PATH_A2_RE = /^\/(\d{5,20})(?:\/[0-9A-Za-z]+)?\/?$/;
const CANONICAL_POST_PATH_RE = /^\/(\d{5,20})\/((?=.*[A-Za-z])[0-9A-Za-z]{8,12})\/?$/;
const SEARCH_PATH_RE = /^\/weibo\/([^/]+)\/?$/;

/**
 * Section 6.3 (1): 5-branch href observation & observedPathname resolution.
 * Empty href="", whitespace-only href="   ", and hash-only href="#..." are
 * intercepted BEFORE calling new URL(..., baseURI) so they never inherit
 * document.baseURI.pathname.
 */
export function resolveWeiboHrefObservation({
  hasHrefAttribute,
  rawHref = null,
  baseURI = "https://weibo.com/",
}) {
  if (hasHrefAttribute === null || hasHrefAttribute === undefined) {
    return Object.freeze({
      hrefPresent: null,
      measurementCoverageHrefPresent: "unmeasured",
      rawHref: null,
      observedPathname: null,
    });
  }
  if (hasHrefAttribute === false) {
    return Object.freeze({
      hrefPresent: false,
      measurementCoverageHrefPresent: "measured",
      rawHref: null,
      observedPathname: null,
    });
  }
  const rawString = typeof rawHref === "string" ? rawHref : "";
  const trimmed = rawString.trim();
  if (
    trimmed === "" ||
    trimmed.startsWith("#") ||
    NON_HTTP_PSEUDO_SCHEME_RE.test(trimmed)
  ) {
    return Object.freeze({
      hrefPresent: true,
      measurementCoverageHrefPresent: "measured",
      rawHref: rawString,
      observedPathname: "",
    });
  }
  try {
    const parsed = new URL(trimmed, baseURI);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      typeof parsed.pathname !== "string" ||
      !parsed.pathname.startsWith("/")
    ) {
      return Object.freeze({
        hrefPresent: true,
        measurementCoverageHrefPresent: "measured",
        rawHref: rawString,
        observedPathname: "",
      });
    }
    return Object.freeze({
      hrefPresent: true,
      measurementCoverageHrefPresent: "measured",
      rawHref: rawString,
      observedPathname: parsed.pathname,
    });
  } catch {
    return Object.freeze({
      hrefPresent: true,
      measurementCoverageHrefPresent: "measured",
      rawHref: rawString,
      observedPathname: "",
    });
  }
}

/**
 * Section 6.3 (1.2): Direct text observation via public shapeAppearanceMeasurements.
 */
export function resolveWeiboDirectTextObservation({ rawDirectText }) {
  if (rawDirectText === null || rawDirectText === undefined) {
    return Object.freeze({
      directTextPresent: null,
      nonFormatDirectTextPresent: null,
      measurementCoverageDirectTextPresent: "unmeasured",
      observedDirectText: null,
    });
  }
  const text = String(rawDirectText);
  const appearance = shapeAppearanceMeasurements({
    directText: text,
    beforeContent: "none",
    afterContent: "none",
    backgroundImage: "none",
    maskImage: "none",
    webkitMaskImage: "none",
  });
  return Object.freeze({
    directTextPresent: appearance.directTextPresent,
    nonFormatDirectTextPresent: appearance.nonFormatDirectTextPresent,
    measurementCoverageDirectTextPresent: "measured",
    observedDirectText: text,
  });
}

function parseSupportedWeiboUrl(rawUrl, baseURI = "https://weibo.com") {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (
    trimmed === "" ||
    trimmed.startsWith("#") ||
    NON_HTTP_PSEUDO_SCHEME_RE.test(trimmed)
  ) {
    return null;
  }
  try {
    const parsed = new URL(trimmed, baseURI);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (!SUPPORTED_WEIBO_HOSTS.has(parsed.hostname.toLowerCase())) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Section 6.3 (4.2.1): Normalize Weibo author URL into "uid:<digits>" | "unknown"
 * within the supported experimental subset (exact SUPPORTED_WEIBO_HOSTS check
 * first, then 5-20 decimal digit UID).
 */
export function normalizeWeiboAuthorUid(rawUrl, baseURI = "https://weibo.com") {
  const parsed = parseSupportedWeiboUrl(rawUrl, baseURI);
  if (!parsed) return "unknown";
  const m1 = UID_PATH_A1_RE.exec(parsed.pathname);
  if (m1) return `uid:${m1[1]}`;
  const m2 = UID_PATH_A2_RE.exec(parsed.pathname);
  if (m2) return `uid:${m2[1]}`;
  return "unknown";
}

/**
 * Section 6.3 (4.2.2): Normalize Weibo post URL into "post:<uid>/<bid>" | "unknown"
 * within the supported experimental subset (exact SUPPORTED_WEIBO_HOSTS check
 * first, then 5-20 digit UID + 8-12 char alphanumeric bid containing >=1 ASCII letter).
 */
export function normalizeWeiboCanonicalPostId(rawUrl, baseURI = "https://weibo.com") {
  const parsed = parseSupportedWeiboUrl(rawUrl, baseURI);
  if (!parsed) return "unknown";
  const m = CANONICAL_POST_PATH_RE.exec(parsed.pathname);
  if (!m) return "unknown";
  return `post:${m[1]}/${m[2]}`;
}

/**
 * Section 6.3 (4.2.3): Normalize Weibo search query with explicit captureSessionId,
 * pageUrl from window.location.href / explicit pageUrl, single-decode semantics
 * (URLSearchParams.get("q") is already decoded once and never passed to
 * decodeURIComponent again; path segment /weibo/<seg> is decoded once with
 * URIError mapped to "unknown").
 */
export function normalizeWeiboSearchQuery({
  pageKind,
  pageUrl = null,
  callerConfirmedQuery = null,
  captureSessionId = null,
} = {}) {
  if (pageKind === "feed_with_reposts") {
    if (typeof captureSessionId === "string" && captureSessionId.trim().length > 0) {
      return `__non_search__:${captureSessionId.trim()}`;
    }
    return "unknown";
  }
  if (pageKind !== "search_results" && pageKind !== "mixed_search_and_reposts") {
    return "unknown";
  }

  let rawQuery = null;
  if (typeof pageUrl === "string" && pageUrl.trim().length > 0) {
    let parsed;
    try {
      parsed = new URL(pageUrl.trim());
    } catch {
      return "unknown";
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !SUPPORTED_WEIBO_HOSTS.has(parsed.hostname.toLowerCase())
    ) {
      return "unknown";
    }
    if (parsed.searchParams.has("q")) {
      rawQuery = parsed.searchParams.get("q");
    } else {
      const m = SEARCH_PATH_RE.exec(parsed.pathname);
      if (m) {
        try {
          rawQuery = decodeURIComponent(m[1]);
        } catch {
          return "unknown";
        }
      }
    }
  }

  if (rawQuery === null && typeof callerConfirmedQuery === "string") {
    rawQuery = callerConfirmedQuery;
  }
  if (typeof rawQuery !== "string") {
    return "unknown";
  }
  const normalized = rawQuery.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
  return normalized.length > 0 ? normalized : "unknown";
}

/**
 * Section 6.3 (4.2): Deterministic extraction of Weibo sourceFamily metadata.
 */
export function extractDeterministicWeiboSourceFamily({
  sourceFamilyId,
  pageKind,
  pageUrl = null,
  callerConfirmedQuery = null,
  captureSessionId = null,
  baseURI = "https://weibo.com",
  outerPostUrls = [],
  embeddedOrigPostUrls = [],
  authorUrls = [],
}) {
  if (typeof sourceFamilyId !== "string" || sourceFamilyId.trim() === "") {
    throw new Error("W0A_CAPTURE_INVALID_SOURCE_FAMILY: sourceFamilyId must be a non-empty string");
  }
  const queryNormalized = normalizeWeiboSearchQuery({
    pageKind,
    pageUrl,
    callerConfirmedQuery,
    captureSessionId,
  });

  const canonicalPostIds = [];
  const origPostIds = [];
  const authorUids = [];

  for (const url of outerPostUrls) {
    const pid = normalizeWeiboCanonicalPostId(url, baseURI);
    canonicalPostIds.push(pid);
    if (pid !== "unknown") {
      const uidPart = pid.slice("post:".length).split("/")[0];
      if (uidPart) authorUids.push(`uid:${uidPart}`);
    }
  }

  for (const url of embeddedOrigPostUrls) {
    const pid = normalizeWeiboCanonicalPostId(url, baseURI);
    origPostIds.push(pid);
    canonicalPostIds.push(pid);
    if (pid !== "unknown") {
      const uidPart = pid.slice("post:".length).split("/")[0];
      if (uidPart) authorUids.push(`uid:${uidPart}`);
    }
  }

  for (const url of authorUrls) {
    authorUids.push(normalizeWeiboAuthorUid(url, baseURI));
  }

  if (canonicalPostIds.length === 0) canonicalPostIds.push("unknown");
  if (authorUids.length === 0) authorUids.push("unknown");

  const normalizedCaptureSessionId =
    typeof captureSessionId === "string" && captureSessionId.trim() !== ""
      ? captureSessionId.trim()
      : sourceFamilyId.trim();

  return Object.freeze({
    sourceFamilyId: sourceFamilyId.trim(),
    captureSessionId: normalizedCaptureSessionId,
    pageKind,
    queryNormalized,
    canonicalPostIds: Object.freeze([...new Set(canonicalPostIds)]),
    origPostIds: Object.freeze([...new Set(origPostIds)]),
    authorUids: Object.freeze([...new Set(authorUids)]),
  });
}

function loadValidatedL1Profile({ l1Profile, l1ProfilePath }) {
  if (typeof l1ProfilePath === "string" && l1ProfilePath.trim() !== "") {
    const parsed = JSON.parse(readFileSync(l1ProfilePath, "utf8"));
    return validateBasicKindProfile(parsed);
  }
  return validateBasicKindProfile(l1Profile ?? DEFAULT_BASIC_KIND_PROFILE);
}

/**
 * Section 6.3 (2): Read-only live DOM assembly into a diagnostic raw-capture
 * W0a snapshot package (usageScope: "diagnostic_development_only",
 * trainingEligible: false, autoGold: false).
 */
export function buildWeiboW0aRawCaptureFromLiveDom({
  document,
  window,
  pageUrl = null,
  snapshotId,
  sourceFamily,
  l1Profile = DEFAULT_BASIC_KIND_PROFILE,
  l1ProfilePath = null,
  l1Config = DEFAULT_BASIC_KIND_CONFIG,
  excludeRoot = null,
  maxRelationHops = 4,
}) {
  if (!document || !window) {
    throw new Error("W0A_CAPTURE_INVALID_DOM: document and window are required");
  }
  if (typeof snapshotId !== "string" || snapshotId.trim() === "") {
    throw new Error("W0A_CAPTURE_INVALID_SNAPSHOT_ID: snapshotId must be a non-empty string");
  }

  const validatedProfile = loadValidatedL1Profile({ l1Profile, l1ProfilePath });
  const validatedConfig = validateBasicKindConfig(l1Config);

  // Page URL truth source is explicit pageUrl or window.location.href, never document.baseURI.
  const effectivePageUrl =
    typeof pageUrl === "string" && pageUrl.trim() !== ""
      ? pageUrl.trim()
      : typeof window?.location?.href === "string"
        ? window.location.href
        : null;
  const linkBaseURI =
    typeof document.baseURI === "string" && document.baseURI.trim() !== ""
      ? document.baseURI
      : effectivePageUrl ?? "https://weibo.com/";

  const registry = createStableNodeRefRegistry("node");
  // Strictly omit readContent: true (defaults to readContent: false) so no <input>.value is read.
  const liveSnapshot = observeLiveDom({
    document,
    window,
    registry,
    excludeRoot,
    maxRelationHops,
    snapshotRef: snapshotId,
    documentRef: snapshotId,
  });

  // Verify zero input value collection across all observed evidence entries.
  for (const [, ev] of liveSnapshot.evidence.entries()) {
    if (ev.inputValue !== null) {
      throw new Error("W0A_CAPTURE_READ_CONTENT_VIOLATION: inputValue must be null under readContent: false");
    }
  }

  const candidateObservation = observeCandidates({
    observation: liveSnapshot.observation,
  });
  const candidateBatch = checkCandidates(
    candidateObservation,
    createFocusSpec(),
  );
  const l1Batch = classifyBasicKindBatch(
    {
      ...candidateBatch,
      itemObservations: liveSnapshot.itemObservations,
    },
    validatedConfig,
    validatedProfile,
  );

  const l1SlotByRef = new Map(l1Batch.slots.map((s) => [s.nodeRef, s]));
  const itemObsByRef = new Map(liveSnapshot.itemObservations.map((o) => [o.nodeRef, o]));

  const slots = [];

  for (let slotIndex = 0; slotIndex < liveSnapshot.observation.nodes.length; slotIndex += 1) {
    const obsNode = liveSnapshot.observation.nodes[slotIndex];
    const nodeRef = obsNode.nodeRef;
    const element = liveSnapshot.resolveElement(nodeRef);
    if (!element) {
      throw new Error(`W0A_CAPTURE_broken_registry_ref: liveSnapshot.resolveElement(${nodeRef}) returned null`);
    }

    const rawDirectText = Array.from(element.childNodes ?? [])
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent ?? "")
      .join("");
    const textObs = resolveWeiboDirectTextObservation({ rawDirectText });

    const hasHrefAttribute = Boolean(element.hasAttribute?.("href"));
    const rawHref = hasHrefAttribute ? element.getAttribute("href") : null;
    const hrefObs = resolveWeiboHrefObservation({
      hasHrefAttribute,
      rawHref,
      baseURI: linkBaseURI,
    });

    const itemObs = itemObsByRef.get(nodeRef);
    const rawExploration = liveSnapshot.explorationInputs.get(nodeRef);
    const explorationInput = validateExplorationInput(rawExploration);

    const l1Slot = l1SlotByRef.get(nodeRef);
    if (!l1Slot) {
      throw new Error(`W0A_CAPTURE_MISSING_L1_SLOT: missing BasicKindSlot for ${nodeRef}`);
    }

    const outcome = describeSlotOutcome(l1Slot);

    const sidecar = {
      nodeRef,
      slotIndex,
      parentRef: obsNode.parentRef,
      rawTag: obsNode.tag,
      rawHref: hrefObs.rawHref,
      observedPathname: hrefObs.observedPathname,
      observedDirectText: textObs.observedDirectText,
      candidateStatus: l1Slot.candidateStatus,
      candidateReasons: [...l1Slot.candidateReasons],
      effectiveL1: outcome.effectiveL1,
      disposition: outcome.disposition,
    };

    slots.push({
      slotIndex,
      index: slotIndex,
      nodeRef,
      rawParentRef: obsNode.parentRef,
      parentRef: obsNode.parentRef,
      observationNode: obsNode,
      itemObservation: itemObs,
      explorationInput,
      sidecar,
      candidateStatus: l1Slot.candidateStatus,
      candidateReasons: [...l1Slot.candidateReasons],
      judgmentStatus: outcome.judgmentStatus,
      basicKind: outcome.basicKind,
      effectiveL1: outcome.effectiveL1,
      disposition: outcome.disposition,
      inMainClassificationInput: outcome.inMainClassificationInput,
      l1Wires16: outcome.l1Wires16,
      rawJudgment: {
        judgmentStatus: l1Slot.judgmentStatus,
        basicKind: l1Slot.basicKind,
        reasons: [...l1Slot.reasons],
      },
      ...(l1Slot.semanticDiagnostic === undefined
        ? {}
        : { semanticDiagnostic: l1Slot.semanticDiagnostic }),
    });
  }

  const retainedNodes = computeRetainedNodes(slots).map((r) => ({
    ...r,
    disposition: "active_retained",
    roleAnnotation: {
      reviewStatus: "unreviewed",
      goldRole: null,
    },
  }));

  const resolvedMap = resolveRetainedNodesMap({ slots, retainedNodes });
  const pairGen = generateWeiboCandidatePairs(resolvedMap);
  const candidatePairAnnotations = pairGen.candidatePairs.map((pair) => ({
    sourceRef: pair.sourceRef,
    targetRef: pair.targetRef,
    hopDistance: pair.hopDistance,
    ancestorRef: pair.ancestorRef,
    upHops: pair.upHops,
    downHops: pair.downHops,
    reviewStatus: "unreviewed",
    goldRelation: null,
  }));

  const normalizedSourceFamily =
    sourceFamily && typeof sourceFamily === "object" && Array.isArray(sourceFamily.canonicalPostIds)
      ? {
          ...sourceFamily,
          queryNormalized:
            typeof sourceFamily.queryNormalized === "string"
              ? sourceFamily.queryNormalized
              : normalizeWeiboSearchQuery({
                  pageKind: sourceFamily.pageKind,
                  pageUrl: effectivePageUrl,
                  callerConfirmedQuery: sourceFamily.callerConfirmedQuery ?? null,
                  captureSessionId: sourceFamily.captureSessionId ?? null,
                }),
        }
      : extractDeterministicWeiboSourceFamily({
          ...(sourceFamily ?? { sourceFamilyId: `sf-${snapshotId}`, pageKind: "search_results" }),
          pageUrl: effectivePageUrl,
          baseURI: linkBaseURI,
        });

  return {
    contract: "weibo.w0a.snapshot.v1",
    snapshotId,
    pageUrl: effectivePageUrl,
    l1ProfileId: validatedProfile.id,
    usageScope: "diagnostic_development_only",
    trainingEligible: false,
    autoGold: false,
    filterRecallStatus: "UNVERIFIED",
    sourceFamily: normalizedSourceFamily,
    viewport: liveSnapshot.observation.viewport,
    coverage: liveSnapshot.coverage,
    slots,
    retainedNodes,
    independentGoldRelations: [],
    candidatePairAnnotations,
  };
}

/**
 * Section 6.3 (3.2): Non-destructive dual-track gold annotation & formal
 * benchmark promotion reusing a SINGLE assertConsistentSnapshotGold call.
 */
export function applyDualTrackGoldAnnotations({
  rawSnapshot,
  roleAnnotationsByNodeRef = {},
  independentGoldRelations = [],
  reviewedNegativeCandidatePairs = [],
  conflictingCandidatePairOverrides = [],
  promoteToFormalBenchmark = false,
}) {
  if (!rawSnapshot || typeof rawSnapshot !== "object") {
    throw new Error("W0A_GOLD_INVALID_RAW_SNAPSHOT: rawSnapshot must be an object");
  }

  // Deep clone so rawSnapshot is never mutated if validation or promotion fails.
  const candidateSnapshot = structuredClone(rawSnapshot);
  candidateSnapshot.autoGold = false;

  const roleMap =
    roleAnnotationsByNodeRef instanceof Map
      ? roleAnnotationsByNodeRef
      : new Map(Object.entries(roleAnnotationsByNodeRef ?? {}));

  const duplicateRetainedConflicts = [];
  for (const node of candidateSnapshot.retainedNodes ?? []) {
    if (roleMap.has(node.nodeRef)) {
      const entry = roleMap.get(node.nodeRef);
      if (typeof entry === "string") {
        node.roleAnnotation = {
          reviewStatus: "confirmed_gold",
          goldRole: entry,
        };
      } else if (entry && typeof entry === "object") {
        if (Array.isArray(entry.goldRole) && entry.goldRole.length > 1) {
          node.roleAnnotation = {
            reviewStatus: entry.reviewStatus ?? "confirmed_gold",
            goldRole: entry.goldRole[0],
          };
          for (let i = 1; i < entry.goldRole.length; i += 1) {
            duplicateRetainedConflicts.push({
              ...node,
              roleAnnotation: {
                reviewStatus: entry.reviewStatus ?? "confirmed_gold",
                goldRole: entry.goldRole[i],
              },
            });
          }
        } else {
          node.roleAnnotation = {
            reviewStatus: entry.reviewStatus ?? "confirmed_gold",
            goldRole: entry.goldRole ?? null,
          };
        }
      }
    }
  }
  if (duplicateRetainedConflicts.length > 0) {
    candidateSnapshot.retainedNodes.push(...duplicateRetainedConflicts);
  }

  candidateSnapshot.independentGoldRelations = independentGoldRelations.map((rel) => ({
    sourceRef: rel.sourceRef,
    targetRef: rel.targetRef,
    relation: rel.relation,
    reviewStatus: rel.reviewStatus ?? "confirmed_gold",
  }));

  const negativeSet = new Set(
    reviewedNegativeCandidatePairs.map((item) =>
      typeof item === "string" ? item : `${item.sourceRef}->${item.targetRef}`,
    ),
  );
  const indepMap = new Map();
  for (const rel of candidateSnapshot.independentGoldRelations) {
    const key = `${rel.sourceRef}->${rel.targetRef}`;
    if (!indepMap.has(key) && rel.reviewStatus === "confirmed_gold") {
      indepMap.set(key, rel.relation);
    }
  }
  const overrideMap = new Map(
    conflictingCandidatePairOverrides.map((ov) => [
      `${ov.sourceRef}->${ov.targetRef}`,
      ov,
    ]),
  );

  for (const pa of candidateSnapshot.candidatePairAnnotations ?? []) {
    const key = `${pa.sourceRef}->${pa.targetRef}`;
    if (overrideMap.has(key)) {
      const ov = overrideMap.get(key);
      pa.reviewStatus = ov.reviewStatus ?? "confirmed_gold";
      pa.goldRelation = ov.goldRelation ?? null;
    } else if (indepMap.has(key)) {
      pa.reviewStatus = "confirmed_gold";
      pa.goldRelation = indepMap.get(key);
    } else if (negativeSet.has(key)) {
      pa.reviewStatus = "confirmed_gold";
      pa.goldRelation = "unrelated";
    }
  }

  const resolvedMap = resolveRetainedNodesMap({
    slots: candidateSnapshot.slots,
    retainedNodes: candidateSnapshot.retainedNodes,
  });
  const pairGen = generateWeiboCandidatePairs(resolvedMap);
  const candKeySet = new Set(
    pairGen.candidatePairs.map((c) => `${c.sourceRef}->${c.targetRef}`),
  );

  // Single call to assertConsistentSnapshotGold (no redundant checkSnapshotGoldConsistency call).
  const consistencyResult = assertConsistentSnapshotGold(
    candidateSnapshot,
    candidateSnapshot.snapshotId ?? "snapshot",
    candKeySet,
  );

  if (promoteToFormalBenchmark) {
    const unlabeledRoleNodes = (candidateSnapshot.retainedNodes ?? []).filter(
      (n) => n.roleAnnotation?.reviewStatus !== "confirmed_gold" || !WEIBO_W0A_ROLE_HEADS.includes(n.roleAnnotation?.goldRole),
    );
    const unlabeledPairs = (candidateSnapshot.candidatePairAnnotations ?? []).filter(
      (pa) => pa.reviewStatus !== "confirmed_gold" || !WEIBO_W0A_RELATION_HEADS.includes(pa.goldRelation),
    );
    const sf = candidateSnapshot.sourceFamily ?? {};
    const hasUnknownIdentity =
      !sf.sourceFamilyId ||
      sf.sourceFamilyId === "unknown" ||
      !sf.queryNormalized ||
      sf.queryNormalized === "unknown" ||
      !Array.isArray(sf.canonicalPostIds) ||
      sf.canonicalPostIds.length === 0 ||
      sf.canonicalPostIds.includes("unknown") ||
      (Array.isArray(sf.origPostIds) && sf.origPostIds.includes("unknown")) ||
      !Array.isArray(sf.authorUids) ||
      sf.authorUids.length === 0 ||
      sf.authorUids.includes("unknown");

    if (
      unlabeledRoleNodes.length > 0 ||
      unlabeledPairs.length > 0 ||
      hasUnknownIdentity
    ) {
      throw new Error(
        `W0A_PROMOTION_REJECTED_INCOMPLETE_OR_UNKNOWN_IDENTITY: snapshot ${candidateSnapshot.snapshotId} cannot be promoted (unlabeledRoleNodes=${unlabeledRoleNodes.length}, unlabeledPairs=${unlabeledPairs.length}, hasUnknownIdentity=${hasUnknownIdentity})`,
      );
    }

    candidateSnapshot.usageScope = "formal_benchmark";
    candidateSnapshot.trainingEligible = true;
  } else {
    candidateSnapshot.usageScope = "diagnostic_development_only";
    candidateSnapshot.trainingEligible = false;
  }

  return {
    snapshot: candidateSnapshot,
    consistency: consistencyResult,
  };
}
