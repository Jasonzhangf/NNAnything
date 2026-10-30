#!/usr/bin/env node
// W0a-Prep-1B dataset & source-family disjointness validator.
//
// Enforces Section 4.3 (source-family connected components and unknown identity
// overlap guard), Section 4.4 Table 4.1 (minimum coverage per role/relation head),
// Section 4.4.1 (confirmed pair evaluation domain |P_unlabeled| === 0 for formal
// splits), and rejects diagnostic_development_only / trainingEligible === false
// snapshots from formal partitions.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  WEIBO_W0A_ROLE_HEADS,
  WEIBO_W0A_RELATION_HEADS,
  WEIBO_W0A_POSITIVE_RELATION_HEADS,
} from "../../../../dist/filters/weibo-filtered-dom-contract.js";
import {
  resolveRetainedNodesMap,
  generateWeiboCandidatePairs,
} from "../../../../dist/filters/weibo-filtered-dom-w0a.js";

export function checkSnapshotGoldConsistency(snap, splitName, snapId, candKeySet = null) {
  const violations = [];
  const retained = Array.isArray(snap.retainedNodes) ? snap.retainedNodes : [];
  const roleByNodeRef = new Map();
  for (const node of retained) {
    const ref = node.nodeRef;
    const ann = node.roleAnnotation ?? null;
    if (roleByNodeRef.has(ref)) {
      const prev = roleByNodeRef.get(ref);
      violations.push({
        code: "CONFLICTING_GOLD_ROLE_ANNOTATIONS",
        split: splitName,
        snapshotId: snapId,
        nodeRef: ref,
        firstRole: prev?.goldRole ?? null,
        secondRole: ann?.goldRole ?? null,
        message: `Snapshot ${snapId} has duplicate or conflicting roleAnnotation entries on nodeRef ${ref}`,
      });
    } else {
      roleByNodeRef.set(ref, ann);
    }
    if (
      ann &&
      ann.reviewStatus === "confirmed_gold" &&
      (!ann.goldRole || !WEIBO_W0A_ROLE_HEADS.includes(ann.goldRole))
    ) {
      violations.push({
        code: "INVALID_GOLD_ROLE_LABEL",
        split: splitName,
        snapshotId: snapId,
        nodeRef: ref,
        goldRole: ann.goldRole ?? null,
        message: `Snapshot ${snapId} node ${ref} has invalid confirmed_gold role label ${ann.goldRole}`,
      });
    }
  }

  let effectiveCandKeySet = candKeySet;
  if (!effectiveCandKeySet && Array.isArray(snap.slots) && retained.length > 0) {
    try {
      const resolvedMap = resolveRetainedNodesMap({
        slots: snap.slots,
        retainedNodes: retained,
      });
      const pairGen = generateWeiboCandidatePairs(resolvedMap);
      effectiveCandKeySet = new Set(
        pairGen.candidatePairs.map((c) => `${c.sourceRef}->${c.targetRef}`),
      );
    } catch {
      effectiveCandKeySet = null;
    }
  }

  const indepByKey = new Map();
  for (const rel of snap.independentGoldRelations ?? []) {
    const key = `${rel.sourceRef}->${rel.targetRef}`;
    if (indepByKey.has(key)) {
      const prev = indepByKey.get(key);
      violations.push({
        code: "CONFLICTING_GOLD_RELATION_ANNOTATIONS",
        split: splitName,
        snapshotId: snapId,
        pairKey: key,
        independentRelation: prev.relation ?? null,
        conflictingIndependentRelation: rel.relation ?? null,
        message: `Snapshot ${snapId} has duplicate or conflicting independentGoldRelations entries on directed pair ${key}`,
      });
    } else {
      indepByKey.set(key, rel);
    }
    if (
      rel.reviewStatus === "confirmed_gold" &&
      (!rel.relation || !WEIBO_W0A_POSITIVE_RELATION_HEADS.includes(rel.relation))
    ) {
      violations.push({
        code: "INVALID_INDEPENDENT_GOLD_RELATION",
        split: splitName,
        snapshotId: snapId,
        pairKey: key,
        relation: rel.relation ?? null,
        message: `Snapshot ${snapId} pair ${key} has invalid confirmed_gold independent relation ${rel.relation}`,
      });
    }
  }

  const paByKey = new Map();
  for (const pa of snap.candidatePairAnnotations ?? []) {
    const key = `${pa.sourceRef}->${pa.targetRef}`;
    if (paByKey.has(key)) {
      const prev = paByKey.get(key);
      violations.push({
        code: "CONFLICTING_GOLD_RELATION_ANNOTATIONS",
        split: splitName,
        snapshotId: snapId,
        pairKey: key,
        candidatePairRelation: prev.goldRelation ?? null,
        conflictingCandidatePairRelation: pa.goldRelation ?? null,
        message: `Snapshot ${snapId} has duplicate or conflicting candidatePairAnnotations entries on directed pair ${key}`,
      });
    } else {
      paByKey.set(key, pa);
    }
    if (
      pa.reviewStatus === "confirmed_gold" &&
      (!pa.goldRelation || !WEIBO_W0A_RELATION_HEADS.includes(pa.goldRelation))
    ) {
      violations.push({
        code: "INVALID_CANDIDATE_PAIR_GOLD_RELATION",
        split: splitName,
        snapshotId: snapId,
        pairKey: key,
        goldRelation: pa.goldRelation ?? null,
        message: `Snapshot ${snapId} pair ${key} has invalid confirmed_gold candidatePairAnnotation ${pa.goldRelation}`,
      });
    }
  }

  // Cross-check between independentGoldRelations and candidatePairAnnotations on the same directed pair
  for (const [key, indep] of indepByKey.entries()) {
    if (paByKey.has(key)) {
      const pa = paByKey.get(key);
      if (indep.reviewStatus === "confirmed_gold") {
        if (pa.reviewStatus !== "confirmed_gold" || pa.goldRelation !== indep.relation) {
          violations.push({
            code: "CONFLICTING_GOLD_RELATION_ANNOTATIONS",
            split: splitName,
            snapshotId: snapId,
            pairKey: key,
            independentRelation: indep.relation,
            candidatePairRelation: pa.goldRelation ?? null,
            candidatePairReviewStatus: pa.reviewStatus ?? null,
            message: `Snapshot ${snapId} pair ${key} has conflicting gold relation: independentGoldRelations=${indep.relation} (${indep.reviewStatus}) vs candidatePairAnnotations=${pa.goldRelation ?? "null"} (${pa.reviewStatus ?? "null"})`,
          });
        }
      } else if (pa.reviewStatus === "confirmed_gold") {
        violations.push({
          code: "CONFLICTING_GOLD_RELATION_ANNOTATIONS",
          split: splitName,
          snapshotId: snapId,
          pairKey: key,
          independentRelation: indep.relation ?? null,
          independentReviewStatus: indep.reviewStatus ?? null,
          candidatePairRelation: pa.goldRelation ?? null,
          message: `Snapshot ${snapId} pair ${key} has unconfirmed independentGoldRelations (${indep.reviewStatus}) but confirmed_gold candidatePairAnnotations (${pa.goldRelation})`,
        });
      }
    } else if (
      indep.reviewStatus === "confirmed_gold" &&
      effectiveCandKeySet &&
      effectiveCandKeySet.has(key) &&
      paByKey.size > 0
    ) {
      violations.push({
        code: "CONFLICTING_GOLD_RELATION_ANNOTATIONS",
        split: splitName,
        snapshotId: snapId,
        pairKey: key,
        independentRelation: indep.relation,
        candidatePairRelation: null,
        message: `Snapshot ${snapId} pair ${key} is an in-pool confirmed_gold relation (${indep.relation}) in independentGoldRelations but is missing from candidatePairAnnotations`,
      });
    }
  }

  for (const [key, pa] of paByKey.entries()) {
    if (
      pa.reviewStatus === "confirmed_gold" &&
      pa.goldRelation &&
      pa.goldRelation !== "unrelated" &&
      !indepByKey.has(key)
    ) {
      violations.push({
        code: "CONFLICTING_GOLD_RELATION_ANNOTATIONS",
        split: splitName,
        snapshotId: snapId,
        pairKey: key,
        independentRelation: null,
        candidatePairRelation: pa.goldRelation,
        message: `Snapshot ${snapId} pair ${key} has confirmed_gold positive relation ${pa.goldRelation} in candidatePairAnnotations but is missing from independentGoldRelations`,
      });
    }
  }

  return {
    violations,
    indepByKey,
    paByKey,
  };
}

