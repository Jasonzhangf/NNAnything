import { posix } from "node:path";
import { expectRecord } from "../core/schema.js";
import {
  entrySelectFeatures,
  predictEntrySelectRelation,
  resolveEntrySelectSet,
  validateEntrySelectSelector,
  validateObservedCandidateInput,
  zeroEntrySelectProfile,
  type EntrySelectFeatures,
  type EntrySelectProfile,
  type EntrySelectRef,
  type EntrySelectRelation,
  type EntrySelectSelector,
  type EntrySelectSetOutcome,
  type EntrySelectSetReason,
  type EntrySelectSetResolution,
  type EntrySelectTargetType,
  type ObservedCandidateInput,
} from "../filters/cli-entry-select-relation.js";

export type EntrySelectPartition = "train" | "development" | "verification";

export type EntrySelectCombinationId =
  | "B-C111"
  | "B-C110"
  | "B-C101"
  | "B-C011"
  | "B-C100"
  | "B-C010"
  | "B-C001"
  | "B-C000";

export type EntrySelectCandidateRow = Readonly<{
  id: string;
  setId: string;
  sourceGroup: string;
  partition: EntrySelectPartition;
  targetType: EntrySelectTargetType;
  combinationId: EntrySelectCombinationId;
  candidateIndex: number;
  selector: EntrySelectSelector;
  candidate: ObservedCandidateInput;
  features: EntrySelectFeatures;
  expectedLabel: 0 | 1;
  expectedRelation: EntrySelectRelation;
}>;

export type EntrySelectSetSample = Readonly<{
  id: string;
  sourceGroup: string;
  partition: EntrySelectPartition;
  targetType: EntrySelectTargetType;
  selector: EntrySelectSelector;
  coverage: "complete";
  candidates: readonly ObservedCandidateInput[];
  candidateRows: readonly EntrySelectCandidateRow[];
  expectedOutcome: "selected" | "not_found";
  expectedStatus: "achieved" | "unmet";
  expectedSatisfaction: 100 | 0;
  expectedRef: EntrySelectRef | null;
  expectedReason: "unique_match" | "not_found";
}>;

export type EntrySelectProbeId =
  | "B-PROBE-NULL-NAME"
  | "B-PROBE-NULL-TYPE"
  | "B-PROBE-NULL-PARENT"
  | "B-PROBE-PARTIAL-HIT"
  | "B-PROBE-PARTIAL-MISS"
  | "B-PROBE-EMPTY-DIR"
  | "B-PROBE-DUP-NAME"
  | "B-PROBE-DUP-REF"
  | "B-PROBE-PATH-MISMATCH"
  | "B-PROBE-CONFLICT-MULTI";

export type EntrySelectProbeSample = Readonly<{
  id: EntrySelectProbeId;
  targetType: EntrySelectTargetType;
  selector: EntrySelectSelector;
  coverage: "complete" | "partial";
  candidates: readonly ObservedCandidateInput[];
  overrideProfileWeights?: readonly [number, number, number, number];
  expectedOutcome: EntrySelectSetOutcome;
  expectedStatus: EntrySelectSetResolution["status"];
  expectedSatisfaction: 100 | 0 | null;
  expectedRef: EntrySelectRef | null;
  expectedReason: EntrySelectSetReason;
  description: string;
}>;

export type EntrySelectDataset = Readonly<{
  contract: "cli.entry-select-dataset.v1";
  version: 1;
  sets: readonly EntrySelectSetSample[];
  candidateRows: readonly EntrySelectCandidateRow[];
  probes: readonly EntrySelectProbeSample[];
}>;

export type EntrySelectDatasetValidationSummary = Readonly<{
  contract: "cli.entry-select-dataset.validation.v1";
  totalSets: number;
  totalCandidates: number;
  totalProbes: number;
  partitions: Readonly<Record<EntrySelectPartition, Readonly<{
    families: readonly string[];
    setCount: number;
    directorySets: number;
    regularSets: number;
    selectedSets: number;
    notFoundSets: number;
    candidateCount: number;
    positiveCandidates: number;
    negativeCandidates: number;
    byTargetType: Readonly<Record<EntrySelectTargetType, Readonly<{
      sets: number;
      candidates: number;
      selectedSets: number;
      notFoundSets: number;
      byCombination: Readonly<Record<EntrySelectCombinationId, number>>;
    }>>>;
    byCombination: Readonly<Record<EntrySelectCombinationId, number>>;
  }>>>;
  byCombinationTotal: Readonly<Record<EntrySelectCombinationId, number>>;
  familyDisjoint: boolean;
  conflictingFeatureLabelPairs: number;
}>;

export const COMBINATION_FEATURES: Readonly<Record<EntrySelectCombinationId, EntrySelectFeatures>> = Object.freeze({
  "B-C111": Object.freeze([1, 1, 1, 1] as const),
  "B-C110": Object.freeze([1, 1, 1, 0] as const),
  "B-C101": Object.freeze([1, 1, 0, 1] as const),
  "B-C011": Object.freeze([1, 0, 1, 1] as const),
  "B-C100": Object.freeze([1, 1, 0, 0] as const),
  "B-C010": Object.freeze([1, 0, 1, 0] as const),
  "B-C001": Object.freeze([1, 0, 0, 1] as const),
  "B-C000": Object.freeze([1, 0, 0, 0] as const),
});

export const ENTRY_SELECT_COMBINATIONS: readonly EntrySelectCombinationId[] = Object.freeze([
  "B-C111",
  "B-C110",
  "B-C101",
  "B-C011",
  "B-C100",
  "B-C010",
  "B-C001",
  "B-C000",
] as const);

