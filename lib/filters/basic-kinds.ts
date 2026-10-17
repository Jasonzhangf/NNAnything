import { expectArray, expectFiniteNumber, expectNonEmptyString, expectRecord } from "../core/schema.js";
import { validateCandidateBatch, type CandidateSlot } from "./candidate-chain.js";

export const BASIC_KIND_FAMILIES = {
  control: ["button", "input", "select"],
  media: ["image", "video", "audio"],
  navigation: ["link"],
  text: ["text"],
  structure: ["container", "list", "listitem"],
} as const;
export type BasicKindFamily = keyof typeof BASIC_KIND_FAMILIES;
for (const leaves of Object.values(BASIC_KIND_FAMILIES)) Object.freeze(leaves);
Object.freeze(BASIC_KIND_FAMILIES);
export type SpecificBasicKindLabel = typeof BASIC_KIND_FAMILIES[BasicKindFamily][number];
export type BasicKindLabel = SpecificBasicKindLabel | "other";
export type BasicKindStatus = "judged" | "unknown" | "conflict" | "excluded";
export type BasicKindWireValue = 0 | 1 | null;
export interface ScoreInterval { readonly min: number; readonly max: number }
export interface BasicKindMeasurements {
  readonly inputType?: string | null;
  readonly hrefPresent?: boolean | null;
  readonly contentEditable?: boolean | null;
  readonly directTextPresent?: boolean | null;
  readonly childElementCount?: number | null;
  readonly positiveAreaChildCount?: number | null;
  readonly repeatedChildGeometry?: boolean | null;
  readonly inVerifiedListParent?: boolean | null;
}
export interface BasicKindProperties extends BasicKindMeasurements {
  readonly tag: string | null;
  readonly role: string | null;
  readonly disabled?: boolean | null;
  readonly hidden?: boolean | null;
}
export interface BasicKindConfig { readonly taskId: string; readonly minScore: number; readonly minMargin: number }
export const DEFAULT_BASIC_KIND_CONFIG: BasicKindConfig = Object.freeze({ taskId: "dom.basic-kinds.v1", minScore: 0.6, minMargin: 0.15 });