export function assertConsistentSnapshotGold(snap, snapId = "snapshot", candKeySet = null) {
  const res = checkSnapshotGoldConsistency(snap, "runtime", snapId, candKeySet);
  if (res.violations.length > 0) {
    const first = res.violations[0];
    throw new Error(`${first.code}: ${first.message}`);
  }
  return res;
}

export function resolveConsistentCandidatePairGold(
  key,
  indepGoldByKey,
  pairAnnByKey,
  snapId = "snapshot",
) {
  const indepRel = indepGoldByKey.get(key) ?? null;
  const pa = pairAnnByKey.get(key) ?? null;
  const paConfirmedRel =
    pa && pa.reviewStatus === "confirmed_gold" ? pa.goldRelation : null;

  if (indepRel !== null) {
    if (pa === null || paConfirmedRel !== indepRel) {
      throw new Error(
        `CONFLICTING_GOLD_RELATION_ANNOTATIONS: snapshot ${snapId} pair ${key} has independentGoldRelations=${indepRel} vs candidatePairAnnotations=${pa?.goldRelation ?? "null"} (${pa?.reviewStatus ?? "missing"})`,
      );
    }
    return indepRel;
  }

  if (paConfirmedRel !== null) {
    if (paConfirmedRel !== "unrelated") {
      throw new Error(
        `CONFLICTING_GOLD_RELATION_ANNOTATIONS: snapshot ${snapId} pair ${key} has positive candidatePairAnnotations=${paConfirmedRel} missing from independentGoldRelations`,
      );
    }
    return "unrelated";
  }

  return null;
}

