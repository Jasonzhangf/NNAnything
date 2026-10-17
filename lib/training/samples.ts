import type { Rect } from "../adapters/browser/observation.js";
import { expectArray, expectFiniteNumber, expectNonEmptyString, expectRecord, expectStringArray } from "../core/schema.js";
import { onlyKeys, readTeacherRecord } from "../filters/sample-match.js";
import type { SemanticResult, TeacherRecord } from "../filters/sample-match.js";

export type CandidateStatus = "ok" | "filtered_out" | "skipped" | "unknown";
export type LabelState = "positive" | "negative" | "unlabeled" | "conflict" | "excluded";
export interface SourceGroup { readonly snapshotRefs: readonly string[]; readonly postRefs?: readonly string[]; readonly adAssetRefs?: readonly string[] }
export interface StudentObservation {
  readonly tag?: string | null; readonly role?: string | null; readonly parentRef?: string | null;
  readonly rect?: Rect | null; readonly clippedRect?: Rect | null; readonly fragments?: readonly Rect[] | null;
}
export interface InputRef { readonly snapshotRef: string; readonly nodeRef: string; readonly index: number }
export interface RawDomRecord extends TeacherRecord {
  readonly nodeRef: string; readonly provenanceRef: string; readonly candidateStatus?: CandidateStatus; readonly studentObservation?: StudentObservation;
}
export interface RawDomRecords { readonly snapshotRef: string; readonly sourceGroup: SourceGroup; readonly records: readonly RawDomRecord[] }
export interface MatchedSlot extends SemanticResult {
  readonly index: number; readonly nodeRef: string; readonly inputRef: InputRef; readonly provenanceRef: string; readonly sourceGroup: SourceGroup;
  readonly candidateStatus?: CandidateStatus; readonly studentObservation?: StudentObservation;
}
export interface MatchedRecords {
  readonly snapshotRef: string; readonly sourceGroup: SourceGroup; readonly ruleId: string; readonly slots: readonly MatchedSlot[];
  readonly matchedRefs: readonly { readonly index: number; readonly nodeRef: string }[];
}
export interface SampleAssembleConfig {
  readonly taskId: string; readonly supervisionMap: Readonly<Record<string, "positive" | "negative">>;
  readonly expectedLabels: { readonly positive: string; readonly negative: string }; readonly unmappedPolicy: "unlabeled" | "excluded";
}
export interface TaskSampleRow extends SemanticResult {
  readonly taskId: string; readonly ruleId: string; readonly inputRef: InputRef; readonly provenanceRef: string; readonly sourceGroup: SourceGroup;
  readonly expectedLabel: string | null; readonly labelState: LabelState; readonly labelProvenance: "rule_proposed";
  readonly excludeReasons: readonly string[]; readonly studentObservation?: StudentObservation;
}
export interface TaskDataset { readonly taskId: string; readonly ruleId: string; readonly items: readonly TaskSampleRow[] }
export const LABEL_STATES: readonly LabelState[] = ["positive", "negative", "unlabeled", "conflict", "excluded"];

