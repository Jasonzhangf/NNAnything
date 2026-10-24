import {
  BASIC_KIND_FAMILIES,
  classifyBasicKind,
  validateBasicKindProperties,
  type BasicKindLabel,
  type BasicKindProperties,
} from "../filters/basic-kinds.js";
import {
  expectArray,
  expectFiniteNumber,
  expectNonEmptyString,
  expectRecord,
  expectStringArray,
} from "../core/schema.js";
import { validateExplorationInput, type ExplorationInputV1 } from "../adapters/browser/exploration-input.js";

export const BASIC_KIND_TASK_ID = "dom.basic-kinds.v1" as const;
export type BasicKindInputScope = "candidate_qualified" | "properties_offline";
export type CandidateQualificationStatus = "ok" | "filtered_out" | "skipped" | "unknown" | "not_evaluated";
export type BasicKindReviewStatus = "verified" | "unreviewed" | "ambiguous" | "rejected";
export type BasicKindProposalStatus = "matched" | "unmatched" | "unknown" | "conflict";

export interface ReviewedBasicKindRow {
  readonly sampleId: string;
  readonly inputRef: {
    readonly snapshotRef: string;
    readonly documentRef: string;
    readonly frameRef: string;
    readonly nodeRef: string;
    readonly index: number;
    readonly regionRef?: string;
  };
  readonly provenanceRef: string;
  readonly sourceAssociations: {
    readonly snapshotRefs: readonly string[];
    readonly postRefs: readonly string[];
    readonly assetRefs: readonly string[];
  };
  readonly candidateQualification: {
    readonly status: CandidateQualificationStatus;
    readonly reasons: readonly string[];
  };
  readonly captureCoverage: {
    readonly frameContent: "captured" | "not_captured" | "not_applicable";
    readonly directChildren: "complete" | "incomplete" | "unknown";
  };
  readonly properties: BasicKindProperties;
  readonly explorationInput?: ExplorationInputV1 | null;
  readonly proposal: {
    readonly ruleRef: string | null;
    readonly label: BasicKindLabel | null;
    readonly status: BasicKindProposalStatus;
  };
  readonly review: {
    readonly status: BasicKindReviewStatus;
    readonly expectedLabel: BasicKindLabel | null;
    readonly reviewerRef: string | null;
    readonly evidenceRef: string | null;
    readonly otherReason: string | null;
  };
}

export interface BasicKindTrainingRequest {
  readonly schemaVersion: 1;
  readonly taskId: typeof BASIC_KIND_TASK_ID;
  readonly rows: readonly ReviewedBasicKindRow[];
}

export interface PrepareBasicKindConfig {
  readonly taskId: typeof BASIC_KIND_TASK_ID;
  readonly inputScope: BasicKindInputScope;
}

export interface PreparedBasicKindRow extends ReviewedBasicKindRow {
  readonly index: number;
  readonly included: boolean;
  readonly reasons: readonly string[];
}

export interface BasicKindSamples {
  readonly schemaVersion: 1;
  readonly taskId: typeof BASIC_KIND_TASK_ID;
  readonly inputScope: BasicKindInputScope;
  readonly rows: readonly PreparedBasicKindRow[];
  readonly includedIndices: readonly number[];
}

export interface BasicKindFitRowProjection {
  readonly properties: BasicKindProperties;
  readonly expectedLabel: BasicKindLabel;
}

const LABELS: readonly BasicKindLabel[] = [
  ...Object.values(BASIC_KIND_FAMILIES).flat(),
  "other",
];
const PROPERTY_KEYS = [
  "tag",
  "role",
  "inputType",
  "hrefPresent",
  "contentEditable",
  "directTextPresent",
  "nonFormatDirectTextPresent",
  "beforeContentPresent",
  "afterContentPresent",
  "backgroundImagePresent",
  "maskImagePresent",
  "childElementCount",
  "positiveAreaChildCount",
  "repeatedChildGeometry",
  "inVerifiedListParent",
  "svgGraphicChildren",
  "disabled",
  "hidden",
  "pointerCursor",
  "parentPointerCursor",
  "tabIndexFocus",
  "activeElementFocus",
  "borderPresent",
  "aspectRatio",
  "descendantTextPresent",
  "directListChildPresent",
  "singleChildTag",
  "singleChildSameRect",
  "withinControlAncestor",
  "inSvgAncestor",
  "explicitTabIndexKind",
] as const;

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  if (Object.keys(value).some(key => !keys.includes(key))) {
    throw new TypeError(`${field} contains unsupported fields`);
  }
}