export const FORMAL_COVERAGE_THRESHOLDS = Object.freeze({
  train: {
    minSourceFamilies: 6,
    minPages: 8,
    minPostRoot: 40,
    minRepostedEmbeddedPost: 12,
    minPerOtherRoleHead: 8,
    minPerPositiveRelationHead: 8,
  },
  development: {
    minSourceFamilies: 3,
    minPages: 4,
    minPostRoot: 20,
    minRepostedEmbeddedPost: 6,
    minPerOtherRoleHead: 4,
    minPerPositiveRelationHead: 4,
  },
  verification: {
    minSourceFamilies: 3,
    minPages: 4,
    minPostRoot: 20,
    minRepostedEmbeddedPost: 6,
    minPerOtherRoleHead: 4,
    minPerPositiveRelationHead: 4,
  },
});

export function readSnapshotsFile(filePath, label = "dataset") {
  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`W0A_DATASET_READ_ERROR: ${label} at ${filePath} could not be parsed: ${error.message}`);
  }
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray(raw.snapshots)) {
    return raw.snapshots;
  }
  // If a single prep file (like snapshot-001.prep.json) was passed directly:
  if (raw && typeof raw === "object" && Array.isArray(raw.slots)) {
    return [raw];
  }
  throw new Error(`W0A_DATASET_SCHEMA_ERROR: ${label} must be an array of snapshots or { snapshots: [...] }`);
}

