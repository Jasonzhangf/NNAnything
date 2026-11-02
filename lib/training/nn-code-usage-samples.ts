// Confirmed nn-code usage-log learning cases.
//
// This module owns mechanical source-family grouping, cross-batch case
// association, and the conversion gate from independently confirmed log cases
// to train/dev/verification material. It never reads raw logs, never scans the
// filesystem, and never starts fitting. The algorithms preserve the audited r5
// data-gate behavior.
import {
  VALUE_FLOW_FEATURE_NAMES,
  VALUE_FLOW_FEATURE_SCHEMA,
  VALUE_FLOW_HR_PARAMETER_COUNT,
  VALUE_FLOW_HR_UNIT_ID,
  VALUE_FLOW_LABELS,
} from "../adapters/cli/value-flow-contract.js";

type AnyRecord = Record<string, any>;

export type MechanicalFamilyAssignmentInput = Readonly<{
  observations: readonly AnyRecord[];
  existingPartitions?: AnyRecord | null;
  confirmedFamilyAssignments?: readonly AnyRecord[];
  repoAliasMap?: Readonly<Record<string, string>>;
}>;

export type DatasetConversionInput = Readonly<{
  batchId?: string;
  acceptedCases?: readonly AnyRecord[];
  targetUnitContract: AnyRecord;
  existingPartitions?: AnyRecord | null;
  confirmedFamilyAssignments?: readonly AnyRecord[];
  existingCaseAssociations?: readonly AnyRecord[];
  repoAliasMap?: Readonly<Record<string, string>>;
  baselineProfile?: AnyRecord | null;
}>;

export type DatasetConversionResult = Readonly<{
  converterReadiness: "NOT_READY" | "SELF_CHECK_PASSED_AWAITING_AUDIT";
  readinessStatus: Readonly<{
    baselineReady: boolean;
    confirmedSampleCount: number;
    hasConfirmedSamples: boolean;
    canStartPostTraining: boolean;
    blockingReasons: readonly string[];
  }>;
  holdReason: string | null;
  caseAssociations: readonly AnyRecord[];
  updatedExistingCaseAssociations: readonly AnyRecord[];
  conflictedHistoricalCaseIds: readonly string[];
  familyAssignments: readonly AnyRecord[];
  familyAssignmentSummary: Readonly<{
    acceptedGroups: readonly string[];
    excludedGroups: readonly string[];
    conflictingGroups: readonly string[];
    unresolvedGroups: readonly string[];
    notReadyGroups: readonly string[];
  }>;
  train: readonly AnyRecord[];
  dev: readonly AnyRecord[];
  verificationRefs: readonly AnyRecord[];
  pendingReview?: readonly AnyRecord[];
  trainerPayload: Readonly<{
    trainInstancesOnly: readonly AnyRecord[];
    verificationContentIncluded: false;
  }>;
  engineeringRegressionRefs: readonly AnyRecord[];
  excludedWithReasons: readonly AnyRecord[];
  auditSummary?: Readonly<Record<string, any>>;
}>;

const ALLOWED_PARTITIONS = Object.freeze(["train", "dev", "verification"] as const);
const ALLOWED_LABEL_AUTHORITY_KINDS = Object.freeze([
  "ast_posterior_verified",
  "human_verified",
  "locked_oracle_verified",
] as const);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isExactThreeLabelSet(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length === VALUE_FLOW_LABELS.length
    && new Set(value).size === VALUE_FLOW_LABELS.length
    && VALUE_FLOW_LABELS.every(label => value.includes(label));
}

function isValidIsoTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function isValidComparisonSnapshot(snapshot: any): boolean {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
  return isNonEmptyString(snapshot.familyId)
    && isNonEmptyString(snapshot.callsiteKey)
    && isNonEmptyString(snapshot.candidateKey)
    && isNonEmptyString(snapshot.syntaxPatternKey)
    && isNonEmptyString(snapshot.unitId)
    && isNonEmptyString(snapshot.profileRef)
    && isNonEmptyString(snapshot.featureSchema)
    && isExactThreeLabelSet(snapshot.legalCandidates)
    && Array.isArray(snapshot.effectiveFeatures)
    && snapshot.effectiveFeatures.length === VALUE_FLOW_FEATURE_NAMES.length
    && snapshot.effectiveFeatures.every((value: unknown) => typeof value === "number" && Number.isFinite(value))
    && Array.isArray(snapshot.inputMissingMask)
    && snapshot.inputMissingMask.length === VALUE_FLOW_FEATURE_NAMES.length
    && snapshot.inputMissingMask.every((value: unknown) => typeof value === "boolean")
    && (VALUE_FLOW_LABELS as readonly string[]).includes(snapshot.expectedLabel);
}

function buildObservationIdentityKeyFromSnapshot(snapshot: any): string {
  return JSON.stringify([
    snapshot.familyId,
    snapshot.callsiteKey,
    snapshot.candidateKey,
    snapshot.syntaxPatternKey,
    snapshot.requestScopeKey ?? "default_scope",
    snapshot.unitId,
    snapshot.profileRef,
    snapshot.featureSchema,
    snapshot.legalCandidates,
    snapshot.effectiveFeatures,
    snapshot.inputMissingMask,
  ]);
}