type FamilySpec = Readonly<{
  sourceGroup: string;
  partition: EntrySelectPartition;
  parent: string;
  altParentA: string;
  altParentB: string;
  dirTargetA: string;
  dirTargetB: string;
  dirPeerA: string;
  dirPeerB: string;
  fileTargetA: string;
  fileTargetB: string;
  filePeerA: string;
  filePeerB: string;
  noiseNames: readonly [string, string, string, string];
  dirSets: readonly [
    readonly [EntrySelectCombinationId, EntrySelectCombinationId, EntrySelectCombinationId, EntrySelectCombinationId],
    readonly [EntrySelectCombinationId, EntrySelectCombinationId, EntrySelectCombinationId, EntrySelectCombinationId],
  ];
  fileSets: readonly [
    readonly [EntrySelectCombinationId, EntrySelectCombinationId, EntrySelectCombinationId, EntrySelectCombinationId],
    readonly [EntrySelectCombinationId, EntrySelectCombinationId, EntrySelectCombinationId, EntrySelectCombinationId],
  ];
}>;

const FAMILY_SPECS: readonly FamilySpec[] = Object.freeze([
  // TRAIN (4 families = 16 sets / 64 candidates)
  {
    sourceGroup: "B_TRAIN_workspace_tree",
    partition: "train",
    parent: "/train/workspace/apps",
    altParentA: "/train/workspace/archive",
    altParentB: "/train/workspace/staging",
    dirTargetA: "humanagent",
    dirTargetB: "orchestrator",
    dirPeerA: "shared-core",
    dirPeerB: "telemetry-bus",
    fileTargetA: "manifest.json",
    fileTargetB: "lockfile.yaml",
    filePeerA: "readme.md",
    filePeerB: "notes.txt",
    noiseNames: ["cache-index.bin", "build-stamp.log", "legacy-stub", "temp-socket"],
    dirSets: [
      ["B-C111", "B-C110", "B-C000", "B-C000"],
      ["B-C000", "B-C111", "B-C011", "B-C000"],
    ],
    fileSets: [
      ["B-C111", "B-C110", "B-C000", "B-C000"],
      ["B-C000", "B-C111", "B-C011", "B-C000"],
    ],
  },
  {
    sourceGroup: "B_TRAIN_package_tree",
    partition: "train",
    parent: "/train/packages/runtime",
    altParentA: "/train/packages/legacy",
    altParentB: "/train/packages/vendor",
    dirTargetA: "adapters",
    dirTargetB: "workflows",
    dirPeerA: "filters",
    dirPeerB: "schemas",
    fileTargetA: "package.json",
    fileTargetB: "tsconfig.json",
    filePeerA: "index.ts",
    filePeerB: "vitest.config.ts",
    noiseNames: ["dist-bundle.js", "coverage-map.json", "vendor-README", "old-lock"],
    dirSets: [
      ["B-C011", "B-C000", "B-C111", "B-C000"],
      ["B-C110", "B-C101", "B-C100", "B-C000"],
    ],
    fileSets: [
      ["B-C011", "B-C000", "B-C111", "B-C000"],
      ["B-C110", "B-C101", "B-C100", "B-C000"],
    ],
  },
  {
    sourceGroup: "B_TRAIN_service_tree",
    partition: "train",
    parent: "/train/services/gateway",
    altParentA: "/train/services/worker",
    altParentB: "/train/services/metrics",
    dirTargetA: "handlers",
    dirTargetB: "middleware",
    dirPeerA: "routes",
    dirPeerB: "policies",
    fileTargetA: "server.toml",
    fileTargetB: "routes.yaml",
    filePeerA: "healthcheck.sh",
    filePeerB: "tls-cert.pem",
    noiseNames: ["trace-dump.json", "pid-lock", "access-log.txt", "metrics-pipe"],
    dirSets: [
      ["B-C000", "B-C010", "B-C000", "B-C111"],
      ["B-C111", "B-C001", "B-C000", "B-C000"],
    ],
    fileSets: [
      ["B-C000", "B-C010", "B-C000", "B-C111"],
      ["B-C111", "B-C001", "B-C000", "B-C000"],
    ],
  },
  {
    sourceGroup: "B_TRAIN_docs_tree",
    partition: "train",
    parent: "/train/docs/guides",
    altParentA: "/train/docs/drafts",
    altParentB: "/train/docs/archive",
    dirTargetA: "architecture",
    dirTargetB: "operations",
    dirPeerA: "tutorials",
    dirPeerB: "references",
    fileTargetA: "design.md",
    fileTargetB: "roadmap.md",
    filePeerA: "changelog.md",
    filePeerB: "glossary.md",
    noiseNames: ["diagram-export.svg", "review-notes.txt", "draft-folder", "obsolete-link"],
    dirSets: [
      ["B-C000", "B-C111", "B-C000", "B-C000"],
      ["B-C101", "B-C100", "B-C010", "B-C001"],
    ],
    fileSets: [
      ["B-C000", "B-C111", "B-C000", "B-C000"],
      ["B-C101", "B-C100", "B-C010", "B-C001"],
    ],
  },

  // DEVELOPMENT (2 families = 8 sets / 32 candidates)
  {
    sourceGroup: "B_DEV_release_tree",
    partition: "development",
    parent: "/dev/releases/v2026-10",
    altParentA: "/dev/releases/v2026-09",
    altParentB: "/dev/releases/nightly",
    dirTargetA: "artifacts",
    dirTargetB: "bundles",
    dirPeerA: "checksums",
    dirPeerB: "signatures",
    fileTargetA: "release-notes.md",
    fileTargetB: "manifest-v2.json",
    filePeerA: "sbom.spdx.json",
    filePeerB: "provenance.intoto",
    noiseNames: ["scratch-tar", "debug-symbols", "canary-flag", "staging-marker"],
    dirSets: [
      ["B-C111", "B-C110", "B-C000", "B-C000"],
      ["B-C000", "B-C111", "B-C011", "B-C000"],
    ],
    fileSets: [
      ["B-C111", "B-C110", "B-C000", "B-C000"],
      ["B-C000", "B-C111", "B-C011", "B-C000"],
    ],
  },
  {
    sourceGroup: "B_DEV_config_tree",
    partition: "development",
    parent: "/dev/config/profiles",
    altParentA: "/dev/config/defaults",
    altParentB: "/dev/config/overrides",
    dirTargetA: "production",
    dirTargetB: "sandbox-env",
    dirPeerA: "development",
    dirPeerB: "evaluation",
    fileTargetA: "policy.json",
    fileTargetB: "thresholds.yaml",
    filePeerA: "logging.conf",
    filePeerB: "limits.toml",
    noiseNames: ["backup-cfg", "temp-override", "legacy-ini", "local-env"],
    dirSets: [
      ["B-C000", "B-C000", "B-C111", "B-C000"],
      ["B-C101", "B-C100", "B-C010", "B-C001"],
    ],
    fileSets: [
      ["B-C000", "B-C000", "B-C111", "B-C000"],
      ["B-C101", "B-C100", "B-C010", "B-C001"],
    ],
  },

  // VERIFICATION (3 independent families = 12 sets / 48 candidates; never renamed from dev)
  {
    sourceGroup: "B_VERIFY_alpha_tree",
    partition: "verification",
    parent: "/verify/alpha-cluster/nodes",
    altParentA: "/verify/alpha-cluster/backups",
    altParentB: "/verify/alpha-cluster/quarantine",
    dirTargetA: "compute-pool-a",
    dirTargetB: "storage-shard-1",
    dirPeerA: "ingress-router",
    dirPeerB: "scheduler-unit",
    fileTargetA: "cluster-state.json",
    fileTargetB: "heartbeat.log",
    filePeerA: "topology.yaml",
    filePeerB: "fencing-token.txt",
    noiseNames: ["orphan-chunk", "stale-lease", "wal-segment", "snapshot-meta"],
    dirSets: [
      ["B-C111", "B-C110", "B-C001", "B-C000"],
      ["B-C000", "B-C111", "B-C011", "B-C000"],
    ],
    fileSets: [
      ["B-C111", "B-C110", "B-C001", "B-C000"],
      ["B-C000", "B-C111", "B-C011", "B-C000"],
    ],
  },
  {
    sourceGroup: "B_VERIFY_beta_tree",
    partition: "verification",
    parent: "/verify/beta-ラボ/数据区",
    altParentA: "/verify/beta-ラボ/归档区",
    altParentB: "/verify/beta-ラボ/缓存区",
    dirTargetA: "样本集合-01",
    dirTargetB: "评测基线-v3",
    dirPeerA: "特征索引库",
    dirPeerB: "回放记录夹",
    fileTargetA: "指标汇总.json",
    fileTargetB: "校准报告.md",
    filePeerA: "参数配置.yaml",
    filePeerB: "审计回执.txt",
    noiseNames: ["临时导出.csv", "旧版快照.bin", "校验日志.log", "占位目录"],
    dirSets: [
      ["B-C000", "B-C000", "B-C111", "B-C001"],
      ["B-C110", "B-C101", "B-C100", "B-C000"],
    ],
    fileSets: [
      ["B-C000", "B-C000", "B-C111", "B-C001"],
      ["B-C110", "B-C101", "B-C100", "B-C000"],
    ],
  },
  {
    sourceGroup: "B_VERIFY_gamma_tree",
    partition: "verification",
    parent: "/verify/gamma space/sub-tree",
    altParentA: "/verify/gamma space/sibling-a",
    altParentB: "/verify/gamma space/sibling-b",
    dirTargetA: "target folder",
    dirTargetB: "nested module",
    dirPeerA: "helper module",
    dirPeerB: "common assets",
    fileTargetA: "spec sheet.txt",
    fileTargetB: "run receipt.json",
    filePeerA: "summary note.md",
    filePeerB: "schema card.yaml",
    noiseNames: ["extra item 1", "extra item 2", "extra item 3", "extra item 4"],
    dirSets: [
      ["B-C000", "B-C010", "B-C000", "B-C111"],
      ["B-C101", "B-C011", "B-C100", "B-C010"],
    ],
    fileSets: [
      ["B-C000", "B-C010", "B-C000", "B-C111"],
      ["B-C101", "B-C011", "B-C100", "B-C010"],
    ],
  },
]);