function computeConnectedSourceFamilies(taggedSnapshots) {
  const n = taggedSnapshots.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  }

  for (let i = 0; i < n; i += 1) {
    const snapI = taggedSnapshots[i].snapshot ?? {};
    const si = snapI.sourceFamily ?? {};
    for (let j = i + 1; j < n; j += 1) {
      const snapJ = taggedSnapshots[j].snapshot ?? {};
      const sj = snapJ.sourceFamily ?? {};
      let sharesIdentity = false;
      if (
        typeof snapI.snapshotId === "string" &&
        snapI.snapshotId.length > 0 &&
        snapI.snapshotId === snapJ.snapshotId
      ) {
        sharesIdentity = true;
      }
      if (
        !sharesIdentity &&
        typeof snapI.sourceId === "string" &&
        snapI.sourceId.length > 0 &&
        snapI.sourceId === snapJ.sourceId
      ) {
        sharesIdentity = true;
      }
      if (
        !sharesIdentity &&
        typeof si.captureSessionId === "string" &&
        si.captureSessionId.length > 0 &&
        si.captureSessionId === sj.captureSessionId
      ) {
        sharesIdentity = true;
      }
      if (
        !sharesIdentity &&
        typeof si.queryNormalized === "string" &&
        si.queryNormalized.length > 0 &&
        si.queryNormalized === sj.queryNormalized
      ) {
        sharesIdentity = true;
      }
      if (!sharesIdentity && Array.isArray(si.canonicalPostIds) && Array.isArray(sj.canonicalPostIds)) {
        const setI = new Set(si.canonicalPostIds.filter((id) => id && id !== "unknown"));
        if (sj.canonicalPostIds.some((id) => id && id !== "unknown" && setI.has(id))) {
          sharesIdentity = true;
        }
      }
      if (!sharesIdentity && Array.isArray(si.authorUids) && Array.isArray(sj.authorUids)) {
        const setI = new Set(si.authorUids.filter((id) => id && id !== "unknown"));
        if (sj.authorUids.some((id) => id && id !== "unknown" && setI.has(id))) {
          sharesIdentity = true;
        }
      }
      if (!sharesIdentity && Array.isArray(si.origPostIds) && Array.isArray(sj.origPostIds)) {
        const setI = new Set(si.origPostIds.filter((id) => id && id !== "unknown"));
        if (sj.origPostIds.some((id) => id && id !== "unknown" && setI.has(id))) {
          sharesIdentity = true;
        }
      }
      if (sharesIdentity) {
        union(i, j);
      }
    }
  }

  const clusters = new Map();
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    const familyId = `family-${root}`;
    const list = clusters.get(familyId) ?? [];
    list.push({ ...taggedSnapshots[i], sourceFamilyId: familyId });
    clusters.set(familyId, list);
  }
  return clusters;
}

