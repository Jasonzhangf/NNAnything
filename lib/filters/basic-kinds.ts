import { expectArray, expectFiniteNumber, expectNonEmptyString, expectRecord } from "../core/schema.js";
import { validateCandidateBatch, type CandidateSlot } from "./candidate-chain.js";

export const BASIC_KIND_FAMILIES = {
  control: ["button", "input", "select"],
  media: ["image", "video", "audio"],
  navigation: ["link"],
  text: ["text"],
  structure: ["container", "list", "listitem", "ignore"],
} as const;
export type BasicKindFamily = keyof typeof BASIC_KIND_FAMILIES;
for (const leaves of Object.values(BASIC_KIND_FAMILIES)) Object.freeze(leaves);
Object.freeze(BASIC_KIND_FAMILIES);
export type SpecificBasicKindLabel = typeof BASIC_KIND_FAMILIES[BasicKindFamily][number];
export type BasicKindLabel = SpecificBasicKindLabel | "other";
export type BasicKindStatus = "judged" | "unknown" | "conflict" | "excluded";
export type BasicKindWireValue = number | null;
export interface ScoreInterval { readonly min: number; readonly max: number }
export interface BasicKindMeasurements {
  readonly inputType?: string | null;
  readonly hrefPresent?: boolean | null;
  readonly contentEditable?: boolean | null;
  readonly directTextPresent?: boolean | null;
  readonly nonFormatDirectTextPresent?: boolean | null;
  readonly beforeContentPresent?: boolean | null;
  readonly afterContentPresent?: boolean | null;
  readonly backgroundImagePresent?: boolean | null;
  readonly maskImagePresent?: boolean | null;
  readonly childElementCount?: number | null;
  readonly positiveAreaChildCount?: number | null;
  readonly repeatedChildGeometry?: boolean | null;
  readonly inVerifiedListParent?: boolean | null;
  readonly svgGraphicChildren?: boolean | null;
  readonly pointerCursor?: boolean | null;
  readonly parentPointerCursor?: boolean | null;
  readonly tabIndexFocus?: boolean | null;
  readonly borderPresent?: boolean | null;
  readonly aspectRatio?: number | null;
  readonly descendantTextPresent?: boolean | null;
  readonly directListChildPresent?: boolean | null;
  readonly singleChildTag?: string | null;
  readonly singleChildSameRect?: boolean | null;
  readonly withinControlAncestor?: boolean | null;
  readonly inSvgAncestor?: boolean | null;
}
export interface BasicKindProperties extends BasicKindMeasurements {
  readonly tag: string | null;
  readonly role: string | null;
  readonly disabled?: boolean | null;
  readonly hidden?: boolean | null;
}
export interface BasicKindConfig { readonly taskId: string; readonly minScore: number; readonly minMargin: number }
export const DEFAULT_BASIC_KIND_CONFIG: BasicKindConfig = Object.freeze({ taskId: "dom.basic-kinds.v1", minScore: 0.6, minMargin: 0.15 });

export interface AppearanceMeasurementInput {
  readonly directText?: string | null;
  readonly beforeContent?: string | null;
  readonly afterContent?: string | null;
  readonly backgroundImage?: string | null;
  readonly maskImage?: string | null;
  readonly webkitMaskImage?: string | null;
}

export interface AppearanceMeasurements {
  readonly directTextPresent: boolean | null;
  readonly nonFormatDirectTextPresent: boolean | null;
  readonly beforeContentPresent: boolean | null;
  readonly afterContentPresent: boolean | null;
  readonly backgroundImagePresent: boolean | null;
  readonly maskImagePresent: boolean | null;
}

export function hasNonFormatDirectText(rawDirectText: string | null | undefined): boolean | null {
  // Presence test only: the original string, including joiners, stays untouched.
  return rawDirectText == null ? null : /[^\p{Cf}\s]/u.test(rawDirectText);
}

