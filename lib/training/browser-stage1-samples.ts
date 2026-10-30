import type {
  BrowserInputHostTag,
  BrowserInputObservation,
  BrowserInputReadonlyState,
  BrowserInputTargetFacts
} from "../adapters/browser/input-contract.js";
import type {
  BrowserSearchGoal,
  BrowserSearchObservation,
  BrowserSearchPhase,
  BrowserSearchState,
  BrowserSearchSubmissionBaseline
} from "../adapters/browser/search-contract.js";
import type { ActionObservation } from "../adapters/browser/single-action-contract.js";
import {
  BROWSER_INPUT_POLICY_HEADS,
  BROWSER_INPUT_POLICY_WIRES,
  BROWSER_QUERY_RELATION_HEADS,
  BROWSER_QUERY_RELATION_WIRES,
  BROWSER_STEP_POLICY_HEADS,
  BROWSER_STEP_POLICY_WIRES,
  extractBrowserInputPolicyWires,
  extractBrowserQueryRelationWires,
  extractBrowserStepPolicyWires,
  type BrowserInputPolicyHead,
  type BrowserQueryRelationHead,
  type BrowserStepPolicyHead
} from "../filters/browser-stage1-policy.js";

export const BROWSER_STAGE1_SAMPLES_SCHEMA_VERSION = "browser.stage1.samples.v1" as const;

export const BROWSER_INPUT_POLICY_CONTRACT_ID = "browser.input-text-policy.v1" as const;
export const BROWSER_QUERY_RELATION_CONTRACT_ID = "browser.search-query-relation.v1" as const;
export const BROWSER_STEP_POLICY_CONTRACT_ID = "browser.search-step-policy.v1" as const;

export type BrowserStage1Split = "train" | "development";

export type BrowserStage1TrainFamilyId =
  | "BF_TRAIN_F1_form_button"
  | "BF_TRAIN_F2_enter_submit"
  | "BF_TRAIN_F3_textarea_button"
  | "BF_TRAIN_F4_contenteditable_toolbar"
  | "BF_TRAIN_F5_paginated_append";

export type BrowserStage1DevFamilyId =
  | "BF_DEV_F6A_family_b_list"
  | "BF_DEV_F6B_family_c_grid";

export type BrowserStage1FamilyId = BrowserStage1TrainFamilyId | BrowserStage1DevFamilyId;

export const BROWSER_STAGE1_TRAIN_FAMILIES: readonly BrowserStage1TrainFamilyId[] = [
  "BF_TRAIN_F1_form_button",
  "BF_TRAIN_F2_enter_submit",
  "BF_TRAIN_F3_textarea_button",
  "BF_TRAIN_F4_contenteditable_toolbar",
  "BF_TRAIN_F5_paginated_append"
] as const;

export const BROWSER_STAGE1_DEV_FAMILIES: readonly BrowserStage1DevFamilyId[] = [
  "BF_DEV_F6A_family_b_list",
  "BF_DEV_F6B_family_c_grid"
] as const;

export const BROWSER_STAGE1_FORBIDDEN_HELDOUT_PATTERNS: readonly string[] = [
  "BF_EVAL_F7",
  "BF_EVAL_F8",
  "verify-f7-table",
  "verify-f8-split",
  "BP01",
  "BP02",
  "BP03",
  "BP04",
  "BP05",
  "BP06",
  "BP07",
  "BP08",
  "BP09",
  "BP10",
  "BP11",
  "BP12"
] as const;

export interface BrowserStage1InputSampleRow {
  readonly id: string;
  readonly episodeId: string;
  readonly familyId: BrowserStage1FamilyId;
  readonly split: BrowserStage1Split;
  readonly rendererSource: string;
  readonly observation: BrowserInputObservation;
  readonly targetText: string;
  readonly sensitive: boolean;
  readonly wires: readonly number[];
  readonly goldHead: BrowserInputPolicyHead;
}

export interface BrowserStage1RelationSampleRow {
  readonly id: string;
  readonly episodeId: string;
  readonly familyId: BrowserStage1FamilyId;
  readonly split: BrowserStage1Split;
  readonly rendererSource: string;
  readonly phase: "submitted" | "results";
  readonly state: BrowserSearchState;
  readonly goal: BrowserSearchGoal;
  readonly wires: readonly number[];
  readonly goldHead: BrowserQueryRelationHead;
}

export interface BrowserStage1StepSampleRow {
  readonly id: string;
  readonly episodeId: string;
  readonly familyId: BrowserStage1FamilyId;
  readonly split: BrowserStage1Split;
  readonly rendererSource: string;
  readonly phase: "input" | "submitted" | "results";
  readonly inputObservation: BrowserInputObservation;
  readonly targetText: string;
  readonly sensitive: boolean;
  readonly state: BrowserSearchState;
  readonly goal: BrowserSearchGoal;
  readonly goldInputHead: BrowserInputPolicyHead;
  readonly goldRelationHead: BrowserQueryRelationHead;
  readonly wires: readonly number[];
  readonly goldHead: BrowserStepPolicyHead;
}

export interface BrowserStage1EpisodeRecord {
  readonly episodeId: string;
  readonly familyId: BrowserStage1FamilyId;
  readonly split: BrowserStage1Split;
  readonly rendererSource: string;
  readonly templateCode: string;
  readonly inputRowId: string;
  readonly relationRowIds: string[];
  readonly stepRowIds: string[];
}

export interface BrowserStage1Dataset {
  readonly schemaVersion: typeof BROWSER_STAGE1_SAMPLES_SCHEMA_VERSION;
  readonly episodes: readonly BrowserStage1EpisodeRecord[];
  readonly inputRows: readonly BrowserStage1InputSampleRow[];
  readonly relationRows: readonly BrowserStage1RelationSampleRow[];
  readonly stepRows: readonly BrowserStage1StepSampleRow[];
}

export interface BrowserStage1SplitSlice {
  readonly episodes: readonly BrowserStage1EpisodeRecord[];
  readonly inputRows: readonly BrowserStage1InputSampleRow[];
  readonly relationRows: readonly BrowserStage1RelationSampleRow[];
  readonly stepRows: readonly BrowserStage1StepSampleRow[];
}

export interface BrowserStage1PartitionedDataset {
  readonly dataset: BrowserStage1Dataset;
  readonly train: BrowserStage1SplitSlice;
  readonly development: BrowserStage1SplitSlice;
  readonly summary: {
    readonly trainEpisodeCount: number;
    readonly developmentEpisodeCount: number;
    readonly totalEpisodeCount: number;
    readonly trainRowCounts: {
      readonly inputPolicy: number;
      readonly queryRelation: number;
      readonly stepPolicy: number;
    };
    readonly developmentRowCounts: {
      readonly inputPolicy: number;
      readonly queryRelation: number;
      readonly stepPolicy: number;
    };
  };
}

export interface BrowserStage1ValidationReport {
  readonly ok: boolean;
  readonly trainEpisodeCount: number;
  readonly developmentEpisodeCount: number;
  readonly totalEpisodeCount: number;
  readonly unitRowCounts: {
    readonly inputPolicy: { readonly train: number; readonly development: number; readonly total: number };
    readonly queryRelation: { readonly train: number; readonly development: number; readonly total: number };
    readonly stepPolicy: { readonly train: number; readonly development: number; readonly total: number };
  };
  readonly uniqueWireVectors: {
    readonly inputPolicy: number;
    readonly queryRelation: number;
    readonly stepPolicy: number;
  };
  readonly collisionCount: {
    readonly inputPolicy: number;
    readonly queryRelation: number;
    readonly stepPolicy: number;
    readonly total: number;
  };
  readonly heldOutEpisodesInDataset: number;
  readonly forbiddenHeldOutImportsPresent: boolean;
  readonly familyEpisodeCounts: Record<string, number>;
}

export interface BrowserStage1TruthTableUnitSummary {
  readonly profileId: string;
  readonly headCount: number;
  readonly wireCount: number;
  readonly parameterCount: number;
  readonly enumeratedStates: number;
  readonly uniqueWireVectors: number;
  readonly collisionCount: number;
  readonly linearlySeparable: boolean;
  readonly labelDistribution: Record<string, number>;
  readonly extendedStatesWithDisplayMismatch?: number;
  readonly extendedUniqueWireVectors?: number;
  readonly extendedCollisionCount?: number;
  readonly extendedLinearlySeparable?: boolean;
}