function makeCandidateForCombination(
  spec: FamilySpec,
  selector: EntrySelectSelector,
  combinationId: EntrySelectCombinationId,
  setId: string,
  candidateIndex: number,
): ObservedCandidateInput {
  const isDirectoryTarget = selector.type === "directory";
  const matchingType = isDirectoryTarget ? "directory" : "regular";
  const nonMatchingType = isDirectoryTarget ? (candidateIndex % 2 === 0 ? "regular" : "symlink") : (candidateIndex % 2 === 0 ? "directory" : "symlink");
  const diffNameSameParent = isDirectoryTarget
    ? (candidateIndex % 2 === 0 ? `${spec.dirPeerA}-${candidateIndex}` : `${spec.dirPeerB}-${candidateIndex}`)
    : (candidateIndex % 2 === 0 ? `${spec.filePeerA}-${candidateIndex}` : `${spec.filePeerB}-${candidateIndex}`);
  const diffNameOtherParent = `${spec.noiseNames[candidateIndex % spec.noiseNames.length]!}-${candidateIndex}`;
  const otherParentFor110 = spec.altParentA;
  const otherParentFor100 = spec.altParentB;
  const otherParentGeneric = candidateIndex % 2 === 0 ? spec.altParentA : spec.altParentB;

  let name: string;
  let type: "directory" | "regular" | "symlink";
  let parent: string;

  switch (combinationId) {
    case "B-C111":
      name = selector.name;
      type = matchingType;
      parent = selector.parent;
      break;
    case "B-C110":
      name = selector.name;
      type = matchingType;
      parent = otherParentFor110;
      break;
    case "B-C101":
      name = selector.name;
      type = nonMatchingType;
      parent = selector.parent;
      break;
    case "B-C011":
      name = diffNameSameParent;
      type = matchingType;
      parent = selector.parent;
      break;
    case "B-C100":
      name = selector.name;
      type = nonMatchingType;
      parent = otherParentFor100;
      break;
    case "B-C010":
      name = diffNameOtherParent;
      type = matchingType;
      parent = otherParentGeneric;
      break;
    case "B-C001":
      name = `${diffNameSameParent}-alt`;
      type = nonMatchingType;
      parent = selector.parent;
      break;
    case "B-C000":
      name = diffNameOtherParent;
      type = nonMatchingType;
      parent = otherParentGeneric;
      break;
  }

  const path = posix.join(parent, name);
  const ref = Object.freeze({
    kind: type === "directory" ? "cli.directory" : type === "regular" ? "cli.file" : "cli.entry",
    id: `${setId}:cand:${candidateIndex}`,
    path,
  });

  return validateObservedCandidateInput({
    ref,
    path,
    name,
    type,
    parent,
  });
}