function validateConfirmedLearningCaseFields(
  item: any,
  targetUnitContract: any,
): string[] {
  const reasons: string[] = [];

  if (!isNonEmptyString(item.callsiteKey)) reasons.push("MISSING_OR_EMPTY_CALLSITE_KEY");
  if (!isNonEmptyString(item.candidateKey)) reasons.push("MISSING_OR_EMPTY_CANDIDATE_KEY");
  if (!isNonEmptyString(item.syntaxPatternKey)) reasons.push("MISSING_OR_EMPTY_SYNTAX_PATTERN_KEY");
  if (
    !isNonEmptyString(item.runId)
    || typeof item.seq !== "number"
    || !Number.isInteger(item.seq)
    || item.seq < 0
  ) {
    reasons.push("MISSING_OR_INVALID_RUN_SEQ_REF");
  }

  const sourceOrigin = item.sourceOrigin;
  if (!sourceOrigin || typeof sourceOrigin !== "object" || Array.isArray(sourceOrigin)) {
    reasons.push("MISSING_SOURCE_ORIGIN_EVIDENCE_OBJECT");
  } else {
    const hasRepoOrigin = isNonEmptyString(sourceOrigin.repoCanonicalId)
      && isNonEmptyString(sourceOrigin.repoEvidenceRef);
    const hasTemplateOrigin = isNonEmptyString(sourceOrigin.templateSourceId)
      && isNonEmptyString(sourceOrigin.templateEvidenceRef);
    if (!hasRepoOrigin && !hasTemplateOrigin) {
      reasons.push("MISSING_REPO_OR_SYNTHETIC_TEMPLATE_ORIGIN_EVIDENCE");
    }
    if (sourceOrigin.repoIndependenceConfirmed === false) {
      reasons.push("UNRESOLVED_REPO_ALIAS_OR_INDEPENDENCE_EVIDENCE");
    }
    if (sourceOrigin.renameRelationConfirmed === false) {
      reasons.push("UNRESOLVED_FILE_RENAME_RELATION");
    }
    if (sourceOrigin.sourceConsistentAcrossRuns === "unknown") {
      reasons.push("UNRESOLVED_CROSS_RUN_SOURCE_CONSISTENCY");
    }
  }

  if (
    item.assignedPartition !== undefined
    && !(ALLOWED_PARTITIONS as readonly unknown[]).includes(item.assignedPartition)
  ) {
    reasons.push(`INVALID_OR_UNKNOWN_PARTITION:${String(item.assignedPartition)}`);
  }

  const labelAuthority = item.labelAuthority;
  if (!labelAuthority || typeof labelAuthority !== "object" || Array.isArray(labelAuthority)) {
    reasons.push("MISSING_OR_NON_OBJECT_LABEL_AUTHORITY");
  } else {
    if (!(ALLOWED_LABEL_AUTHORITY_KINDS as readonly unknown[]).includes(labelAuthority.kind)) {
      reasons.push(`UNRECOGNIZED_LABEL_AUTHORITY_KIND:${String(labelAuthority.kind)}`);
    }
    if (!isNonEmptyString(labelAuthority.reviewer)) {
      reasons.push("MISSING_LABEL_AUTHORITY_REVIEWER");
    }
    if (!isValidIsoTimestamp(labelAuthority.confirmedAt)) {
      reasons.push("MISSING_OR_INVALID_CONFIRMED_AT_TIMESTAMP");
    }
    if (
      !Array.isArray(labelAuthority.evidenceRefs)
      || labelAuthority.evidenceRefs.length === 0
      || !labelAuthority.evidenceRefs.every(isNonEmptyString)
    ) {
      reasons.push("MISSING_OR_EMPTY_EVIDENCE_REFS");
    }
  }

  const posteriorFact = item.posteriorFact;
  if (!posteriorFact || typeof posteriorFact !== "object" || Array.isArray(posteriorFact)) {
    reasons.push("MISSING_OR_NON_OBJECT_POSTERIOR_FACT");
  } else {
    if (!(VALUE_FLOW_LABELS as readonly unknown[]).includes(posteriorFact.expectedLabel)) {
      reasons.push(`INVALID_EXPECTED_LABEL_NOT_IN_3CLASS_CONTRACT:${String(posteriorFact.expectedLabel)}`);
    }
    if (posteriorFact.supervisionMasked !== false) {
      reasons.push("SUPERVISION_MASKED_MUST_BE_FALSE_FOR_CONFIRMED_LEARNING_CASE");
    }
    if (
      !isNonEmptyString(posteriorFact.oracleKind)
      || !isNonEmptyString(posteriorFact.verifiedSpanOrEdgeRef)
    ) {
      reasons.push("MISSING_ORACLE_KIND_OR_VERIFIED_SPAN_REF");
    }
  }

  const decisionEvent = item.decisionEvent;
  if (!decisionEvent || typeof decisionEvent !== "object" || Array.isArray(decisionEvent)) {
    reasons.push("MISSING_DECISION_EVENT");
  } else {
    if (decisionEvent.unitId !== targetUnitContract.unitId) {
      reasons.push(`MISMATCHED_UNIT_ID:${String(decisionEvent.unitId)}`);
    }
    if (decisionEvent.featureSchema !== targetUnitContract.featureSchema) {
      reasons.push(`MISMATCHED_FEATURE_SCHEMA:${String(decisionEvent.featureSchema)}`);
    }
    if (!isNonEmptyString(decisionEvent.profileRef)) reasons.push("MISSING_PROFILE_REF");
    if (
      !Array.isArray(decisionEvent.preDecisionFeatures)
      || decisionEvent.preDecisionFeatures.length !== VALUE_FLOW_FEATURE_NAMES.length
      || !decisionEvent.preDecisionFeatures.every(
        (value: unknown) => typeof value === "number" && Number.isFinite(value),
      )
    ) {
      reasons.push("NON_FINITE_OR_WRONG_DIM_PRE_DECISION_FEATURES");
    }
    if (
      !Array.isArray(decisionEvent.inputMissingMask)
      || decisionEvent.inputMissingMask.length !== VALUE_FLOW_FEATURE_NAMES.length
      || !decisionEvent.inputMissingMask.every((value: unknown) => typeof value === "boolean")
    ) {
      reasons.push("INVALID_OR_WRONG_DIM_INPUT_MISSING_MASK_15");
    }
    if (!isExactThreeLabelSet(decisionEvent.legalCandidates)) {
      reasons.push("INVALID_LEGAL_CANDIDATES");
    } else if (!decisionEvent.legalCandidates.includes(decisionEvent.originalChoice)) {
      reasons.push("ORIGINAL_CHOICE_NOT_IN_LEGAL_CANDIDATES");
    }
  }

  if (item.sourceExcerptComplete === false || item.sourceChangedDuringRun === true) {
    reasons.push("INCOMPLETE_EXCERPT_OR_SOURCE_MUTATED");
  }

  return reasons;
}