function enumValue<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (!values.includes(value as T)) throw new TypeError(`${field} has an invalid value`);
  return value as T;
}
function position(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new TypeError("index must be a nonnegative integer");
  return value as number;
}
function inputRef(value: unknown): InputRef {
  const r = expectRecord(value, "inputRef"); onlyKeys(r, ["snapshotRef", "nodeRef", "index"], "inputRef");
  return { snapshotRef: expectNonEmptyString(r.snapshotRef, "snapshotRef"), nodeRef: expectNonEmptyString(r.nodeRef, "nodeRef"), index: position(r.index) };
}
function sourceGroup(value: unknown, snapshotRef: string): SourceGroup {
  const r = expectRecord(value, "sourceGroup"); onlyKeys(r, ["snapshotRefs", "postRefs", "adAssetRefs"], "sourceGroup");
  const snapshotRefs = expectStringArray(r.snapshotRefs, "snapshotRefs");
  if (!snapshotRefs.includes(snapshotRef)) throw new TypeError("sourceGroup must reference the input snapshot");
  return { snapshotRefs, ...(r.postRefs !== undefined ? { postRefs: expectStringArray(r.postRefs, "postRefs") } : {}), ...(r.adAssetRefs !== undefined ? { adAssetRefs: expectStringArray(r.adAssetRefs, "adAssetRefs") } : {}) };
}
function rect(value: unknown): Rect | null {
  if (value === null) return null;
  const r = expectRecord(value, "rect");
  const result = { x: expectFiniteNumber(r.x, "rect.x"), y: expectFiniteNumber(r.y, "rect.y"), width: expectFiniteNumber(r.width, "rect.width"), height: expectFiniteNumber(r.height, "rect.height") };
  if (result.width < 0 || result.height < 0) throw new TypeError("rect dimensions must be nonnegative");
  return result;
}
export function projectStudentObservation(value: unknown): StudentObservation {
  const r = expectRecord(value, "studentObservation");
  const text = (v: unknown, key: string) => v === null ? null : expectNonEmptyString(v, key);
  return {
    ...(r.tag !== undefined ? { tag: text(r.tag, "tag") } : {}),
    ...(r.role !== undefined ? { role: text(r.role, "role") } : {}),
    ...(r.parentRef !== undefined ? { parentRef: text(r.parentRef, "parentRef") } : {}),
    ...(r.rect !== undefined ? { rect: rect(r.rect) } : {}),
    ...(r.clippedRect !== undefined ? { clippedRect: rect(r.clippedRect) } : {}),
    ...(r.fragments !== undefined ? { fragments: r.fragments === null ? null : expectArray(r.fragments, "fragments").map(v => {
      const result = rect(v); if (!result) throw new TypeError("fragment must be a rectangle"); return result;
    }) } : {}),
  };
}
function observation(r: Record<string, unknown>): { studentObservation?: StudentObservation } {
  return r.studentObservation === undefined ? {} : { studentObservation: projectStudentObservation(r.studentObservation) };
}
function candidate(r: Record<string, unknown>): { candidateStatus?: CandidateStatus } {
  return r.candidateStatus === undefined ? {} : { candidateStatus: enumValue(r.candidateStatus, ["ok", "filtered_out", "skipped", "unknown"], "candidateStatus") };
}
function semantic(r: Record<string, unknown>): SemanticResult {
  const matchStatus = enumValue(r.matchStatus, ["matched", "unmatched", "unknown", "conflict"], "matchStatus");
  const semanticLabel = r.semanticLabel === null ? null : expectNonEmptyString(r.semanticLabel, "semanticLabel");
  const matchedRuleIds = expectStringArray(r.matchedRuleIds, "matchedRuleIds");
  if ((matchStatus === "matched") !== (semanticLabel !== null)) throw new TypeError("semantic label must exist only for a matched result");
  if ((matchStatus === "matched" || matchStatus === "conflict") ? !matchedRuleIds.length : matchedRuleIds.length > 0) throw new TypeError("matched rule references disagree with status");
  const reasons = expectStringArray(r.reasons, "reasons");
  const valid = ["semantic_match", "semantic_conflict", "unresolved_competing_class", "missing_teacher_field", "no_rule_match"];
  if (reasons.some(x => !valid.includes(x))) throw new TypeError("unsupported semantic reason");
  return { matchStatus, semanticLabel, matchedRuleIds, reasons };
}
export function readRawRecords(value: unknown): RawDomRecords {
  const r = expectRecord(value, "raw records"); onlyKeys(r, ["snapshotRef", "sourceGroup", "records"], "raw records");
  const snapshotRef = expectNonEmptyString(r.snapshotRef, "snapshotRef");
  return { snapshotRef, sourceGroup: sourceGroup(r.sourceGroup, snapshotRef), records: expectArray(r.records, "records").map(v => {
    const item = expectRecord(v, "raw record");
    return { ...readTeacherRecord(item), nodeRef: expectNonEmptyString(item.nodeRef, "nodeRef"), provenanceRef: expectNonEmptyString(item.provenanceRef, "provenanceRef"), ...candidate(item), ...observation(item) };
  }) };
}
const semanticKeys = ["matchStatus", "semanticLabel", "matchedRuleIds", "reasons"];
export function readMatchedRecords(value: unknown): MatchedRecords {
  const r = expectRecord(value, "matched records"); onlyKeys(r, ["snapshotRef", "sourceGroup", "ruleId", "slots", "matchedRefs"], "matched records");
  const snapshotRef = expectNonEmptyString(r.snapshotRef, "snapshotRef");
  const slots = expectArray(r.slots, "slots").map((v, i): MatchedSlot => {
    const s = expectRecord(v, "slot");
    onlyKeys(s, ["index", "nodeRef", "inputRef", "provenanceRef", "sourceGroup", "candidateStatus", "studentObservation", ...semanticKeys], "slot");
    const ref = inputRef(s.inputRef);
    if (s.index !== i || ref.index !== i || ref.nodeRef !== s.nodeRef || ref.snapshotRef !== snapshotRef) throw new TypeError("slot/inputRef position or source mismatch");
    return { index: i, nodeRef: expectNonEmptyString(s.nodeRef, "nodeRef"), inputRef: ref, provenanceRef: expectNonEmptyString(s.provenanceRef, "provenanceRef"), sourceGroup: sourceGroup(s.sourceGroup, snapshotRef), ...semantic(s), ...candidate(s), ...observation(s) };
  });
  const matchedRefs = expectArray(r.matchedRefs, "matchedRefs").map(v => {
    const ref = expectRecord(v, "matched reference"); onlyKeys(ref, ["index", "nodeRef"], "matched reference");
    return { index: position(ref.index), nodeRef: expectNonEmptyString(ref.nodeRef, "nodeRef") };
  });
  const expected = slots.filter(s => s.matchStatus === "matched");
  if (expected.length !== matchedRefs.length || expected.some((s, i) => s.index !== matchedRefs[i]!.index || s.nodeRef !== matchedRefs[i]!.nodeRef)) throw new TypeError("matchedRefs must preserve matched slot positions");
  return { snapshotRef, sourceGroup: sourceGroup(r.sourceGroup, snapshotRef), ruleId: expectNonEmptyString(r.ruleId, "ruleId"), slots, matchedRefs };
}
export function readAssembleConfig(value: unknown): SampleAssembleConfig {
  const r = expectRecord(value, "task config"); onlyKeys(r, ["taskId", "supervisionMap", "expectedLabels", "unmappedPolicy"], "task config");
  const mapping = expectRecord(r.supervisionMap, "supervisionMap");
  const supervisionMap = Object.fromEntries(Object.entries(mapping).map(([key, value]) => [expectNonEmptyString(key, "semantic map key"), enumValue(value, ["positive", "negative"] as const, "supervision polarity")]));
  const labels = expectRecord(r.expectedLabels, "expectedLabels"); onlyKeys(labels, ["positive", "negative"], "expectedLabels");
  const expectedLabels = { positive: expectNonEmptyString(labels.positive, "positive label"), negative: expectNonEmptyString(labels.negative, "negative label") };
  if (expectedLabels.positive === expectedLabels.negative) throw new TypeError("expected labels must differ");
  return { taskId: expectNonEmptyString(r.taskId, "taskId"), supervisionMap, expectedLabels, unmappedPolicy: r.unmappedPolicy === undefined ? "unlabeled" : enumValue(r.unmappedPolicy, ["unlabeled", "excluded"], "unmappedPolicy") };
}
export function assembleSamples(value: unknown, rawConfig: unknown): TaskDataset {
  const input = readMatchedRecords(value), config = readAssembleConfig(rawConfig);
  const items = input.slots.map((s): TaskSampleRow => {
    let labelState: LabelState = "unlabeled";
    let expectedLabel: string | null = null;
    const excludeReasons: string[] = [];
    if (s.candidateStatus === "filtered_out" || s.candidateStatus === "skipped") {
      labelState = "excluded"; excludeReasons.push(`candidate_${s.candidateStatus}`);
    } else if (s.candidateStatus !== "unknown") {
      if (s.matchStatus === "conflict") labelState = "conflict";
      else if (s.matchStatus === "matched") {
        const polarity = Object.hasOwn(config.supervisionMap, s.semanticLabel!) ? config.supervisionMap[s.semanticLabel!] : undefined;
        if (polarity) { labelState = polarity; expectedLabel = config.expectedLabels[polarity]; }
        else if (config.unmappedPolicy === "excluded") { labelState = "excluded"; excludeReasons.push("unmapped_semantic_label"); }
      }
    }
    return { taskId: config.taskId, ruleId: input.ruleId, inputRef: s.inputRef, provenanceRef: s.provenanceRef, sourceGroup: s.sourceGroup,
      matchStatus: s.matchStatus, semanticLabel: s.semanticLabel, matchedRuleIds: s.matchedRuleIds, reasons: s.reasons,
      expectedLabel, labelState, labelProvenance: "rule_proposed", excludeReasons, ...observation(s as unknown as Record<string, unknown>) };
  });
  return { taskId: config.taskId, ruleId: input.ruleId, items };
}
export function readTaskDataset(value: unknown): TaskDataset {
  const r = expectRecord(value, "dataset"); onlyKeys(r, ["taskId", "ruleId", "items"], "dataset");
  const taskId = expectNonEmptyString(r.taskId, "taskId"), ruleId = expectNonEmptyString(r.ruleId, "ruleId");
  const items = expectArray(r.items, "items").map((v, i): TaskSampleRow => {
    const s = expectRecord(v, "sample row");
    onlyKeys(s, ["taskId", "ruleId", "inputRef", "provenanceRef", "sourceGroup", "expectedLabel", "labelState", "labelProvenance", "excludeReasons", "studentObservation", ...semanticKeys], "sample row");
    const ref = inputRef(s.inputRef), classification = semantic(s);
    if (s.taskId !== taskId || s.ruleId !== ruleId || ref.index !== i || s.labelProvenance !== "rule_proposed") throw new TypeError("row task/rule/position/provenance mismatch");
    const labelState = enumValue(s.labelState, LABEL_STATES, "labelState");
    const expectedLabel = s.expectedLabel === null ? null : expectNonEmptyString(s.expectedLabel, "expectedLabel");
    const labeled = labelState === "positive" || labelState === "negative";
    if (labeled !== (expectedLabel !== null) || (labeled && classification.matchStatus !== "matched") || (labelState === "conflict" && classification.matchStatus !== "conflict")) throw new TypeError("row label and classification states disagree");
    const excludeReasons = expectStringArray(s.excludeReasons, "excludeReasons");
    if (excludeReasons.some(x => !["candidate_filtered_out", "candidate_skipped", "unmapped_semantic_label"].includes(x)) || (labelState !== "excluded" && excludeReasons.length)) throw new TypeError("invalid exclusion reasons");
    return { taskId, ruleId, inputRef: ref, provenanceRef: expectNonEmptyString(s.provenanceRef, "provenanceRef"), sourceGroup: sourceGroup(s.sourceGroup, ref.snapshotRef), ...classification, labelState, expectedLabel, labelProvenance: "rule_proposed", excludeReasons, ...observation(s) };
  });
  return { taskId, ruleId, items };
}