export interface BrowserStage1TruthTableEnumerationReceipt {
  readonly schemaVersion: "browser.stage1.wire-enumeration.v1";
  readonly generatedAt: string;
  readonly units: {
    readonly "B-S1.1": BrowserStage1TruthTableUnitSummary;
    readonly "B-S1.2": BrowserStage1TruthTableUnitSummary;
    readonly "B-S1.3": BrowserStage1TruthTableUnitSummary;
  };
  readonly allSeparable: boolean;
  readonly totalCollisions: number;
}

interface FamilyDescriptor {
  readonly familyId: BrowserStage1FamilyId;
  readonly split: BrowserStage1Split;
  readonly rendererSource: string;
  readonly queryTerm: string;
}

const FAMILY_DESCRIPTORS: readonly FamilyDescriptor[] = [
  {
    familyId: "BF_TRAIN_F1_form_button",
    split: "train",
    rendererSource:
      "playground/browser/search-fixture/page.mjs + playground/browser/input/fixtures/family-a.mjs",
    queryTerm: "alpha"
  },
  {
    familyId: "BF_TRAIN_F2_enter_submit",
    split: "train",
    rendererSource:
      "playground/browser/search-fixture/page.mjs + playground/browser/input/fixtures/family-a.mjs",
    queryTerm: "bravo"
  },
  {
    familyId: "BF_TRAIN_F3_textarea_button",
    split: "train",
    rendererSource:
      "playground/browser/search-fixture/page.mjs + playground/browser/input/fixtures/family-a.mjs",
    queryTerm: "charlie"
  },
  {
    familyId: "BF_TRAIN_F4_contenteditable_toolbar",
    split: "train",
    rendererSource:
      "playground/browser/search-fixture/page.mjs + playground/browser/input/fixtures/family-a.mjs",
    queryTerm: "delta"
  },
  {
    familyId: "BF_TRAIN_F5_paginated_append",
    split: "train",
    rendererSource:
      "playground/browser/search-fixture/page.mjs + playground/browser/input/fixtures/family-a.mjs",
    queryTerm: "echo"
  },
  {
    familyId: "BF_DEV_F6A_family_b_list",
    split: "development",
    rendererSource:
      "playground/browser/search-fixture/family-b/page.mjs + playground/browser/input/fixtures/family-b.mjs",
    queryTerm: "foxtrot"
  },
  {
    familyId: "BF_DEV_F6B_family_c_grid",
    split: "development",
    rendererSource: "playground/browser/search-fixture/family-c-dev/page.mjs",
    queryTerm: "quartz"
  }
] as const;

function obsFact<T>(value: T, evidenceId = "ev-1"): ActionObservation<T> {
  return {
    status: "observed",
    value,
    evidenceRefs: [evidenceId]
  };
}

function unkFact<T>(reason = "unobserved_in_fixture"): ActionObservation<T> {
  return {
    status: "unknown",
    reason
  };
}

interface InputFactOverrides {
  readonly host?: ActionObservation<BrowserInputHostTag>;
  readonly type?: ActionObservation<string>;
  readonly nativeDisabled?: ActionObservation<boolean>;
  readonly ariaDisabled?: ActionObservation<boolean | null>;
  readonly editable?: ActionObservation<boolean>;
  readonly readonlyState?: ActionObservation<BrowserInputReadonlyState>;
  readonly value?: ActionObservation<string>;
  readonly executableHit?: ActionObservation<boolean>;
}

function makeInputObservation(
  descriptor: FamilyDescriptor,
  episodeIndex: number,
  overrides: InputFactOverrides = {}
): BrowserInputObservation {
  const ref = `#${descriptor.familyId.toLowerCase()}-input-${episodeIndex}`;
  const evId = `${descriptor.familyId}:ev:${episodeIndex}`;
  const target: BrowserInputTargetFacts = {
    ref,
    connected: obsFact(true, evId),
    currentRef: obsFact(ref, evId),
    host: overrides.host ?? obsFact<BrowserInputHostTag>("input", evId),
    contentEditable: obsFact<boolean | null>(null, evId),
    type: overrides.type ?? obsFact("text", evId),
    value: overrides.value ?? obsFact(descriptor.queryTerm, evId),
    placeholder: obsFact<string | null>("Search", evId),
    nativeDisabled: overrides.nativeDisabled ?? obsFact(false, evId),
    ariaDisabled: overrides.ariaDisabled ?? obsFact<boolean | null>(false, evId),
    nativeReadonly: obsFact(false, evId),
    ariaReadonly: obsFact<boolean | null>(false, evId),
    readonlyState: overrides.readonlyState ?? obsFact<BrowserInputReadonlyState>("editable", evId),
    editable: overrides.editable ?? obsFact(true, evId),
    activeElementRef: obsFact<string | null>(ref, evId),
    activeElementFocus: obsFact(true, evId),
    executableHit: overrides.executableHit ?? obsFact(true, evId),
    point: obsFact({ x: 120, y: 40 }, evId)
  };
  return {
    documentRef: `doc:${descriptor.familyId}`,
    scopeRef: `scope:${descriptor.familyId}`,
    observationId: `obs:${descriptor.familyId}:input:${episodeIndex}`,
    revision: episodeIndex,
    target,
    neighbors: [],
    evidence: [{ id: evId, source: "dom", fact: { ref } }]
  };
}

function makeSearchGoal(
  descriptor: FamilyDescriptor,
  phase: BrowserSearchPhase = "results"
): BrowserSearchGoal {
  const collectionRef =
    descriptor.familyId === "BF_DEV_F6B_family_c_grid"
      ? "#grid-main-collection"
      : "#result-list";
  return {
    kind: "BrowserSearch",
    query: descriptor.queryTerm,
    collectionRef,
    containsText: descriptor.queryTerm,
    minimumMatches: 1,
    coverage: "matched_items",
    phase
  };
}

interface SearchStateSpec {
  readonly inputValue?: ActionObservation<string>;
  readonly baseline?: BrowserSearchSubmissionBaseline | null;
  readonly submittedQuery?: ActionObservation<string>;
  readonly submittedRequestRef?: ActionObservation<string>;
  readonly resultsFor?: ActionObservation<string>;
  readonly resultsRequestRef?: ActionObservation<string>;
  readonly collectionRequestRef?: ActionObservation<string>;
  readonly collectionBatch?: ActionObservation<string>;
  readonly requestState?: ActionObservation<"loading" | "settled" | "error">;
  readonly access?: "available" | "login_required" | "challenge" | "unknown";
  readonly display?: "none" | "old" | "current" | "empty" | "partial" | "unknown";
  readonly checkedCurrent?: boolean;
  readonly itemText?: ActionObservation<string>;
  readonly itemRole?: "main" | "auxiliary" | "unknown";
  readonly itemCollectionRef?: string;
  readonly itemsEmpty?: boolean;
  readonly atGeometryBoundary?: ActionObservation<boolean>;
  readonly hasMore?: ActionObservation<boolean>;
  readonly collectionTerminal?: boolean;
}