function buildSetSample(
  spec: FamilySpec,
  targetType: EntrySelectTargetType,
  slotIndex: 0 | 1,
  combinations: readonly [EntrySelectCombinationId, EntrySelectCombinationId, EntrySelectCombinationId, EntrySelectCombinationId],
): EntrySelectSetSample {
  const targetName = targetType === "directory"
    ? (slotIndex === 0 ? spec.dirTargetA : spec.dirTargetB)
    : (slotIndex === 0 ? spec.fileTargetA : spec.fileTargetB);
  const setId = `${spec.sourceGroup}:${targetType}:${slotIndex + 1}`;
  const selector = validateEntrySelectSelector({
    name: targetName,
    type: targetType,
    parent: spec.parent,
  });

  const candidates: ObservedCandidateInput[] = [];
  const candidateRows: EntrySelectCandidateRow[] = [];

  combinations.forEach((combinationId, candidateIndex) => {
    const candidate = makeCandidateForCombination(spec, selector, combinationId, setId, candidateIndex);
    const computed = entrySelectFeatures(selector, candidate);
    const expectedFeatures = COMBINATION_FEATURES[combinationId];
    if (computed === null || computed.some((val, idx) => val !== expectedFeatures[idx])) {
      throw new Error(`Feature mismatch in ${setId} candidate ${candidateIndex} for ${combinationId}`);
    }
    const expectedLabel: 0 | 1 = combinationId === "B-C111" ? 1 : 0;
    const expectedRelation: EntrySelectRelation = expectedLabel === 1
      ? "matches_selector"
      : "does_not_match_selector";
    candidates.push(candidate);
    candidateRows.push(Object.freeze({
      id: `${setId}#${candidateIndex}`,
      setId,
      sourceGroup: spec.sourceGroup,
      partition: spec.partition,
      targetType,
      combinationId,
      candidateIndex,
      selector,
      candidate,
      features: computed,
      expectedLabel,
      expectedRelation,
    }));
  });

  const positiveRows = candidateRows.filter(row => row.expectedLabel === 1);
  if (positiveRows.length > 1) {
    throw new Error(`Set ${setId} has more than one positive candidate`);
  }
  const hasMatch = positiveRows.length === 1;

  return Object.freeze({
    id: setId,
    sourceGroup: spec.sourceGroup,
    partition: spec.partition,
    targetType,
    selector,
    coverage: "complete" as const,
    candidates: Object.freeze(candidates),
    candidateRows: Object.freeze(candidateRows),
    expectedOutcome: hasMatch ? "selected" : "not_found",
    expectedStatus: hasMatch ? "achieved" : "unmet",
    expectedSatisfaction: hasMatch ? 100 : 0,
    expectedRef: hasMatch ? positiveRows[0]!.candidate.ref : null,
    expectedReason: hasMatch ? "unique_match" : "not_found",
  });
}