const tagSets = {
  nat_control_button: ["button", "summary"], nat_control_text: ["textarea"], nat_control_select: ["select", "option", "optgroup"], nat_input_tag: ["input"],
  nat_image: ["img", "picture", "canvas"], nat_video: ["video"], nat_audio: ["audio"], nat_anchor: ["a"],
  nat_text: ["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "code", "pre", "time", "label", "em", "strong", "small"], nat_span: ["span"],
  nat_container: ["article", "section", "nav", "aside", "header", "footer", "main", "form", "fieldset", "dialog", "details"],
  nat_list: ["ul", "ol", "dl"], nat_listitem: ["li", "dt", "dd"], nat_div: ["div"],
} as const;
const roleSets = {
  role_button: ["button"], role_input: ["textbox", "searchbox", "spinbutton"],
  role_select: ["combobox", "listbox", "option", "menuitem", "tab", "checkbox", "radio", "switch"],
  role_image: ["img", "image", "figure"], role_link: ["link"], role_text: ["text", "heading"],
  role_container: ["region", "main", "navigation", "complementary", "banner", "contentinfo", "form", "dialog", "group", "toolbar", "article"],
  role_list: ["list", "feed", "menu", "tablist"], role_listitem: ["listitem"],
  role_presentational: ["none", "presentation"],
} as const;
const typeSets = {
  input_type_text: ["text", "search", "password", "email", "url", "tel", "number", "date", "datetime-local", "month", "time", "week", "range", "color", "file"],
  input_type_button: ["button", "submit", "reset", "image"], input_type_select: ["checkbox", "radio"],
  input_type_hidden: ["hidden"],
} as const;
const localWireNames = ["attr_editable", "anchor_href", "span_leaf", "span_direct_text", "div_multi_child", "div_repeated_children", "div_in_list", "state_disabled", "state_hidden"] as const;
export type BasicKindWireName = keyof typeof tagSets | keyof typeof roleSets | keyof typeof typeSets | typeof localWireNames[number];
export const BASIC_KIND_WIRE_NAMES: readonly BasicKindWireName[] = [
  ...Object.keys(tagSets) as (keyof typeof tagSets)[],
  ...Object.keys(roleSets) as (keyof typeof roleSets)[],
  ...Object.keys(typeSets) as (keyof typeof typeSets)[],
  ...localWireNames,
];
export type BasicKindWeights = Readonly<Partial<Record<BasicKindWireName, number>>>;
export interface BasicKindProfile {
  readonly id: string;
  readonly familyWeights: Readonly<Record<BasicKindFamily, BasicKindWeights>>;
  readonly leafWeights: Readonly<Record<SpecificBasicKindLabel, BasicKindWeights>>;
}
export const DEFAULT_BASIC_KIND_PROFILE: BasicKindProfile = {
  id: "dom-basic-kinds-handwritten-v1",
  familyWeights: {
    control: { nat_control_button: 0.85, nat_control_text: 0.85, nat_control_select: 0.85, nat_input_tag: 0.85, role_button: 0.8, role_input: 0.8, role_select: 0.8, attr_editable: 0.75 },
    media: { nat_image: 0.85, nat_video: 0.9, nat_audio: 0.9, role_image: 0.8 },
    navigation: { nat_anchor: 0.45, anchor_href: 0.35, role_link: 0.8 },
    text: { nat_text: 0.8, role_text: 0.8, nat_span: 0.2, span_leaf: 0.2, span_direct_text: 0.35 },
    structure: { nat_container: 0.8, nat_list: 0.85, nat_listitem: 0.85, role_container: 0.75, role_list: 0.8, role_listitem: 0.8, nat_div: 0.25, div_multi_child: 0.45, div_in_list: 0.5 },
  },
  leafWeights: {
    button: { nat_control_button: 0.85, input_type_button: 0.85, role_button: 0.8 },
    input: { nat_control_text: 0.85, input_type_text: 0.85, role_input: 0.8, attr_editable: 0.75 },
    select: { nat_control_select: 0.85, input_type_select: 0.85, role_select: 0.8 },
    image: { nat_image: 0.85, role_image: 0.8 }, video: { nat_video: 0.9 }, audio: { nat_audio: 0.9 },
    link: { nat_anchor: 0.45, anchor_href: 0.35, role_link: 0.8 },
    text: { nat_text: 0.8, role_text: 0.8, nat_span: 0.2, span_leaf: 0.2, span_direct_text: 0.35 },
    container: { nat_container: 0.8, role_container: 0.75, nat_div: 0.25, div_multi_child: 0.45, div_repeated_children: -0.2, div_in_list: -0.45 },
    list: { nat_list: 0.85, role_list: 0.8, div_repeated_children: 0.45 },
    listitem: { nat_listitem: 0.85, role_listitem: 0.8, nat_div: 0.25, div_in_list: 0.5 },
  },
};
for (const group of [DEFAULT_BASIC_KIND_PROFILE.familyWeights, DEFAULT_BASIC_KIND_PROFILE.leafWeights]) {
  for (const weights of Object.values(group)) {
    // No measured evidence yet for a discriminative weight on these states.
    Object.assign(weights, { role_presentational: 0, input_type_hidden: 0, state_disabled: 0, state_hidden: 0 });
    Object.freeze(weights);
  }
  Object.freeze(group);
}
Object.freeze(DEFAULT_BASIC_KIND_PROFILE);

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`BASIC_KIND_FORBIDDEN_FEATURE: unsupported ${label} field ${key}`);
}
function optionalText(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return expectNonEmptyString(value, label).trim().toLowerCase();
}
function optionalBoolean(value: unknown, label: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean or null`);
  return value;
}
const measurementNames = ["inputType", "hrefPresent", "contentEditable", "directTextPresent", "childElementCount", "positiveAreaChildCount", "repeatedChildGeometry", "inVerifiedListParent"] as const;
function measurements(value: Record<string, unknown>): BasicKindMeasurements {
  const inputType = value.inputType === "" ? "" : optionalText(value.inputType, "inputType");
  const bool = (key: string) => optionalBoolean(value[key], key);
  const count = (key: string): number | null => {
    if (value[key] === undefined || value[key] === null) return null;
    const n = expectFiniteNumber(value[key], key);
    if (!Number.isInteger(n) || n < 0) throw new TypeError(`${key} must be a nonnegative integer`);
    return n;
  };
  const childElementCount = count("childElementCount"), positiveAreaChildCount = count("positiveAreaChildCount");
  if (childElementCount !== null && positiveAreaChildCount !== null && positiveAreaChildCount > childElementCount) throw new TypeError("positiveAreaChildCount exceeds childElementCount");
  return { inputType, hrefPresent: bool("hrefPresent"), contentEditable: bool("contentEditable"), directTextPresent: bool("directTextPresent"), childElementCount, positiveAreaChildCount, repeatedChildGeometry: bool("repeatedChildGeometry"), inVerifiedListParent: bool("inVerifiedListParent") };
}
export function validateBasicKindProperties(value: unknown): BasicKindProperties {
  const input = expectRecord(value, "basic-kind properties");
  onlyKeys(input, ["tag", "role", "disabled", "hidden", ...measurementNames], "properties");
  return { ...measurements(input), tag: optionalText(input.tag, "tag"), role: optionalText(input.role, "role"), disabled: optionalBoolean(input.disabled, "disabled"), hidden: optionalBoolean(input.hidden, "hidden") };
}
export function validateBasicKindConfig(value: unknown): BasicKindConfig {
  const input = expectRecord(value, "basic-kind config");
  onlyKeys(input, ["taskId", "minScore", "minMargin"], "config");
  const minScore = expectFiniteNumber(input.minScore, "minScore"), minMargin = expectFiniteNumber(input.minMargin, "minMargin");
  if (minScore <= 0 || minScore > 1 || minMargin < 0 || minMargin > 1) throw new TypeError("minScore must be in (0,1] and minMargin in [0,1]");
  return { taskId: expectNonEmptyString(input.taskId, "taskId"), minScore, minMargin };
}
export function validateBasicKindProfile(value: unknown): BasicKindProfile {
  const input = expectRecord(value, "basic-kind profile");
  onlyKeys(input, ["id", "familyWeights", "leafWeights"], "profile");
  const wireNames = [...Object.keys(tagSets), ...Object.keys(roleSets), ...Object.keys(typeSets), ...localWireNames];
  function rows<T extends string>(raw: unknown, names: readonly T[], label: string): Record<T, BasicKindWeights> {
    const group = expectRecord(raw, label);
    onlyKeys(group, names, label);
    return Object.fromEntries(names.map(name => {
      const row = expectRecord(group[name], `${label}.${name}`);
      onlyKeys(row, wireNames, `${label}.${name}`);
      const coefficients = Object.fromEntries(Object.entries(row).map(([wire, rawWeight]) => {
        const weight = expectFiniteNumber(rawWeight, `weight ${wire}`);
        if (weight < -1 || weight > 1) throw new TypeError(`weight ${wire} must be in [-1,1]`);
        return [wire, weight];
      }));
      return [name, coefficients];
    })) as Record<T, BasicKindWeights>;
  }
  return { id: expectNonEmptyString(input.id, "profile.id"), familyWeights: rows(input.familyWeights, Object.keys(BASIC_KIND_FAMILIES) as BasicKindFamily[], "familyWeights"), leafWeights: rows(input.leafWeights, Object.values(BASIC_KIND_FAMILIES).flat(), "leafWeights") };
}

export function extractBasicKindWires(input: BasicKindProperties): Readonly<Record<BasicKindWireName, BasicKindWireValue>> {
  const wires = {} as Record<BasicKindWireName, BasicKindWireValue>;
  for (const [wire, tags] of Object.entries(tagSets)) wires[wire as keyof typeof tagSets] = input.tag === null ? null : tags.some(tag => tag === input.tag) ? 1 : 0;
  // No usable explicit role is not a prediction of an unobserved role.
  for (const [wire, roles] of Object.entries(roleSets)) wires[wire as keyof typeof roleSets] = roles.some(role => role === input.role) ? 1 : 0;
  for (const [wire, types] of Object.entries(typeSets)) wires[wire as keyof typeof typeSets] = input.tag !== "input" ? 0 : !input.inputType ? null : types.some(type => type === input.inputType) ? 1 : 0;
  const bool = (value: boolean | null | undefined): BasicKindWireValue => value === undefined || value === null ? null : value ? 1 : 0;
  const div = input.tag === "div" && input.role === null;
  wires.attr_editable = input.contentEditable === true ? 1 : input.contentEditable === false ? 0 : (input.tag === "div" || input.tag === "span") && input.role === null ? null : 0;
  wires.anchor_href = input.tag === "a" ? bool(input.hrefPresent) : 0;
  const neutralSpan = input.tag === "span" && input.role === null;
  wires.span_leaf = !neutralSpan ? 0 : input.childElementCount == null ? null : input.childElementCount === 0 ? 1 : 0;
  wires.span_direct_text = neutralSpan ? bool(input.directTextPresent) : 0;
  wires.div_multi_child = !div ? 0 : input.positiveAreaChildCount == null ? null : input.positiveAreaChildCount >= 2 ? 1 : 0;
  wires.div_repeated_children = div ? bool(input.repeatedChildGeometry) : 0;
  wires.div_in_list = div ? bool(input.inVerifiedListParent) : 0;
  wires.state_disabled = bool(input.disabled);
  wires.state_hidden = bool(input.hidden);
  return wires;
}

export interface BasicKindTerm { readonly stage: "family" | "leaf"; readonly target: string; readonly wire: BasicKindWireName; readonly value: BasicKindWireValue; readonly weight: number; readonly contribution: ScoreInterval }
export interface BasicKindStageDecision { readonly stage: "family" | "leaf"; readonly status: "judged" | "unknown" | "conflict"; readonly selected: string | null; readonly score: number; readonly margin: number; readonly reasons: readonly string[] }
export interface BasicKindJudgment {
  readonly familyStatus: BasicKindStatus; readonly family: BasicKindFamily | null;
  readonly familyScores: Readonly<Record<string, ScoreInterval>> | null;
  readonly judgmentStatus: BasicKindStatus; readonly basicKind: BasicKindLabel | null;
  readonly leafScores: Readonly<Record<string, ScoreInterval>> | null;
  readonly score: number | null; readonly margin: number | null;
  readonly confidenceState: "uncalibrated" | "not_applicable"; readonly calibratedConfidence: null;
  readonly reasons: readonly string[];
  readonly evidence: { readonly stateFlags: { readonly disabled: boolean | null; readonly hidden: boolean | null }; readonly wires: Readonly<Partial<Record<BasicKindWireName, BasicKindWireValue>>>; readonly activeTerms: readonly BasicKindTerm[]; readonly path: readonly BasicKindStageDecision[] };
}
const clamp = (n: number) => Math.max(0, Math.min(1, n));
export function computeBasicKindStageRawIntervals(
  _stage: "family" | "leaf",
  names: readonly string[],
  rows: Readonly<Record<string, BasicKindWeights>>,
  wires: Readonly<Record<BasicKindWireName, BasicKindWireValue>>,
): Readonly<Record<string, ScoreInterval>> {
  const scores: Record<string, ScoreInterval> = {};
  for (const target of names) {
    let min = 0, max = 0;
    for (const [name, weight] of Object.entries(rows[target]!)) {
      const wire = name as BasicKindWireName, value = wires[wire];
      const contribution = value === null ? { min: Math.min(weight, 0), max: Math.max(weight, 0) } : { min: weight * value, max: weight * value };
      min += contribution.min; max += contribution.max;
    }
    scores[target] = { min, max };
  }
  return scores;
}
function scoreStage(stage: "family" | "leaf", names: readonly string[], rows: Readonly<Record<string, BasicKindWeights>>, wires: Readonly<Record<BasicKindWireName, BasicKindWireValue>>, config: BasicKindConfig, terms: BasicKindTerm[]) {
  const raw = computeBasicKindStageRawIntervals(stage, names, rows, wires);
  const scores: Record<string, ScoreInterval> = {};
  for (const target of names) {
    for (const [name, weight] of Object.entries(rows[target]!)) {
      const wire = name as BasicKindWireName, value = wires[wire];
      const contribution = value === null
        ? { min: Math.min(weight, 0), max: Math.max(weight, 0) }
        : { min: weight * value, max: weight * value };
      if (value !== 0 && weight !== 0) terms.push({ stage, target, wire, value, weight, contribution });
    }
    scores[target] = { min: clamp(raw[target]!.min), max: clamp(raw[target]!.max) };
  }
  const ordered = [...names].sort((a, b) => scores[b]!.min - scores[a]!.min || scores[b]!.max - scores[a]!.max);
  const best = ordered[0]!, first = scores[best]!, second = ordered[1] === undefined ? 0 : scores[ordered[1]!]!.min;
  const rivalUpper = Math.max(0, ...ordered.slice(1).map(name => scores[name]!.max));
  const margin = first.min - rivalUpper;
  let status: BasicKindStageDecision["status"], reasons: string[];
  if (first.min < config.minScore) {
    status = "unknown"; reasons = [first.max >= config.minScore ? "unresolved_missing_feature" : "below_min_score"];
  } else if (second >= config.minScore && (first.min === second || first.min - second < config.minMargin)) {
    status = "conflict"; reasons = ["competing_basic_kinds"];
  } else if (margin <= 0 || margin < config.minMargin) {
    status = "unknown"; reasons = ["unresolved_missing_feature"];
  } else { status = "judged"; reasons = []; }
  const decision: BasicKindStageDecision = { stage, status, selected: status === "judged" ? best : null, score: first.min, margin, reasons };
  return { scores, decision };
}
function emptyJudgment(status: "unknown" | "excluded", reasons: readonly string[], input?: BasicKindProperties): BasicKindJudgment {
  return { familyStatus: status, family: null, familyScores: null, judgmentStatus: status, basicKind: null, leafScores: null, score: null, margin: null, confidenceState: "not_applicable", calibratedConfidence: null, reasons, evidence: { stateFlags: { disabled: input?.disabled ?? null, hidden: input?.hidden ?? null }, wires: {}, activeTerms: [], path: [] } };
}
function classify(input: BasicKindProperties, config: BasicKindConfig, profile: BasicKindProfile): BasicKindJudgment {
  const wires = extractBasicKindWires(input), activeTerms: BasicKindTerm[] = [];
  const families = scoreStage("family", Object.keys(BASIC_KIND_FAMILIES), profile.familyWeights, wires, config, activeTerms);
  const family = families.decision.selected as BasicKindFamily | null;
  // The leaf stage is only evaluated after family selection.
  const leaves = family === null ? null : scoreStage("leaf", BASIC_KIND_FAMILIES[family], profile.leafWeights, wires, config, activeTerms);
  const last = leaves?.decision ?? families.decision;
  const reasons = [...last.reasons];
  if (last.status === "conflict" && input.role !== null) reasons.push("tag_role_conflict");
  if (last.status === "unknown") {
    if (input.tag === "input" && !input.inputType) reasons.push("missing_input_type");
    if (input.tag === "input" && input.inputType === "hidden") reasons.push("hidden_input_type");
    if (input.tag === "a") reasons.push(input.hrefPresent == null ? "missing_link_evidence" : input.hrefPresent === false ? "empty_anchor_or_missing_href" : "insufficient_link_evidence");
    if (input.tag === "span" && input.directTextPresent == null) reasons.push("insufficient_text_evidence");
    if (input.tag === "div" && input.positiveAreaChildCount == null) reasons.push("incomplete_child_geometry");
  }
  if (last.status === "judged") reasons.push("basic_kind_judged");
  else reasons.push("fallback_other");
  return { familyStatus: families.decision.status, family, familyScores: families.scores, judgmentStatus: last.status, basicKind: (leaves?.decision.selected as SpecificBasicKindLabel | null) ?? "other", leafScores: leaves?.scores ?? null, score: last.status === "judged" ? Math.min(families.decision.score, last.score) : null, margin: last.status === "judged" ? Math.min(families.decision.margin, last.margin) : null, confidenceState: "uncalibrated", calibratedConfidence: null, reasons, evidence: { stateFlags: { disabled: input.disabled ?? null, hidden: input.hidden ?? null }, wires, activeTerms, path: [families.decision, ...(leaves === null ? [] : [leaves.decision])] } };
}
export function classifyBasicKind(value: unknown, config: BasicKindConfig = DEFAULT_BASIC_KIND_CONFIG, profile: BasicKindProfile = DEFAULT_BASIC_KIND_PROFILE): BasicKindJudgment {
  return classify(validateBasicKindProperties(value), validateBasicKindConfig(config), validateBasicKindProfile(profile));
}

export function validateBasicKindRequest(value: unknown) {
  const raw = expectRecord(value, "basic-kind request"), candidateBatch = validateCandidateBatch(raw);
  const observations = new Map<string, BasicKindMeasurements>();
  const refs = new Set(candidateBatch.observation.nodes.map(node => node.nodeRef));
  for (const item of raw.itemObservations === undefined ? [] : expectArray(raw.itemObservations, "itemObservations")) {
    const row = expectRecord(item, "itemObservation");
    onlyKeys(row, ["nodeRef", ...measurementNames], "itemObservation");
    const ref = expectNonEmptyString(row.nodeRef, "itemObservation.nodeRef");
    if (!refs.has(ref) || observations.has(ref)) throw new TypeError("itemObservation requires unique known nodeRef");
    observations.set(ref, measurements(row));
  }
  return { candidateBatch, observations };
}
export interface BasicKindSlot extends BasicKindJudgment { readonly index: number; readonly nodeRef: string; readonly candidateStatus: CandidateSlot["status"]; readonly candidateReasons: readonly string[] }
export interface BasicKindBatch { readonly taskId: string; readonly profileId: string; readonly slots: readonly BasicKindSlot[] }
function stateFlag(value: unknown): boolean | null {
  if (value === true || value === "true" || value === "") return true;
  if (value === false || value === "false") return false;
  return null;
}
function htmlBoolean(value: unknown): boolean | null {
  // A present HTML boolean attribute is true even for disabled="false".
  if (typeof value === "string") return true;
  return typeof value === "boolean" ? value : null;
}
function combineState(left: boolean | null, right: boolean | null): boolean | null {
  return left === true || right === true ? true : left === false || right === false ? false : null;
}
export function classifyBasicKindBatch(value: unknown, config: BasicKindConfig = DEFAULT_BASIC_KIND_CONFIG, profile: BasicKindProfile = DEFAULT_BASIC_KIND_PROFILE): BasicKindBatch {
  const { candidateBatch, observations } = validateBasicKindRequest(value), spec = validateBasicKindConfig(config), weights = validateBasicKindProfile(profile);
  const nodes = new Map(candidateBatch.observation.nodes.map(node => [node.nodeRef, node]));
  const slots = candidateBatch.slots.map(slot => {
    const node = nodes.get(slot.nodeRef);
    let judgment: BasicKindJudgment;
    if (slot.status !== "ok") judgment = emptyJudgment(slot.status === "unknown" ? "unknown" : "excluded", [slot.status === "unknown" ? "candidate_unknown" : "candidate_excluded"]);
    else if (!node) judgment = emptyJudgment("unknown", ["missing_node_ref"]);
    else {
      const local = observations.get(slot.nodeRef) ?? {};
      judgment = classify(validateBasicKindProperties({ ...local, tag: node.tag, role: node.role, contentEditable: local.contentEditable ?? (node.attributes.contenteditable === "plaintext-only" ? true : stateFlag(node.attributes.contenteditable)), hidden: combineState(htmlBoolean(node.attributes.hidden), stateFlag(node.attributes["aria-hidden"])), disabled: combineState(htmlBoolean(node.attributes.disabled), stateFlag(node.attributes["aria-disabled"])) }), spec, weights);
    }
    return { index: slot.index, nodeRef: slot.nodeRef, candidateStatus: slot.status, candidateReasons: [...slot.reasons], ...judgment };
  });
  return { taskId: spec.taskId, profileId: weights.id, slots };
}