export function validateW0aDataset({
  trainSnapshots,
  devSnapshots,
  verificationSnapshots = [],
  allowSyntheticEngineeringSmoke = false,
}) {
  const violations = [];
  const splitEntries = [
    ["train", trainSnapshots ?? []],
    ["development", devSnapshots ?? []],
    ...(verificationSnapshots && verificationSnapshots.length > 0
      ? [["verification", verificationSnapshots]]
      : []),
  ];

  const allTagged = [];
  const splitStats = {};

  for (const [splitName, snapshots] of splitEntries) {
    if (!Array.isArray(snapshots) || snapshots.length === 0) {
      violations.push({
        code: "EMPTY_PARTITION",
        split: splitName,
        message: `Partition ${splitName} must contain at least one snapshot`,
      });
      continue;
    }

    const roleCounts = Object.fromEntries(WEIBO_W0A_ROLE_HEADS.map((h) => [h, 0]));
    const positiveRelCounts = Object.fromEntries(
      WEIBO_W0A_POSITIVE_RELATION_HEADS.map((h) => [h, 0]),
    );
    let unlabeledRoleNodeCount = 0;
    let unlabeledCandidatePairCount = 0;
    let hasSearchResultsPage = false;
    let hasRepostPage = false;

    for (let idx = 0; idx < snapshots.length; idx += 1) {
      const snap = snapshots[idx];
      const snapId = snap.snapshotId ?? snap.sourceId ?? `${splitName}-${idx}`;
      allTagged.push({ split: splitName, snapshotId: snapId, snapshot: snap });

      // Never allow diagnostic_development_only or trainingEligible === false
      if (
        snap.usageScope === "diagnostic_development_only" ||
        snap.trainingEligible === false
      ) {
        violations.push({
          code: "DIAGNOSTIC_OR_INELIGIBLE_SNAPSHOT_FORBIDDEN",
          split: splitName,
          snapshotId: snapId,
          message: `Snapshot ${snapId} has usageScope=${snap.usageScope} or trainingEligible=${snap.trainingEligible} and cannot enter ${splitName}`,
        });
      }

      if (!allowSyntheticEngineeringSmoke && snap.usageScope === "synthetic_engineering_smoke") {
        violations.push({
          code: "SYNTHETIC_SMOKE_FORBIDDEN_WITHOUT_FLAG",
          split: splitName,
          snapshotId: snapId,
          message: `Snapshot ${snapId} is synthetic_engineering_smoke but allowSyntheticEngineeringSmoke is false`,
        });
      }

      const sf = snap.sourceFamily;
      if (!sf || typeof sf.captureSessionId !== "string" || !sf.captureSessionId) {
        violations.push({
          code: "MISSING_SOURCE_FAMILY_METADATA",
          split: splitName,
          snapshotId: snapId,
          message: `Snapshot ${snapId} is missing sourceFamily.captureSessionId`,
        });
      } else {
        if (sf.pageKind === "search_results" || sf.pageKind === "mixed_search_and_reposts") {
          hasSearchResultsPage = true;
        }
        if (sf.pageKind === "feed_with_reposts" || sf.pageKind === "mixed_search_and_reposts") {
          hasRepostPage = true;
        }
        const hasUnknownPostId =
          !Array.isArray(sf.canonicalPostIds) ||
          sf.canonicalPostIds.length === 0 ||
          sf.canonicalPostIds.some((id) => !id || id === "unknown");
        const hasUnknownAuthorUid =
          !Array.isArray(sf.authorUids) ||
          sf.authorUids.length === 0 ||
          sf.authorUids.some((id) => !id || id === "unknown");
        if (hasUnknownPostId || hasUnknownAuthorUid) {
          violations.push({
            code: "UNVERIFIED_IDENTITY_OVERLAP_RISK",
            split: splitName,
            snapshotId: snapId,
            message: `Snapshot ${snapId} contains unknown canonicalPostId or authorUid and risks cross-partition identity leakage`,
          });
        }
      }

      const retained = Array.isArray(snap.retainedNodes) ? snap.retainedNodes : [];
      for (const node of retained) {
        const ann = node.roleAnnotation;
        if (!ann || ann.reviewStatus !== "confirmed_gold" || !ann.goldRole) {
          unlabeledRoleNodeCount += 1;
        } else if (ann.goldRole in roleCounts) {
          roleCounts[ann.goldRole] += 1;
        }
      }

      // Check independent gold relations and candidate pair annotations
      let resolvedMap = null;
      let pairGen = null;
      let candKeySet = null;
      try {
        resolvedMap = resolveRetainedNodesMap({
          slots: snap.slots,
          retainedNodes: retained,
        });
        pairGen = generateWeiboCandidatePairs(resolvedMap);
        candKeySet = new Set(
          pairGen.candidatePairs.map((c) => `${c.sourceRef}->${c.targetRef}`),
        );
      } catch (error) {
        violations.push({
          code: "INVALID_RETAINED_NODE_STRUCTURE",
          split: splitName,
          snapshotId: snapId,
          message: error.message,
        });
      }

      const consistency = checkSnapshotGoldConsistency(
        snap,
        splitName,
        snapId,
        candKeySet,
      );
      for (const v of consistency.violations) {
        violations.push(v);
      }

      const indepRels = Array.isArray(snap.independentGoldRelations)
        ? snap.independentGoldRelations
        : [];
      for (const rel of indepRels) {
        if (rel.reviewStatus !== "confirmed_gold") {
          violations.push({
            code: "UNCONFIRMED_INDEPENDENT_GOLD_RELATION",
            split: splitName,
            snapshotId: snapId,
            message: `Independent relation (${rel.sourceRef}, ${rel.targetRef}) is not confirmed_gold`,
          });
        } else if (rel.relation in positiveRelCounts) {
          positiveRelCounts[rel.relation] += 1;
        }
      }

      if (pairGen) {
        const annByKey = consistency.paByKey;
        for (const cand of pairGen.candidatePairs) {
          const key = `${cand.sourceRef}->${cand.targetRef}`;
          const pa = annByKey.get(key);
          if (!pa || pa.reviewStatus !== "confirmed_gold" || !pa.goldRelation) {
            unlabeledCandidatePairCount += 1;
          }
        }
      }
    }

    if (unlabeledRoleNodeCount > 0) {
      violations.push({
        code: "UNCONFIRMED_ROLE_LABELS_PRESENT",
        split: splitName,
        count: unlabeledRoleNodeCount,
        message: `Partition ${splitName} has ${unlabeledRoleNodeCount} retained nodes without confirmed_gold roleAnnotation`,
      });
    }

    if (unlabeledCandidatePairCount > 0) {
      violations.push({
        code: "UNLABELED_CANDIDATE_PAIRS_PRESENT",
        split: splitName,
        count: unlabeledCandidatePairCount,
        message: `Partition ${splitName} has ${unlabeledCandidatePairCount} candidate pairs in P_unlabeled (formal partitions require |P_unlabeled| === 0)`,
      });
    }

    // Check zero gold denominators (always enforced even in synthetic engineering smoke!)
    for (const roleHead of WEIBO_W0A_ROLE_HEADS) {
      if (roleCounts[roleHead] === 0) {
        violations.push({
          code: "UNVERIFIED_ZERO_GOLD_DENOMINATOR",
          split: splitName,
          headKind: "role",
          head: roleHead,
          message: `Partition ${splitName} has 0 confirmed gold examples for role head ${roleHead}`,
        });
      }
    }
    for (const relHead of WEIBO_W0A_POSITIVE_RELATION_HEADS) {
      if (positiveRelCounts[relHead] === 0) {
        violations.push({
          code: "UNVERIFIED_ZERO_GOLD_DENOMINATOR",
          split: splitName,
          headKind: "relation",
          head: relHead,
          message: `Partition ${splitName} has 0 confirmed independent gold edges for relation head ${relHead}`,
        });
      }
    }

    splitStats[splitName] = {
      pageCount: snapshots.length,
      hasSearchResultsPage,
      hasRepostPage,
      roleCounts,
      positiveRelCounts,
      unlabeledRoleNodeCount,
      unlabeledCandidatePairCount,
    };
  }

  // Connected component source-family disjointness across splits
  const clusters = computeConnectedSourceFamilies(allTagged);
  const splitClusterCounts = { train: 0, development: 0, verification: 0 };
  for (const [familyId, members] of clusters.entries()) {
    const splitsPresent = [...new Set(members.map((m) => m.split))];
    if (splitsPresent.length > 1) {
      violations.push({
        code: "CROSS_PARTITION_SOURCE_FAMILY_LEAKAGE",
        sourceFamilyId: familyId,
        splits: splitsPresent,
        snapshotIds: members.map((m) => m.snapshotId),
        message: `Connected source family ${familyId} spans multiple partitions (${splitsPresent.join(", ")})`,
      });
    } else if (splitsPresent.length === 1) {
      const sp = splitsPresent[0];
      splitClusterCounts[sp] = (splitClusterCounts[sp] ?? 0) + 1;
    }
  }

  for (const [splitName] of splitEntries) {
    if (splitStats[splitName]) {
      splitStats[splitName].independentSourceFamilyCount = splitClusterCounts[splitName] ?? 0;
    }
  }

  // Enforce formal Table 4.1 scale thresholds unless allowSyntheticEngineeringSmoke is true
  if (!allowSyntheticEngineeringSmoke) {
    for (const [splitName] of splitEntries) {
      const stats = splitStats[splitName];
      const thresh = FORMAL_COVERAGE_THRESHOLDS[splitName];
      if (!stats || !thresh) continue;
      if (stats.independentSourceFamilyCount < thresh.minSourceFamilies) {
        violations.push({
          code: "BELOW_MIN_SOURCE_FAMILIES",
          split: splitName,
          actual: stats.independentSourceFamilyCount,
          required: thresh.minSourceFamilies,
          message: `Partition ${splitName} has ${stats.independentSourceFamilyCount} independent source families (requires >= ${thresh.minSourceFamilies})`,
        });
      }
      if (stats.pageCount < thresh.minPages) {
        violations.push({
          code: "BELOW_MIN_SNAPSHOT_PAGES",
          split: splitName,
          actual: stats.pageCount,
          required: thresh.minPages,
          message: `Partition ${splitName} has ${stats.pageCount} pages (requires >= ${thresh.minPages})`,
        });
      }
      if (!stats.hasSearchResultsPage || !stats.hasRepostPage) {
        violations.push({
          code: "MISSING_REQUIRED_PAGE_KINDS",
          split: splitName,
          message: `Partition ${splitName} must include both search results pages and repost pages`,
        });
      }
      if (stats.roleCounts.post_root < thresh.minPostRoot) {
        violations.push({
          code: "BELOW_MIN_POST_ROOT_COUNT",
          split: splitName,
          actual: stats.roleCounts.post_root,
          required: thresh.minPostRoot,
          message: `Partition ${splitName} has ${stats.roleCounts.post_root} post_root examples (requires >= ${thresh.minPostRoot})`,
        });
      }
      if (stats.roleCounts.reposted_embedded_post < thresh.minRepostedEmbeddedPost) {
        violations.push({
          code: "BELOW_MIN_REPOST_COUNT",
          split: splitName,
          actual: stats.roleCounts.reposted_embedded_post,
          required: thresh.minRepostedEmbeddedPost,
          message: `Partition ${splitName} has ${stats.roleCounts.reposted_embedded_post} reposted_embedded_post examples (requires >= ${thresh.minRepostedEmbeddedPost})`,
        });
      }
      for (const roleHead of WEIBO_W0A_ROLE_HEADS) {
        if (roleHead === "post_root" || roleHead === "reposted_embedded_post") continue;
        if (stats.roleCounts[roleHead] < thresh.minPerOtherRoleHead) {
          violations.push({
            code: "BELOW_MIN_ROLE_HEAD_COUNT",
            split: splitName,
            head: roleHead,
            actual: stats.roleCounts[roleHead],
            required: thresh.minPerOtherRoleHead,
            message: `Partition ${splitName} role head ${roleHead} has ${stats.roleCounts[roleHead]} examples (requires >= ${thresh.minPerOtherRoleHead})`,
          });
        }
      }
      for (const relHead of WEIBO_W0A_POSITIVE_RELATION_HEADS) {
        if (stats.positiveRelCounts[relHead] < thresh.minPerPositiveRelationHead) {
          violations.push({
            code: "BELOW_MIN_RELATION_HEAD_COUNT",
            split: splitName,
            head: relHead,
            actual: stats.positiveRelCounts[relHead],
            required: thresh.minPerPositiveRelationHead,
            message: `Partition ${splitName} relation head ${relHead} has ${stats.positiveRelCounts[relHead]} gold edges (requires >= ${thresh.minPerPositiveRelationHead})`,
          });
        }
      }
    }
  }

  return {
    kind: "nnanything.w0a.dataset-validation.v1",
    valid: violations.length === 0,
    allowSyntheticEngineeringSmoke,
    splitStats,
    violations,
  };
}