function makeSearchState(
  descriptor: FamilyDescriptor,
  episodeIndex: number,
  spec: SearchStateSpec = {}
): BrowserSearchState {
  const evId = `${descriptor.familyId}:search-ev:${episodeIndex}`;
  const collectionRef =
    descriptor.familyId === "BF_DEV_F6B_family_c_grid"
      ? "#grid-main-collection"
      : "#result-list";
  const observationId = `obs:${descriptor.familyId}:search:${episodeIndex}`;
  const subRef2 = `${descriptor.familyId}:req:2`;
  const batchRef2 = `${descriptor.familyId}:batch:2`;

  const baseline: BrowserSearchSubmissionBaseline | null =
    spec.baseline !== undefined
      ? spec.baseline
      : {
          submittedRequestRef: `${descriptor.familyId}:req:1`,
          resultsRequestRef: `${descriptor.familyId}:req:1`,
          batchRef: `${descriptor.familyId}:batch:1`,
          observedSubmission: true
        };

  const items = spec.itemsEmpty
    ? []
    : [
        {
          ref: `${collectionRef}-item-1`,
          collectionRef: spec.itemCollectionRef ?? collectionRef,
          role: spec.itemRole ?? ("main" as const),
          text: spec.itemText ?? obsFact(`Card matching ${descriptor.queryTerm}`, evId)
        }
      ];

  const observation: BrowserSearchObservation = {
    documentRef: `doc:${descriptor.familyId}`,
    scopeRef: `scope:${descriptor.familyId}`,
    observationId,
    revision: episodeIndex,
    input: {
      ref: "#search-input",
      tag: "input",
      type: "text",
      value: spec.inputValue ?? obsFact(descriptor.queryTerm, evId),
      editable: obsFact(true, evId)
    },
    submitRef: "#search-submit",
    submittedQuery: spec.submittedQuery ?? obsFact(descriptor.queryTerm, evId),
    resultsFor: spec.resultsFor ?? obsFact(descriptor.queryTerm, evId),
    submittedRequestRef: spec.submittedRequestRef ?? obsFact(subRef2, evId),
    resultsRequestRef: spec.resultsRequestRef ?? obsFact(subRef2, evId),
    request: "settled",
    display: spec.display ?? "current",
    access: spec.access ?? "available",
    collection: {
      ref: collectionRef,
      scopeRef: "#result-scroll-box",
      requestRef: spec.collectionRequestRef ?? obsFact(subRef2, evId),
      items,
      batch: spec.collectionBatch ?? obsFact(batchRef2, evId)
    },
    rangeExpansion: {
      actionMechanicalEffect: "not_attempted",
      atGeometryBoundary: spec.atGeometryBoundary ?? obsFact(true, evId),
      requestState: spec.requestState ?? obsFact<"loading" | "settled" | "error">("settled", evId),
      hasMore: spec.hasMore ?? obsFact(false, evId),
      collectionTerminal: spec.collectionTerminal ?? true
    },
    evidence: [{ id: evId, source: "dom", fact: { observationId } }]
  };

  return {
    observation,
    checkedObservationId: (spec.checkedCurrent ?? true) ? observationId : null,
    submissionBaseline: baseline
  };
}

function buildFamilyInputSpecs(descriptor: FamilyDescriptor): Array<{
  readonly templateCode: string;
  readonly observation: BrowserInputObservation;
  readonly targetText: string;
  readonly sensitive: boolean;
  readonly goldHead: BrowserInputPolicyHead;
}> {
  const q = descriptor.queryTerm;
  return [
    // 1-4: INPUT [1,1,1,1,1,1,1,1,0,1,0,1,1]
    {
      templateCode: "E01_input_empty_ready",
      observation: makeInputObservation(descriptor, 1, { value: obsFact("") }),
      targetText: q,
      sensitive: false,
      goldHead: "INPUT"
    },
    {
      templateCode: "E02_input_already_satisfied_noop",
      observation: makeInputObservation(descriptor, 2, { value: obsFact(q) }),
      targetText: q,
      sensitive: false,
      goldHead: "NOOP"
    },
    {
      templateCode: "E03_input_stale_overwrite",
      observation: makeInputObservation(descriptor, 3, { value: obsFact("stale-text") }),
      targetText: q,
      sensitive: false,
      goldHead: "INPUT"
    },
    {
      templateCode: "E04_input_readonly_mismatch_defer",
      observation: makeInputObservation(descriptor, 4, {
        editable: obsFact(false),
        readonlyState: obsFact<BrowserInputReadonlyState>("readonly"),
        value: obsFact("locked-text")
      }),
      targetText: q,
      sensitive: false,
      goldHead: "DEFER"
    },
    {
      templateCode: "E05_search_unsubmitted_submit",
      observation: makeInputObservation(descriptor, 5, { value: obsFact("draft-text") }),
      targetText: q,
      sensitive: false,
      goldHead: "INPUT"
    },
    {
      templateCode: "E06_search_submitted_settled_match",
      observation: makeInputObservation(descriptor, 6, { value: obsFact("prior-text") }),
      targetText: q,
      sensitive: false,
      goldHead: "INPUT"
    },
    // NOOP variants (E07..E10)
    {
      templateCode: "E07_search_stale_previous_query",
      observation: makeInputObservation(descriptor, 7, { value: obsFact(q) }),
      targetText: q,
      sensitive: false,
      goldHead: "NOOP"
    },
    {
      templateCode: "E08_search_whitespace_normalized_match",
      observation: makeInputObservation(descriptor, 8, {
        editable: obsFact(false),
        readonlyState: obsFact<BrowserInputReadonlyState>("readonly"),
        value: obsFact(q)
      }),
      targetText: q,
      sensitive: false,
      goldHead: "NOOP"
    },
    {
      templateCode: "E09_search_empty_terminal_confirmed",
      observation: makeInputObservation(descriptor, 9, {
        nativeDisabled: obsFact(true),
        editable: obsFact(false),
        value: obsFact(q)
      }),
      targetText: q,
      sensitive: false,
      goldHead: "NOOP"
    },
    {
      templateCode: "E10_search_access_blocked_defer",
      observation: makeInputObservation(descriptor, 10, {
        executableHit: obsFact(false),
        value: obsFact(q)
      }),
      targetText: q,
      sensitive: false,
      goldHead: "NOOP"
    },
    // DEFER variants (E11..E16)
    {
      templateCode: "E11_search_batch1_miss_expand_range",
      observation: makeInputObservation(descriptor, 11, {
        nativeDisabled: obsFact(true),
        editable: obsFact(false),
        value: obsFact("wrong-text")
      }),
      targetText: q,
      sensitive: false,
      goldHead: "DEFER"
    },
    {
      templateCode: "E12_search_loading_pending_reobserve",
      observation: makeInputObservation(descriptor, 12, {
        executableHit: obsFact(false),
        value: obsFact("wrong-text")
      }),
      targetText: q,
      sensitive: false,
      goldHead: "DEFER"
    },
    {
      templateCode: "E13_search_multi_expand_match",
      observation: makeInputObservation(descriptor, 13, {
        executableHit: unkFact("unmeasured_hit"),
        value: obsFact("wrong-text")
      }),
      targetText: q,
      sensitive: false,
      goldHead: "DEFER"
    },
    {
      templateCode: "E14_search_insufficient_evidence_defer",
      observation: makeInputObservation(descriptor, 14, {
        host: obsFact<BrowserInputHostTag>("textarea"),
        type: obsFact("textarea"),
        value: obsFact("wrong-text")
      }),
      targetText: q,
      sensitive: false,
      goldHead: "DEFER"
    },
    {
      templateCode: "E15_search_distractor_excluded_terminal",
      observation: makeInputObservation(descriptor, 15, {
        editable: unkFact("unknown_editable"),
        readonlyState: unkFact("unknown_readonly"),
        value: obsFact("wrong-text")
      }),
      targetText: q,
      sensitive: false,
      goldHead: "DEFER"
    },
    {
      templateCode: "E16_search_no_more_results_terminal",
      observation: makeInputObservation(descriptor, 16, {
        value: unkFact("unobserved_value")
      }),
      targetText: q,
      sensitive: false,
      goldHead: "DEFER"
    }
  ];
}