function cssImagePresent(value: string | null | undefined): boolean | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "none" || trimmed === "normal") return false;
  return trimmed.split(",").some(layer => {
    const current = layer.trim();
    return current !== "" && current !== "none" && current !== "normal";
  });
}

function pseudoContentPresent(value: string | null | undefined): boolean | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "none" || trimmed === "normal" || trimmed === '""' || trimmed === "''") return false;
  return true;
}

export function shapeAppearanceMeasurements(raw: AppearanceMeasurementInput): AppearanceMeasurements {
  return {
    directTextPresent: raw.directText == null ? null : Boolean(raw.directText.trim()),
    nonFormatDirectTextPresent: hasNonFormatDirectText(raw.directText),
    beforeContentPresent: pseudoContentPresent(raw.beforeContent),
    afterContentPresent: pseudoContentPresent(raw.afterContent),
    backgroundImagePresent: cssImagePresent(raw.backgroundImage),
    maskImagePresent: cssImagePresent(raw.maskImage ?? raw.webkitMaskImage),
  };
}

const tagSets = {
  nat_control_button: ["button", "summary"], nat_control_text: ["textarea"], nat_control_select: ["select", "option", "optgroup"], nat_input_tag: ["input"],
  nat_image: ["img", "picture", "canvas"], nat_video: ["video"], nat_audio: ["audio"], nat_anchor: ["a"],
  nat_text: ["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "code", "pre", "time", "label", "em", "strong", "small"], nat_span: ["span"],
  nat_container: ["article", "section", "nav", "aside", "header", "footer", "main", "form", "fieldset", "dialog", "details"],
  nat_list: ["ul", "ol", "dl"], nat_listitem: ["li", "dt", "dd"], nat_div: ["div"],
  nat_svg: ["svg"],
  nat_svg_child: ["path", "use", "g", "circle", "rect", "line", "polyline", "polygon", "ellipse", "defs", "symbol", "clippath", "mask", "pattern", "lineargradient", "radialgradient", "stop", "filter"],
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
const localWireNames = ["attr_editable", "anchor_href", "span_leaf", "span_direct_text", "div_multi_child", "div_repeated_children", "div_repeated_child_extent", "div_in_list", "svg_graphic_children", "div_single_child", "div_leaf", "div_direct_text", "direct_non_format_text", "css_before_content", "css_after_content", "css_background_image", "css_mask_image", "state_disabled", "state_hidden",
  "editable_non_input", "input_text_combobox", "listitem_role_select", "nat_inline_format_text", "neutral_multi_child", "neutral_single_child", "neutral_focusable_control", "neutral_list_choice", "neutral_same_rect_wrapper", "composite_descendant_text", "neutral_presentation_leaf", "own_pointer_boundary", "single_child_div", "svg_internal_part", "empty_pointer_extent", "empty_border_extent", "nat_document_root"] as const;
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

const NEW_BASIC_KIND_WIRE_TARGETS = [
  ["familyWeights", "media", "nat_svg"],
  ["familyWeights", "media", "svg_graphic_children"],
  ["leafWeights", "image", "nat_svg"],
  ["leafWeights", "image", "svg_graphic_children"],
  ["familyWeights", "structure", "div_single_child"],
  ["leafWeights", "container", "div_single_child"],
  ["familyWeights", "text", "div_leaf"],
  ["leafWeights", "text", "div_leaf"],
  ["familyWeights", "text", "div_direct_text"],
  ["leafWeights", "text", "div_direct_text"],
  ["familyWeights", "text", "direct_non_format_text"],
  ["leafWeights", "text", "direct_non_format_text"],
  ["familyWeights", "text", "css_before_content"],
  ["leafWeights", "text", "css_before_content"],
  ["familyWeights", "text", "css_after_content"],
  ["leafWeights", "text", "css_after_content"],
  ["familyWeights", "text", "nat_svg_child"],
  ["leafWeights", "text", "nat_svg_child"],
  ["familyWeights", "media", "direct_non_format_text"],
  ["leafWeights", "image", "direct_non_format_text"],
  ["familyWeights", "media", "css_before_content"],
  ["leafWeights", "image", "css_before_content"],
  ["familyWeights", "media", "css_after_content"],
  ["leafWeights", "image", "css_after_content"],
  ["familyWeights", "media", "css_background_image"],
  ["leafWeights", "image", "css_background_image"],
  ["familyWeights", "media", "css_mask_image"],
  ["leafWeights", "image", "css_mask_image"],
  ["familyWeights", "media", "nat_svg_child"],
  ["leafWeights", "image", "nat_svg_child"],
  ["familyWeights", "control", "direct_non_format_text"],
  ["leafWeights", "button", "direct_non_format_text"],
  ["familyWeights", "control", "css_before_content"],
  ["leafWeights", "button", "css_before_content"],
  ["familyWeights", "control", "css_after_content"],
  ["leafWeights", "button", "css_after_content"],
  ["familyWeights", "control", "css_background_image"],
  ["leafWeights", "button", "css_background_image"],
  ["familyWeights", "control", "css_mask_image"],
  ["leafWeights", "button", "css_mask_image"],
  ["familyWeights", "navigation", "direct_non_format_text"],
  ["leafWeights", "link", "direct_non_format_text"],
  ["familyWeights", "navigation", "css_before_content"],
  ["leafWeights", "link", "css_before_content"],
  ["familyWeights", "navigation", "css_background_image"],
  ["leafWeights", "link", "css_background_image"],
  ["familyWeights", "structure", "direct_non_format_text"],
  ["leafWeights", "container", "direct_non_format_text"],
  ["familyWeights", "structure", "css_background_image"],
  ["leafWeights", "container", "css_background_image"],
  ["familyWeights", "structure", "nat_svg_child"],
  ["leafWeights", "container", "nat_svg_child"],
  ["familyWeights", "control", "editable_non_input"],
  ["familyWeights", "text", "editable_non_input"],
  ["leafWeights", "input", "editable_non_input"],
  ["familyWeights", "control", "input_text_combobox"],
  ["leafWeights", "input", "input_text_combobox"],
  ["leafWeights", "select", "input_text_combobox"],
  ["familyWeights", "control", "listitem_role_select"],
  ["familyWeights", "structure", "listitem_role_select"],
  ["leafWeights", "select", "listitem_role_select"],
  ["leafWeights", "listitem", "listitem_role_select"],
  ["familyWeights", "text", "nat_inline_format_text"],
  ["leafWeights", "text", "nat_inline_format_text"],
  ["familyWeights", "text", "composite_descendant_text"],
  ["leafWeights", "text", "composite_descendant_text"],
  ["familyWeights", "structure", "composite_descendant_text"],
  ["leafWeights", "container", "composite_descendant_text"],
  ["familyWeights", "structure", "neutral_multi_child"],
  ["leafWeights", "container", "neutral_multi_child"],
  ["leafWeights", "ignore", "neutral_multi_child"],
  ["familyWeights", "structure", "neutral_single_child"],
  ["leafWeights", "container", "neutral_single_child"],
  ["leafWeights", "ignore", "neutral_single_child"],
  ["familyWeights", "control", "neutral_focusable_control"],
  ["familyWeights", "structure", "neutral_focusable_control"],
  ["leafWeights", "input", "neutral_focusable_control"],
  ["leafWeights", "button", "neutral_focusable_control"],
  ["leafWeights", "select", "neutral_focusable_control"],
  ["leafWeights", "container", "neutral_focusable_control"],
  ["leafWeights", "ignore", "neutral_focusable_control"],
  ["familyWeights", "control", "neutral_list_choice"],
  ["familyWeights", "structure", "neutral_list_choice"],
  ["leafWeights", "select", "neutral_list_choice"],
  ["leafWeights", "button", "neutral_list_choice"],
  ["leafWeights", "input", "neutral_list_choice"],
  ["leafWeights", "container", "neutral_list_choice"],
  ["leafWeights", "ignore", "neutral_list_choice"],
  ["familyWeights", "structure", "neutral_same_rect_wrapper"],
  ["leafWeights", "ignore", "neutral_same_rect_wrapper"],
  ["leafWeights", "container", "neutral_same_rect_wrapper"],
  ["familyWeights", "structure", "single_child_div"],
  ["leafWeights", "container", "single_child_div"],
  ["leafWeights", "ignore", "single_child_div"],
  ["familyWeights", "control", "own_pointer_boundary"],
  ["leafWeights", "button", "own_pointer_boundary"],
  ["leafWeights", "input", "own_pointer_boundary"],
  ["leafWeights", "select", "own_pointer_boundary"],
  ["familyWeights", "structure", "own_pointer_boundary"],
  ["leafWeights", "ignore", "own_pointer_boundary"],
  ["familyWeights", "structure", "neutral_presentation_leaf"],
  ["familyWeights", "text", "neutral_presentation_leaf"],
  ["familyWeights", "control", "neutral_presentation_leaf"],
  ["leafWeights", "ignore", "neutral_presentation_leaf"],
  ["leafWeights", "container", "neutral_presentation_leaf"],
  ["leafWeights", "text", "neutral_presentation_leaf"],
  ["leafWeights", "button", "neutral_presentation_leaf"],
  ["familyWeights", "structure", "svg_internal_part"],
  ["leafWeights", "ignore", "svg_internal_part"],
  ["familyWeights", "media", "svg_internal_part"],
  ["leafWeights", "image", "svg_internal_part"],
  ["familyWeights", "structure", "empty_pointer_extent"],
  ["leafWeights", "container", "empty_pointer_extent"],
  ["leafWeights", "ignore", "empty_pointer_extent"],
  ["familyWeights", "control", "empty_pointer_extent"],
  ["leafWeights", "button", "empty_pointer_extent"],
  ["familyWeights", "structure", "empty_border_extent"],
  ["leafWeights", "container", "empty_border_extent"],
  ["leafWeights", "ignore", "empty_border_extent"],
  ["familyWeights", "control", "empty_border_extent"],
  ["leafWeights", "button", "empty_border_extent"],
  ["familyWeights", "structure", "nat_document_root"],
  ["leafWeights", "ignore", "nat_document_root"],
  ["leafWeights", "list", "div_repeated_child_extent"],
  ["leafWeights", "container", "div_repeated_child_extent"],
] as const;

function freezeProfile(profile: BasicKindProfile): BasicKindProfile {
  const freezeRows = <T extends string>(rows: Readonly<Record<T, BasicKindWeights>>): Readonly<Record<T, BasicKindWeights>> => {
    const frozen = {} as Record<T, BasicKindWeights>;
    for (const name of Object.keys(rows) as T[]) {
      // Copy inherited rows before adding defaults so the source profile stays untouched.
      frozen[name] = Object.freeze({ ...rows[name], role_presentational: 0, input_type_hidden: 0, state_disabled: 0, state_hidden: 0 });
    }
    return Object.freeze(frozen);
  };
  return Object.freeze({ id: profile.id, familyWeights: freezeRows(profile.familyWeights), leafWeights: freezeRows(profile.leafWeights) });
}

export const LEGACY_BASIC_KIND_PROFILE: BasicKindProfile = freezeProfile({
  id: "dom-basic-kinds-handwritten-v1",
  familyWeights: {
    control: { nat_control_button: 0.85, nat_control_text: 0.85, nat_control_select: 0.85, nat_input_tag: 0.85, role_button: 0.8, role_input: 0.8, role_select: 0.8, attr_editable: 0.75,
      direct_non_format_text: 0, css_before_content: 0, css_after_content: 0, css_background_image: 0, css_mask_image: 0 },
    media: { nat_image: 0.85, nat_video: 0.9, nat_audio: 0.9, role_image: 0.8, nat_svg: 0, svg_graphic_children: 0,
      direct_non_format_text: 0, css_before_content: 0, css_after_content: 0, css_background_image: 0, css_mask_image: 0, nat_svg_child: 0 },
    navigation: { nat_anchor: 0.45, anchor_href: 0.35, role_link: 0.8, direct_non_format_text: 0, css_before_content: 0, css_background_image: 0 },
    text: { nat_text: 0.8, role_text: 0.8, nat_span: 0.2, span_leaf: 0.2, span_direct_text: 0.35, div_leaf: 0, div_direct_text: 0,
      direct_non_format_text: 0, css_before_content: 0, css_after_content: 0, nat_svg_child: 0 },
    structure: { nat_container: 0.8, nat_list: 0.85, nat_listitem: 0.85, role_container: 0.75, role_list: 0.8, role_listitem: 0.8, nat_div: 0.25, div_multi_child: 0.45, div_in_list: 0.5, div_single_child: 0,
      direct_non_format_text: 0, css_background_image: 0, nat_svg_child: 0 },
  },
  leafWeights: {
    button: { nat_control_button: 0.85, input_type_button: 0.85, role_button: 0.8, direct_non_format_text: 0, css_before_content: 0, css_after_content: 0, css_background_image: 0, css_mask_image: 0 },
    input: { nat_control_text: 0.85, input_type_text: 0.85, role_input: 0.8, attr_editable: 0.75 },
    select: { nat_control_select: 0.85, input_type_select: 0.85, role_select: 0.8 },
    image: { nat_image: 0.85, role_image: 0.8, nat_svg: 0, svg_graphic_children: 0, direct_non_format_text: 0, css_before_content: 0, css_after_content: 0, css_background_image: 0, css_mask_image: 0, nat_svg_child: 0 }, video: { nat_video: 0.9 }, audio: { nat_audio: 0.9 },
    link: { nat_anchor: 0.45, anchor_href: 0.35, role_link: 0.8, direct_non_format_text: 0, css_before_content: 0, css_background_image: 0 },
    text: { nat_text: 0.8, role_text: 0.8, nat_span: 0.2, span_leaf: 0.2, span_direct_text: 0.35, div_leaf: 0, div_direct_text: 0, direct_non_format_text: 0, css_before_content: 0, css_after_content: 0, nat_svg_child: 0 },
    container: { nat_container: 0.8, role_container: 0.75, nat_div: 0.25, div_multi_child: 0.45, div_repeated_children: -0.2, div_in_list: -0.45, div_single_child: 0, direct_non_format_text: 0, css_background_image: 0, nat_svg_child: 0 },
    list: { nat_list: 0.85, role_list: 0.8, div_repeated_children: 0.45 },
    listitem: { nat_listitem: 0.85, role_listitem: 0.8, nat_div: 0.25, div_in_list: 0.5 },
    ignore: {},
  },
});

export const DEFAULT_BASIC_KIND_PROFILE: BasicKindProfile = freezeProfile({
  id: "dom-basic-kinds-handwritten-v2",
  familyWeights: {
    ...LEGACY_BASIC_KIND_PROFILE.familyWeights,
    media: { ...LEGACY_BASIC_KIND_PROFILE.familyWeights.media, nat_svg: 0.45, svg_graphic_children: 0.35 },
    text: { ...LEGACY_BASIC_KIND_PROFILE.familyWeights.text, div_leaf: 0.3, div_direct_text: 0.45 },
    structure: { ...LEGACY_BASIC_KIND_PROFILE.familyWeights.structure, div_single_child: 0.45 },
  },
  leafWeights: {
    ...LEGACY_BASIC_KIND_PROFILE.leafWeights,
    image: { ...LEGACY_BASIC_KIND_PROFILE.leafWeights.image, nat_svg: 0.45, svg_graphic_children: 0.35 },
    text: { ...LEGACY_BASIC_KIND_PROFILE.leafWeights.text, div_leaf: 0.3, div_direct_text: 0.45 },
    container: { ...LEGACY_BASIC_KIND_PROFILE.leafWeights.container, div_single_child: 0.45 },
  },
});

export function migrateBasicKindProfile(raw: unknown): BasicKindProfile {
  const input = expectRecord(raw, "basic-kind profile");
  const rawLeaves = expectRecord(input.leafWeights, "profile.leafWeights");
  const validated = validateBasicKindProfile({ ...input, leafWeights: { ...rawLeaves, ignore: rawLeaves.ignore ?? {} } });
  type MutableWeights = Partial<Record<BasicKindWireName, number>>;
  const cloneRows = <T extends string>(rows: Readonly<Record<T, BasicKindWeights>>): Record<T, MutableWeights> =>
    Object.fromEntries(Object.entries(rows).map(([name, weights]) => [name, Object.assign({}, weights)])) as Record<T, MutableWeights>;
  const familyWeights = cloneRows(validated.familyWeights);
  const leafWeights = cloneRows(validated.leafWeights);
  const profile = {
    id: validated.id,
    familyWeights,
    leafWeights,
  };
  for (const [group, target, wire] of NEW_BASIC_KIND_WIRE_TARGETS) {
    const rows = group === "familyWeights" ? familyWeights as Record<string, MutableWeights> : leafWeights as Record<string, MutableWeights>;
    const row = rows[target]!;
    if (row[wire] === undefined) row[wire] = 0;
  }
  return freezeProfile(profile);
}

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
const measurementNames = [
  "inputType", "hrefPresent", "contentEditable", "directTextPresent", "nonFormatDirectTextPresent",
  "beforeContentPresent", "afterContentPresent", "backgroundImagePresent", "maskImagePresent",
  "childElementCount", "positiveAreaChildCount", "repeatedChildGeometry", "inVerifiedListParent",
  "svgGraphicChildren", "pointerCursor", "parentPointerCursor", "tabIndexFocus", "borderPresent",
  "aspectRatio", "descendantTextPresent", "directListChildPresent", "singleChildTag", "singleChildSameRect", "withinControlAncestor", "inSvgAncestor",
] as const;
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
  const aspectRatio = value.aspectRatio == null ? null : expectFiniteNumber(value.aspectRatio, "aspectRatio");
  if (aspectRatio !== null && (aspectRatio < 0 || aspectRatio > 1)) throw new TypeError("aspectRatio must be in [0,1]");
  return {
    inputType, hrefPresent: bool("hrefPresent"), contentEditable: bool("contentEditable"),
    directTextPresent: bool("directTextPresent"), nonFormatDirectTextPresent: bool("nonFormatDirectTextPresent"),
    beforeContentPresent: bool("beforeContentPresent"), afterContentPresent: bool("afterContentPresent"),
    backgroundImagePresent: bool("backgroundImagePresent"), maskImagePresent: bool("maskImagePresent"),
    childElementCount, positiveAreaChildCount, repeatedChildGeometry: bool("repeatedChildGeometry"),
    inVerifiedListParent: bool("inVerifiedListParent"), svgGraphicChildren: bool("svgGraphicChildren"),
    pointerCursor: bool("pointerCursor"), parentPointerCursor: bool("parentPointerCursor"),
    tabIndexFocus: bool("tabIndexFocus"), borderPresent: bool("borderPresent"), aspectRatio,
    descendantTextPresent: bool("descendantTextPresent"), directListChildPresent: bool("directListChildPresent"),
    singleChildTag: optionalText(value.singleChildTag, "singleChildTag"),
    singleChildSameRect: bool("singleChildSameRect"),
    withinControlAncestor: bool("withinControlAncestor"), inSvgAncestor: bool("inSvgAncestor"),
  };
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
  wires.direct_non_format_text = bool(input.nonFormatDirectTextPresent);
  wires.css_before_content = bool(input.beforeContentPresent);
  wires.css_after_content = bool(input.afterContentPresent);
  wires.css_background_image = bool(input.backgroundImagePresent);
  wires.css_mask_image = bool(input.maskImagePresent);
  wires.div_multi_child = !div ? 0 : input.positiveAreaChildCount == null ? null : input.positiveAreaChildCount >= 2 ? 1 : 0;
  wires.div_repeated_children = div ? bool(input.repeatedChildGeometry) : 0;
  wires.div_in_list = div ? bool(input.inVerifiedListParent) : 0;
  wires.svg_graphic_children = input.tag !== "svg"
    ? 0
    : (input.childElementCount != null && input.childElementCount <= 0) || input.svgGraphicChildren === false
      ? 0
      : input.childElementCount == null || input.svgGraphicChildren == null
        ? null
        : 1;
  wires.div_single_child = !div
    ? 0
    : (input.positiveAreaChildCount != null && input.positiveAreaChildCount !== 1) || input.directTextPresent === true
      ? 0
      : input.positiveAreaChildCount == null || input.directTextPresent == null
        ? null
        : 1;
  wires.div_leaf = !div ? 0 : input.childElementCount == null ? null : input.childElementCount === 0 ? 1 : 0;
  wires.div_direct_text = !div
    ? 0
    : (input.childElementCount != null && input.childElementCount > 0) || input.directTextPresent === false
      ? 0
      : input.childElementCount == null || input.directTextPresent == null
        ? null
        : 1;
  wires.state_disabled = bool(input.disabled);
  wires.state_hidden = bool(input.hidden);
  const and = (...values: BasicKindWireValue[]): BasicKindWireValue =>
    values.includes(0) ? 0 : values.includes(null) ? null : values.includes(1) ? 1 : null;
  const andContinuous = (...values: BasicKindWireValue[]): BasicKindWireValue => {
    if (values.includes(0)) return 0;
    if (values.includes(null)) return null;
    return values.find(value => value !== null && value !== 1) ?? 1;
  };
  const selectRole = roleSets.role_select.some(role => role === input.role);
  const singleChildTag = input.singleChildTag;
  const neutralContainer = and(
    input.role === null ? 1 : 0,
    ["div", "span"].includes(input.tag ?? "") || input.tag?.includes("-") ? 1 : 0,
    input.contentEditable === false ? 1 : input.contentEditable === true ? 0 : null,
  );
  wires.div_repeated_child_extent = andContinuous(
    div ? 1 : 0,
    neutralContainer,
    bool(input.repeatedChildGeometry),
    input.positiveAreaChildCount == null ? null : input.positiveAreaChildCount <= 0 ? 0 : Math.min(input.positiveAreaChildCount, 16) / 16,
  );
  const noOwnText = input.directTextPresent === false;
  const noVisibleChildren = input.childElementCount === 0;
  const noAppearance = and(
    input.beforeContentPresent === false ? 1 : input.beforeContentPresent === true ? 0 : null,
    input.afterContentPresent === false ? 1 : input.afterContentPresent === true ? 0 : null,
    input.backgroundImagePresent === false ? 1 : input.backgroundImagePresent === true ? 0 : null,
    input.maskImagePresent === false ? 1 : input.maskImagePresent === true ? 0 : null,
  );
  const emptyBase = and(
    neutralContainer,
    noOwnText ? 1 : input.directTextPresent === true ? 0 : null,
    noVisibleChildren ? 1 : input.childElementCount != null ? 0 : null,
    noAppearance,
  );

  wires.editable_non_input = and(
    input.contentEditable === true ? 1 : input.contentEditable === false ? 0 : null,
    input.tag !== "input" && input.tag !== "textarea" ? 1 : 0,
  );
  wires.input_text_combobox = and(
    input.tag === "input" ? 1 : 0,
    input.role === "combobox" ? 1 : 0,
    typeSets.input_type_text.some(type => type === input.inputType) ? 1 : input.inputType == null ? null : 0,
  );
  wires.listitem_role_select = and(input.tag === "li" ? 1 : 0, selectRole ? 1 : 0);
  wires.nat_inline_format_text = and(
    ["b", "u", "s", "mark", "sub", "sup", "cite", "q"].some(tag => tag === input.tag) ? 1 : 0,
    bool(input.nonFormatDirectTextPresent),
  );
  wires.neutral_multi_child = and(neutralContainer, input.positiveAreaChildCount == null ? null : input.positiveAreaChildCount >= 2 ? 1 : 0);
  wires.neutral_single_child = and(neutralContainer, input.positiveAreaChildCount == null ? null : input.positiveAreaChildCount === 1 ? 1 : 0);
  wires.neutral_focusable_control = and(neutralContainer, bool(input.tabIndexFocus));
  wires.neutral_list_choice = and(
    neutralContainer,
    bool(input.pointerCursor),
    bool(input.directListChildPresent),
    bool(input.descendantTextPresent),
  );
  wires.neutral_same_rect_wrapper = and(
    neutralContainer,
    input.positiveAreaChildCount == null ? null : input.positiveAreaChildCount === 1 ? 1 : 0,
    input.childElementCount == null ? null : input.childElementCount === 1 ? 1 : 0,
    input.nonFormatDirectTextPresent == null ? null : input.nonFormatDirectTextPresent ? 0 : 1,
    noAppearance,
    bool(input.singleChildSameRect),
  );
  wires.composite_descendant_text = and(
    neutralContainer,
    input.directTextPresent === false ? 1 : input.directTextPresent === true ? 0 : null,
    bool(input.descendantTextPresent),
    input.withinControlAncestor == null ? null : input.withinControlAncestor ? 0 : 1,
  );
  wires.own_pointer_boundary = and(
    neutralContainer,
    bool(input.pointerCursor),
    input.parentPointerCursor == null ? null : input.parentPointerCursor ? 0 : 1,
  );
  wires.neutral_presentation_leaf = and(
    neutralContainer,
    noAppearance,
    input.positiveAreaChildCount == null ? null : input.positiveAreaChildCount === 0 ? 1 : 0,
    input.nonFormatDirectTextPresent == null ? null : input.nonFormatDirectTextPresent ? 0 : 1,
    input.descendantTextPresent == null ? null : input.descendantTextPresent ? 0 : 1,
    input.tabIndexFocus == null ? null : input.tabIndexFocus ? 0 : 1,
    wires.own_pointer_boundary == null ? null : wires.own_pointer_boundary === 0 ? 1 : 0,
  );
  wires.single_child_div = and(
    neutralContainer,
    input.positiveAreaChildCount == null ? null : input.positiveAreaChildCount === 1 ? 1 : 0,
    singleChildTag == null ? null : singleChildTag === "div" ? 1 : 0,
  );
  wires.svg_internal_part = and(
    ["svg"].includes(input.tag ?? "") || tagSets.nat_svg_child.some(tag => tag === input.tag) ? 1 : 0,
    bool(input.inSvgAncestor),
    input.role === null ? 1 : 0,
    input.tabIndexFocus == null ? null : input.tabIndexFocus ? 0 : 1,
  );
  wires.empty_pointer_extent = andContinuous(
    emptyBase,
    bool(input.pointerCursor),
    input.aspectRatio ?? null,
  );
  wires.empty_border_extent = andContinuous(
    emptyBase,
    bool(input.borderPresent),
    input.aspectRatio ?? null,
  );
  wires.nat_document_root = input.tag === "html" || input.tag === "body" ? 1 : 0;
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