function buildProbes(): readonly EntrySelectProbeSample[] {
  const dirSelector = validateEntrySelectSelector({
    name: "humanagent",
    type: "directory",
    parent: "/probe/workspace",
  });
  const fileSelector = validateEntrySelectSelector({
    name: "manifest.json",
    type: "regular",
    parent: "/probe/workspace",
  });

  const probes: EntrySelectProbeSample[] = [
    Object.freeze({
      id: "B-PROBE-NULL-NAME",
      targetType: "directory",
      selector: dirSelector,
      coverage: "complete",
      candidates: Object.freeze([
        validateObservedCandidateInput({
          ref: "probe-null-name-0",
          path: "/probe/workspace/opaque",
          name: null,
          type: "directory",
          parent: "/probe/workspace",
        }),
      ]),
      expectedOutcome: "insufficient_evidence",
      expectedStatus: "unknown",
      expectedSatisfaction: null,
      expectedRef: null,
      expectedReason: "unknown_comparison",
      description: "Candidate with name: null yields unknown single-candidate status and insufficient_evidence set outcome",
    }),
    Object.freeze({
      id: "B-PROBE-NULL-TYPE",
      targetType: "regular",
      selector: fileSelector,
      coverage: "complete",
      candidates: Object.freeze([
        validateObservedCandidateInput({
          ref: "probe-null-type-0",
          path: "/probe/workspace/manifest.json",
          name: "manifest.json",
          type: "unknown",
          parent: "/probe/workspace",
        }),
      ]),
      expectedOutcome: "insufficient_evidence",
      expectedStatus: "unknown",
      expectedSatisfaction: null,
      expectedRef: null,
      expectedReason: "unknown_comparison",
      description: "Candidate with type: unknown yields unknown single-candidate status and insufficient_evidence set outcome",
    }),
    Object.freeze({
      id: "B-PROBE-NULL-PARENT",
      targetType: "directory",
      selector: dirSelector,
      coverage: "complete",
      candidates: Object.freeze([
        validateObservedCandidateInput({
          ref: "probe-null-parent-0",
          path: "/probe/workspace/humanagent",
          name: "humanagent",
          type: "directory",
          parent: null,
        }),
      ]),
      expectedOutcome: "insufficient_evidence",
      expectedStatus: "unknown",
      expectedSatisfaction: null,
      expectedRef: null,
      expectedReason: "unknown_comparison",
      description: "Candidate with parent: null yields unknown single-candidate status and insufficient_evidence set outcome",
    }),
    Object.freeze({
      id: "B-PROBE-PARTIAL-HIT",
      targetType: "directory",
      selector: dirSelector,
      coverage: "partial",
      candidates: Object.freeze([
        validateObservedCandidateInput({
          ref: "probe-partial-hit-0",
          path: "/probe/workspace/humanagent",
          name: "humanagent",
          type: "directory",
          parent: "/probe/workspace",
        }),
      ]),
      expectedOutcome: "insufficient_evidence",
      expectedStatus: "unknown",
      expectedSatisfaction: null,
      expectedRef: null,
      expectedReason: "coverage_partial",
      description: "Partial directory coverage with a matching candidate still yields insufficient_evidence",
    }),
    Object.freeze({
      id: "B-PROBE-PARTIAL-MISS",
      targetType: "regular",
      selector: fileSelector,
      coverage: "partial",
      candidates: Object.freeze([
        validateObservedCandidateInput({
          ref: "probe-partial-miss-0",
          path: "/probe/workspace/other.txt",
          name: "other.txt",
          type: "regular",
          parent: "/probe/workspace",
        }),
      ]),
      expectedOutcome: "insufficient_evidence",
      expectedStatus: "unknown",
      expectedSatisfaction: null,
      expectedRef: null,
      expectedReason: "coverage_partial",
      description: "Partial directory coverage without a matching candidate yields insufficient_evidence rather than not_found",
    }),
    Object.freeze({
      id: "B-PROBE-EMPTY-DIR",
      targetType: "directory",
      selector: dirSelector,
      coverage: "complete",
      candidates: Object.freeze([]),
      expectedOutcome: "not_found",
      expectedStatus: "unmet",
      expectedSatisfaction: 0,
      expectedRef: null,
      expectedReason: "not_found",
      description: "Complete empty directory listing yields not_found / unmet / 0",
    }),
    Object.freeze({
      id: "B-PROBE-DUP-NAME",
      targetType: "regular",
      selector: fileSelector,
      coverage: "complete",
      candidates: Object.freeze([
        validateObservedCandidateInput({
          ref: "probe-dup-name-0",
          path: "/probe/workspace/manifest.json",
          name: "manifest.json",
          type: "regular",
          parent: "/probe/workspace",
        }),
        validateObservedCandidateInput({
          ref: "probe-dup-name-1",
          path: "/probe/workspace/manifest.json",
          name: "manifest.json",
          type: "directory",
          parent: "/probe/workspace",
        }),
      ]),
      expectedOutcome: "invalid_input",
      expectedStatus: "rejected",
      expectedSatisfaction: 0,
      expectedRef: null,
      expectedReason: "duplicate_entity",
      description: "Duplicate (parent, name) entries in candidate set are rejected as invalid_input / duplicate_entity",
    }),
    Object.freeze({
      id: "B-PROBE-DUP-REF",
      targetType: "directory",
      selector: dirSelector,
      coverage: "complete",
      candidates: Object.freeze([
        validateObservedCandidateInput({
          ref: "shared-ref",
          path: "/probe/workspace/humanagent",
          name: "humanagent",
          type: "directory",
          parent: "/probe/workspace",
        }),
        validateObservedCandidateInput({
          ref: "shared-ref",
          path: "/probe/workspace/other",
          name: "other",
          type: "directory",
          parent: "/probe/workspace",
        }),
      ]),
      expectedOutcome: "invalid_input",
      expectedStatus: "rejected",
      expectedSatisfaction: 0,
      expectedRef: null,
      expectedReason: "duplicate_ref",
      description: "Duplicate candidate ref is rejected as invalid_input / duplicate_ref",
    }),
    Object.freeze({
      id: "B-PROBE-PATH-MISMATCH",
      targetType: "regular",
      selector: fileSelector,
      coverage: "complete",
      candidates: Object.freeze([
        validateObservedCandidateInput({
          ref: "probe-path-mismatch-0",
          path: "/probe/other/manifest.json",
          name: "manifest.json",
          type: "regular",
          parent: "/probe/workspace",
        }),
      ]),
      expectedOutcome: "invalid_input",
      expectedStatus: "rejected",
      expectedSatisfaction: 0,
      expectedRef: null,
      expectedReason: "path_mismatch",
      description: "Contradictory candidate.path !== posix.join(parent, name) is rejected as invalid_input / path_mismatch",
    }),
    Object.freeze({
      id: "B-PROBE-CONFLICT-MULTI",
      targetType: "directory",
      selector: dirSelector,
      coverage: "complete",
      candidates: Object.freeze([
        validateObservedCandidateInput({
          ref: "probe-conflict-0",
          path: "/probe/workspace/humanagent",
          name: "humanagent",
          type: "directory",
          parent: "/probe/workspace",
        }),
        validateObservedCandidateInput({
          ref: "probe-conflict-1",
          path: "/probe/workspace/peer-dir",
          name: "peer-dir",
          type: "directory",
          parent: "/probe/workspace",
        }),
      ]),
      overrideProfileWeights: Object.freeze([0, 0, 0, 0] as const),
      expectedOutcome: "conflict",
      expectedStatus: "unknown",
      expectedSatisfaction: null,
      expectedRef: null,
      expectedReason: "multiple_matches_in_single_parent",
      description: "Degenerate all-zero profile matches multiple candidates and yields conflict / unknown / null without first-match tie-breaking",
    }),
  ];

  return Object.freeze(probes);
}