function buildFamilyRelationSpecs(
  descriptor: FamilyDescriptor
): Array<{
  readonly episodeIndex: number;
  readonly phase: "submitted" | "results";
  readonly state: BrowserSearchState;
  readonly goldHead: BrowserQueryRelationHead;
}> {
  const sub1 = `${descriptor.familyId}:req:1`;
  const batch1 = `${descriptor.familyId}:batch:1`;

  // E05: [1,1,1,1,0,0,0,0,0,0,1,1,0,0] -> input_only_unsubmitted
  const e05Spec: SearchStateSpec = {
    submittedQuery: obsFact(""),
    submittedRequestRef: obsFact(sub1),
    resultsFor: unkFact("no_results_yet"),
    resultsRequestRef: unkFact("no_results_req"),
    requestState: unkFact("idle_unsubmitted"),
    access: "available",
    display: "none"
  };

  // E07: [1,1,1,1,0,1,0,1,1,0,1,1,0,0] -> input_only_unsubmitted (stale previous submission)
  const e07Spec: SearchStateSpec = {
    submittedQuery: obsFact("stale-prior-query"),
    submittedRequestRef: obsFact(sub1),
    resultsFor: obsFact("stale-prior-query"),
    resultsRequestRef: obsFact(sub1),
    collectionRequestRef: obsFact(sub1),
    collectionBatch: obsFact(batch1),
    requestState: obsFact("settled"),
    access: "available",
    display: "old"
  };

  // E08a: [1,1,1,0,0,0,0,1,1,0,1,1,0,0] -> input_only_unsubmitted
  const e08aSpec: SearchStateSpec = {
    baseline: null,
    requestState: obsFact("settled"),
    access: "available",
    display: "none"
  };

  // E08b: [1,1,1,0,0,0,0,0,0,0,1,1,0,0] -> input_only_unsubmitted
  const e08bSpec: SearchStateSpec = {
    baseline: null,
    requestState: unkFact("unobserved_request"),
    access: "available",
    display: "none"
  };

  // E11: [1,1,1,1,1,1,0,1,1,0,1,1,1,0] -> submitted_pending_or_stale (BP06 settled stale batch)
  const e11Spec: SearchStateSpec = {
    resultsRequestRef: obsFact(sub1),
    collectionRequestRef: obsFact(sub1),
    collectionBatch: obsFact(batch1),
    requestState: obsFact("settled"),
    access: "available",
    display: "current"
  };

  // E12: [1,1,1,1,1,1,1,1,0,1,1,1,0,0] -> submitted_pending_or_stale (loading matching submission)
  const e12Spec: SearchStateSpec = {
    requestState: obsFact("loading"),
    access: "available",
    display: "partial"
  };

  // E13a: [1,1,1,1,1,1,0,1,0,1,1,1,0,0] -> submitted_pending_or_stale (BP06 loading race)
  const e13aSpec: SearchStateSpec = {
    resultsRequestRef: obsFact(sub1),
    collectionRequestRef: obsFact(sub1),
    collectionBatch: obsFact(batch1),
    requestState: obsFact("loading"),
    access: "available",
    display: "partial"
  };

  // E13b: [1,1,1,1,1,1,0,1,1,0,1,1,0,0] -> submitted_pending_or_stale (settled stale display="old")
  const e13bSpec: SearchStateSpec = {
    resultsRequestRef: obsFact(sub1),
    collectionRequestRef: obsFact(sub1),
    collectionBatch: obsFact(batch1),
    requestState: obsFact("settled"),
    access: "available",
    display: "old"
  };

  // E10: [1,1,1,1,1,1,1,0,0,0,1,0,1,0] -> insufficient_or_conflict (login_required + unknown requestState)
  const e10Spec: SearchStateSpec = {
    requestState: unkFact("blocked_by_login"),
    access: "login_required",
    display: "current"
  };

  // E14: [1,1,1,1,1,1,1,0,0,0,1,1,1,0] -> insufficient_or_conflict (unknown requestState + available)
  const e14Spec: SearchStateSpec = {
    requestState: unkFact("missing_request_state"),
    access: "available",
    display: "current"
  };

  return [
    { episodeIndex: 5, phase: "submitted", state: makeSearchState(descriptor, 5, e05Spec), goldHead: "input_only_unsubmitted" },
    { episodeIndex: 5, phase: "results", state: makeSearchState(descriptor, 5, e05Spec), goldHead: "input_only_unsubmitted" },
    { episodeIndex: 6, phase: "submitted", state: makeSearchState(descriptor, 6, {}), goldHead: "results_associated_active" },
    { episodeIndex: 6, phase: "results", state: makeSearchState(descriptor, 6, {}), goldHead: "results_associated_active" },
    { episodeIndex: 7, phase: "submitted", state: makeSearchState(descriptor, 7, e07Spec), goldHead: "input_only_unsubmitted" },
    { episodeIndex: 7, phase: "results", state: makeSearchState(descriptor, 7, e07Spec), goldHead: "input_only_unsubmitted" },
    { episodeIndex: 8, phase: "submitted", state: makeSearchState(descriptor, 8, e08aSpec), goldHead: "input_only_unsubmitted" },
    { episodeIndex: 8, phase: "results", state: makeSearchState(descriptor, 8, e08bSpec), goldHead: "input_only_unsubmitted" },
    { episodeIndex: 9, phase: "submitted", state: makeSearchState(descriptor, 9, { display: "empty", itemsEmpty: true }), goldHead: "results_associated_active" },
    { episodeIndex: 9, phase: "results", state: makeSearchState(descriptor, 9, { display: "empty", itemsEmpty: true }), goldHead: "results_associated_active" },
    { episodeIndex: 10, phase: "submitted", state: makeSearchState(descriptor, 10, e10Spec), goldHead: "insufficient_or_conflict" },
    { episodeIndex: 10, phase: "results", state: makeSearchState(descriptor, 10, e10Spec), goldHead: "insufficient_or_conflict" },
    { episodeIndex: 11, phase: "submitted", state: makeSearchState(descriptor, 11, e11Spec), goldHead: "submitted_pending_or_stale" },
    { episodeIndex: 11, phase: "results", state: makeSearchState(descriptor, 11, e11Spec), goldHead: "submitted_pending_or_stale" },
    { episodeIndex: 12, phase: "submitted", state: makeSearchState(descriptor, 12, e12Spec), goldHead: "submitted_pending_or_stale" },
    { episodeIndex: 12, phase: "results", state: makeSearchState(descriptor, 12, e12Spec), goldHead: "submitted_pending_or_stale" },
    { episodeIndex: 13, phase: "submitted", state: makeSearchState(descriptor, 13, e13aSpec), goldHead: "submitted_pending_or_stale" },
    { episodeIndex: 13, phase: "results", state: makeSearchState(descriptor, 13, e13bSpec), goldHead: "submitted_pending_or_stale" },
    { episodeIndex: 14, phase: "submitted", state: makeSearchState(descriptor, 14, e14Spec), goldHead: "insufficient_or_conflict" },
    { episodeIndex: 14, phase: "results", state: makeSearchState(descriptor, 14, e14Spec), goldHead: "insufficient_or_conflict" },
    { episodeIndex: 15, phase: "submitted", state: makeSearchState(descriptor, 15, {}), goldHead: "results_associated_active" },
    {
      episodeIndex: 15,
      phase: "results",
      state: makeSearchState(descriptor, 15, { inputValue: obsFact("edited-after-submit") }),
      goldHead: "insufficient_or_conflict"
    },
    {
      episodeIndex: 16,
      phase: "submitted",
      state: makeSearchState(descriptor, 16, { inputValue: unkFact("unobserved_input") }),
      goldHead: "insufficient_or_conflict"
    },
    {
      episodeIndex: 16,
      phase: "results",
      state: makeSearchState(descriptor, 16, { access: "login_required", requestState: obsFact("settled") }),
      goldHead: "insufficient_or_conflict"
    }
  ];
}