function oneOf<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (!values.includes(value as T)) throw new TypeError(`${field} has an invalid value`);
  return value as T;
}

function indexValue(value: unknown, field: string): number {
  const index = expectFiniteNumber(value, field);
  if (!Number.isInteger(index) || index < 0) throw new TypeError(`${field} must be a nonnegative integer`);
  return index;
}

function nullableString(value: unknown, field: string): string | null {
  return value === null ? null : expectNonEmptyString(value, field);
}

function nullableLabel(value: unknown, field: string): BasicKindLabel | null {
  return value === null ? null : oneOf(value, LABELS, field);
}

function readInputRef(value: unknown, rowIndex: number): ReviewedBasicKindRow["inputRef"] {
  const input = expectRecord(value, `rows[${rowIndex}].inputRef`);
  onlyKeys(input, ["snapshotRef", "documentRef", "frameRef", "nodeRef", "index", "regionRef"], `rows[${rowIndex}].inputRef`);
  const index = indexValue(input.index, `rows[${rowIndex}].inputRef.index`);
  if (index !== rowIndex) throw new TypeError("row inputRef.index must match its array position");
  return {
    snapshotRef: expectNonEmptyString(input.snapshotRef, "inputRef.snapshotRef"),
    documentRef: expectNonEmptyString(input.documentRef, "inputRef.documentRef"),
    frameRef: expectNonEmptyString(input.frameRef, "inputRef.frameRef"),
    nodeRef: expectNonEmptyString(input.nodeRef, "inputRef.nodeRef"),
    index,
    ...(input.regionRef !== undefined ? { regionRef: expectNonEmptyString(input.regionRef, "inputRef.regionRef") } : {}),
  };
}

function readSourceAssociations(
  value: unknown,
  inputRef: ReviewedBasicKindRow["inputRef"],
  rowIndex: number,
): ReviewedBasicKindRow["sourceAssociations"] {
  const input = expectRecord(value, `rows[${rowIndex}].sourceAssociations`);
  onlyKeys(input, ["snapshotRefs", "postRefs", "assetRefs"], `rows[${rowIndex}].sourceAssociations`);
  const snapshotRefs = expectStringArray(input.snapshotRefs, "sourceAssociations.snapshotRefs");
  if (!snapshotRefs.includes(inputRef.snapshotRef)) throw new TypeError("sourceAssociations.snapshotRefs must include inputRef.snapshotRef");
  return {
    snapshotRefs,
    postRefs: expectStringArray(input.postRefs, "sourceAssociations.postRefs"),
    assetRefs: expectStringArray(input.assetRefs, "sourceAssociations.assetRefs"),
  };
}