function parseArgs(argv) {
  const options = {
    allowSyntheticEngineeringSmoke: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--train-path") {
      options.trainPath = argv[++i];
    } else if (arg === "--dev-path") {
      options.devPath = argv[++i];
    } else if (arg === "--verification-path") {
      options.verificationPath = argv[++i];
    } else if (arg === "--out-report") {
      options.outReport = argv[++i];
    } else if (arg === "--allow-synthetic-engineering-smoke") {
      options.allowSyntheticEngineeringSmoke = true;
    } else {
      throw new Error(`Unsupported argument: ${arg}`);
    }
  }
  if (!options.trainPath || !options.devPath || !options.outReport) {
    throw new Error("--train-path, --dev-path, and --out-report are required");
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const trainSnapshots = readSnapshotsFile(options.trainPath, "train-path");
  const devSnapshots = readSnapshotsFile(options.devPath, "dev-path");
  const verificationSnapshots = options.verificationPath
    ? readSnapshotsFile(options.verificationPath, "verification-path")
    : [];
  const report = validateW0aDataset({
    trainSnapshots,
    devSnapshots,
    verificationSnapshots,
    allowSyntheticEngineeringSmoke: options.allowSyntheticEngineeringSmoke,
  });
  mkdirSync(dirname(options.outReport), { recursive: true });
  writeFileSync(options.outReport, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (!report.valid) {
    console.error(
      `W0A_DATASET_VALIDATION_FAILED: ${report.violations.length} violation(s) written to ${options.outReport}`,
    );
    process.exitCode = 1;
  } else {
    console.log(`W0A_DATASET_VALIDATION_PASSED: report written to ${options.outReport}`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  }
}