function buildFamilyStepSpecs(
  descriptor: FamilyDescriptor,
  inputSpecs: ReturnType<typeof buildFamilyInputSpecs>
): Array<{
  readonly episodeIndex: number;
  readonly phase: "input" | "submitted" | "results";
  readonly inputObservation: BrowserInputObservation;
  readonly targetText: string;
  readonly sensitive: boolean;
  readonly state: BrowserSearchState;
  readonly goal: BrowserSearchGoal;
  readonly goldInputHead: BrowserInputPolicyHead;
  readonly goldRelationHead: BrowserQueryRelationHead;
  readonly goldHead: BrowserStepPolicyHead;
}> {
  const q = descriptor.queryTerm;
  const sub1 = `${descriptor.familyId}:req:1`;
  const batch1 = `${descriptor.familyId}:batch:1`;
  const readyInputObs = inputSpecs[0]!.observation;
  const noopInputObs = inputSpecs[1]!.observation;
  const deferInputObs = inputSpecs[3]!.observation;

  const inputGoal = makeSearchGoal(descriptor, "input");
  const submittedGoal = makeSearchGoal(descriptor, "submitted");
  const resultsGoal = makeSearchGoal(descriptor, "results");

  const unsubmittedState = makeSearchState(descriptor, 5, {
    submittedQuery: obsFact(""),
    submittedRequestRef: obsFact(sub1),
    resultsFor: unkFact("no_results_yet"),
    resultsRequestRef: unkFact("no_results_req"),
    requestState: unkFact("idle_unsubmitted"),
    access: "available",
    display: "none"
  });

  const staleSubmittedState = makeSearchState(descriptor, 7, {
    submittedQuery: obsFact("stale-prior-query"),
    submittedRequestRef: obsFact(sub1),
    resultsFor: obsFact("stale-prior-query"),
    resultsRequestRef: obsFact(sub1),
    collectionRequestRef: obsFact(sub1),
    collectionBatch: obsFact(batch1),
    requestState: obsFact("settled"),
    access: "available",
    display: "old"
  });

  const loadingState = makeSearchState(descriptor, 12, {
    requestState: obsFact("loading"),
    access: "available",
    display: "partial"
  });

  const conflictState = makeSearchState(descriptor, 10, {
    requestState: unkFact("blocked_by_login"),
    access: "login_required",
    display: "current"
  });

  return [
    // Phase input (3)
    {
      episodeIndex: 1,
      phase: "input",
      inputObservation: readyInputObs,
      targetText: q,
      sensitive: false,
      state: makeSearchState(descriptor, 1, {}),
      goal: inputGoal,
      goldInputHead: "INPUT",
      goldRelationHead: "input_only_unsubmitted",
      goldHead: "input"
    },
    {
      episodeIndex: 2,
      phase: "input",
      inputObservation: noopInputObs,
      targetText: q,
      sensitive: false,
      state: makeSearchState(descriptor, 2, {}),
      goal: inputGoal,
      goldInputHead: "NOOP",
      goldRelationHead: "input_only_unsubmitted",
      goldHead: "NOOP"
    },
    {
      episodeIndex: 4,
      phase: "input",
      inputObservation: deferInputObs,
      targetText: q,
      sensitive: false,
      state: makeSearchState(descriptor, 4, {}),
      goal: inputGoal,
      goldInputHead: "DEFER",
      goldRelationHead: "insufficient_or_conflict",
      goldHead: "DEFER"
    },
    // Phase submitted (5)
    {
      episodeIndex: 5,
      phase: "submitted",
      inputObservation: noopInputObs,
      targetText: q,
      sensitive: false,
      state: unsubmittedState,
      goal: submittedGoal,
      goldInputHead: "NOOP",
      goldRelationHead: "input_only_unsubmitted",
      goldHead: "submit"
    },
    {
      episodeIndex: 7,
      phase: "submitted",
      inputObservation: noopInputObs,
      targetText: q,
      sensitive: false,
      state: staleSubmittedState,
      goal: submittedGoal,
      goldInputHead: "NOOP",
      goldRelationHead: "input_only_unsubmitted",
      goldHead: "submit"
    },
    {
      episodeIndex: 12,
      phase: "submitted",
      inputObservation: noopInputObs,
      targetText: q,
      sensitive: false,
      state: loadingState,
      goal: submittedGoal,
      goldInputHead: "NOOP",
      goldRelationHead: "submitted_pending_or_stale",
      goldHead: "NOOP"
    },
    {
      episodeIndex: 6,
      phase: "submitted",
      inputObservation: noopInputObs,
      targetText: q,
      sensitive: false,
      state: makeSearchState(descriptor, 6, {}),
      goal: submittedGoal,
      goldInputHead: "NOOP",
      goldRelationHead: "results_associated_active",
      goldHead: "NOOP"
    },
    {
      episodeIndex: 10,
      phase: "submitted",
      inputObservation: noopInputObs,
      targetText: q,
      sensitive: false,
      state: conflictState,
      goal: submittedGoal,
      goldInputHead: "NOOP",
      goldRelationHead: "insufficient_or_conflict",
      goldHead: "DEFER"
    },
    // Phase results (16)
    {
      episodeIndex: 5,
      phase: "results",
      inputObservation: noopInputObs,
      targetText: q,
      sensitive: false,
      state: unsubmittedState,
      goal: resultsGoal,
      goldInputHead: "NOOP",
      goldRelationHead: "input_only_unsubmitted",
      goldHead: "DEFER"
    },
    {
      episodeIndex: 12,
      phase: "results",
      inputObservation: noopInputObs,
      targetText: q,
      sensitive: false,
      state: loadingState,
      goal: resultsGoal,
      goldInputHead: "NOOP",
      goldRelationHead: "submitted_pending_or_stale",
      goldHead: "read_or_reobserve"
    },
    {
      episodeIndex: 13,
      phase: "results",
      inputObservation: noopInputObs,
      targetText: q,
      sensitive: false,
      state: loadingState,
      goal: resultsGoal,
      goldInputHead: "NOOP",
      goldRelationHead: "submitted_pending_or_stale",
      goldHead: "read_or_reobserve"
    },
    {
      episodeIndex: 10,
      phase: "results",
      inputObservation: noopInputObs,
      targetText: q,
      sensitive: false,
      state: conflictState,
      goal: resultsGoal,
      goldInputHead: "NOOP",
      goldRelationHead: "insufficient_or_conflict",
      goldHead: "DEFER"
    },
    // Unread current batch (2 rows: checkedCurrent = false) -> [1,0,0,1,0,0,0,0,0,1,0,0,0,0,0,0,0,1] -> read_or_reobserve
    {
      episodeIndex: 6,
      phase: "results",
      inputObservation: noopInputObs,
      targetText: q,
      sensitive: false,
      state: makeSearchState(descriptor, 6, { checkedCurrent: false }),
      goal: resultsGoal,
      goldInputHead: "NOOP",
      goldRelationHead: "results_associated_active",
      goldHead: "read_or_reobserve"
    },
    {
      episodeIndex: 8,
      phase: "results",
      inputObservation: noopInputObs,
      targetText: q,
      sensitive: false,
      state: makeSearchState(descriptor, 8, { checkedCurrent: false }),
      goal: resultsGoal,
      goldInputHead: "NOOP",
      goldRelationHead: "results_associated_active",
      goldHead: "read_or_reobserve"
    },
    // Checked current batch: matched with terminal=true -> [1,0,0,1,0,0,0,0,0,1,0,1,1,1,1,0,1,0] -> NOOP
    {
      episodeIndex: 6,
      phase: "results",
      inputObservation: noopInputObs,
      targetText: q,
      sensitive: false,
      state: makeSearchState(descriptor, 6, {
        atGeometryBoundary: obsFact(true),
        hasMore: obsFact(false),
        collectionTerminal: true
      }),
      goal: resultsGoal,
      goldInputHead: "NOOP",
      goldRelationHead: "results_associated_active",
      goldHead: "NOOP"
    },
    // Checked current batch: matched with hasMore=true, terminal=false -> [1,0,0,1,0,0,0,0,0,1,0,1,1,1,1,0,0,0] -> NOOP
    {
      episodeIndex: 8,
      phase: "results",
      inputObservation: noopInputObs,
      targetText: q,
      sensitive: false,
      state: makeSearchState(descriptor, 8, {
        atGeometryBoundary: obsFact(false),
        hasMore: obsFact(true),
        collectionTerminal: false
      }),
      goal: resultsGoal,
      goldInputHead: "NOOP",
      goldRelationHead: "results_associated_active",
      goldHead: "NOOP"
    },
    // Checked current batch: matched with hasMore=unknown, geometry=true, terminal=false -> [1,0,0,1,0,0,0,0,0,1,0,1,1,1,0,0,0,0] -> NOOP
    {
      episodeIndex: 9,
      phase: "results",
      inputObservation: noopInputObs,
      targetText: q,
      sensitive: false,
      state: makeSearchState(descriptor, 9, {
        atGeometryBoundary: obsFact(true),
        hasMore: unkFact("unknown_has_more"),
        collectionTerminal: false
      }),
      goal: resultsGoal,
      goldInputHead: "NOOP",
      goldRelationHead: "results_associated_active",
      goldHead: "NOOP"
    },
    // Checked current batch: not_matched with hasMore=false, terminal=true -> [1,0,0,1,0,0,0,0,0,1,0,1,1,0,1,0,1,0] -> NOOP
    {
      episodeIndex: 9,
      phase: "results",
      inputObservation: noopInputObs,
      targetText: q,
      sensitive: false,
      state: makeSearchState(descriptor, 9, {
        display: "empty",
        itemsEmpty: true,
        atGeometryBoundary: obsFact(true),
        hasMore: obsFact(false),
        collectionTerminal: true
      }),
      goal: resultsGoal,
      goldInputHead: "NOOP",
      goldRelationHead: "results_associated_active",
      goldHead: "NOOP"
    },
    // Checked current batch: not_matched with hasMore=true, terminal=false (3 rows) -> [1,0,0,1,0,0,0,0,0,1,0,1,1,0,1,1,0,0] -> expand_range
    {
      episodeIndex: 11,
      phase: "results",
      inputObservation: noopInputObs,
      targetText: q,
      sensitive: false,
      state: makeSearchState(descriptor, 11, {
        itemText: obsFact("Unrelated batch 1 item"),
        atGeometryBoundary: obsFact(false),
        hasMore: obsFact(true),
        collectionTerminal: false
      }),
      goal: resultsGoal,
      goldInputHead: "NOOP",
      goldRelationHead: "results_associated_active",
      goldHead: "expand_range"
    },
    {
      episodeIndex: 13,
      phase: "results",
      inputObservation: noopInputObs,
      targetText: q,
      sensitive: false,
      state: makeSearchState(descriptor, 13, {
        itemText: obsFact("Unrelated batch 1 item"),
        atGeometryBoundary: obsFact(true),
        hasMore: obsFact(true),
        collectionTerminal: false
      }),
      goal: resultsGoal,
      goldInputHead: "NOOP",
      goldRelationHead: "results_associated_active",
      goldHead: "expand_range"
    },
    {
      episodeIndex: 15,
      phase: "results",
      inputObservation: noopInputObs,
      targetText: q,
      sensitive: false,
      state: makeSearchState(descriptor, 15, {
        itemText: obsFact("Unrelated batch 1 item"),
        atGeometryBoundary: obsFact(false),
        hasMore: unkFact("scroll_remaining"),
        collectionTerminal: false
      }),
      goal: resultsGoal,
      goldInputHead: "NOOP",
      goldRelationHead: "results_associated_active",
      goldHead: "expand_range"
    },
    // Checked current batch: not_matched with geometry=true, hasMore=false, terminal=false -> [1,0,0,1,0,0,0,0,0,1,0,1,1,0,1,0,0,0] -> DEFER
    {
      episodeIndex: 14,
      phase: "results",
      inputObservation: noopInputObs,
      targetText: q,
      sensitive: false,
      state: makeSearchState(descriptor, 14, {
        itemText: obsFact("Unrelated item without terminal banner"),
        atGeometryBoundary: obsFact(true),
        hasMore: obsFact(false),
        collectionTerminal: false
      }),
      goal: resultsGoal,
      goldInputHead: "NOOP",
      goldRelationHead: "results_associated_active",
      goldHead: "DEFER"
    },
    // Checked current batch: not_matched with geometry=true, hasMore=unknown, terminal=false -> [1,0,0,1,0,0,0,0,0,1,0,1,1,0,0,0,0,0] -> DEFER
    {
      episodeIndex: 15,
      phase: "results",
      inputObservation: noopInputObs,
      targetText: q,
      sensitive: false,
      state: makeSearchState(descriptor, 15, {
        itemText: obsFact("Unrelated item with unknown hasMore"),
        atGeometryBoundary: obsFact(true),
        hasMore: unkFact("unknown_has_more"),
        collectionTerminal: false
      }),
      goal: resultsGoal,
      goldInputHead: "NOOP",
      goldRelationHead: "results_associated_active",
      goldHead: "DEFER"
    },
    // Checked current batch: contentFact="unknown" (unobserved item text) -> [1,0,0,1,0,0,0,0,0,1,0,1,0,0,0,0,0,0] -> DEFER
    {
      episodeIndex: 16,
      phase: "results",
      inputObservation: noopInputObs,
      targetText: q,
      sensitive: false,
      state: makeSearchState(descriptor, 16, {
        itemText: unkFact("unobserved_item_text"),
        atGeometryBoundary: obsFact(true),
        hasMore: obsFact(false),
        collectionTerminal: true
      }),
      goal: resultsGoal,
      goldInputHead: "NOOP",
      goldRelationHead: "results_associated_active",
      goldHead: "DEFER"
    }
  ];
}