function readReviewedRow(value: unknown, rowIndex: number, label: string): ReviewedBasicKindRow {
  const input = expectRecord(value, label);
  onlyKeys(input, [
    "sampleId",
    "inputRef",
    "provenanceRef",
    "sourceAssociations",
    "candidateQualification",
    "captureCoverage",
    "properties",
    "explorationInput",
    "proposal",
    "review",
  ], label);
  const inputRef = readInputRef(input.inputRef, rowIndex);
  const qualification = expectRecord(input.candidateQualification, "candidateQualification");
  onlyKeys(qualification, ["status", "reasons"], "candidateQualification");
  const coverage = expectRecord(input.captureCoverage, "captureCoverage");
  onlyKeys(coverage, ["frameContent", "directChildren"], "captureCoverage");
  const proposal = expectRecord(input.proposal, "proposal");
  onlyKeys(proposal, ["ruleRef", "label", "status"], "proposal");
  const proposalStatus = oneOf(proposal.status, ["matched", "unmatched", "unknown", "conflict"] as const, "proposal.status");
  const proposalLabel = nullableLabel(proposal.label, "proposal.label");
  if ((proposalStatus === "matched") !== (proposalLabel !== null)) throw new TypeError("proposal label must exist only for matched proposals");
  const review = expectRecord(input.review, "review");
  onlyKeys(review, ["status", "expectedLabel", "reviewerRef", "evidenceRef", "otherReason"], "review");
  const reviewStatus = oneOf(review.status, ["verified", "unreviewed", "ambiguous", "rejected"] as const, "review.status");
  const expectedLabel = nullableLabel(review.expectedLabel, "review.expectedLabel");
  const reviewerRef = nullableString(review.reviewerRef, "review.reviewerRef");
  const evidenceRef = nullableString(review.evidenceRef, "review.evidenceRef");
  const otherReason = nullableString(review.otherReason, "review.otherReason");
  if (reviewStatus === "verified") {
    if (expectedLabel === null || reviewerRef === null || evidenceRef === null) throw new TypeError("verified review requires an expected label, reviewerRef and evidenceRef");
  } else if (expectedLabel !== null || reviewerRef !== null || evidenceRef !== null || otherReason !== null) {
    throw new TypeError("non-verified review cannot carry a gold label or review references");
  }
  if (expectedLabel === "other" && otherReason === null) throw new TypeError("gold other requires an explicit otherReason");
  if (expectedLabel !== "other" && otherReason !== null) throw new TypeError("otherReason is valid only for gold other");

  const projectedProperties = validateBasicKindProperties(input.properties);
  const explorationInput = input.explorationInput == null ? input.explorationInput : validateExplorationInput(input.explorationInput);
  if (explorationInput && explorationInput.nodeRef !== inputRef.nodeRef) throw new TypeError("explorationInput nodeRef must match inputRef.nodeRef");
  return {
    sampleId: expectNonEmptyString(input.sampleId, "sampleId"),
    inputRef,
    provenanceRef: expectNonEmptyString(input.provenanceRef, "provenanceRef"),
    sourceAssociations: readSourceAssociations(input.sourceAssociations, inputRef, rowIndex),
    candidateQualification: {
      status: oneOf(qualification.status, ["ok", "filtered_out", "skipped", "unknown", "not_evaluated"] as const, "candidateQualification.status"),
      reasons: expectStringArray(qualification.reasons, "candidateQualification.reasons"),
    },
    captureCoverage: {
      frameContent: oneOf(coverage.frameContent, ["captured", "not_captured", "not_applicable"] as const, "captureCoverage.frameContent"),
      directChildren: oneOf(coverage.directChildren, ["complete", "incomplete", "unknown"] as const, "captureCoverage.directChildren"),
    },
    properties: projectedProperties,
    ...(explorationInput !== undefined ? { explorationInput } : {}),
    proposal: {
      ruleRef: nullableString(proposal.ruleRef, "proposal.ruleRef"),
      label: proposalLabel,
      status: proposalStatus,
    },
    review: { status: reviewStatus, expectedLabel, reviewerRef, evidenceRef, otherReason },
  };
}

export function readBasicKindTrainingRequest(value: unknown): BasicKindTrainingRequest {
  const input = expectRecord(value, "training request");
  onlyKeys(input, ["schemaVersion", "taskId", "rows"], "training request");
  if (input.schemaVersion !== 1) throw new TypeError("training request schemaVersion must be 1");
  const taskId = expectNonEmptyString(input.taskId, "taskId");
  if (taskId !== BASIC_KIND_TASK_ID) throw new TypeError(`taskId must be ${BASIC_KIND_TASK_ID}`);
  const rows = expectArray(input.rows, "rows").map((entry, index) => readReviewedRow(entry, index, `rows[${index}]`));
  const ids = new Set<string>();
  for (const item of rows) {
    if (ids.has(item.sampleId)) throw new TypeError(`duplicate sampleId ${item.sampleId}`);
    ids.add(item.sampleId);
  }
  return { schemaVersion: 1, taskId: BASIC_KIND_TASK_ID, rows };
}

function readInputScope(value: unknown, label: string): BasicKindInputScope {
  return oneOf(value, ["candidate_qualified", "properties_offline"] as const, `${label}.inputScope`);
}

export function readPrepareBasicKindConfig(value: unknown): PrepareBasicKindConfig {
  const input = expectRecord(value, "prepare config");
  onlyKeys(input, ["taskId", "inputScope"], "prepare config");
  const taskId = expectNonEmptyString(input.taskId, "prepare config.taskId");
  if (taskId !== BASIC_KIND_TASK_ID) throw new TypeError(`prepare config.taskId must be ${BASIC_KIND_TASK_ID}`);
  return {
    taskId: BASIC_KIND_TASK_ID,
    inputScope: readInputScope(input.inputScope, "prepare config"),
  };
}

