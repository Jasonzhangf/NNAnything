// Read-only comparison of two profiles over live re-observed pages. Each input
// file is one reobserve-live capture. It reports how many rows change judgment
// between the two profiles, which changes are disturbances, and which rows the
// candidate calls ignore while the node still carries interaction or content.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { classifyBasicKind, DEFAULT_BASIC_KIND_CONFIG, DEFAULT_BASIC_KIND_PROFILE } from "nnanything/browser";
import { parseBrowserWeightAsset } from "nnanything/browser-classify";

const arg = name => { const i = process.argv.indexOf(name); return i === -1 ? undefined : process.argv[i + 1]; };
const profileA = arg("--profile-a") ?? "default";
const profileB = arg("--profile-b");
const files = (() => {
  const out = [];
  for (let i = 2; i < process.argv.length; i++) {
    const token = process.argv[i];
    if (token === "--profile-a" || token === "--profile-b") { i++; continue; }
    out.push(token);
  }
  return out;
})();
const load = async spec => spec === "default"
  ? DEFAULT_BASIC_KIND_PROFILE
  : parseBrowserWeightAsset(JSON.parse(await readFile(resolve(spec), "utf8")), spec).profile;
const a = await load(profileA), b = await load(profileB);
const propertyKeys = ["inputType","hrefPresent","contentEditable","directTextPresent","nonFormatDirectTextPresent","beforeContentPresent","afterContentPresent","backgroundImagePresent","maskImagePresent","childElementCount","positiveAreaChildCount","repeatedChildGeometry","inVerifiedListParent","svgGraphicChildren","pointerCursor","parentPointerCursor","tabIndexFocus","activeElementFocus","borderPresent","aspectRatio","descendantTextPresent","directListChildPresent","singleChildTag","singleChildSameRect","withinControlAncestor","inSvgAncestor","shallowStructuralPeerRatio","coincidentChildPairRatio","ownLabelPresent","graphicDescendantPresent","tag","role","disabled","hidden"];
const pickProperties = measurements => Object.fromEntries(propertyKeys.filter(key => key in measurements).map(key => [key, measurements[key]]));
const interactionTags = new Set(["a", "button", "input", "select", "textarea", "summary", "label", "details"]);
const interactionRoles = new Set(["button", "link", "tab", "menuitem", "checkbox", "radio", "switch", "textbox", "combobox", "searchbox", "slider", "spinbutton"]);

const summary = { files: [], total: 0, changed: 0, judgedToUnknown: 0, unknownToJudged: 0, kindToKind: 0, toIgnore: 0, fromIgnore: 0, candidateIgnore: 0, falseIgnore: [], changes: [] };
for (const file of files) {
  const capture = JSON.parse(await readFile(resolve(file), "utf8"));
  const per = { file, total: capture.rows.length, changed: 0, candidateIgnore: 0, falseIgnore: 0 };
  for (const row of capture.rows) {
    const props = pickProperties(row.measurements);
    const before = classifyBasicKind(props, DEFAULT_BASIC_KIND_CONFIG, a);
    const after = classifyBasicKind(props, DEFAULT_BASIC_KIND_CONFIG, b);
    const changed = before.judgmentStatus !== after.judgmentStatus || before.basicKind !== after.basicKind;
    if (after.basicKind === "ignore") {
      per.candidateIgnore++;
      summary.candidateIgnore++;
      const m = row.measurements;
      const interactive = (m.tag !== null && interactionTags.has(m.tag))
        || (m.role !== null && interactionRoles.has(m.role))
        || m.tabIndexFocus === true || m.activeElementFocus === true
        || (m.hrefPresent === true && m.tag === "a");
      if (interactive) {
        per.falseIgnore++;
        summary.falseIgnore.push({ file, nodeRef: row.nodeRef, tag: m.tag, role: m.role, score: after.score, before: before.basicKind });
      }
    }
    if (!changed) continue;
    per.changed++; summary.changed++;
    let kind = "kindToKind";
    if (before.judgmentStatus === "judged" && after.judgmentStatus !== "judged") { kind = "judgedToUnknown"; summary.judgedToUnknown++; }
    else if (before.judgmentStatus !== "judged" && after.judgmentStatus === "judged") { kind = "unknownToJudged"; summary.unknownToJudged++; }
    else summary.kindToKind++;
    if (after.basicKind === "ignore" && before.basicKind !== "ignore") summary.toIgnore++;
    if (before.basicKind === "ignore" && after.basicKind !== "ignore") summary.fromIgnore++;
    if (summary.changes.length < 40) summary.changes.push({ file: file.split("/").pop(), nodeRef: row.nodeRef, tag: row.measurements.tag, role: row.measurements.role, before: `${before.judgmentStatus}:${before.basicKind}`, after: `${after.judgmentStatus}:${after.basicKind}`, score: after.score, kind });
  }
  summary.total += capture.rows.length;
  summary.files.push(per);
}
console.log(JSON.stringify(summary, null, 1));