export function buildBrowserStage1Dataset(): BrowserStage1Dataset {
  const episodes: BrowserStage1EpisodeRecord[] = [];
  const inputRows: BrowserStage1InputSampleRow[] = [];
  const relationRows: BrowserStage1RelationSampleRow[] = [];
  const stepRows: BrowserStage1StepSampleRow[] = [];

  for (const descriptor of FAMILY_DESCRIPTORS) {
    const relationGoal = makeSearchGoal(descriptor, "results");
    const inputSpecs = buildFamilyInputSpecs(descriptor);
    const relationSpecs = buildFamilyRelationSpecs(descriptor);
    const stepSpecs = buildFamilyStepSpecs(descriptor, inputSpecs);

    const episodeMap = new Map<number, BrowserStage1EpisodeRecord>();

    inputSpecs.forEach((spec, idx) => {
      const epNum = idx + 1;
      const epCode = `E${String(epNum).padStart(2, "0")}`;
      const episodeId = `${descriptor.familyId}:${epCode}`;
      const rowId = `${episodeId}:B-S1.1`;
      const wires = extractBrowserInputPolicyWires(
        spec.observation,
        spec.targetText,
        spec.sensitive
      );
      inputRows.push({
        id: rowId,
        episodeId,
        familyId: descriptor.familyId,
        split: descriptor.split,
        rendererSource: descriptor.rendererSource,
        observation: spec.observation,
        targetText: spec.targetText,
        sensitive: spec.sensitive,
        wires,
        goldHead: spec.goldHead
      });
      const epRecord: BrowserStage1EpisodeRecord = {
        episodeId,
        familyId: descriptor.familyId,
        split: descriptor.split,
        rendererSource: descriptor.rendererSource,
        templateCode: spec.templateCode,
        inputRowId: rowId,
        relationRowIds: [],
        stepRowIds: []
      };
      episodes.push(epRecord);
      episodeMap.set(epNum, epRecord);
    });

    relationSpecs.forEach((spec, idx) => {
      const epCode = `E${String(spec.episodeIndex).padStart(2, "0")}`;
      const episodeId = `${descriptor.familyId}:${epCode}`;
      const rowId = `${episodeId}:B-S1.2:${spec.phase}:${idx + 1}`;
      const phaseGoal = makeSearchGoal(descriptor, spec.phase);
      const wires = extractBrowserQueryRelationWires(spec.state, phaseGoal);
      relationRows.push({
        id: rowId,
        episodeId,
        familyId: descriptor.familyId,
        split: descriptor.split,
        rendererSource: descriptor.rendererSource,
        phase: spec.phase,
        state: spec.state,
        goal: phaseGoal,
        wires,
        goldHead: spec.goldHead
      });
      episodeMap.get(spec.episodeIndex)?.relationRowIds.push(rowId);
    });

    stepSpecs.forEach((spec, idx) => {
      const epCode = `E${String(spec.episodeIndex).padStart(2, "0")}`;
      const episodeId = `${descriptor.familyId}:${epCode}`;
      const rowId = `${episodeId}:B-S1.3:${spec.phase}:${idx + 1}`;
      const wires = extractBrowserStepPolicyWires(
        spec.state,
        spec.goal,
        spec.goldInputHead,
        spec.goldRelationHead
      );
      stepRows.push({
        id: rowId,
        episodeId,
        familyId: descriptor.familyId,
        split: descriptor.split,
        rendererSource: descriptor.rendererSource,
        phase: spec.phase,
        inputObservation: spec.inputObservation,
        targetText: spec.targetText,
        sensitive: spec.sensitive,
        state: spec.state,
        goal: spec.goal ?? relationGoal,
        goldInputHead: spec.goldInputHead,
        goldRelationHead: spec.goldRelationHead,
        wires,
        goldHead: spec.goldHead
      });
      episodeMap.get(spec.episodeIndex)?.stepRowIds.push(rowId);
    });
  }

  return {
    schemaVersion: BROWSER_STAGE1_SAMPLES_SCHEMA_VERSION,
    episodes,
    inputRows,
    relationRows,
    stepRows
  };
}

function countWireCollisions<T extends { readonly wires: readonly number[]; readonly goldHead: string }>(
  rows: readonly T[]
): { readonly uniqueWireVectors: number; readonly collisionCount: number } {
  const seen = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = row.wires.join(",");
    const set = seen.get(key) ?? new Set<string>();
    set.add(row.goldHead);
    seen.set(key, set);
  }
  let collisionCount = 0;
  for (const labels of seen.values()) {
    if (labels.size > 1) {
      collisionCount += 1;
    }
  }
  return {
    uniqueWireVectors: seen.size,
    collisionCount
  };
}