function hasObservedProperties(properties: BasicKindProperties): boolean {
  return PROPERTY_KEYS.some(key => {
    const value = properties[key];
    return value !== undefined && value !== null && value !== "";
  });
}

export function prepareBasicKindSamples(value: unknown, rawConfig: unknown): BasicKindSamples {
  const request = readBasicKindTrainingRequest(value);
  const config = readPrepareBasicKindConfig(rawConfig);
  const rows = request.rows.map((item, index): PreparedBasicKindRow => {
    const reasons: string[] = [];
    let included = true;
    if (item.review.status !== "verified") {
      included = false;
      reasons.push("review_not_verified");
    } else reasons.push("review_verified");
    if (config.inputScope === "candidate_qualified" && item.candidateQualification.status !== "ok") {
      included = false;
      reasons.push("candidate_not_qualified");
    } else if (config.inputScope === "properties_offline") {
      reasons.push("offline_properties_scope");
    } else reasons.push("candidate_qualified");
    if (item.captureCoverage.frameContent === "not_captured") {
      included = false;
      reasons.push("frame_content_not_captured");
    }
    if (!hasObservedProperties(item.properties)) {
      included = false;
      reasons.push("no_observed_wires");
    }
    if (included) reasons.push("observed_properties");
    return { ...item, index, included, reasons };
  });
  return {
    schemaVersion: 1,
    taskId: BASIC_KIND_TASK_ID,
    inputScope: config.inputScope,
    rows,
    includedIndices: rows.filter(item => item.included).map(item => item.index),
  };
}

export function readBasicKindSamples(value: unknown): BasicKindSamples {
  const input = expectRecord(value, "samples");
  onlyKeys(input, ["schemaVersion", "taskId", "inputScope", "rows", "includedIndices"], "samples");
  if (input.schemaVersion !== 1) throw new TypeError("samples schemaVersion must be 1");
  if (input.taskId !== BASIC_KIND_TASK_ID) throw new TypeError(`samples taskId must be ${BASIC_KIND_TASK_ID}`);
  const inputScope = readInputScope(input.inputScope, "samples");
  const rows = expectArray(input.rows, "samples.rows").map((entry, index): PreparedBasicKindRow => {
    const raw = expectRecord(entry, `samples.rows[${index}]`);
    onlyKeys(raw, [
      "sampleId",
      "inputRef",
      "provenanceRef",
      "sourceAssociations",
      "candidateQualification",
      "captureCoverage",
      "properties",
      "explorationInput",
      "proposal",
      "review",
      "index",
      "included",
      "reasons",
    ], `samples.rows[${index}]`);
    const reviewed = readReviewedRow(
      Object.fromEntries(Object.entries(raw).filter(([key]) => !["index", "included", "reasons"].includes(key))),
      index,
      `samples.rows[${index}]`,
    );
    if (raw.index !== index) throw new TypeError("prepared row index must match its array position");
    if (typeof raw.included !== "boolean") throw new TypeError("prepared row.included must be boolean");
    return {
      ...reviewed,
      index,
      included: raw.included,
      reasons: expectStringArray(raw.reasons, `samples.rows[${index}].reasons`),
    };
  });
  const includedIndices = expectArray(input.includedIndices, "includedIndices").map((entry, index) =>
    indexValue(entry, `includedIndices[${index}]`),
  );
  const expected = rows.filter(item => item.included).map(item => item.index);
  if (JSON.stringify(includedIndices) !== JSON.stringify(expected)) throw new TypeError("includedIndices must match included rows in input order");
  const included = new Set(includedIndices);
  for (const row of rows) {
    if (row.included !== included.has(row.index)) throw new TypeError("prepared row inclusion flag disagrees with includedIndices");
    if (row.included && row.review.expectedLabel === null) throw new TypeError("included sample requires a verified expected label");
  }
  return { schemaVersion: 1, taskId: BASIC_KIND_TASK_ID, inputScope, rows, includedIndices };
}

export function toBasicKindFitRows(value: unknown): BasicKindFitRowProjection[] {
  const samples = readBasicKindSamples(value);
  const included = new Set(samples.includedIndices);
  return samples.rows.filter(item => included.has(item.index)).map(item => {
    if (item.review.expectedLabel === null) throw new TypeError("included sample is missing a verified expected label");
    return {
      properties: { ...item.properties },
      expectedLabel: item.review.expectedLabel,
    };
  });
}

export const BASIC_KIND_LABELS = LABELS;
