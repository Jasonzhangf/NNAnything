// Read-only probe: shows why the ignore increment cannot be regression-checked on
// the legacy gold/Weibo corpora. A same-rect wrapper is judged only when the newer
// measurement fields are present; the legacy rows carry 10-12 of the 31 fields, so
// the structure family stays below the score threshold and every candidate judges
// them unknown. Usage: node playground/browser/ignore-coverage-probe.mjs <weightfile>
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { classifyBasicKind, DEFAULT_BASIC_KIND_CONFIG, extractBasicKindWires } from "nnanything/browser";
import { parseBrowserWeightAsset } from "nnanything/browser-classify";

const weightFile = resolve(process.argv[2]);
const profile = parseBrowserWeightAsset(JSON.parse(await readFile(weightFile, "utf8")), weightFile).profile;
const legacyFields = ["inputType", "hrefPresent", "contentEditable", "directTextPresent", "childElementCount", "positiveAreaChildCount", "repeatedChildGeometry", "inVerifiedListParent", "disabled", "hidden", "role", "tag"];
const ignoreWires = ["neutral_same_rect_wrapper", "single_child_div", "neutral_single_child", "div_single_child", "neutral_presentation_leaf", "neutral_inherited_pointer_wrapper", "neutral_single_element_wrapper", "noninteractive_hidden_leaf", "svg_internal_part", "empty_border_extent", "nat_document_root", "role_presentational", "neutral_single_positive_wrapper", "neutral_coincident_layer_wrapper", "independent_graphic_content", "own_focus_target"];

const dataset = JSON.parse(await readFile("/Volumes/extension/code/NNAnything/training/samples/three-site-zero/wrapper-increment-request.json", "utf8"));
const wrapper = dataset.rows.find(row => row.review.expectedLabel === "ignore" && row.properties.singleChildSameRect === true && row.properties.childElementCount === 1);
const reduced = Object.fromEntries(Object.entries(wrapper.properties).filter(([key]) => legacyFields.includes(key)));
const summarize = properties => {
  const judgment = classifyBasicKind(properties, DEFAULT_BASIC_KIND_CONFIG, profile);
  const wires = extractBasicKindWires(properties);
  return {
    judgmentStatus: judgment.judgmentStatus,
    basicKind: judgment.basicKind,
    family: judgment.family,
    structure: judgment.familyScores ? judgment.familyScores.structure : null,
    openIgnoreWires: ignoreWires.filter(wire => wires[wire] === 1).length,
    unknownIgnoreWires: ignoreWires.filter(wire => wires[wire] === null || wires[wire] === undefined).length,
  };
};
console.log(JSON.stringify({
  profile: profile.id,
  measuredWrapper: summarize(wrapper.properties),
  legacyFieldWrapper: summarize(reduced),
}, null, 1));