export function makeEntrySelectDataset(): EntrySelectDataset {
  const sets: EntrySelectSetSample[] = [];
  const candidateRows: EntrySelectCandidateRow[] = [];

  for (const spec of FAMILY_SPECS) {
    const dirSet0 = buildSetSample(spec, "directory", 0, spec.dirSets[0]);
    const dirSet1 = buildSetSample(spec, "directory", 1, spec.dirSets[1]);
    const fileSet0 = buildSetSample(spec, "regular", 0, spec.fileSets[0]);
    const fileSet1 = buildSetSample(spec, "regular", 1, spec.fileSets[1]);
    for (const setSample of [dirSet0, dirSet1, fileSet0, fileSet1]) {
      sets.push(setSample);
      candidateRows.push(...setSample.candidateRows);
    }
  }

  return Object.freeze({
    contract: "cli.entry-select-dataset.v1" as const,
    version: 1 as const,
    sets: Object.freeze(sets),
    candidateRows: Object.freeze(candidateRows),
    probes: buildProbes(),
  });
}

function emptyCombinationCounts(): Record<EntrySelectCombinationId, number> {
  return {
    "B-C111": 0,
    "B-C110": 0,
    "B-C101": 0,
    "B-C011": 0,
    "B-C100": 0,
    "B-C010": 0,
    "B-C001": 0,
    "B-C000": 0,
  };
}

const EXPECTED_PARTITION_COMBINATIONS: Readonly<Record<EntrySelectPartition, Readonly<Record<EntrySelectCombinationId, number>>>> = Object.freeze({
  train: Object.freeze({
    "B-C111": 12,
    "B-C110": 4,
    "B-C101": 4,
    "B-C011": 4,
    "B-C100": 4,
    "B-C010": 4,
    "B-C001": 4,
    "B-C000": 28,
  }),
  development: Object.freeze({
    "B-C111": 6,
    "B-C110": 2,
    "B-C101": 2,
    "B-C011": 2,
    "B-C100": 2,
    "B-C010": 2,
    "B-C001": 2,
    "B-C000": 14,
  }),
  verification: Object.freeze({
    "B-C111": 8,
    "B-C110": 4,
    "B-C101": 4,
    "B-C011": 4,
    "B-C100": 4,
    "B-C010": 4,
    "B-C001": 4,
    "B-C000": 16,
  }),
});