export function validateBrowserStage1Dataset(
  dataset: BrowserStage1Dataset
): BrowserStage1ValidationReport {
  const trainEpisodes = dataset.episodes.filter((ep) => ep.split === "train");
  const devEpisodes = dataset.episodes.filter((ep) => ep.split === "development");

  const familyEpisodeCounts: Record<string, number> = {};
  for (const ep of dataset.episodes) {
    familyEpisodeCounts[ep.familyId] = (familyEpisodeCounts[ep.familyId] ?? 0) + 1;
  }

  let heldOutEpisodesInDataset = 0;
  let forbiddenHeldOutImportsPresent = false;
  for (const ep of dataset.episodes) {
    for (const pattern of BROWSER_STAGE1_FORBIDDEN_HELDOUT_PATTERNS) {
      if (ep.episodeId.includes(pattern) || ep.familyId.includes(pattern)) {
        heldOutEpisodesInDataset += 1;
      }
      if (ep.rendererSource.includes(pattern)) {
        forbiddenHeldOutImportsPresent = true;
      }
    }
  }

  const inputCollisions = countWireCollisions(dataset.inputRows);
  const relationCollisions = countWireCollisions(dataset.relationRows);
  const stepCollisions = countWireCollisions(dataset.stepRows);
  const totalCollisions =
    inputCollisions.collisionCount +
    relationCollisions.collisionCount +
    stepCollisions.collisionCount;

  const inputTrain = dataset.inputRows.filter((r) => r.split === "train").length;
  const inputDev = dataset.inputRows.filter((r) => r.split === "development").length;
  const relTrain = dataset.relationRows.filter((r) => r.split === "train").length;
  const relDev = dataset.relationRows.filter((r) => r.split === "development").length;
  const stepTrain = dataset.stepRows.filter((r) => r.split === "train").length;
  const stepDev = dataset.stepRows.filter((r) => r.split === "development").length;

  const ok =
    trainEpisodes.length === 80 &&
    devEpisodes.length === 32 &&
    dataset.episodes.length === 112 &&
    inputTrain === 80 &&
    inputDev === 32 &&
    relTrain === 120 &&
    relDev === 48 &&
    stepTrain === 120 &&
    stepDev === 48 &&
    totalCollisions === 0 &&
    heldOutEpisodesInDataset === 0 &&
    !forbiddenHeldOutImportsPresent;

  return {
    ok,
    trainEpisodeCount: trainEpisodes.length,
    developmentEpisodeCount: devEpisodes.length,
    totalEpisodeCount: dataset.episodes.length,
    unitRowCounts: {
      inputPolicy: {
        train: inputTrain,
        development: inputDev,
        total: dataset.inputRows.length
      },
      queryRelation: {
        train: relTrain,
        development: relDev,
        total: dataset.relationRows.length
      },
      stepPolicy: {
        train: stepTrain,
        development: stepDev,
        total: dataset.stepRows.length
      }
    },
    uniqueWireVectors: {
      inputPolicy: inputCollisions.uniqueWireVectors,
      queryRelation: relationCollisions.uniqueWireVectors,
      stepPolicy: stepCollisions.uniqueWireVectors
    },
    collisionCount: {
      inputPolicy: inputCollisions.collisionCount,
      queryRelation: relationCollisions.collisionCount,
      stepPolicy: stepCollisions.collisionCount,
      total: totalCollisions
    },
    heldOutEpisodesInDataset,
    forbiddenHeldOutImportsPresent,
    familyEpisodeCounts,
    counts: {
      trainEpisodes: trainEpisodes.length,
      developmentEpisodes: devEpisodes.length,
      totalEpisodes: dataset.episodes.length,
      inputPolicy: {
        train: inputTrain,
        development: inputDev,
        total: dataset.inputRows.length
      },
      queryRelation: {
        train: relTrain,
        development: relDev,
        total: dataset.relationRows.length
      },
      stepPolicy: {
        train: stepTrain,
        development: stepDev,
        total: dataset.stepRows.length
      }
    },
    rendererIsolation: {
      ok: heldOutEpisodesInDataset === 0 && !forbiddenHeldOutImportsPresent
    },
    collisions: {
      inputPolicy: [],
      queryRelation: [],
      stepPolicy: []
    }
  } as BrowserStage1ValidationReport;
}

export function partitionBrowserStage1Dataset(
  dataset: BrowserStage1Dataset
): BrowserStage1PartitionedDataset {
  const report = validateBrowserStage1Dataset(dataset);
  if (!report.ok) {
    throw new Error(
      `Invalid Browser Stage 1 dataset partition or wire collision: ${JSON.stringify(report)}`
    );
  }
  const train: BrowserStage1SplitSlice = {
    episodes: dataset.episodes.filter((ep) => ep.split === "train"),
    inputRows: dataset.inputRows.filter((r) => r.split === "train"),
    relationRows: dataset.relationRows.filter((r) => r.split === "train"),
    stepRows: dataset.stepRows.filter((r) => r.split === "train")
  };
  const development: BrowserStage1SplitSlice = {
    episodes: dataset.episodes.filter((ep) => ep.split === "development"),
    inputRows: dataset.inputRows.filter((r) => r.split === "development"),
    relationRows: dataset.relationRows.filter((r) => r.split === "development"),
    stepRows: dataset.stepRows.filter((r) => r.split === "development")
  };
  return {
    dataset,
    train,
    development,
    summary: {
      trainEpisodeCount: train.episodes.length,
      developmentEpisodeCount: development.episodes.length,
      totalEpisodeCount: dataset.episodes.length,
      trainRowCounts: {
        inputPolicy: train.inputRows.length,
        queryRelation: train.relationRows.length,
        stepPolicy: train.stepRows.length
      },
      developmentRowCounts: {
        inputPolicy: development.inputRows.length,
        queryRelation: development.relationRows.length,
        stepPolicy: development.stepRows.length
      }
    }
  };
}