export function buildMechanicalFamilyAssignments(
  input: MechanicalFamilyAssignmentInput,
): Readonly<{
  directOverlaps: readonly string[];
  hasAnyUnresolvedIndependenceGroup: boolean;
  familyAssignments: readonly AnyRecord[];
  itemToFamilyAssignment: ReadonlyMap<AnyRecord, AnyRecord>;
}> {
  const observations = input.observations as readonly AnyRecord[];
  const existingPartitions = input.existingPartitions ?? {};
  const confirmedFamilyAssignments = input.confirmedFamilyAssignments ?? [];
  const repoAliasMap = input.repoAliasMap ?? {};

  const existingTrain = new Set<string>(existingPartitions.trainFamilies ?? []);
  const existingDev = new Set<string>(existingPartitions.devFamilies ?? []);
  const existingVerification = new Set<string>(existingPartitions.verificationFamilies ?? []);
  const existingDemoted = new Set<string>(existingPartitions.demotedVerificationFamilies ?? []);

  const directOverlaps: string[] = [];
  for (const familyId of existingTrain) {
    if (existingDev.has(familyId) || existingVerification.has(familyId)) {
      directOverlaps.push(familyId);
    }
  }
  for (const familyId of existingDev) {
    if (existingVerification.has(familyId) && !directOverlaps.includes(familyId)) {
      directOverlaps.push(familyId);
    }
  }

  const legacyFamilyPartitionMap = new Map<string, string>();
  for (const familyId of existingTrain) legacyFamilyPartitionMap.set(familyId, "train");
  for (const familyId of existingDev) legacyFamilyPartitionMap.set(familyId, "dev");
  for (const familyId of existingVerification) {
    legacyFamilyPartitionMap.set(
      familyId,
      existingDemoted.has(familyId) ? "demoted_known_regression" : "verification",
    );
  }
  for (const familyId of existingDemoted) {
    if (!legacyFamilyPartitionMap.has(familyId)) {
      legacyFamilyPartitionMap.set(familyId, "demoted_known_regression");
    }
  }

  const confirmedAssignmentsByFamilyId = new Map<string, AnyRecord[]>();
  const confirmedAssignmentsByOriginKey = new Map<string, AnyRecord[]>();
  for (const entry of confirmedFamilyAssignments) {
    if (!entry || !isNonEmptyString(entry.familyId)) continue;
    const byFamily = confirmedAssignmentsByFamilyId.get(entry.familyId) ?? [];
    byFamily.push(entry);
    confirmedAssignmentsByFamilyId.set(entry.familyId, byFamily);
    for (const rawOriginKey of entry.repoOrTemplateOrigins ?? []) {
      const normalizedOriginKey = String(rawOriginKey).startsWith("repo:")
        ? `repo:${repoAliasMap[String(rawOriginKey).slice(5)] ?? String(rawOriginKey).slice(5)}`
        : String(rawOriginKey);
      const byOrigin = confirmedAssignmentsByOriginKey.get(normalizedOriginKey) ?? [];
      byOrigin.push(entry);
      confirmedAssignmentsByOriginKey.set(normalizedOriginKey, byOrigin);
    }
  }

  const count = observations.length;
  const parent = Array.from({ length: count }, (_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    let current = index;
    while (current !== root) {
      const next = parent[current]!;
      parent[current] = root;
      current = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    if (leftRoot < rightRoot) parent[rightRoot] = leftRoot;
    else parent[leftRoot] = rightRoot;
  };

  const observationKeyToIndex = new Map<string, number>();
  const caseIdToIndex = new Map<string, number>();
  const canonicalOriginToFirstIndex = new Map<string, number>();
  const familyIdToFirstIndex = new Map<string, number>();

  const resolveCanonicalOriginKey = (item: any): string | null => {
    const sourceOrigin = item.sourceOrigin;
    if (!sourceOrigin || typeof sourceOrigin !== "object") return null;
    if (isNonEmptyString(sourceOrigin.templateSourceId)) {
      return `template:${sourceOrigin.templateSourceId}`;
    }
    const rawRepo = sourceOrigin.worktreeOfRepoId
      ?? sourceOrigin.repoCanonicalId
      ?? sourceOrigin.repoPath
      ?? null;
    if (!isNonEmptyString(rawRepo)) return null;
    return `repo:${repoAliasMap[rawRepo] ?? rawRepo}`;
  };

  for (let index = 0; index < count; index += 1) {
    const item = observations[index]!;
    const logRoot = item.logRoot ?? "default_log_root";
    const observationKey = `${logRoot}#${item.runId}#${item.seq}`;
    if (!observationKeyToIndex.has(observationKey)) observationKeyToIndex.set(observationKey, index);
    if (isNonEmptyString(item.caseId) && !caseIdToIndex.has(item.caseId)) {
      caseIdToIndex.set(item.caseId, index);
    }
    const hasInvalidPartition = item.assignedPartition !== undefined
      && !(ALLOWED_PARTITIONS as readonly unknown[]).includes(item.assignedPartition);
    const hasMissingOrigin = item.reviewState === "confirmed_learning_case"
      && (!item.sourceOrigin || typeof item.sourceOrigin !== "object");
    if (hasInvalidPartition || hasMissingOrigin) continue;
    const originKey = resolveCanonicalOriginKey(item);
    if (originKey !== null) {
      const first = canonicalOriginToFirstIndex.get(originKey);
      if (first === undefined) canonicalOriginToFirstIndex.set(originKey, index);
      else union(index, first);
    }
    if (isNonEmptyString(item.familyId)) {
      const first = familyIdToFirstIndex.get(item.familyId);
      if (first === undefined) familyIdToFirstIndex.set(item.familyId, index);
      else union(index, first);
    }
  }

  for (let index = 0; index < count; index += 1) {
    const item = observations[index]!;
    const references = [
      ...(item.derivedFrom ?? []),
      ...(item.sameSourceAs ?? []),
      ...(item.renamedFromCaseIds ?? []),
    ];
    for (const reference of references) {
      const caseIndex = caseIdToIndex.get(reference);
      if (caseIndex !== undefined) union(index, caseIndex);
      else {
        const observationIndex = observationKeyToIndex.get(reference);
        if (observationIndex !== undefined) union(index, observationIndex);
      }
    }
    for (const familyId of item.connectedLegacyFamilyIds ?? []) {
      const familyIndex = familyIdToFirstIndex.get(familyId);
      if (familyIndex !== undefined) union(index, familyIndex);
    }
  }

  const components = new Map<number, AnyRecord[]>();
  for (let index = 0; index < count; index += 1) {
    const root = find(index);
    const members = components.get(root) ?? [];
    members.push(observations[index]!);
    components.set(root, members);
  }

  const familyAssignments: AnyRecord[] = [];
  const itemToFamilyAssignment = new Map<AnyRecord, AnyRecord>();
  let hasAnyUnresolvedIndependenceGroup = false;
  let groupSequence = 0;

  for (const members of components.values()) {
    groupSequence += 1;
    const legacyFamilyIds = new Set<string>();
    const candidateFamilyIds = new Set<string>();
    const repoOrTemplateOrigins = new Set<string>();
    const confirmedRelationEdges: AnyRecord[] = [];
    const memberCaseRefs: string[] = [];
    let usedForFixOrDesign = false;
    let hasUnresolvedOriginOrEdge = false;
    const unresolvedReasons: string[] = [];

    for (const member of members) {
      if (isNonEmptyString(member.caseId)) memberCaseRefs.push(member.caseId);
      const originKey = resolveCanonicalOriginKey(member);
      if (originKey !== null) repoOrTemplateOrigins.add(originKey);
      else if (member.reviewState === "confirmed_learning_case") {
        hasUnresolvedOriginOrEdge = true;
        unresolvedReasons.push("MISSING_REPO_OR_TEMPLATE_ORIGIN");
      }
      if (member.sourceOrigin?.repoIndependenceConfirmed === false) {
        hasUnresolvedOriginOrEdge = true;
        hasAnyUnresolvedIndependenceGroup = true;
        unresolvedReasons.push("REPO_ALIAS_OR_INDEPENDENCE_UNCONFIRMED");
      }
      if (Array.isArray(member.unconfirmedRelationEdges) && member.unconfirmedRelationEdges.length > 0) {
        hasUnresolvedOriginOrEdge = true;
        hasAnyUnresolvedIndependenceGroup = true;
        unresolvedReasons.push(`UNCONFIRMED_RELATION_EDGES:${member.unconfirmedRelationEdges.join(",")}`);
      }
      for (const target of member.derivedFrom ?? []) {
        confirmedRelationEdges.push({
          from: member.caseId ?? member.runId,
          to: target,
          kind: "derivedFrom",
        });
      }
      for (const target of member.sameSourceAs ?? []) {
        confirmedRelationEdges.push({
          from: member.caseId ?? member.runId,
          to: target,
          kind: "sameSourceAs",
        });
      }
      if (isNonEmptyString(member.familyId)) {
        candidateFamilyIds.add(member.familyId);
        if (legacyFamilyPartitionMap.has(member.familyId)) legacyFamilyIds.add(member.familyId);
      }
      for (const familyId of member.connectedLegacyFamilyIds ?? []) {
        candidateFamilyIds.add(familyId);
        if (legacyFamilyPartitionMap.has(familyId)) legacyFamilyIds.add(familyId);
      }
      if (
        member.usedForFixOrDesign === true
        || (isNonEmptyString(member.familyId) && existingDemoted.has(member.familyId))
      ) {
        usedForFixOrDesign = true;
      }
    }

    const matchedAssignments = new Set<AnyRecord>();
    for (const familyId of candidateFamilyIds) {
      for (const entry of confirmedAssignmentsByFamilyId.get(familyId) ?? []) {
        matchedAssignments.add(entry);
      }
    }
    for (const originKey of repoOrTemplateOrigins) {
      for (const entry of confirmedAssignmentsByOriginKey.get(originKey) ?? []) {
        matchedAssignments.add(entry);
      }
    }
    const matchedConfirmedAssignments = [...matchedAssignments].sort((left, right) =>
      String(left.familyId ?? "").localeCompare(String(right.familyId ?? "")),
    );
    for (const matched of matchedConfirmedAssignments) {
      if (isNonEmptyString(matched.familyId)) candidateFamilyIds.add(matched.familyId);
    }

    const sortedLegacyIds = [...legacyFamilyIds].sort();
    const sortedCandidateIds = [...candidateFamilyIds].sort();
    const primaryFamilyId = sortedLegacyIds[0]
      ?? sortedCandidateIds[0]
      ?? `auto-unconfirmed-group-${groupSequence}`;

    const claimedPartitions = new Set<string>();
    let wasEverVerification = false;
    for (const familyId of sortedLegacyIds) {
      const partition = legacyFamilyPartitionMap.get(familyId);
      if (
        partition === "verification"
        || partition === "demoted_known_regression"
        || existingVerification.has(familyId)
        || existingDemoted.has(familyId)
      ) {
        wasEverVerification = true;
      }
      if (partition && partition !== "demoted_known_regression") {
        claimedPartitions.add(partition);
      }
    }
    for (const matched of matchedConfirmedAssignments) {
      if (isNonEmptyString(matched.partition)) {
        claimedPartitions.add(matched.partition);
        if (matched.partition === "verification") wasEverVerification = true;
      }
      if (matched.previousPartition === "verification" || matched.wasEverVerification === true) {
        wasEverVerification = true;
      }
      if (matched.usedForFixOrDesign === true) usedForFixOrDesign = true;
    }

    let anyMemberMissingExplicitPartition = false;
    for (const member of members) {
      if (member.assignedPartition === "verification") wasEverVerification = true;
      if (member.reviewState !== "confirmed_learning_case") continue;
      if (member.assignedPartition !== undefined) {
        claimedPartitions.add(member.assignedPartition);
      } else if (
        sortedLegacyIds.length === 0
        && matchedConfirmedAssignments.length === 0
      ) {
        anyMemberMissingExplicitPartition = true;
      }
    }

    let assignmentState: string;
    let resolvedPartition: string | null = null;
    let holdReason: string | null = null;
    if (hasUnresolvedOriginOrEdge) {
      assignmentState = "unresolved";
      holdReason = `UNRESOLVED_SOURCE_RELATION:${[...new Set(unresolvedReasons)].join(";")}`;
    } else if (claimedPartitions.size > 1) {
      assignmentState = "conflicting";
      holdReason = `CONNECTED_FAMILY_PARTITION_CONFLICT:${[...claimedPartitions].sort().join("_vs_")}`;
    } else if (wasEverVerification && usedForFixOrDesign) {
      assignmentState = "excluded";
      resolvedPartition = "demoted_known_regression";
      holdReason = "WHOLE_GROUP_DEMOTED_FROM_VERIFICATION_USED_FOR_FIX_OR_DESIGN";
    } else if (claimedPartitions.size === 0 || anyMemberMissingExplicitPartition) {
      assignmentState = "NOT_READY";
      holdReason = "UNASSIGNED_FAMILY_OR_MISSING_PARTITION_NEVER_DEFAULT_TO_TRAIN";
    } else {
      const singlePartition = [...claimedPartitions][0]!;
      if (!(ALLOWED_PARTITIONS as readonly string[]).includes(singlePartition)) {
        assignmentState = "NOT_READY";
        holdReason = `INVALID_CLAIMED_PARTITION:${singlePartition}`;
      } else {
        const isLegacyApproved = sortedLegacyIds.length > 0;
        const hasConfirmedAssignmentEvidence = matchedConfirmedAssignments.length > 0
          && matchedConfirmedAssignments.every(matched =>
            isNonEmptyString(matched.confirmedBy)
            && isValidIsoTimestamp(matched.confirmedAt)
            && isNonEmptyString(matched.independentSourceEvidence)
          );
        if (!isLegacyApproved && !hasConfirmedAssignmentEvidence) {
          assignmentState = "NOT_READY";
          holdReason = "NEW_SOURCE_FAMILY_MISSING_CONFIRMED_ASSIGNMENT_RECEIPT_EVIDENCE";
        } else {
          assignmentState = "accepted";
          resolvedPartition = singlePartition;
        }
      }
    }

    const familyRecord: AnyRecord = {
      familyId: primaryFamilyId,
      mergedLegacyFamilyIds: sortedLegacyIds,
      matchedConfirmedFamilyIds: matchedConfirmedAssignments.map(matched => matched.familyId),
      memberCaseRefs: memberCaseRefs.sort(),
      repoOrTemplateOrigins: [...repoOrTemplateOrigins].sort(),
      confirmedRelationEdges,
      partition: resolvedPartition,
      usageHistory: { usedForFixOrDesign, wasEverVerification },
      confirmedBy: matchedConfirmedAssignments
        .map(matched => matched.confirmedBy)
        .filter(Boolean)
        .join(",")
        || (sortedLegacyIds.length > 0 ? "existing_locked_partition" : null),
      confirmedAt: matchedConfirmedAssignments[0]?.confirmedAt ?? null,
      assignmentState,
      holdReason,
    };
    familyAssignments.push(familyRecord);
    for (const member of members) itemToFamilyAssignment.set(member, familyRecord);
  }

  familyAssignments.sort((left, right) => {
    const familyComparison = String(left.familyId).localeCompare(String(right.familyId));
    if (familyComparison !== 0) return familyComparison;
    return String(left.memberCaseRefs[0] ?? "").localeCompare(String(right.memberCaseRefs[0] ?? ""));
  });

  return Object.freeze({
    directOverlaps: Object.freeze([...directOverlaps]),
    hasAnyUnresolvedIndependenceGroup,
    familyAssignments: Object.freeze(familyAssignments),
    itemToFamilyAssignment,
  });
}

export function convertLogObservationsToDataset(
  input: DatasetConversionInput,
): DatasetConversionResult {
  const {
    batchId = "batch-20261101",
    acceptedCases = [],
    targetUnitContract,
    existingPartitions = null,
    confirmedFamilyAssignments = [],
    existingCaseAssociations = [],
    repoAliasMap = {},
    baselineProfile = null,
  } = input;

  const baselineReady = Boolean(
    baselineProfile
    && baselineProfile.qualified === true
    && isNonEmptyString(baselineProfile.profileId),
  );

  const missingContractFields = [
    "unitId",
    "semanticContractRef",
    "featureSchema",
    "labelSchema",
    "trainerEntry",
  ].filter(key => !targetUnitContract || !isNonEmptyString(targetUnitContract[key]));
  if (
    missingContractFields.length > 0
    || targetUnitContract.featureDim !== VALUE_FLOW_FEATURE_NAMES.length
    || targetUnitContract.paramCount !== VALUE_FLOW_HR_PARAMETER_COUNT
    || !Array.isArray(targetUnitContract.classes)
    || targetUnitContract.classes.length !== VALUE_FLOW_LABELS.length
    || !VALUE_FLOW_LABELS.every(label => targetUnitContract.classes.includes(label))
  ) {
    const blockingReasons = ["TARGET_UNIT_CONTRACT_INCOMPLETE"];
    if (!baselineReady) blockingReasons.push("baseline_not_ready");
    return Object.freeze({
      converterReadiness: "NOT_READY",
      readinessStatus: Object.freeze({
        baselineReady,
        confirmedSampleCount: 0,
        hasConfirmedSamples: false,
        canStartPostTraining: false,
        blockingReasons: Object.freeze(blockingReasons),
      }),
      holdReason: `TARGET_UNIT_CONTRACT_INCOMPLETE: missing or mismatched ${missingContractFields.join(", ") || "15-dim/579-param/3-class contract"}`,
      caseAssociations: Object.freeze([]),
      updatedExistingCaseAssociations: Object.freeze([]),
      conflictedHistoricalCaseIds: Object.freeze([]),
      familyAssignments: Object.freeze([]),
      familyAssignmentSummary: Object.freeze({
        acceptedGroups: Object.freeze([]),
        excludedGroups: Object.freeze([]),
        conflictingGroups: Object.freeze([]),
        unresolvedGroups: Object.freeze([]),
        notReadyGroups: Object.freeze([]),
      }),
      train: Object.freeze([]),
      dev: Object.freeze([]),
      verificationRefs: Object.freeze([]),
      pendingReview: Object.freeze([]),
      trainerPayload: Object.freeze({
        trainInstancesOnly: Object.freeze([]),
        verificationContentIncluded: false,
      }),
      engineeringRegressionRefs: Object.freeze([]),
      excludedWithReasons: Object.freeze([]),
    });
  }

  const historicalCaseById = new Map<string, any>();
  const historicalCaseByObservationRef = new Map<string, any>();
  const historicalCasesByObservationIdentityKey = new Map<string, any[]>();
  const historicalCasesByLocationKey = new Map<string, any[]>();
  const historicalCasesByFamilyKey = new Map<string, any[]>();
  const preExistingConflictedHistoricalCases: any[] = [];

  for (const historical of existingCaseAssociations) {
    if (!historical || !isNonEmptyString(historical.caseId)) continue;
    const cloned = structuredClone(historical);
    historicalCaseById.set(cloned.caseId, cloned);
    if (cloned.associationState === "conflict") preExistingConflictedHistoricalCases.push(cloned);
    for (const reference of cloned.observationRefs ?? []) {
      historicalCaseByObservationRef.set(reference, cloned);
    }
    if (isNonEmptyString(cloned.sourceFamilyRef)) {
      const cases = historicalCasesByFamilyKey.get(cloned.sourceFamilyRef) ?? [];
      cases.push(cloned);
      historicalCasesByFamilyKey.set(cloned.sourceFamilyRef, cases);
    }
    if (isValidComparisonSnapshot(cloned.comparisonSnapshot)) {
      const snapshot = cloned.comparisonSnapshot;
      const identityKey = buildObservationIdentityKeyFromSnapshot(snapshot);
      const identityCases = historicalCasesByObservationIdentityKey.get(identityKey) ?? [];
      identityCases.push(cloned);
      historicalCasesByObservationIdentityKey.set(identityKey, identityCases);
      const locationKey = `${snapshot.familyId}::${snapshot.callsiteKey}`;
      const locationCases = historicalCasesByLocationKey.get(locationKey) ?? [];
      locationCases.push(cloned);
      historicalCasesByLocationKey.set(locationKey, locationCases);
      if (isNonEmptyString(snapshot.familyId)) {
        const familyCases = historicalCasesByFamilyKey.get(snapshot.familyId) ?? [];
        familyCases.push(cloned);
        historicalCasesByFamilyKey.set(snapshot.familyId, familyCases);
      }
    } else if (
      isNonEmptyString(cloned.sourceFamilyRef)
      && isNonEmptyString(cloned.callsiteKey)
    ) {
      const locationKey = `${cloned.sourceFamilyRef}::${cloned.callsiteKey}`;
      const locationCases = historicalCasesByLocationKey.get(locationKey) ?? [];
      locationCases.push(cloned);
      historicalCasesByLocationKey.set(locationKey, locationCases);
    }
  }

  const canonicalObservationPayload = (item: any): string => {
    const copy = { ...item };
    delete copy.caseId;
    delete copy.originalLogPath;
    return JSON.stringify(copy);
  };

  const seenObservationPayloadByKey = new Map<string, AnyRecord>();
  const conflictingObservationKeys = new Set<string>();
  const missingHistoricalPayloadObservationKeys = new Set<string>();
  const deduplicatedObservations: any[] = [];
  let idempotentDuplicatesSkipped = 0;
  let crossBatchIdempotentSkippedCount = 0;
  const conflictedHistoricalCaseIds = new Set<string>();
  const updatedExistingCaseMap = new Map<string, any>();

  for (const historical of preExistingConflictedHistoricalCases) {
    conflictedHistoricalCaseIds.add(historical.caseId);
    updatedExistingCaseMap.set(historical.caseId, historical);
  }
  for (const historicalGroup of historicalCasesByObservationIdentityKey.values()) {
    const labels = new Set(
      historicalGroup.map(historical => historical.comparisonSnapshot.expectedLabel),
    );
    if (
      historicalGroup.some(historical => historical.associationState === "conflict")
      || labels.size > 1
    ) {
      const groupIds = historicalGroup.map(historical => historical.caseId).sort();
      for (const historical of historicalGroup) {
        historical.associationState = "conflict";
        historical.relatedCaseIds = [
          ...new Set([
            ...(historical.relatedCaseIds ?? []),
            ...groupIds.filter((caseId: string) => caseId !== historical.caseId),
          ]),
        ].sort();
        conflictedHistoricalCaseIds.add(historical.caseId);
        updatedExistingCaseMap.set(historical.caseId, historical);
      }
    }
  }

  for (const item of acceptedCases) {
    const logRoot = item.logRoot ?? "default_log_root";
    const observationKey = `${logRoot}#${item.runId}#${item.seq}`;
    const payloadString = canonicalObservationPayload(item);
    if (historicalCaseByObservationRef.has(observationKey)) {
      const historical = historicalCaseByObservationRef.get(observationKey);
      const historicalPayload = historical.observationPayloadsByRef?.[observationKey];
      if (!isNonEmptyString(historicalPayload)) {
        missingHistoricalPayloadObservationKeys.add(observationKey);
      } else if (historicalPayload === payloadString) {
        idempotentDuplicatesSkipped += 1;
        crossBatchIdempotentSkippedCount += 1;
        continue;
      } else {
        conflictingObservationKeys.add(observationKey);
        historical.associationState = "conflict";
        conflictedHistoricalCaseIds.add(historical.caseId);
        updatedExistingCaseMap.set(historical.caseId, historical);
      }
    }

    const previous = seenObservationPayloadByKey.get(observationKey);
    if (previous !== undefined) {
      if (previous.payloadString === payloadString) {
        idempotentDuplicatesSkipped += 1;
        if (
          isNonEmptyString(item.originalLogPath)
          && !previous.item.preservedOriginalPaths.includes(item.originalLogPath)
        ) {
          previous.item.preservedOriginalPaths.push(item.originalLogPath);
        }
        continue;
      }
      conflictingObservationKeys.add(observationKey);
    } else {
      const wrapped = {
        ...item,
        logRoot,
        observationKey,
        payloadString,
        preservedOriginalPaths: isNonEmptyString(item.originalLogPath)
          ? [item.originalLogPath]
          : [],
      };
      seenObservationPayloadByKey.set(observationKey, { payloadString, item: wrapped });
      deduplicatedObservations.push(wrapped);
    }
  }

  const grouping = buildMechanicalFamilyAssignments({
    observations: deduplicatedObservations,
    existingPartitions,
    confirmedFamilyAssignments,
    repoAliasMap,
  });
  if (grouping.directOverlaps.length > 0) {
    const overlaps = [...grouping.directOverlaps].sort();
    const blockingReasons = [`EXISTING_PARTITIONS_FAMILY_OVERLAP:${overlaps.join(",")}`];
    if (!baselineReady) blockingReasons.push("baseline_not_ready");
    return Object.freeze({
      converterReadiness: "NOT_READY",
      readinessStatus: Object.freeze({
        baselineReady,
        confirmedSampleCount: 0,
        hasConfirmedSamples: false,
        canStartPostTraining: false,
        blockingReasons: Object.freeze(blockingReasons),
      }),
      holdReason: `EXISTING_PARTITIONS_FAMILY_OVERLAP: ${overlaps.join(", ")}`,
      caseAssociations: Object.freeze([]),
      updatedExistingCaseAssociations: Object.freeze([]),
      conflictedHistoricalCaseIds: Object.freeze([]),
      familyAssignments: grouping.familyAssignments,
      familyAssignmentSummary: Object.freeze({
        acceptedGroups: Object.freeze([]),
        excludedGroups: Object.freeze([]),
        conflictingGroups: Object.freeze(overlaps),
        unresolvedGroups: Object.freeze([]),
        notReadyGroups: Object.freeze([]),
      }),
      train: Object.freeze([]),
      dev: Object.freeze([]),
      verificationRefs: Object.freeze([]),
      pendingReview: Object.freeze([]),
      trainerPayload: Object.freeze({
        trainInstancesOnly: Object.freeze([]),
        verificationContentIncluded: false,
      }),
      engineeringRegressionRefs: Object.freeze([]),
      excludedWithReasons: Object.freeze([]),
    });
  }

  const familyAssignmentSummary = Object.freeze({
    acceptedGroups: Object.freeze(
      grouping.familyAssignments
        .filter(group => group.assignmentState === "accepted")
        .map(group => group.familyId),
    ),
    excludedGroups: Object.freeze(
      grouping.familyAssignments
        .filter(group => group.assignmentState === "excluded")
        .map(group => group.familyId),
    ),
    conflictingGroups: Object.freeze(
      grouping.familyAssignments
        .filter(group => group.assignmentState === "conflicting")
        .map(group => group.familyId),
    ),
    unresolvedGroups: Object.freeze(
      grouping.familyAssignments
        .filter(group => group.assignmentState === "unresolved")
        .map(group => group.familyId),
    ),
    notReadyGroups: Object.freeze(
      grouping.familyAssignments
        .filter(group => group.assignmentState === "NOT_READY")
        .map(group => group.familyId),
    ),
  });

  let repeatedCallsiteMergedCount = 0;
  let crossBatchMergedObservationCount = 0;
  const train: any[] = [];
  const dev: any[] = [];
  const verificationRefs: any[] = [];
  const pendingReview: any[] = [];
  const engineeringRegressionRefs: any[] = [];
  const excludedWithReasons: any[] = [];
  const caseAssociations: any[] = [];

  let nextCaseSequence = existingCaseAssociations.length + 1;
  const allocateCaseId = (observationKey: string, explicitCaseId?: unknown): string => {
    const historical = historicalCaseByObservationRef.get(observationKey);
    if (historical !== undefined) return historical.caseId;
    if (isNonEmptyString(explicitCaseId) && !historicalCaseById.has(explicitCaseId)) {
      return explicitCaseId;
    }
    const caseId = `${batchId}-case-${String(nextCaseSequence).padStart(4, "0")}`;
    nextCaseSequence += 1;
    return caseId;
  };

  const validLearningCandidates: any[] = [];
  for (const item of deduplicatedObservations) {
    const idempotentKey = `${item.runId}#${item.seq}`;
    const observationKey = item.observationKey;
    const familyRecord = grouping.itemToFamilyAssignment.get(item);
    const familyId = familyRecord?.familyId ?? item.familyId ?? null;

    if (missingHistoricalPayloadObservationKeys.has(observationKey)) {
      const caseId = allocateCaseId(observationKey, item.caseId);
      caseAssociations.push({
        caseId,
        observationRefs: [observationKey],
        relatedCaseIds: [],
        associationState: "unresolved",
        missingEvidence: ["MISSING_HISTORICAL_OBSERVATION_PAYLOAD_EVIDENCE"],
        comparedFields: ["logRoot", "runId", "seq", "payload"],
        evidenceRefs: [observationKey],
        confirmedBy: null,
        confirmedAt: null,
        sourceFamilyRef: familyId,
      });
      excludedWithReasons.push({
        caseId,
        idempotentKey,
        sourceFamily: familyId,
        state: "needs_evidence",
        reasonCode: "MISSING_HISTORICAL_OBSERVATION_PAYLOAD_EVIDENCE",
        rejectionReasons: ["MISSING_HISTORICAL_OBSERVATION_PAYLOAD_EVIDENCE"],
      });
      continue;
    }

    if (conflictingObservationKeys.has(observationKey)) {
      const caseId = allocateCaseId(observationKey, item.caseId);
      caseAssociations.push({
        caseId,
        observationRefs: [observationKey],
        relatedCaseIds: [],
        associationState: "conflict",
        comparedFields: ["logRoot", "runId", "seq", "payload"],
        evidenceRefs: [observationKey],
        confirmedBy: "converter_raw_ref_check",
        confirmedAt: "2026-11-01T07:30:00Z",
        sourceFamilyRef: familyId,
      });
      excludedWithReasons.push({
        caseId,
        idempotentKey,
        sourceFamily: familyId,
        state: "conflict",
        reasonCode: "SAME_OBSERVATION_REF_DIFFERENT_CONTENT",
        rejectionReasons: ["SAME_OBSERVATION_REF_DIFFERENT_CONTENT"],
      });
      continue;
    }

    if (item.runState !== "complete") {
      excludedWithReasons.push({
        caseId: item.caseId,
        idempotentKey,
        sourceFamily: familyId,
        state: "needs_evidence",
        reasonCode: "RUN_NOT_COMPLETE_MISSING_START_OR_FINISH",
        rejectionReasons: [`RUN_STATE_${String(item.runState)}`],
      });
      continue;
    }

    if (
      item.confirmationSource === "llm_proposal_only"
      || item.confirmationSource === "unverified_self_parser"
      || item.confirmationSource === "current_source_spotcheck_without_historical_expected"
    ) {
      const reasonCode = item.confirmationSource === "current_source_spotcheck_without_historical_expected"
        ? "CURRENT_SOURCE_SPOTCHECK_NOT_HISTORICAL_SUPERVISION"
        : "UNCONFIRMED_PROPOSAL_OR_SELF_GOLD_REJECTED";
      excludedWithReasons.push({
        caseId: item.caseId,
        idempotentKey,
        sourceFamily: familyId,
        state: "needs_evidence",
        reasonCode,
        rejectionReasons: [reasonCode],
      });
      continue;
    }

    if (familyRecord?.partition === "demoted_known_regression") {
      engineeringRegressionRefs.push({
        caseId: item.caseId,
        idempotentKey,
        familyId,
        regressionKind: "known_regression_demoted_from_verification",
        owner: item.owner ?? "lib/filters/cli-value-flow-policy.ts",
        sourceRef: item.sourceRef ?? idempotentKey,
      });
      continue;
    }

    switch (item.reviewState) {
      case "unreviewed":
      case "needs_evidence": {
        const reasonCode = item.missingReasonCode ?? "NEEDS_SOURCE_OR_BINDING_EVIDENCE";
        pendingReview.push({
          caseId: item.caseId ?? null,
          idempotentKey,
          sourceFamily: familyId,
          state: item.reviewState,
          reasonCode,
          correlatedRunIds: item.correlatedRunIds ?? [],
        });
        excludedWithReasons.push({
          caseId: item.caseId,
          idempotentKey,
          sourceFamily: familyId,
          state: item.reviewState,
          reasonCode,
          rejectionReasons: [reasonCode],
          correlatedRunIds: item.correlatedRunIds ?? [],
        });
        break;
      }
      case "conflict": {
        const reasonCode = item.conflictReasonCode ?? "TEACHER_OR_GOLD_CONFLICT_HELD_FOR_AUDIT";
        excludedWithReasons.push({
          caseId: item.caseId,
          idempotentKey,
          sourceFamily: familyId,
          state: "conflict",
          reasonCode,
          rejectionReasons: [reasonCode],
        });
        break;
      }
      case "confirmed_boundary": {
        engineeringRegressionRefs.push({
          caseId: item.caseId,
          idempotentKey,
          familyId,
          regressionKind: item.regressionKind ?? "confirmed_boundary_unknown_correctness",
          reasonCode: item.unknownFact?.reasonCode ?? "BOUNDARY_UNKNOWN",
          owner: item.owner ?? "lib/filters/cli-call-depth-policy.ts",
          sourceRef: item.sourceRef ?? idempotentKey,
        });
        break;
      }
      case "confirmed_parser_gap": {
        engineeringRegressionRefs.push({
          caseId: item.caseId,
          idempotentKey,
          buglistId: item.buglistId ?? null,
          familyId,
          regressionKind: item.regressionKind ?? "confirmed_parser_gap_blackbox_regression",
          reasonCode: item.unknownFact?.reasonCode ?? "PARSER_CAPABILITY_GAP",
          owner: item.owner ?? "lib/filters/cli-call-depth-policy.ts",
          sourceRef: item.sourceRef ?? idempotentKey,
          expectedDeterministicResolution: item.expectedFact ?? null,
        });
        break;
      }
      case "confirmed_learning_case": {
        const validationErrors = validateConfirmedLearningCaseFields(item, targetUnitContract);
        if (
          validationErrors.includes("UNRESOLVED_REPO_ALIAS_OR_INDEPENDENCE_EVIDENCE")
          || validationErrors.includes("UNRESOLVED_FILE_RENAME_RELATION")
          || validationErrors.includes("UNRESOLVED_CROSS_RUN_SOURCE_CONSISTENCY")
        ) {
          const caseId = allocateCaseId(observationKey, item.caseId);
          caseAssociations.push({
            caseId,
            observationRefs: [observationKey],
            observationPayloadsByRef: { [observationKey]: item.payloadString },
            relatedCaseIds: item.derivedFrom ?? item.sameSourceAs ?? [],
            associationState: "unresolved",
            missingEvidence: validationErrors,
            comparedFields: [
              "repoEvidenceRef",
              "relFile",
              "declOrCallSpan",
              "syntaxForm",
              "sourceConsistentAcrossRuns",
            ],
            evidenceRefs: [observationKey],
            confirmedBy: item.labelAuthority?.reviewer ?? null,
            confirmedAt: item.labelAuthority?.confirmedAt ?? null,
            sourceFamilyRef: familyId,
          });
          excludedWithReasons.push({
            caseId,
            idempotentKey,
            sourceFamily: familyId,
            state: "needs_evidence",
            reasonCode: validationErrors[0],
            rejectionReasons: validationErrors,
          });
          break;
        }
        if (validationErrors.length > 0) {
          excludedWithReasons.push({
            caseId: item.caseId,
            idempotentKey,
            sourceFamily: familyId,
            state: "needs_evidence",
            reasonCode: validationErrors[0],
            rejectionReasons: validationErrors,
          });
          break;
        }
        if (
          familyRecord === undefined
          || familyRecord.assignmentState !== "accepted"
          || !(ALLOWED_PARTITIONS as readonly unknown[]).includes(familyRecord.partition)
        ) {
          const state = familyRecord?.assignmentState === "conflicting" ? "conflict" : "needs_evidence";
          const reason = familyRecord?.holdReason
            ?? "UNASSIGNED_FAMILY_OR_MISSING_PARTITION_NEVER_DEFAULT_TO_TRAIN";
          excludedWithReasons.push({
            caseId: item.caseId,
            idempotentKey,
            sourceFamily: familyId,
            state,
            reasonCode: reason,
            rejectionReasons: [reason],
          });
          break;
        }
        if (
          grouping.hasAnyUnresolvedIndependenceGroup
          && item.sourceOrigin?.provenIndependentFromUnresolvedGroups !== true
        ) {
          const reason = "HELD_DUE_TO_UNRESOLVED_GROUP_INDEPENDENCE_IN_BATCH";
          excludedWithReasons.push({
            caseId: item.caseId,
            idempotentKey,
            sourceFamily: familyId,
            state: "needs_evidence",
            reasonCode: reason,
            rejectionReasons: [reason],
          });
          break;
        }

        const linkedHistoricalIds = [
          ...(item.sameSourceAs ?? []),
          ...(item.derivedFrom ?? []),
        ].filter((caseId: string) => historicalCaseById.has(caseId));
        const locationKey = `${familyId}::${item.callsiteKey}`;
        const sameLocationHistoricalCases = historicalCasesByLocationKey.get(locationKey) ?? [];
        const sameFamilyHistoricalCases = familyId
          ? (historicalCasesByFamilyKey.get(familyId) ?? [])
          : [];
        const relevantHistoricalCases = [
          ...linkedHistoricalIds.map((caseId: string) => historicalCaseById.get(caseId)),
          ...sameLocationHistoricalCases,
          ...sameFamilyHistoricalCases,
        ];
        const missingHistoricalSnapshot = relevantHistoricalCases.find(
          historical => !isValidComparisonSnapshot(historical.comparisonSnapshot),
        );
        if (missingHistoricalSnapshot) {
          const caseId = allocateCaseId(observationKey, item.caseId);
          const reason = `MISSING_HISTORICAL_CASE_COMPARISON_SNAPSHOT:${missingHistoricalSnapshot.caseId}`;
          caseAssociations.push({
            caseId,
            observationRefs: [observationKey],
            observationPayloadsByRef: { [observationKey]: item.payloadString },
            relatedCaseIds: [missingHistoricalSnapshot.caseId],
            associationState: "unresolved",
            missingEvidence: [reason],
            comparedFields: [
              "repoEvidenceRef",
              "callsiteKey",
              "candidateKey",
              "syntaxPatternKey",
              "unitId",
              "profileRef",
              "featureSchema",
              "preDecisionFeatures",
              "inputMissingMask",
              "legalCandidates",
              "expectedLabel",
            ],
            evidenceRefs: item.labelAuthority.evidenceRefs,
            confirmedBy: item.labelAuthority.reviewer,
            confirmedAt: item.labelAuthority.confirmedAt,
            sourceFamilyRef: familyId,
          });
          excludedWithReasons.push({
            caseId,
            idempotentKey,
            sourceFamily: familyId,
            state: "needs_evidence",
            reasonCode: "MISSING_HISTORICAL_CASE_COMPARISON_SNAPSHOT",
            rejectionReasons: [reason],
          });
          break;
        }

        const decisionEvent = item.decisionEvent;
        const effectiveFeatures = decisionEvent.preDecisionFeatures.map(
          (value: number, index: number) => decisionEvent.inputMissingMask[index] ? 0 : value,
        );
        validLearningCandidates.push({
          item,
          observationKey,
          payloadString: item.payloadString,
          idempotentKey,
          familyId,
          targetPartition: familyRecord.partition,
          effectiveFeatures,
          inputMissingMask: [...decisionEvent.inputMissingMask],
          expectedLabel: item.posteriorFact.expectedLabel,
        });
        break;
      }
      default: {
        const reason = `UNSUPPORTED_REVIEW_STATE:${String(item.reviewState)}`;
        excludedWithReasons.push({
          caseId: item.caseId,
          idempotentKey,
          sourceFamily: familyId,
          state: "needs_evidence",
          reasonCode: reason,
          rejectionReasons: [reason],
        });
      }
    }
  }

  const observationGroups = new Map<string, AnyRecord>();
  for (const candidate of validLearningCandidates) {
    const decisionEvent = candidate.item.decisionEvent;
    const snapshot = {
      familyId: candidate.familyId,
      callsiteKey: candidate.item.callsiteKey,
      candidateKey: candidate.item.candidateKey,
      syntaxPatternKey: candidate.item.syntaxPatternKey,
      requestScopeKey: candidate.item.requestScopeKey ?? "default_scope",
      unitId: decisionEvent.unitId,
      profileRef: decisionEvent.profileRef,
      featureSchema: decisionEvent.featureSchema,
      legalCandidates: decisionEvent.legalCandidates,
      effectiveFeatures: candidate.effectiveFeatures,
      inputMissingMask: candidate.inputMissingMask,
      expectedLabel: candidate.expectedLabel,
      targetPartition: candidate.targetPartition,
    };
    const identityKey = buildObservationIdentityKeyFromSnapshot(snapshot);
    const group = observationGroups.get(identityKey) ?? { snapshot, candidates: [] };
    group.candidates.push(candidate);
    observationGroups.set(identityKey, group);
  }

  const locationToAcceptedCaseIds = new Map<string, string[]>();
  for (const [locationKey, historicalCases] of historicalCasesByLocationKey.entries()) {
    locationToAcceptedCaseIds.set(
      locationKey,
      historicalCases
        .filter(historical => historical.associationState !== "conflict")
        .map(historical => historical.caseId),
    );
  }

  const pendingEmittedCases: any[] = [];
  const emittedCaseAssociationIds = new Set<string>();
  const pushCaseAssociationOnce = (entry: any): void => {
    if (!entry || !isNonEmptyString(entry.caseId)) return;
    if (emittedCaseAssociationIds.has(entry.caseId)) return;
    emittedCaseAssociationIds.add(entry.caseId);
    caseAssociations.push(entry);
  };

  for (const [observationIdentityKey, group] of observationGroups.entries()) {
    const sortedGroup = [...group.candidates].sort(
      (left, right) => left.idempotentKey.localeCompare(right.idempotentKey),
    );
    const distinctLabels = new Set(sortedGroup.map(candidate => candidate.expectedLabel));
    const matchedHistoricalCases = [
      ...(historicalCasesByObservationIdentityKey.get(observationIdentityKey) ?? []),
    ].sort((left, right) => left.caseId.localeCompare(right.caseId));
    const hasHistoricalConflict = matchedHistoricalCases.some(
      historical => historical.associationState === "conflict",
    );
    for (const historical of matchedHistoricalCases) {
      distinctLabels.add(historical.comparisonSnapshot.expectedLabel);
    }

    if (hasHistoricalConflict || distinctLabels.size > 1) {
      const conflictCaseIds = sortedGroup.map(candidate =>
        allocateCaseId(candidate.observationKey, candidate.item.caseId)
      );
      const allConflictPartyCaseIds = [
        ...new Set([
          ...matchedHistoricalCases.map(historical => historical.caseId),
          ...conflictCaseIds,
        ]),
      ].sort();
      for (const historical of matchedHistoricalCases) {
        historical.associationState = "conflict";
        historical.relatedCaseIds = [
          ...new Set([
            ...(historical.relatedCaseIds ?? []),
            ...allConflictPartyCaseIds.filter(caseId => caseId !== historical.caseId),
          ]),
        ].sort();
        conflictedHistoricalCaseIds.add(historical.caseId);
        updatedExistingCaseMap.set(historical.caseId, historical);
        pushCaseAssociationOnce(historical);
      }
      const reasonCode = matchedHistoricalCases.length > 0
        ? "CONTRADICTORY_CONFIRMED_LABELS_AGAINST_HISTORICAL_CASE"
        : "CONTRADICTORY_CONFIRMED_LABELS_ON_IDENTICAL_OBSERVATION";
      for (let index = 0; index < sortedGroup.length; index += 1) {
        const candidate = sortedGroup[index]!;
        const caseId = conflictCaseIds[index]!;
        pushCaseAssociationOnce({
          caseId,
          callsiteKey: candidate.item.callsiteKey,
          observationRefs: [candidate.observationKey],
          observationPayloadsByRef: { [candidate.observationKey]: candidate.payloadString },
          relatedCaseIds: allConflictPartyCaseIds.filter(other => other !== caseId),
          associationState: "conflict",
          comparedFields: [
            "repoEvidenceRef",
            "callsiteKey",
            "candidateKey",
            "syntaxPatternKey",
            "unitId",
            "profileRef",
            "featureSchema",
            "preDecisionFeatures",
            "inputMissingMask",
            "legalCandidates",
            "expectedLabel",
          ],
          comparisonSnapshot: { ...group.snapshot, expectedLabel: candidate.expectedLabel },
          evidenceRefs: candidate.item.labelAuthority.evidenceRefs,
          confirmedBy: candidate.item.labelAuthority.reviewer,
          confirmedAt: candidate.item.labelAuthority.confirmedAt,
          sourceFamilyRef: candidate.familyId,
        });
        excludedWithReasons.push({
          caseId,
          idempotentKey: candidate.idempotentKey,
          sourceFamily: candidate.familyId,
          state: "conflict",
          reasonCode,
          rejectionReasons: [reasonCode],
        });
      }
      continue;
    }

    if (matchedHistoricalCases.length > 0) {
      const targetHistorical = matchedHistoricalCases[0];
      targetHistorical.observationPayloadsByRef ??= {};
      for (const candidate of sortedGroup) {
        if (!targetHistorical.observationRefs.includes(candidate.observationKey)) {
          targetHistorical.observationRefs.push(candidate.observationKey);
          crossBatchMergedObservationCount += 1;
          repeatedCallsiteMergedCount += 1;
        }
        targetHistorical.observationPayloadsByRef[candidate.observationKey] = candidate.payloadString;
      }
      targetHistorical.observationRefs.sort();
      targetHistorical.occurrenceCount = targetHistorical.observationRefs.length;
      targetHistorical.associationState = "same_case";
      updatedExistingCaseMap.set(targetHistorical.caseId, targetHistorical);
      pushCaseAssociationOnce(targetHistorical);
      continue;
    }

    const primary = sortedGroup[0];
    const caseId = allocateCaseId(primary.observationKey, primary.item.caseId);
    if (sortedGroup.length > 1) repeatedCallsiteMergedCount += sortedGroup.length - 1;
    const locationKey = `${primary.familyId}::${primary.item.callsiteKey}`;
    const acceptedAtLocation = locationToAcceptedCaseIds.get(locationKey) ?? [];
    if (!acceptedAtLocation.includes(caseId)) acceptedAtLocation.push(caseId);
    locationToAcceptedCaseIds.set(locationKey, acceptedAtLocation);
    pendingEmittedCases.push({
      caseId,
      locationKey,
      sortedGroup,
      primary,
      comparisonSnapshot: { ...group.snapshot, expectedLabel: primary.expectedLabel },
    });
  }

  for (const entry of pendingEmittedCases) {
    const { caseId, locationKey, sortedGroup, primary, comparisonSnapshot } = entry;
    const siblingCaseIds = (locationToAcceptedCaseIds.get(locationKey) ?? [])
      .filter(other => other !== caseId);
    const associationState = sortedGroup.length > 1
      ? "same_case"
      : siblingCaseIds.length > 0
        ? "distinct_related"
        : "same_case";
    const observationPayloadsByRef: Record<string, string> = {};
    for (const candidate of sortedGroup) {
      observationPayloadsByRef[candidate.observationKey] = candidate.payloadString;
    }
    pushCaseAssociationOnce({
      caseId,
      callsiteKey: primary.item.callsiteKey,
      observationRefs: sortedGroup.map((candidate: any) => candidate.observationKey),
      observationPayloadsByRef,
      relatedCaseIds: siblingCaseIds,
      associationState,
      comparedFields: [
        "repoEvidenceRef",
        "callsiteKey",
        "candidateKey",
        "syntaxPatternKey",
        "unitId",
        "profileRef",
        "featureSchema",
        "preDecisionFeatures",
        "inputMissingMask",
        "legalCandidates",
        "expectedLabel",
      ],
      comparisonSnapshot,
      occurrenceCount: sortedGroup.length,
      evidenceRefs: primary.item.labelAuthority.evidenceRefs,
      confirmedBy: primary.item.labelAuthority.reviewer,
      confirmedAt: primary.item.labelAuthority.confirmedAt,
      sourceFamilyRef: primary.familyId,
    });

    const labelIndex = (VALUE_FLOW_LABELS as readonly string[]).indexOf(primary.expectedLabel);
    const linkedRunRefs = sortedGroup.map((candidate: any) => candidate.idempotentKey);
    const studentRow = {
      id: caseId,
      sourceGroup: primary.familyId,
      partition: primary.targetPartition,
      head: "R",
      unitId: targetUnitContract.unitId,
      featureSchema: targetUnitContract.featureSchema,
      x: primary.effectiveFeatures,
      inputMissingMask: primary.inputMissingMask,
      supervisionMasked: false,
      legalCandidates: [...primary.item.decisionEvent.legalCandidates],
      originalChoice: primary.item.decisionEvent.originalChoice,
      allowed: [labelIndex],
      goldLabel: primary.expectedLabel,
      labelAuthority: primary.item.labelAuthority,
      posteriorFact: primary.item.posteriorFact,
      sampleWeight: 1,
      occurrenceCount: sortedGroup.length,
      linkedRunRefs,
    };
    if (primary.targetPartition === "train") train.push(studentRow);
    else if (primary.targetPartition === "dev") dev.push(studentRow);
    else if (primary.targetPartition === "verification") {
      verificationRefs.push({
        id: studentRow.id,
        sourceGroup: studentRow.sourceGroup,
        partition: "verification",
        occurrenceCount: studentRow.occurrenceCount,
        linkedRunRefs: studentRow.linkedRunRefs,
        labelAuthority: studentRow.labelAuthority,
      });
    }
  }

  for (const historical of updatedExistingCaseMap.values()) {
    if (historical.associationState === "conflict") pushCaseAssociationOnce(historical);
  }

  train.sort((left, right) => left.linkedRunRefs[0].localeCompare(right.linkedRunRefs[0]));
  dev.sort((left, right) => left.linkedRunRefs[0].localeCompare(right.linkedRunRefs[0]));
  verificationRefs.sort((left, right) => left.linkedRunRefs[0].localeCompare(right.linkedRunRefs[0]));
  engineeringRegressionRefs.sort((left, right) => left.idempotentKey.localeCompare(right.idempotentKey));
  excludedWithReasons.sort((left, right) => left.idempotentKey.localeCompare(right.idempotentKey));
  caseAssociations.sort((left, right) =>
    String(left.observationRefs[0]).localeCompare(String(right.observationRefs[0]))
  );

  const updatedExistingCaseAssociations = [...updatedExistingCaseMap.values()].sort(
    (left, right) => left.caseId.localeCompare(right.caseId),
  );
  const sortedConflictedHistoricalIds = [...conflictedHistoricalCaseIds].sort();
  const hasNotReadyOrConflictingFamily =
    familyAssignmentSummary.conflictingGroups.length > 0
    || familyAssignmentSummary.notReadyGroups.length > 0
    || familyAssignmentSummary.unresolvedGroups.length > 0;
  const confirmedSampleCount = train.length + dev.length;
  const hasConfirmedSamples = confirmedSampleCount > 0;
  const blockingReasons: string[] = [];
  if (hasNotReadyOrConflictingFamily) blockingReasons.push("family_assignment_not_ready_or_conflicting");
  if (sortedConflictedHistoricalIds.length > 0) blockingReasons.push("historical_case_conflict_detected");
  if (!baselineReady) blockingReasons.push("baseline_not_ready");
  if (!hasConfirmedSamples) blockingReasons.push("no_confirmed_samples");

  return Object.freeze({
    converterReadiness:
      hasNotReadyOrConflictingFamily || sortedConflictedHistoricalIds.length > 0
        ? "NOT_READY"
        : "SELF_CHECK_PASSED_AWAITING_AUDIT",
    readinessStatus: Object.freeze({
      baselineReady,
      confirmedSampleCount,
      hasConfirmedSamples,
      canStartPostTraining:
        !hasNotReadyOrConflictingFamily
        && sortedConflictedHistoricalIds.length === 0
        && baselineReady
        && hasConfirmedSamples,
      blockingReasons: Object.freeze(blockingReasons),
    }),
    holdReason: blockingReasons.length > 0 ? blockingReasons.join(" && ") : null,
    caseAssociations: Object.freeze(caseAssociations),
    updatedExistingCaseAssociations: Object.freeze(updatedExistingCaseAssociations),
    conflictedHistoricalCaseIds: Object.freeze(sortedConflictedHistoricalIds),
    familyAssignments: Object.freeze(grouping.familyAssignments),
    familyAssignmentSummary,
    train: Object.freeze(train),
    dev: Object.freeze(dev),
    verificationRefs: Object.freeze(verificationRefs),
    pendingReview: Object.freeze(pendingReview),
    trainerPayload: Object.freeze({
      trainInstancesOnly: Object.freeze([...train]),
      verificationContentIncluded: false,
    }),
    engineeringRegressionRefs: Object.freeze(engineeringRegressionRefs),
    excludedWithReasons: Object.freeze(excludedWithReasons),
    auditSummary: Object.freeze({
      idempotentDuplicatesSkipped,
      crossBatchIdempotentSkippedCount,
      repeatedCallsiteMergedCount,
      crossBatchMergedObservationCount,
      updatedExistingCaseCount: updatedExistingCaseAssociations.length,
      conflictedHistoricalCaseCount: sortedConflictedHistoricalIds.length,
      demotedVerificationFamilies: familyAssignmentSummary.excludedGroups,
      trainCount: train.length,
      devCount: dev.length,
      verificationRefCount: verificationRefs.length,
      engineeringRegressionCount: engineeringRegressionRefs.length,
      excludedCount: excludedWithReasons.length,
    }),
  });
}