export function validateEntrySelectDataset(value: unknown): EntrySelectDatasetValidationSummary {
  const dataset = expectRecord(value, "Entry select dataset") as unknown as EntrySelectDataset;
  if (dataset.contract !== "cli.entry-select-dataset.v1" || dataset.version !== 1) {
    throw new TypeError("Entry select dataset must have contract cli.entry-select-dataset.v1 and version 1");
  }
  if (!Array.isArray(dataset.sets) || dataset.sets.length !== 36) {
    throw new TypeError("Entry select dataset must contain 36 set samples");
  }
  if (!Array.isArray(dataset.candidateRows) || dataset.candidateRows.length !== 144) {
    throw new TypeError("Entry select dataset must contain 144 candidate rows");
  }
  if (!Array.isArray(dataset.probes) || dataset.probes.length !== 10) {
    throw new TypeError("Entry select dataset must contain 10 non-BCE probes");
  }

  const seenSetIds = new Set<string>();
  const seenRowIds = new Set<string>();
  const partitionFamilies: Record<EntrySelectPartition, Set<string>> = {
    train: new Set<string>(),
    development: new Set<string>(),
    verification: new Set<string>(),
  };
  const partitionParents: Record<EntrySelectPartition, Set<string>> = {
    train: new Set<string>(),
    development: new Set<string>(),
    verification: new Set<string>(),
  };

  const byCombinationTotal = emptyCombinationCounts();
  const featureLabelMap = new Map<string, 0 | 1>();
  let conflictingFeatureLabelPairs = 0;

  const partitionsSummary = {} as Record<EntrySelectPartition, {
    families: string[];
    setCount: number;
    directorySets: number;
    regularSets: number;
    selectedSets: number;
    notFoundSets: number;
    candidateCount: number;
    positiveCandidates: number;
    negativeCandidates: number;
    byTargetType: Record<EntrySelectTargetType, {
      sets: number;
      candidates: number;
      selectedSets: number;
      notFoundSets: number;
      byCombination: Record<EntrySelectCombinationId, number>;
    }>;
    byCombination: Record<EntrySelectCombinationId, number>;
  }>;

  for (const partition of ["train", "development", "verification"] as const) {
    partitionsSummary[partition] = {
      families: [],
      setCount: 0,
      directorySets: 0,
      regularSets: 0,
      selectedSets: 0,
      notFoundSets: 0,
      candidateCount: 0,
      positiveCandidates: 0,
      negativeCandidates: 0,
      byTargetType: {
        directory: { sets: 0, candidates: 0, selectedSets: 0, notFoundSets: 0, byCombination: emptyCombinationCounts() },
        regular: { sets: 0, candidates: 0, selectedSets: 0, notFoundSets: 0, byCombination: emptyCombinationCounts() },
      },
      byCombination: emptyCombinationCounts(),
    };
  }

  // Oracle profile that linearly separates [1,1,1,1] from the other 7 combinations at threshold 0.5
  const oracleDirProfile: EntrySelectProfile = Object.freeze({
    ...zeroEntrySelectProfile("directory", 0.5),
    weights: Object.freeze([-2.5, 1, 1, 1] as const),
  });
  const oracleFileProfile: EntrySelectProfile = Object.freeze({
    ...zeroEntrySelectProfile("regular", 0.5),
    weights: Object.freeze([-2.5, 1, 1, 1] as const),
  });

  const sets = dataset.sets as readonly EntrySelectSetSample[];
  const probes = dataset.probes as readonly EntrySelectProbeSample[];

  for (const setSample of sets) {
    if (seenSetIds.has(setSample.id)) {
      throw new Error(`Duplicate set sample id: ${setSample.id}`);
    }
    seenSetIds.add(setSample.id);
    validateEntrySelectSelector(setSample.selector);
    if (setSample.coverage !== "complete") {
      throw new Error(`Set sample ${setSample.id} must have complete coverage`);
    }
    if (!Array.isArray(setSample.candidates) || setSample.candidates.length !== 4) {
      throw new Error(`Set sample ${setSample.id} must have 4 candidates`);
    }
    if (!Array.isArray(setSample.candidateRows) || setSample.candidateRows.length !== 4) {
      throw new Error(`Set sample ${setSample.id} must have 4 candidateRows`);
    }

    const partition = setSample.partition as EntrySelectPartition;
    const part = partitionsSummary[partition];
    if (!part) throw new Error(`Invalid partition ${setSample.partition} on ${setSample.id}`);
    partitionFamilies[partition].add(setSample.sourceGroup);
    partitionParents[partition].add(setSample.selector.parent);

    part.setCount += 1;
    if (setSample.targetType === "directory") part.directorySets += 1;
    else part.regularSets += 1;

    const targetBucket = part.byTargetType[setSample.targetType];
    targetBucket.sets += 1;

    if (setSample.expectedOutcome === "selected") {
      part.selectedSets += 1;
      targetBucket.selectedSets += 1;
      if (setSample.expectedStatus !== "achieved" || setSample.expectedSatisfaction !== 100 || setSample.expectedRef === null || setSample.expectedReason !== "unique_match") {
        throw new Error(`Invalid selected expectation on set ${setSample.id}`);
      }
    } else if (setSample.expectedOutcome === "not_found") {
      part.notFoundSets += 1;
      targetBucket.notFoundSets += 1;
      if (setSample.expectedStatus !== "unmet" || setSample.expectedSatisfaction !== 0 || setSample.expectedRef !== null || setSample.expectedReason !== "not_found") {
        throw new Error(`Invalid not_found expectation on set ${setSample.id}`);
      }
    } else {
      throw new Error(`Unexpected set outcome on ${setSample.id}`);
    }

    const oracleProfile = setSample.targetType === "directory" ? oracleDirProfile : oracleFileProfile;
    const resolution = resolveEntrySelectSet(setSample.selector, setSample.candidates, setSample.coverage, oracleProfile);
    if (resolution.outcome !== setSample.expectedOutcome
      || resolution.status !== setSample.expectedStatus
      || resolution.satisfaction !== setSample.expectedSatisfaction
      || resolution.reason !== setSample.expectedReason
      || JSON.stringify(resolution.ref) !== JSON.stringify(setSample.expectedRef)) {
      throw new Error(`Set sample ${setSample.id} failed oracle resolution check`);
    }

    const candidateRows = setSample.candidateRows as readonly EntrySelectCandidateRow[];
    for (const row of candidateRows) {
      if (seenRowIds.has(row.id)) {
        throw new Error(`Duplicate candidate row id: ${row.id}`);
      }
      seenRowIds.add(row.id);
      const comboId = row.combinationId as EntrySelectCombinationId;
      const computed = entrySelectFeatures(row.selector, row.candidate);
      const expectedFeatures = COMBINATION_FEATURES[comboId];
      if (!expectedFeatures || computed === null || computed.some((v, idx) => v !== expectedFeatures[idx]) || row.features.some((v: number, idx: number) => v !== expectedFeatures[idx])) {
        throw new Error(`Candidate row ${row.id} features do not match ${row.combinationId}`);
      }
      const expectedLabel: 0 | 1 = comboId === "B-C111" ? 1 : 0;
      const expectedRelation: EntrySelectRelation = expectedLabel === 1 ? "matches_selector" : "does_not_match_selector";
      if (row.expectedLabel !== expectedLabel || row.expectedRelation !== expectedRelation) {
        throw new Error(`Candidate row ${row.id} label mismatch`);
      }
      const pred = predictEntrySelectRelation(row.selector, row.candidate, oracleProfile);
      if (pred.status !== "judged" || pred.relation !== row.expectedRelation) {
        throw new Error(`Candidate row ${row.id} failed oracle prediction check`);
      }

      const featureKey = `${row.targetType}:${row.features.join(",")}`;
      const prevLabel = featureLabelMap.get(featureKey);
      if (prevLabel !== undefined && prevLabel !== row.expectedLabel) {
        conflictingFeatureLabelPairs += 1;
      } else {
        featureLabelMap.set(featureKey, row.expectedLabel);
      }

      part.candidateCount += 1;
      if (row.expectedLabel === 1) part.positiveCandidates += 1;
      else part.negativeCandidates += 1;
      part.byCombination[comboId] += 1;
      targetBucket.candidates += 1;
      targetBucket.byCombination[comboId] += 1;
      byCombinationTotal[comboId] += 1;
    }
  }

  // Verify family and parent path disjointness across partitions
  const allFamilies = new Set<string>();
  const allParents = new Set<string>();
  let familyDisjoint = true;
  for (const partition of ["train", "development", "verification"] as const) {
    const families = [...partitionFamilies[partition]];
    partitionsSummary[partition].families = families;
    for (const fam of families) {
      if (allFamilies.has(fam)) familyDisjoint = false;
      allFamilies.add(fam);
    }
    for (const parentPath of partitionParents[partition]) {
      if (allParents.has(parentPath)) familyDisjoint = false;
      allParents.add(parentPath);
    }
  }
  if (!familyDisjoint) {
    throw new Error("Source families and parent paths must be strictly disjoint across train, development, and verification");
  }

  // Verify exact counts per partition and per combination
  if (partitionsSummary.train.setCount !== 16 || partitionsSummary.train.candidateCount !== 64 || partitionsSummary.train.selectedSets !== 12 || partitionsSummary.train.notFoundSets !== 4 || partitionsSummary.train.families.length !== 4) {
    throw new Error("Train partition counts do not match contract (16 sets, 64 candidates, 12 selected, 4 not_found, 4 families)");
  }
  if (partitionsSummary.development.setCount !== 8 || partitionsSummary.development.candidateCount !== 32 || partitionsSummary.development.selectedSets !== 6 || partitionsSummary.development.notFoundSets !== 2 || partitionsSummary.development.families.length !== 2) {
    throw new Error("Development partition counts do not match contract (8 sets, 32 candidates, 6 selected, 2 not_found, 2 families)");
  }
  if (partitionsSummary.verification.setCount !== 12 || partitionsSummary.verification.candidateCount !== 48 || partitionsSummary.verification.selectedSets !== 8 || partitionsSummary.verification.notFoundSets !== 4 || partitionsSummary.verification.families.length !== 3) {
    throw new Error("Verification partition counts do not match contract (12 sets, 48 candidates, 8 selected, 4 not_found, 3 families)");
  }

  for (const partition of ["train", "development", "verification"] as const) {
    const expectedCombos = EXPECTED_PARTITION_COMBINATIONS[partition];
    for (const combo of ENTRY_SELECT_COMBINATIONS) {
      if (partitionsSummary[partition].byCombination[combo] !== expectedCombos[combo]) {
        throw new Error(`Partition ${partition} combination ${combo} count ${partitionsSummary[partition].byCombination[combo]} !== expected ${expectedCombos[combo]}`);
      }
      const dirCombo = partitionsSummary[partition].byTargetType.directory.byCombination[combo];
      const regCombo = partitionsSummary[partition].byTargetType.regular.byCombination[combo];
      if (dirCombo !== expectedCombos[combo] / 2 || regCombo !== expectedCombos[combo] / 2) {
        throw new Error(`Partition ${partition} combination ${combo} is not symmetrically split between directory and regular`);
      }
    }
  }

  if (conflictingFeatureLabelPairs !== 0) {
    throw new Error(`Found ${conflictingFeatureLabelPairs} conflicting feature-label pairs`);
  }

  // Validate all 10 probes
  const seenProbeIds = new Set<string>();
  for (const probe of probes) {
    if (seenProbeIds.has(probe.id)) {
      throw new Error(`Duplicate probe id: ${probe.id}`);
    }
    seenProbeIds.add(probe.id);
    const baseProfile = probe.targetType === "directory" ? oracleDirProfile : oracleFileProfile;
    const profile: EntrySelectProfile = probe.overrideProfileWeights
      ? Object.freeze({ ...baseProfile, weights: Object.freeze([...probe.overrideProfileWeights] as [number, number, number, number]) })
      : baseProfile;
    const res = resolveEntrySelectSet(probe.selector, probe.candidates, probe.coverage, profile);
    if (res.outcome !== probe.expectedOutcome
      || res.status !== probe.expectedStatus
      || res.satisfaction !== probe.expectedSatisfaction
      || res.reason !== probe.expectedReason
      || JSON.stringify(res.ref) !== JSON.stringify(probe.expectedRef)) {
      throw new Error(`Probe ${probe.id} failed resolution check: got ${res.outcome}/${res.status}/${res.reason}`);
    }
  }

  return Object.freeze({
    contract: "cli.entry-select-dataset.validation.v1" as const,
    totalSets: dataset.sets.length,
    totalCandidates: dataset.candidateRows.length,
    totalProbes: dataset.probes.length,
    partitions: Object.freeze({
      train: Object.freeze({
        ...partitionsSummary.train,
        families: Object.freeze(partitionsSummary.train.families),
        byTargetType: Object.freeze({
          directory: Object.freeze({ ...partitionsSummary.train.byTargetType.directory, byCombination: Object.freeze(partitionsSummary.train.byTargetType.directory.byCombination) }),
          regular: Object.freeze({ ...partitionsSummary.train.byTargetType.regular, byCombination: Object.freeze(partitionsSummary.train.byTargetType.regular.byCombination) }),
        }),
        byCombination: Object.freeze(partitionsSummary.train.byCombination),
      }),
      development: Object.freeze({
        ...partitionsSummary.development,
        families: Object.freeze(partitionsSummary.development.families),
        byTargetType: Object.freeze({
          directory: Object.freeze({ ...partitionsSummary.development.byTargetType.directory, byCombination: Object.freeze(partitionsSummary.development.byTargetType.directory.byCombination) }),
          regular: Object.freeze({ ...partitionsSummary.development.byTargetType.regular, byCombination: Object.freeze(partitionsSummary.development.byTargetType.regular.byCombination) }),
        }),
        byCombination: Object.freeze(partitionsSummary.development.byCombination),
      }),
      verification: Object.freeze({
        ...partitionsSummary.verification,
        role: "bounded_synthetic_held_out" as const,
        provenance: "synthetic_held_out_from_eight_boolean_templates" as const,
        allEightFeatureVectorsSeenInTrain: true,
        unseenFeatureCapabilityVerified: false,
        families: Object.freeze(partitionsSummary.verification.families),
        byTargetType: Object.freeze({
          directory: Object.freeze({ ...partitionsSummary.verification.byTargetType.directory, byCombination: Object.freeze(partitionsSummary.verification.byTargetType.directory.byCombination) }),
          regular: Object.freeze({ ...partitionsSummary.verification.byTargetType.regular, byCombination: Object.freeze(partitionsSummary.verification.byTargetType.regular.byCombination) }),
        }),
        byCombination: Object.freeze(partitionsSummary.verification.byCombination),
      }),
    }),
    verificationProvenance: Object.freeze({
      role: "bounded_synthetic_held_out" as const,
      provenance: "synthetic_held_out_from_eight_boolean_templates" as const,
      allEightFeatureVectorsSeenInTrain: true,
      unseenFeatureCapabilityVerified: false,
      fullyVerified: false,
    }),
    byCombinationTotal: Object.freeze(byCombinationTotal),
    familyDisjoint,
    conflictingFeatureLabelPairs,
  });
}