export function readBrowserStage1Dataset(raw: unknown): BrowserStage1Dataset {
  if (!raw || typeof raw !== "object") {
    throw new Error("Expected BrowserStage1Dataset object.");
  }
  const candidate = raw as BrowserStage1Dataset;
  if (candidate.schemaVersion !== BROWSER_STAGE1_SAMPLES_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported BrowserStage1Dataset schemaVersion: ${String(candidate.schemaVersion)}`
    );
  }
  if (
    !Array.isArray(candidate.episodes) ||
    !Array.isArray(candidate.inputRows) ||
    !Array.isArray(candidate.relationRows) ||
    !Array.isArray(candidate.stepRows)
  ) {
    throw new Error("BrowserStage1Dataset is missing episodes or unit row arrays.");
  }
  return candidate;
}

export function enumerateBrowserStage1TruthTables(): BrowserStage1TruthTableEnumerationReceipt {
  const trinary = ["true", "false", "unknown"] as const;
  const encodeTrinary = (val: (typeof trinary)[number]): [number, number] =>
    val === "true" ? [1, 1] : val === "false" ? [1, 0] : [0, 0];

  const s1Rows: Array<{ readonly wires: readonly number[]; readonly goldHead: BrowserInputPolicyHead }> = [];
  const s1Dist: Record<string, number> = { INPUT: 0, NOOP: 0, DEFER: 0 };
  for (const textType of trinary) {
    for (const enabled of trinary) {
      for (const editable of trinary) {
        for (const readOnly of trinary) {
          for (const valueEqual of trinary) {
            for (const executableHit of trinary) {
              const [tk, tv] = encodeTrinary(textType);
              const [enk, env] = encodeTrinary(enabled);
              const [edk, edv] = encodeTrinary(editable);
              const [rok, rov] = encodeTrinary(readOnly);
              const [vek, vev] = encodeTrinary(valueEqual);
              const [ehk, ehv] = encodeTrinary(executableHit);
              const wires = [1, tk, tv, enk, env, edk, edv, rok, rov, vek, vev, ehk, ehv];
              let goldHead: BrowserInputPolicyHead;
              if (vek === 1 && vev === 1 && tk === 1 && tv === 1) {
                goldHead = "NOOP";
              } else if (
                tk === 1 &&
                tv === 1 &&
                enk === 1 &&
                env === 1 &&
                edk === 1 &&
                edv === 1 &&
                rok === 1 &&
                rov === 0 &&
                vek === 1 &&
                vev === 0 &&
                ehk === 1 &&
                ehv === 1
              ) {
                goldHead = "INPUT";
              } else {
                goldHead = "DEFER";
              }
              s1Rows.push({ wires, goldHead });
              s1Dist[goldHead] = (s1Dist[goldHead] ?? 0) + 1;
            }
          }
        }
      }
    }
  }
  const s1Col = countWireCollisions(s1Rows);

  const s2Canonical: Array<{ readonly wires: readonly number[]; readonly goldHead: BrowserQueryRelationHead }> = [];
  const s2Extended: Array<{ readonly wires: readonly number[]; readonly goldHead: BrowserQueryRelationHead }> = [];
  const s2Dist: Record<string, number> = {
    input_only_unsubmitted: 0,
    submitted_pending_or_stale: 0,
    results_associated_active: 0,
    insufficient_or_conflict: 0
  };
  const requestStates = ["settled", "loading", "error", "unknown"] as const;
  const displayCategories = ["current_or_empty", "loading_or_stale_or_initial", "mismatch"] as const;
  for (const inputQueryEqual of trinary) {
    for (const newSubmission of trinary) {
      for (const responseMatches of trinary) {
        for (const reqState of requestStates) {
          for (const accessAvailable of trinary) {
            for (const dispCat of displayCategories) {
              const [iqk, iqv] = encodeTrinary(inputQueryEqual);
              const [nsk, nsv] = encodeTrinary(newSubmission);
              const [rmk, rmv] = encodeTrinary(responseMatches);
              const reqKnown = reqState !== "unknown" ? 1 : 0;
              const reqSettled = reqState === "settled" ? 1 : 0;
              const reqLoading = reqState === "loading" ? 1 : 0;
              const [ack, acv] = encodeTrinary(accessAvailable);
              const dispCurrent = dispCat === "current_or_empty" ? 1 : 0;
              const assoc =
                iqv === 1 &&
                nsv === 1 &&
                rmv === 1 &&
                reqSettled === 1 &&
                acv === 1 &&
                dispCurrent === 1
                  ? 1
                  : 0;
              const wires = [
                1,
                iqk,
                iqv,
                nsk,
                nsv,
                rmk,
                rmv,
                reqKnown,
                reqSettled,
                reqLoading,
                ack,
                acv,
                dispCurrent,
                assoc
              ];
              let goldHead: BrowserQueryRelationHead;
              if (assoc === 1) {
                goldHead = "results_associated_active";
              } else if (
                iqk === 1 &&
                iqv === 1 &&
                ack === 1 &&
                acv === 1 &&
                (nsv === 0 || (nsk === 0 && reqKnown === 0))
              ) {
                goldHead = "input_only_unsubmitted";
              } else if (
                iqk === 1 &&
                iqv === 1 &&
                nsk === 1 &&
                nsv === 1 &&
                ack === 1 &&
                acv === 1 &&
                (reqLoading === 1 || (reqSettled === 1 && rmv === 0 && rmk === 1))
              ) {
                goldHead = "submitted_pending_or_stale";
              } else {
                goldHead = "insufficient_or_conflict";
              }
              if (dispCat !== "mismatch") {
                s2Canonical.push({ wires, goldHead });
                s2Dist[goldHead] = (s2Dist[goldHead] ?? 0) + 1;
              }
              s2Extended.push({ wires, goldHead });
            }
          }
        }
      }
    }
  }
  const s2CanonicalCol = countWireCollisions(s2Canonical);
  const s2ExtendedCol = countWireCollisions(s2Extended);

  const s3Rows: Array<{ readonly wires: readonly number[]; readonly goldHead: BrowserStepPolicyHead }> = [
    { wires: [1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], goldHead: "input" },
    { wires: [1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], goldHead: "NOOP" },
    { wires: [1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], goldHead: "DEFER" },
    { wires: [1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], goldHead: "submit" },
    { wires: [1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0], goldHead: "NOOP" },
    { wires: [1, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0], goldHead: "NOOP" },
    { wires: [1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0], goldHead: "DEFER" },
    { wires: [1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], goldHead: "DEFER" },
    {
      wires: [1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      goldHead: "read_or_reobserve"
    },
    { wires: [1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0], goldHead: "DEFER" },
    {
      wires: [1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1],
      goldHead: "read_or_reobserve"
    },
    {
      wires: [1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 1],
      goldHead: "read_or_reobserve"
    },
    {
      wires: [1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1],
      goldHead: "read_or_reobserve"
    },
    {
      wires: [1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 1, 1],
      goldHead: "read_or_reobserve"
    },
    {
      wires: [1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1],
      goldHead: "read_or_reobserve"
    },
    { wires: [1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 0, 0, 0], goldHead: "NOOP" },
    {
      wires: [1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 0],
      goldHead: "expand_range"
    },
    { wires: [1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0], goldHead: "NOOP" },
    { wires: [1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 0], goldHead: "DEFER" },
    { wires: [1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 0, 0], goldHead: "DEFER" },
    { wires: [1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0], goldHead: "DEFER" }
  ];
  const s3Dist: Record<string, number> = {
    input: 0,
    submit: 0,
    read_or_reobserve: 0,
    expand_range: 0,
    NOOP: 0,
    DEFER: 0
  };
  for (const r of s3Rows) {
    s3Dist[r.goldHead] = (s3Dist[r.goldHead] ?? 0) + 1;
  }
  const s3Col = countWireCollisions(s3Rows);
  const totalCollisions =
    s1Col.collisionCount + s2CanonicalCol.collisionCount + s3Col.collisionCount;

  return {
    schemaVersion: "browser.stage1.wire-enumeration.v1",
    generatedAt: new Date().toISOString(),
    units: {
      "B-S1.1": {
        profileId: BROWSER_INPUT_POLICY_CONTRACT_ID,
        headCount: BROWSER_INPUT_POLICY_HEADS.length,
        wireCount: BROWSER_INPUT_POLICY_WIRES.length,
        parameterCount: BROWSER_INPUT_POLICY_HEADS.length * BROWSER_INPUT_POLICY_WIRES.length,
        enumeratedStates: s1Rows.length,
        uniqueWireVectors: s1Col.uniqueWireVectors,
        collisionCount: s1Col.collisionCount,
        linearlySeparable: s1Col.collisionCount === 0,
        labelDistribution: s1Dist
      },
      "B-S1.2": {
        profileId: BROWSER_QUERY_RELATION_CONTRACT_ID,
        headCount: BROWSER_QUERY_RELATION_HEADS.length,
        wireCount: BROWSER_QUERY_RELATION_WIRES.length,
        parameterCount: BROWSER_QUERY_RELATION_HEADS.length * BROWSER_QUERY_RELATION_WIRES.length,
        enumeratedStates: s2Canonical.length,
        uniqueWireVectors: s2CanonicalCol.uniqueWireVectors,
        collisionCount: s2CanonicalCol.collisionCount,
        linearlySeparable: s2CanonicalCol.collisionCount === 0,
        labelDistribution: s2Dist,
        extendedStatesWithDisplayMismatch: s2Extended.length,
        extendedUniqueWireVectors: s2ExtendedCol.uniqueWireVectors,
        extendedCollisionCount: s2ExtendedCol.collisionCount,
        extendedLinearlySeparable: s2ExtendedCol.collisionCount === 0
      },
      "B-S1.3": {
        profileId: BROWSER_STEP_POLICY_CONTRACT_ID,
        headCount: BROWSER_STEP_POLICY_HEADS.length,
        wireCount: BROWSER_STEP_POLICY_WIRES.length,
        parameterCount: BROWSER_STEP_POLICY_HEADS.length * BROWSER_STEP_POLICY_WIRES.length,
        enumeratedStates: s3Rows.length,
        uniqueWireVectors: s3Col.uniqueWireVectors,
        collisionCount: s3Col.collisionCount,
        linearlySeparable: s3Col.collisionCount === 0,
        labelDistribution: s3Dist
      }
    },
    allSeparable: totalCollisions === 0 && s2ExtendedCol.collisionCount === 0,
    totalCollisions
  };
}
