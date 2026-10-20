import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compileWorkflow, createWorkflowInputEvent, loadWorkflow, runWorkflow } from "nnanything";
import { readBasicKindTrainingRequest } from "nnanything/training";
import { BASIC_KIND_FAMILIES, BASIC_KIND_WIRE_NAMES, LEAF_SUPPORT_WIRES, PRIORITY_BASIC_KIND_INITIAL_PROFILE, classifyBasicKind, classifyBasicKindBatch, computeBasicKindStageRawIntervals, domBasicKindsNode, extractBasicKindWires, hasNonFormatDirectText, migrateBasicKindProfile, shapeAppearanceMeasurements, validateBasicKindProfile, validateBasicKindProperties, LEGACY_BASIC_KIND_PROFILE, DEFAULT_BASIC_KIND_PROFILE, DEFAULT_BASIC_KIND_CONFIG, observeCandidates, validateCandidateRequest } from "nnanything/browser";

const complete = { contentEditable: false, directTextPresent: false, childElementCount: 0, positiveAreaChildCount: 0, repeatedChildGeometry: false, inVerifiedListParent: false, svgGraphicChildren: false };
const classify = (tag, fields = {}, profile) => classifyBasicKind({ tag, role: null, ...complete, ...fields }, DEFAULT_BASIC_KIND_CONFIG, profile);
const rect = { x: 10, y: 10, width: 80, height: 30 };
function batch() {
  return observeCandidates(validateCandidateRequest({ observation: { viewport: { x: 0, y: 0, width: 800, height: 600 }, nodes: [{ nodeRef: "one", tag: "button", role: null, parentRef: null, rect, fragments: [rect], clippedRect: rect, attributes: {} }] }, nodeRefs: ["one", "one", "missing"] }));
}

test("coarse family wins before only its leaf kinds execute", () => {
  const cases = [["button", {}, "control", "button"], ["textarea", {}, "control", "input"], ["select", {}, "control", "select"], ["img", {}, "media", "image"], ["video", {}, "media", "video"], ["audio", {}, "media", "audio"], ["a", { hrefPresent: true }, "navigation", "link"], ["p", {}, "text", "text"], ["article", {}, "structure", "container"], ["ul", {}, "structure", "list"], ["li", {}, "structure", "listitem"]];
  const leaves = { control: ["button", "input", "select"], media: ["image", "video", "audio"], navigation: ["link"], text: ["text"], structure: ["container", "list", "listitem", "ignore"] };
  for (const [tag, fields, family, kind] of cases) {
    const result = classify(tag, fields);
    assert.equal(result.family, family, tag);
    assert.equal(result.basicKind, kind, tag);
    assert.equal(result.judgmentStatus, "judged", tag);
    assert.deepEqual(Object.keys(result.leafScores), leaves[family]);
    assert.deepEqual(result.evidence.path.map(stage => stage.stage), ["family", "leaf"]);
    assert.equal(result.confidenceState, "uncalibrated");
    assert.equal(result.calibratedConfidence, null);
    assert.equal("positive" in result, false);
  }
});

test("input missing type retains family but abstains at leaf with a missing interval", () => {
  const result = classify("input");
  assert.equal(result.family, "control");
  assert.equal(result.basicKind, "other");
  assert.equal(result.judgmentStatus, "unknown");
  assert.deepEqual(result.leafScores.button, { min: 0, max: 0.85 });
  assert.equal(result.evidence.wires.input_type_button, null);
  assert.ok(result.reasons.includes("missing_input_type"));
  assert.equal(classify("input", { inputType: "text" }).basicKind, "input");
  assert.equal(classify("input", { inputType: "submit" }).basicKind, "button");
  assert.equal(classify("input", { inputType: "checkbox" }).basicKind, "select");
  assert.equal(classify("input", { inputType: "hidden" }).basicKind, "other");
});

test("present href includes empty href; absent differs from unmeasured", () => {
  assert.equal(classify("a", { hrefPresent: true }).basicKind, "link");
  const absent = classify("a", { hrefPresent: false });
  const missing = classify("a");
  assert.deepEqual(absent.familyScores.navigation, { min: 0.45, max: 0.45 });
  assert.deepEqual(missing.familyScores.navigation, { min: 0.45, max: 0.8 });
  assert.equal(missing.basicKind, "other");
  assert.ok(missing.reasons.includes("missing_link_evidence"));
  assert.ok(!absent.reasons.includes("missing_link_evidence"));
});

test("role specialization and conflicts produce different paths", () => {
  assert.equal(classifyBasicKind({ tag: "span", role: "link" }).basicKind, "link");
  assert.equal(classify("div", { role: "button" }).basicKind, "button");
  assert.equal(classify("span", { role: "link" }).basicKind, "link");
  for (const [tag, fields] of [["img", { role: "button" }], ["button", { role: "link" }], ["a", { role: "button", hrefPresent: true }]]) {
    const result = classify(tag, fields);
    assert.equal(result.familyStatus, "conflict");
    assert.equal(result.leafScores, null);
    assert.equal(result.evidence.path.length, 1);
  }
  // Contradiction inside a chosen family reaches the second stage.
  const leafConflict = classify("select", { role: "textbox" });
  assert.equal(leafConflict.family, "control");
  assert.equal(leafConflict.judgmentStatus, "conflict");
  assert.equal(classify("button", { disabled: true }).basicKind, "button");
});

test("neutral nodes need measured combinations; geometry is not semantic list proof", () => {
  assert.equal(classify("span", { directTextPresent: true }).basicKind, "text");
  assert.equal(classify("span", { directTextPresent: null }).basicKind, "other");
  assert.equal(classify("div").basicKind, "other");
  assert.equal(classify("div", { childElementCount: 1, positiveAreaChildCount: 1 }, LEGACY_BASIC_KIND_PROFILE).basicKind, "other");
  assert.equal(classify("div", { childElementCount: 1, positiveAreaChildCount: 1 }).basicKind, "container");
  const grouping = { childElementCount: 3, positiveAreaChildCount: 3 };
  assert.equal(classify("div", grouping).basicKind, "container");
  assert.equal(classify("div", { ...grouping, repeatedChildGeometry: true }).basicKind, "other");
  assert.equal(classify("div", { ...grouping, repeatedChildGeometry: null }).basicKind, "other");
  assert.equal(classify("svg").basicKind, "other");
  assert.equal(classify("svg", { role: "img" }).basicKind, "image");
});

test("evolved SVG and neutral-div wires retain three-valued evidence", () => {
  const graphicSvg = classify("svg", { childElementCount: 1, positiveAreaChildCount: 1, svgGraphicChildren: true });
  assert.equal(graphicSvg.basicKind, "image");
  assert.equal(graphicSvg.judgmentStatus, "judged");
  assert.equal(graphicSvg.evidence.wires.nat_svg, 1);
  assert.equal(graphicSvg.evidence.wires.svg_graphic_children, 1);
  assert.equal(graphicSvg.confidenceState, "uncalibrated");

  const emptySvg = classify("svg", { childElementCount: 0, svgGraphicChildren: true });
  assert.equal(emptySvg.basicKind, "other");
  assert.equal(emptySvg.judgmentStatus, "unknown");
  assert.equal(emptySvg.evidence.wires.svg_graphic_children, 0);
  assert.equal(classify("svg", { childElementCount: 1, svgGraphicChildren: false }).evidence.wires.svg_graphic_children, 0);
  assert.equal(classify("svg", { childElementCount: null, svgGraphicChildren: true }).evidence.wires.svg_graphic_children, null);
  assert.equal(classify("path").basicKind, "other");
  assert.equal(classify("use").basicKind, "other");

  const leafText = classify("div", { childElementCount: 0, positiveAreaChildCount: 0, directTextPresent: true });
  assert.equal(leafText.basicKind, "text");
  assert.equal(leafText.judgmentStatus, "judged");
  assert.equal(leafText.evidence.wires.div_leaf, 1);
  assert.equal(leafText.evidence.wires.div_direct_text, 1);
  assert.equal(classify("div").basicKind, "other");
  assert.equal(classify("div").judgmentStatus, "unknown");
  assert.equal(classify("div", { childElementCount: 1, positiveAreaChildCount: 1, directTextPresent: true }).basicKind, "other");
  assert.equal(classify("div", { childElementCount: 1, positiveAreaChildCount: 1, directTextPresent: null }).judgmentStatus, "unknown");
});

test("legacy and evolved profiles stay explicit while migration fills only new cells", () => {
  assert.equal(LEGACY_BASIC_KIND_PROFILE.id, "dom-basic-kinds-handwritten-v1");
  assert.equal(DEFAULT_BASIC_KIND_PROFILE.id, "dom-basic-kinds-handwritten-v2");
  assert.deepEqual(Object.keys(DEFAULT_BASIC_KIND_PROFILE).sort(), ["familyWeights", "id", "leafWeights"]);
  assert.equal(LEGACY_BASIC_KIND_PROFILE.familyWeights.media.nat_svg, 0);
  assert.equal(LEGACY_BASIC_KIND_PROFILE.leafWeights.image.svg_graphic_children, 0);
  assert.equal(DEFAULT_BASIC_KIND_PROFILE.familyWeights.media.nat_svg, 0.45);
  assert.equal(DEFAULT_BASIC_KIND_PROFILE.familyWeights.media.svg_graphic_children, 0.35);
  assert.equal(DEFAULT_BASIC_KIND_PROFILE.leafWeights.image.nat_svg, 0.45);
  assert.equal(DEFAULT_BASIC_KIND_PROFILE.leafWeights.image.svg_graphic_children, 0.35);
  assert.equal(DEFAULT_BASIC_KIND_PROFILE.familyWeights.structure.div_single_child, 0.45);
  assert.equal(DEFAULT_BASIC_KIND_PROFILE.leafWeights.container.div_single_child, 0.45);
  assert.equal(DEFAULT_BASIC_KIND_PROFILE.familyWeights.text.div_leaf, 0.3);
  assert.equal(DEFAULT_BASIC_KIND_PROFILE.leafWeights.text.div_leaf, 0.3);
  assert.equal(DEFAULT_BASIC_KIND_PROFILE.familyWeights.text.div_direct_text, 0.45);
  assert.equal(DEFAULT_BASIC_KIND_PROFILE.leafWeights.text.div_direct_text, 0.45);

  const old = structuredClone(LEGACY_BASIC_KIND_PROFILE);
  const newCells = [
    ["familyWeights", "media", "nat_svg"], ["familyWeights", "media", "svg_graphic_children"],
    ["leafWeights", "image", "nat_svg"], ["leafWeights", "image", "svg_graphic_children"],
    ["familyWeights", "structure", "div_single_child"], ["leafWeights", "container", "div_single_child"],
    ["familyWeights", "text", "div_leaf"], ["leafWeights", "text", "div_leaf"],
    ["familyWeights", "text", "div_direct_text"], ["leafWeights", "text", "div_direct_text"],
  ];
  for (const [group, target, wire] of newCells) delete old[group][target][wire];
  old.id = "old-asset-v1";
  old.familyWeights.media.nat_svg = 0.12;
  old.leafWeights.image.svg_graphic_children = 0.07;
  const before = structuredClone(old);
  const migrated = migrateBasicKindProfile(old);
  assert.deepEqual(old, before);
  assert.notEqual(migrated, old);
  assert.equal(migrated.id, "old-asset-v1");
  assert.equal(migrated.familyWeights.media.nat_svg, 0.12);
  assert.equal(migrated.leafWeights.image.svg_graphic_children, 0.07);
  assert.equal(migrated.familyWeights.media.svg_graphic_children, 0);
  assert.equal(migrated.leafWeights.image.nat_svg, 0);
  assert.equal(migrated.familyWeights.structure.div_single_child, 0);
  assert.equal(migrated.leafWeights.container.div_single_child, 0);
  assert.equal(migrated.familyWeights.text.div_leaf, 0);
  assert.equal(migrated.leafWeights.text.div_direct_text, 0);
  assert.throws(() => migrateBasicKindProfile({ ...old, extra: true }), /profile/i);
});

test("missing competition uses rival upper bound and configurable sparse coefficients", () => {
  const uncertain = classify("a", { role: "button" });
  assert.equal(uncertain.familyStatus, "unknown");
  assert.ok(uncertain.reasons.includes("unresolved_missing_feature"));
  const profile = structuredClone(DEFAULT_BASIC_KIND_PROFILE);
  profile.id = "test-profile";
  profile.familyWeights.control.nat_control_button = 0.5;
  assert.equal(classify("button", {}, profile).basicKind, "other");
  assert.equal(classify("button").basicKind, "button");
  assert.equal(classifyBasicKind({ tag: "a", role: "button", hrefPresent: true }, { ...DEFAULT_BASIC_KIND_CONFIG, minMargin: 0 }).familyStatus, "conflict");
  assert.throws(() => validateBasicKindProfile({ ...profile, familyWeights: { ...profile.familyWeights, wrong: {} } }), /familyWeights/);
  profile.familyWeights.control.nat_control_button = NaN;
  assert.throws(() => validateBasicKindProfile(profile), /finite/);
});

test("forbidden raw features and malformed measurements do not enter the model", () => {
  for (const key of ["class", "id", "name", "textContent", "href", "depth"]) {
    assert.throws(() => classify("button", { [key]: "private" }), /BASIC_KIND_FORBIDDEN_FEATURE/);
  }
  assert.throws(() => classify("div", { childElementCount: -1 }), /childElementCount/);
  assert.throws(() => classifyBasicKindBatch({ ...batch(), itemObservations: [{ nodeRef: "one", tag: "img" }] }), /BASIC_KIND_FORBIDDEN_FEATURE/);
  assert.equal(JSON.stringify(classifyBasicKindBatch(batch())).includes("attributes"), false);
  assert.equal(validateBasicKindProperties({ tag: "svg", role: null }).svgGraphicChildren, null);
  assert.equal(validateBasicKindProperties({ tag: "svg", role: null, svgGraphicChildren: true }).svgGraphicChildren, true);
});

test("batch preserves duplicates, upstream exclusions and unknown without evaluating them", () => {
  const input = batch();
  input.slots[1] = { ...input.slots[1], status: "filtered_out", reasons: ["deny_match"] };
  input.candidateRefs = ["one"];
  input.itemObservations = [{ nodeRef: "one", inputType: "text" }];
  const result = classifyBasicKindBatch(input);
  assert.deepEqual(result.slots.map(x => x.nodeRef), ["one", "one", "missing"]);
  assert.deepEqual(result.slots.map(x => x.index), [0, 1, 2]);
  assert.deepEqual(result.slots.map(x => x.judgmentStatus), ["judged", "excluded", "unknown"]);
  assert.equal(result.slots[1].familyScores, null);
  assert.deepEqual(result.slots[1].candidateReasons, ["deny_match"]);
  assert.equal(result.slots[2].basicKind, null);
  assert.equal(result.slots[2].evidence.path.length, 0);
});

test("public saved workflow loads, compiles and runs with explicit profile", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const definition = await loadWorkflow({ configPath: `${root}workflows/dom-basic-kinds.workflow.json`, allowedRoot: root });
  definition.bindings["判断DOM基础种类"].profileId = "custom";
  const compiled = compileWorkflow(definition, { nodeDefinitions: [domBasicKindsNode], profiles: { custom: DEFAULT_BASIC_KIND_PROFILE } });
  const event = createWorkflowInputEvent({ runId: "basic-kind-test", eventId: "basic-kind-test:input", port: "candidate_slots", type: "dom.candidate-slots.v1", payload: batch() });
  const result = await runWorkflow(compiled, event);
  assert.equal(result.status, "completed");
  assert.equal(result.outputEvent.status, "ok");
  assert.equal(result.outputEvent.payload.slots[0].basicKind, "button");
  assert.equal(result.outputEvent.payload.slots.length, 3);
  const upstreamUnknown = await runWorkflow(compiled, { ...event, status: "unknown", payload: { reason: "stale_scope" } });
  assert.equal(upstreamUnknown.outputEvent.status, "skipped");
});

test("every eligible request has a known or other label and all properties reach scoring", () => {
  for (const input of [{tag:"svg",role:null}, {tag:null,role:null}, {tag:"input",role:null}, {tag:"input",role:null,inputType:"hidden"}]) {
    const result=classifyBasicKind(input);
    assert.equal(result.basicKind,"other");
    assert.ok(result.familyScores!==null);
    assert.equal(result.evidence.path[0].stage,"family");
    assert.ok(result.reasons.includes("fallback_other"));
    assert.equal(result.calibratedConfidence,null);
  }
  // These attributes cannot veto independent native evidence.
  for (const fields of [{hidden:true},{role:"presentation"},{role:"none"}]) {
    const result=classifyBasicKind({tag:"button",role:null,...fields});
    assert.equal(result.basicKind,"button");
    assert.equal(result.evidence.path.length,2);
  }
  const conflict=classifyBasicKind({tag:"img",role:"button"});
  assert.equal(conflict.basicKind,"other");
  assert.equal(conflict.judgmentStatus,"conflict");
  assert.equal(conflict.leafScores,null);
  const hidden=classifyBasicKind({tag:"button",role:null,hidden:true});
  assert.equal(hidden.evidence.wires.state_hidden,1);
  const tuned=structuredClone(DEFAULT_BASIC_KIND_PROFILE);
  tuned.familyWeights.control.state_hidden=-0.5;
  assert.equal(classifyBasicKind({tag:"button",role:null,hidden:true},DEFAULT_BASIC_KIND_CONFIG,tuned).basicKind,"other");
  assert.equal(classifyBasicKind({tag:"input",role:"button",inputType:"hidden"}).basicKind,"button");
  // An unavailable observation remains outside classification, never auto-other truth.
  assert.equal(classifyBasicKindBatch(batch()).slots[2].basicKind,null);
});

test("pure appearance preprocessing preserves literal text and separates declared presentation", () => {
  assert.equal(hasNonFormatDirectText("\u200b \u200d"), false);
  assert.equal(hasNonFormatDirectText("中文"), true);
  assert.equal(hasNonFormatDirectText("👩‍💻"), true);
  assert.equal(hasNonFormatDirectText("e\u0301"), true);
  assert.equal(hasNonFormatDirectText("\u061c\u2061"), false);
  assert.equal(hasNonFormatDirectText(null), null);
  assert.equal(shapeAppearanceMeasurements({}).directTextPresent, null);
  assert.equal(shapeAppearanceMeasurements({ directText: null }).nonFormatDirectTextPresent, null);
  assert.equal(shapeAppearanceMeasurements({ directText: "" }).nonFormatDirectTextPresent, false);

  const shaped = shapeAppearanceMeasurements({
    directText: "\u200b",
    beforeContent: '""',
    afterContent: "counter(item)",
    backgroundImage: "none, none",
    maskImage: "none, url(#mask)",
  });
  assert.equal(shaped.directTextPresent, true);
  assert.equal(shaped.nonFormatDirectTextPresent, false);
  assert.equal(shaped.beforeContentPresent, false);
  assert.equal(shaped.afterContentPresent, true);
  assert.equal(shaped.backgroundImagePresent, false);
  assert.equal(shaped.maskImagePresent, true);

  const missing = shapeAppearanceMeasurements({ directText: "real" });
  assert.equal(missing.directTextPresent, true);
  assert.equal(missing.nonFormatDirectTextPresent, true);
  assert.equal(missing.beforeContentPresent, null);
  assert.equal(missing.afterContentPresent, null);
  assert.equal(missing.backgroundImagePresent, null);
  assert.equal(missing.maskImagePresent, null);
});

test("appearance wires keep b and path distinct without changing old decisions", () => {
  const b = { tag: "b", role: null, ...complete, directTextPresent: true, nonFormatDirectTextPresent: true };
  const path = { tag: "path", role: null, ...complete, directTextPresent: false, nonFormatDirectTextPresent: false };
  const bWires = extractBasicKindWires(b), pathWires = extractBasicKindWires(path);
  assert.equal(bWires.direct_non_format_text, 1);
  assert.equal(pathWires.direct_non_format_text, 0);
  assert.equal(bWires.nat_svg_child, 0);
  assert.equal(pathWires.nat_svg_child, 1);
  assert.notDeepEqual(bWires, pathWires);
  assert.equal(classifyBasicKind(b, DEFAULT_BASIC_KIND_CONFIG, LEGACY_BASIC_KIND_PROFILE).basicKind, "other");
  assert.equal(classifyBasicKind(path, DEFAULT_BASIC_KIND_CONFIG, LEGACY_BASIC_KIND_PROFILE).basicKind, "other");
  assert.equal(classifyBasicKind(b).basicKind, "other");
  assert.equal(classifyBasicKind(path).basicKind, "other");
});

test("named migration registers every new appearance target as explicit zero", () => {
  const newWires = new Set(["direct_non_format_text", "css_before_content", "css_after_content", "css_background_image", "css_mask_image", "nat_svg_child"]);
  // The migration must restore the trainable addresses of the public builtin profile.
  const addresses = ["familyWeights", "leafWeights"].flatMap(group =>
    Object.entries(LEGACY_BASIC_KIND_PROFILE[group]).flatMap(([target, weights]) =>
      Object.keys(weights).filter(wire => newWires.has(wire)).map(wire => [group, target, wire])));
  assert.equal(addresses.length, 42);
  const old = structuredClone(LEGACY_BASIC_KIND_PROFILE);
  for (const [group, target, wire] of addresses) delete old[group][target][wire];
  const before = structuredClone(old), migrated = migrateBasicKindProfile(old);
  assert.deepEqual(old, before);
  for (const [group, target, wire] of addresses) assert.equal(migrated[group][target][wire], 0, `${group}.${target}.${wire}`);
});

function zeroProfile() {
  const profile = structuredClone(DEFAULT_BASIC_KIND_PROFILE);
  profile.id = "zero-core-slice";
  for (const rows of [profile.familyWeights, profile.leafWeights]) {
    for (const weights of Object.values(rows)) {
      for (const wire of Object.keys(weights)) weights[wire] = 0;
    }
  }
  return profile;
}

const newMeasurementNames = [
  "pointerCursor",
  "parentPointerCursor",
  "tabIndexFocus",
  "directListChildPresent",
  "borderPresent",
  "aspectRatio",
  "descendantTextPresent",
  "singleChildTag",
  "singleChildSameRect",
  "withinControlAncestor",
  "inSvgAncestor",
];
const newWireNames = [
  "editable_non_input",
  "input_text_combobox",
  "listitem_role_select",
  "nat_inline_format_text",
  "neutral_multi_child",
  "neutral_single_child",
  "neutral_focusable_control",
  "neutral_list_choice",
  "neutral_same_rect_wrapper",
  "composite_descendant_text",
  "own_pointer_boundary",
  "single_child_div",
  "svg_internal_part",
  "empty_pointer_extent",
  "empty_border_extent",
  "nat_document_root",
  "neutral_presentation_leaf",
];

test("neutral presentation leaf fires on visual leaves and keeps missing guards", () => {
  const presented = {
    tag: "xg-placeholder",
    role: null,
    contentEditable: false,
    directTextPresent: false,
    nonFormatDirectTextPresent: false,
    beforeContentPresent: false,
    afterContentPresent: false,
    backgroundImagePresent: false,
    maskImagePresent: false,
    childElementCount: 0,
    positiveAreaChildCount: 0,
    descendantTextPresent: false,
    tabIndexFocus: false,
    pointerCursor: false,
    parentPointerCursor: false,
    borderPresent: null,
  };
  assert.equal(extractBasicKindWires(presented).neutral_presentation_leaf, 1);
  assert.equal(extractBasicKindWires({
    ...presented,
    tag: "xg-played",
    childElementCount: 3,
    pointerCursor: true,
    parentPointerCursor: true,
  }).neutral_presentation_leaf, 1);
  assert.equal(extractBasicKindWires({
    ...presented,
    tag: "span",
    directTextPresent: true,
  }).neutral_presentation_leaf, 1);
  assert.equal(extractBasicKindWires({ ...presented, tag: "div" }).neutral_presentation_leaf, 1);

  for (const [name, fields] of [
    ["native", { tag: "button" }],
    ["explicit role", { role: "button" }],
    ["focus", { tabIndexFocus: true }],
    ["own pointer", { pointerCursor: true, parentPointerCursor: false }],
    ["meaningful text", { nonFormatDirectTextPresent: true }],
    ["descendant text", { descendantTextPresent: true }],
    ["visible child", { childElementCount: 1, positiveAreaChildCount: 1 }],
  ]) assert.equal(extractBasicKindWires({ ...presented, ...fields }).neutral_presentation_leaf, 0, name);
  for (const [name, fields] of [
    ["CSS background image", { backgroundImagePresent: true }],
    ["CSS mask image", { maskImagePresent: true }],
    ["pseudo glyph", { beforeContentPresent: true }],
  ]) assert.equal(extractBasicKindWires({ ...presented, ...fields }).neutral_presentation_leaf, 0, name);

  assert.equal(extractBasicKindWires({ ...presented, backgroundImagePresent: null }).neutral_presentation_leaf, null);
  assert.equal(extractBasicKindWires({ ...presented, descendantTextPresent: null }).neutral_presentation_leaf, null);
  assert.equal(extractBasicKindWires({ ...presented, backgroundImagePresent: null, tabIndexFocus: true }).neutral_presentation_leaf, 0);
});

test("repeated-child extent carries neutral div count evidence without crossing applicability", () => {
  const base = {
    tag: "div",
    role: null,
    contentEditable: false,
    childElementCount: 10,
    positiveAreaChildCount: 2,
    repeatedChildGeometry: true,
  };
  const extent = fields => extractBasicKindWires({ ...base, ...fields }).div_repeated_child_extent;
  const observed = {
    count2: extent({ positiveAreaChildCount: 2 }),
    count4: extent({ positiveAreaChildCount: 4 }),
    count10: extent({ positiveAreaChildCount: 10 }),
    zero: extent({ positiveAreaChildCount: 0 }),
    repeatedFalse: extent({ repeatedChildGeometry: false }),
    repeatedMissing: extent({ repeatedChildGeometry: null }),
    countMissing: extent({ positiveAreaChildCount: null }),
    zeroWithRepeatedMissing: extent({ positiveAreaChildCount: 0, repeatedChildGeometry: null }),
    repeatedFalseWithCountMissing: extent({ positiveAreaChildCount: null, repeatedChildGeometry: false }),
    editableMissing: extent({ contentEditable: null }),
    editableTrue: extent({ contentEditable: true }),
    custom9: extractBasicKindWires({
      ...base,
      tag: "acme-grid",
      childElementCount: 9,
      positiveAreaChildCount: 9,
    }).div_repeated_child_extent,
    span6: extractBasicKindWires({
      ...base,
      tag: "span",
      childElementCount: 6,
      positiveAreaChildCount: 6,
    }).div_repeated_child_extent,
    ul9: extractBasicKindWires({
      ...base,
      tag: "ul",
      childElementCount: 9,
      positiveAreaChildCount: 9,
    }).div_repeated_child_extent,
    explicitRole9: extent({ role: "list", childElementCount: 9, positiveAreaChildCount: 9 }),
    saturation15: extent({ positiveAreaChildCount: 15 }),
    saturation16: extent({ positiveAreaChildCount: 16 }),
    saturation20: extent({ positiveAreaChildCount: 20 }),
  };
  assert.deepEqual(observed, {
    count2: 2 / 16,
    count4: 4 / 16,
    count10: 10 / 16,
    zero: 0,
    repeatedFalse: 0,
    repeatedMissing: null,
    countMissing: null,
    zeroWithRepeatedMissing: 0,
    repeatedFalseWithCountMissing: 0,
    editableMissing: null,
    editableTrue: 0,
    custom9: 0,
    span6: 0,
    ul9: 0,
    explicitRole9: 0,
    saturation15: 15 / 16,
    saturation16: 1,
    saturation20: 1,
  });
});

test("repeated-child extent migration adds only list and container zeros", () => {
  assert.ok(BASIC_KIND_WIRE_NAMES.includes("div_repeated_child_extent"));
  const old = structuredClone(LEGACY_BASIC_KIND_PROFILE);
  for (const group of ["familyWeights", "leafWeights"]) {
    for (const row of Object.values(old[group])) delete row.div_repeated_child_extent;
  }
  const before = structuredClone(old);
  const migrated = migrateBasicKindProfile(old);
  assert.deepEqual(old, before);
  const addresses = [];
  for (const group of ["familyWeights", "leafWeights"]) {
    for (const [target, row] of Object.entries(migrated[group])) {
      if (Object.hasOwn(row, "div_repeated_child_extent")) addresses.push([group, target, row.div_repeated_child_extent]);
    }
  }
  assert.deepEqual(addresses, [
    ["leafWeights", "container", 0],
    ["leafWeights", "list", 0],
  ]);

  const properties = {
    tag: "div",
    role: null,
    contentEditable: false,
    childElementCount: 10,
    positiveAreaChildCount: 10,
    repeatedChildGeometry: true,
  };
  const wires = extractBasicKindWires(properties);
  const familyNames = Object.keys(BASIC_KIND_FAMILIES);
  const leafNames = Object.values(BASIC_KIND_FAMILIES).flat();
  assert.deepEqual(
    computeBasicKindStageRawIntervals("family", familyNames, migrated.familyWeights, wires),
    computeBasicKindStageRawIntervals("family", familyNames, old.familyWeights, wires),
  );
  assert.deepEqual(
    computeBasicKindStageRawIntervals("leaf", leafNames, migrated.leafWeights, wires),
    computeBasicKindStageRawIntervals("leaf", leafNames, old.leafWeights, wires),
  );
});

test("configured presentation score separates ignore leaves from guarded content", () => {
  const profile = zeroProfile();
  profile.id = "neutral-presentation-leaf-test";
  profile.familyWeights.structure.neutral_presentation_leaf = 0.85;
  profile.leafWeights.ignore.neutral_presentation_leaf = 0.85;
  profile.familyWeights.media.css_background_image = 0.85;
  profile.leafWeights.image.css_background_image = 0.85;
  profile.familyWeights.media.css_before_content = 0.85;
  profile.leafWeights.image.css_before_content = 0.85;
  const presented = {
    tag: "span",
    role: null,
    contentEditable: false,
    directTextPresent: false,
    nonFormatDirectTextPresent: false,
    beforeContentPresent: false,
    afterContentPresent: false,
    backgroundImagePresent: false,
    maskImagePresent: false,
    childElementCount: 0,
    positiveAreaChildCount: 0,
    descendantTextPresent: false,
    tabIndexFocus: false,
    pointerCursor: false,
    parentPointerCursor: false,
    borderPresent: null,
  };
  const formatLeaf = { ...presented, directTextPresent: true };
  const separator = { ...presented, tag: "div" };
  const hiddenPaint = { ...presented, tag: "xg-played", childElementCount: 3, pointerCursor: true, parentPointerCursor: true };
  for (const [name, input] of [["empty placeholder", presented], ["format span", formatLeaf], ["thin separator", separator], ["hidden paint", hiddenPaint]]) {
    const result = classifyBasicKind(input, DEFAULT_BASIC_KIND_CONFIG, profile);
    assert.equal(result.basicKind, "ignore", name);
    assert.equal(result.judgmentStatus, "judged", name);
  }

  const guarded = [
    ["native", { ...presented, tag: "button" }],
    ["explicit role", { ...presented, role: "button" }],
    ["focus", { ...presented, tabIndexFocus: true }],
    ["own pointer", { ...presented, pointerCursor: true, parentPointerCursor: false }],
    ["meaningful text", { ...presented, nonFormatDirectTextPresent: true }],
    ["descendant text", { ...presented, descendantTextPresent: true }],
    ["visible child", { ...presented, childElementCount: 1, positiveAreaChildCount: 1 }],
  ];
  for (const [name, input] of guarded) assert.notEqual(classifyBasicKind(input, DEFAULT_BASIC_KIND_CONFIG, profile).basicKind, "ignore", name);

  const backgroundImage = classifyBasicKind({ ...presented, backgroundImagePresent: true }, DEFAULT_BASIC_KIND_CONFIG, profile);
  assert.equal(backgroundImage.basicKind, "image");
  const pseudoGlyph = classifyBasicKind({ ...presented, beforeContentPresent: true }, DEFAULT_BASIC_KIND_CONFIG, profile);
  assert.equal(pseudoGlyph.basicKind, "image");
});

test("presentation wire migration adds seven zeros and preserves sparse profiles", () => {
  const cells = [
    ["familyWeights", "structure", "neutral_presentation_leaf"],
    ["familyWeights", "text", "neutral_presentation_leaf"],
    ["familyWeights", "control", "neutral_presentation_leaf"],
    ["leafWeights", "ignore", "neutral_presentation_leaf"],
    ["leafWeights", "container", "neutral_presentation_leaf"],
    ["leafWeights", "text", "neutral_presentation_leaf"],
    ["leafWeights", "button", "neutral_presentation_leaf"],
  ];
  assert.ok(BASIC_KIND_WIRE_NAMES.includes("neutral_presentation_leaf"));
  const properties = {
    tag: "div",
    role: null,
    contentEditable: false,
    directTextPresent: false,
    nonFormatDirectTextPresent: false,
    beforeContentPresent: false,
    afterContentPresent: false,
    backgroundImagePresent: false,
    maskImagePresent: false,
    childElementCount: 2,
    positiveAreaChildCount: 1,
    descendantTextPresent: true,
    tabIndexFocus: false,
    pointerCursor: true,
    parentPointerCursor: false,
  };
  const wires = extractBasicKindWires(properties);
  const familyNames = Object.keys(BASIC_KIND_FAMILIES);
  const leafNames = Object.values(BASIC_KIND_FAMILIES).flat();
  for (const source of [LEGACY_BASIC_KIND_PROFILE, DEFAULT_BASIC_KIND_PROFILE]) {
    const old = structuredClone(source);
    for (const [group, target, wire] of cells) delete old[group][target][wire];
    const before = structuredClone(old);
    const migrated = migrateBasicKindProfile(old);
    assert.deepEqual(old, before);
    for (const [group, target, wire] of cells) assert.equal(migrated[group][target][wire], 0, `${source.id}.${group}.${target}.${wire}`);
    assert.deepEqual(computeBasicKindStageRawIntervals("family", familyNames, migrated.familyWeights, wires), computeBasicKindStageRawIntervals("family", familyNames, old.familyWeights, wires));
    assert.deepEqual(computeBasicKindStageRawIntervals("leaf", leafNames, migrated.leafWeights, wires), computeBasicKindStageRawIntervals("leaf", leafNames, old.leafWeights, wires));
  }
  assert.equal(LEGACY_BASIC_KIND_PROFILE.familyWeights.structure.neutral_presentation_leaf, undefined);
  assert.equal(DEFAULT_BASIC_KIND_PROFILE.leafWeights.ignore.neutral_presentation_leaf, undefined);
});

test("ignore is a validated leaf and legacy migration preserves old structure intervals", () => {
  assert.deepEqual(BASIC_KIND_FAMILIES.structure, ["container", "list", "listitem", "ignore"]);
  assert.ok(BASIC_KIND_WIRE_NAMES.includes("neutral_multi_child"));
  assert.deepEqual(validateBasicKindProfile(DEFAULT_BASIC_KIND_PROFILE).leafWeights.ignore, {
    role_presentational: 0,
    input_type_hidden: 0,
    state_disabled: 0,
    state_hidden: 0,
  });

  const old = structuredClone(LEGACY_BASIC_KIND_PROFILE);
  delete old.leafWeights.ignore;
  for (const group of ["familyWeights", "leafWeights"]) {
    for (const row of Object.values(old[group])) {
      for (const wire of newWireNames) delete row[wire];
    }
  }
  const properties = {
    tag: "div",
    role: null,
    contentEditable: false,
    directTextPresent: false,
    nonFormatDirectTextPresent: false,
    childElementCount: 3,
    positiveAreaChildCount: 3,
    repeatedChildGeometry: false,
    inVerifiedListParent: false,
    svgGraphicChildren: false,
  };
  const oldWires = extractBasicKindWires(properties);
  const before = computeBasicKindStageRawIntervals(
    "leaf",
    ["container", "list", "listitem"],
    old.leafWeights,
    oldWires,
  );
  const migrated = migrateBasicKindProfile(old);
  const after = computeBasicKindStageRawIntervals(
    "leaf",
    ["container", "list", "listitem"],
    migrated.leafWeights,
    oldWires,
  );
  assert.deepEqual(after, before);
  for (const wire of [
    "role_presentational", "input_type_hidden", "state_disabled", "state_hidden",
    "neutral_multi_child", "neutral_single_child", "neutral_same_rect_wrapper", "single_child_div",
    "own_pointer_boundary", "svg_internal_part", "empty_pointer_extent", "empty_border_extent", "nat_document_root",
  ]) assert.equal(migrated.leafWeights.ignore[wire], 0, `leafWeights.ignore.${wire}`);
  for (const [group, target, wire] of [
    ["familyWeights", "control", "editable_non_input"],
    ["leafWeights", "input", "editable_non_input"],
    ["leafWeights", "select", "listitem_role_select"],
    ["leafWeights", "ignore", "svg_internal_part"],
  ]) {
    assert.equal(migrated[group][target][wire], 0, `${group}.${target}.${wire}`);
  }
  assert.equal(classifyBasicKind(properties, DEFAULT_BASIC_KIND_CONFIG, migrated).basicKind, "container");
});

test("three conflict wires separate canonical labels while ordinary nodes keep their decisions", () => {
  const profile = structuredClone(DEFAULT_BASIC_KIND_PROFILE);
  profile.id = "conflict-separation-test";
  profile.familyWeights.control.editable_non_input = 0.3;
  profile.leafWeights.input.editable_non_input = 0.3;
  profile.leafWeights.input.input_text_combobox = 0.2;
  profile.familyWeights.control.listitem_role_select = 0.3;
  profile.leafWeights.select.listitem_role_select = 0.3;

  const editable = { ...complete, contentEditable: true, directTextPresent: true, nonFormatDirectTextPresent: true };
  const editableWires = extractBasicKindWires({ tag: "p", role: null, ...editable });
  assert.equal(editableWires.editable_non_input, 1);
  assert.equal(classifyBasicKind({ tag: "p", role: null, ...editable }, DEFAULT_BASIC_KIND_CONFIG, profile).basicKind, "input");
  assert.equal(classifyBasicKind({ tag: "p", role: null, ...complete, directTextPresent: true, nonFormatDirectTextPresent: true }).basicKind, "text");

  const combobox = { tag: "input", role: "combobox", inputType: "search" };
  assert.equal(extractBasicKindWires(combobox).input_text_combobox, 1);
  assert.equal(classifyBasicKind(combobox, DEFAULT_BASIC_KIND_CONFIG, profile).basicKind, "input");
  assert.equal(classifyBasicKind({ tag: "input", role: null, inputType: "search" }).basicKind, "input");

  const listTab = { tag: "li", role: "tab" };
  assert.equal(extractBasicKindWires(listTab).listitem_role_select, 1);
  assert.equal(classifyBasicKind(listTab, DEFAULT_BASIC_KIND_CONFIG, profile).basicKind, "select");
  assert.equal(classifyBasicKind({ tag: "li", role: null }).basicKind, "listitem");
});

test("new relationship and continuous-extent wires remain nullable until measured", () => {
  const empty = {
    tag: "div",
    role: null,
    contentEditable: false,
    directTextPresent: false,
    nonFormatDirectTextPresent: false,
    childElementCount: 0,
    positiveAreaChildCount: 0,
    beforeContentPresent: false,
    afterContentPresent: false,
    backgroundImagePresent: false,
    maskImagePresent: false,
    pointerCursor: true,
    parentPointerCursor: false,
    borderPresent: false,
    aspectRatio: 0.25,
    descendantTextPresent: false,
    withinControlAncestor: false,
  };
  const wires = extractBasicKindWires(empty);
  assert.equal(wires.empty_pointer_extent, 0.25);
  assert.equal(wires.empty_border_extent, 0);
  assert.equal(wires.own_pointer_boundary, 1);
  assert.equal(extractBasicKindWires({ ...empty, tag: "button" }).own_pointer_boundary, 0);
  assert.equal(extractBasicKindWires({ ...empty, parentPointerCursor: true }).own_pointer_boundary, 0);
  assert.equal(extractBasicKindWires({ ...empty, borderPresent: true, pointerCursor: false }).empty_border_extent, 0.25);

  const missing = extractBasicKindWires({ ...empty, aspectRatio: null });
  assert.equal(missing.empty_pointer_extent, null);
  assert.deepEqual(
    computeBasicKindStageRawIntervals("leaf", ["ignore"], { ignore: { empty_pointer_extent: 0.4 } }, missing),
    { ignore: { min: 0, max: 0.4 } },
  );
  assert.deepEqual(
    computeBasicKindStageRawIntervals("leaf", ["ignore"], { ignore: { empty_pointer_extent: 0.4 } }, wires),
    { ignore: { min: 0.1, max: 0.1 } },
  );
  assert.throws(() => validateBasicKindProperties({ tag: "div", role: null, aspectRatio: 1.01 }), /aspectRatio/);

  const validated = validateBasicKindProperties({ tag: "div", role: null });
  for (const field of newMeasurementNames) assert.equal(validated[field], null, field);
  assert.throws(
    () => validateBasicKindProperties({ tag: "div", role: null, customElementTag: true }),
    /BASIC_KIND_FORBIDDEN_FEATURE/,
  );
});

test("generic control and empty extents apply only to neutral containers", () => {
  const emptyAppearance = {
    directTextPresent: false,
    nonFormatDirectTextPresent: false,
    childElementCount: 0,
    positiveAreaChildCount: 0,
    beforeContentPresent: false,
    afterContentPresent: false,
    backgroundImagePresent: false,
    maskImagePresent: false,
    parentPointerCursor: false,
  };
  const nativeTags = ["img", "a", "input", "video", "p", "li"];
  const excluded = [
    ...nativeTags.map(tag => ({ tag, role: null, contentEditable: false })),
    { tag: "div", role: "button", contentEditable: false },
    { tag: "div", role: null, contentEditable: true },
  ];
  for (const base of excluded) {
    for (const measured of [
      { pointerCursor: null, borderPresent: null, aspectRatio: null },
      { pointerCursor: true, borderPresent: true, aspectRatio: 1 },
    ]) {
      const wires = extractBasicKindWires({ ...emptyAppearance, ...base, ...measured });
      const label = `${base.tag}/${base.role}/${base.contentEditable}/${measured.pointerCursor}`;
      assert.equal(wires.own_pointer_boundary, 0, label);
      assert.equal(wires.empty_pointer_extent, 0, label);
      assert.equal(wires.empty_border_extent, 0, label);
    }
  }

  const neutralMissing = extractBasicKindWires({
    ...emptyAppearance,
    tag: "div",
    role: null,
    contentEditable: false,
    pointerCursor: null,
    borderPresent: null,
    aspectRatio: null,
  });
  assert.equal(neutralMissing.own_pointer_boundary, null);
  assert.equal(neutralMissing.empty_pointer_extent, null);
  assert.equal(neutralMissing.empty_border_extent, null);
});

test("SVG internals, document roots and custom-element neutrality use measured relationships", () => {
  const root = extractBasicKindWires({ tag: "svg", role: null, inSvgAncestor: false, tabIndexFocus: false });
  assert.equal(root.svg_internal_part, 0);
  assert.equal(extractBasicKindWires({ tag: "path", role: null, inSvgAncestor: true, tabIndexFocus: false }).svg_internal_part, 1);
  assert.equal(extractBasicKindWires({ tag: "svg", role: null, inSvgAncestor: true, tabIndexFocus: false }).svg_internal_part, 1);
  assert.equal(extractBasicKindWires({ tag: "path", role: "button", inSvgAncestor: true, tabIndexFocus: false }).svg_internal_part, 0);
  assert.equal(extractBasicKindWires({ tag: "path", role: null, inSvgAncestor: true, tabIndexFocus: true }).svg_internal_part, 0);
  assert.equal(extractBasicKindWires({ tag: "path", role: null }).svg_internal_part, null);
  assert.equal(extractBasicKindWires({ tag: "html", role: null }).nat_document_root, 1);
  assert.equal(extractBasicKindWires({ tag: "body", role: null }).nat_document_root, 1);
  assert.equal(extractBasicKindWires({ tag: "div", role: null }).nat_document_root, 0);

  const custom = {
    tag: "acme-panel",
    role: null,
    contentEditable: false,
    childElementCount: 2,
    positiveAreaChildCount: 2,
    singleChildTag: null,
    withinControlAncestor: false,
    descendantTextPresent: false,
  };
  const customWires = extractBasicKindWires(custom);
  assert.equal(customWires.neutral_multi_child, 1);
  assert.equal(customWires.neutral_single_child, 0);
  assert.equal(
    extractBasicKindWires(validateBasicKindProperties({ ...custom, tag: "acme-wrapper", childElementCount: 1, positiveAreaChildCount: 1, singleChildTag: "DIV" })).single_child_div,
    1,
  );
  assert.equal(validateBasicKindProperties({ ...custom, singleChildTag: "DIV" }).singleChildTag, "div");
  assert.equal(extractBasicKindWires({ tag: "b", role: null, nonFormatDirectTextPresent: true }).nat_inline_format_text, 1);
  assert.equal(
    extractBasicKindWires({ ...custom, tag: "span", childElementCount: 1, positiveAreaChildCount: 1, directTextPresent: false, descendantTextPresent: true, withinControlAncestor: false }).composite_descendant_text,
    1,
  );
});

test("same-rect neutral wrapper is scored separately from expanded groups and native controls", () => {
  const profile = structuredClone(DEFAULT_BASIC_KIND_PROFILE);
  profile.id = "same-rect-wrapper-test";
  profile.familyWeights.structure.neutral_same_rect_wrapper = 0.7;
  profile.leafWeights.ignore.neutral_same_rect_wrapper = 0.7;
  profile.leafWeights.container.neutral_same_rect_wrapper = 0;
  const shared = {
    role: null,
    contentEditable: false,
    directTextPresent: false,
    nonFormatDirectTextPresent: false,
    childElementCount: 1,
    positiveAreaChildCount: 1,
    singleChildTag: "span",
    repeatedChildGeometry: false,
    inVerifiedListParent: false,
    beforeContentPresent: false,
    afterContentPresent: false,
    backgroundImagePresent: false,
    maskImagePresent: false,
  };
  const wrapper = { ...shared, tag: "span", singleChildSameRect: true };
  const expanded = { ...shared, tag: "div", singleChildSameRect: false };
  const nativeButton = { ...shared, tag: "button", singleChildSameRect: true };
  const missing = { ...shared, tag: "span", singleChildSameRect: null };

  assert.equal(extractBasicKindWires(wrapper).neutral_same_rect_wrapper, 1);
  assert.equal(extractBasicKindWires(expanded).neutral_same_rect_wrapper, 0);
  assert.equal(extractBasicKindWires(nativeButton).neutral_same_rect_wrapper, 0);
  assert.equal(extractBasicKindWires(missing).neutral_same_rect_wrapper, null);
  assert.equal(classifyBasicKind(wrapper, DEFAULT_BASIC_KIND_CONFIG, profile).basicKind, "ignore");
  assert.equal(classifyBasicKind(expanded, DEFAULT_BASIC_KIND_CONFIG, profile).basicKind, "container");
  assert.equal(classifyBasicKind(nativeButton, DEFAULT_BASIC_KIND_CONFIG, profile).basicKind, "button");
  assert.equal(classifyBasicKind(missing, DEFAULT_BASIC_KIND_CONFIG, profile).familyStatus, "unknown");
});

function choiceAddendumProfile() {
  const profile = zeroProfile();
  profile.id = "choice-addendum-test";
  profile.familyWeights.control.nat_control_button = 0.85;
  profile.familyWeights.control.nat_control_select = 0.85;
  profile.familyWeights.control.nat_input_tag = 0.85;
  profile.familyWeights.control.own_pointer_boundary = 0.7;
  profile.familyWeights.control.neutral_focusable_control = 0.85;
  profile.familyWeights.control.neutral_list_choice = 0.85;
  profile.leafWeights.button.nat_control_button = 0.85;
  profile.leafWeights.button.own_pointer_boundary = 0.7;
  profile.leafWeights.input.input_type_text = 0.85;
  profile.leafWeights.input.neutral_focusable_control = 0.85;
  profile.leafWeights.select.nat_control_select = 0.85;
  profile.leafWeights.select.neutral_list_choice = 0.9;
  return profile;
}

test("focusable neutral controls and direct-list choices separate positive and negative scores", () => {
  const profile = choiceAddendumProfile();
  const focusable = {
    tag: "div",
    role: null,
    contentEditable: false,
    directTextPresent: false,
    childElementCount: 1,
    positiveAreaChildCount: 1,
    pointerCursor: false,
    parentPointerCursor: false,
    tabIndexFocus: true,
  };
  const nonFocusable = { ...focusable, tabIndexFocus: false };
  const focusableWires = extractBasicKindWires(focusable);
  const nonFocusableWires = extractBasicKindWires(nonFocusable);
  assert.equal(focusableWires.neutral_focusable_control, 1);
  assert.equal(nonFocusableWires.neutral_focusable_control, 0);
  assert.equal(extractBasicKindWires({ ...focusable, tabIndexFocus: null }).neutral_focusable_control, null);

  const focusableResult = classifyBasicKind(focusable, DEFAULT_BASIC_KIND_CONFIG, profile);
  const nonFocusableResult = classifyBasicKind(nonFocusable, DEFAULT_BASIC_KIND_CONFIG, profile);
  assert.equal(focusableResult.basicKind, "input");
  assert.equal(focusableResult.judgmentStatus, "judged");
  assert.ok(focusableResult.score >= 0.6);
  assert.ok(focusableResult.margin >= 0.15);
  assert.equal(focusableResult.familyScores.control.min, 0.85);
  assert.equal(nonFocusableResult.familyScores.control.min, 0);
  assert.deepEqual(
    computeBasicKindStageRawIntervals(
      "family",
      ["control"],
      { control: { neutral_focusable_control: 0.85 } },
      extractBasicKindWires({ ...focusable, tabIndexFocus: null }),
    ),
    { control: { min: 0, max: 0.85 } },
  );

  const listChoice = {
    tag: "div",
    role: null,
    contentEditable: false,
    directTextPresent: false,
    childElementCount: 2,
    positiveAreaChildCount: 1,
    pointerCursor: true,
    parentPointerCursor: false,
    tabIndexFocus: false,
    directListChildPresent: true,
    descendantTextPresent: true,
  };
  const actionButton = { ...listChoice, childElementCount: 3, positiveAreaChildCount: 3, directListChildPresent: false };
  const listWires = extractBasicKindWires(listChoice);
  const buttonWires = extractBasicKindWires(actionButton);
  assert.equal(listWires.neutral_list_choice, 1);
  assert.equal(buttonWires.neutral_list_choice, 0);
  assert.equal(extractBasicKindWires({ ...listChoice, directListChildPresent: null }).neutral_list_choice, null);
  assert.equal(extractBasicKindWires({ ...listChoice, descendantTextPresent: null }).neutral_list_choice, null);

  const listResult = classifyBasicKind(listChoice, DEFAULT_BASIC_KIND_CONFIG, profile);
  const buttonResult = classifyBasicKind(actionButton, DEFAULT_BASIC_KIND_CONFIG, profile);
  assert.equal(listResult.basicKind, "select");
  assert.equal(buttonResult.basicKind, "button");
  assert.ok(listResult.leafScores.select.min > listResult.leafScores.button.min);
  assert.ok(listResult.leafScores.select.min - listResult.leafScores.button.min >= 0.15);
  assert.ok(buttonResult.leafScores.button.min > buttonResult.leafScores.select.min);
  assert.deepEqual(
    computeBasicKindStageRawIntervals(
      "family",
      ["control"],
      { control: { neutral_list_choice: 0.85 } },
      extractBasicKindWires({ ...listChoice, directListChildPresent: null }),
    ),
    { control: { min: 0, max: 0.85 } },
  );

  for (const [tag, fields, expected] of [
    ["button", {}, "button"],
    ["input", { inputType: "text" }, "input"],
    ["select", {}, "select"],
  ]) {
    const native = {
      tag,
      role: null,
      contentEditable: false,
      ...fields,
      pointerCursor: true,
      parentPointerCursor: false,
      tabIndexFocus: true,
      directListChildPresent: true,
      descendantTextPresent: true,
    };
    const nativeWires = extractBasicKindWires(native);
    assert.equal(nativeWires.neutral_focusable_control, 0, tag);
    assert.equal(nativeWires.neutral_list_choice, 0, tag);
    assert.equal(classifyBasicKind(native, DEFAULT_BASIC_KIND_CONFIG, profile).basicKind, expected, tag);
  }
});

test("direct-list measurement is validated and survives the training property reader", () => {
  assert.equal(validateBasicKindProperties({ tag: "div", role: null }).directListChildPresent, null);
  assert.equal(validateBasicKindProperties({ tag: "div", role: null, directListChildPresent: true }).directListChildPresent, true);
  assert.throws(
    () => validateBasicKindProperties({ tag: "div", role: null, directListChildPresent: "true" }),
    /directListChildPresent/,
  );

  const request = {
    schemaVersion: 1,
    taskId: "dom.basic-kinds.v1",
    rows: [{
      sampleId: "direct-list-reader",
      inputRef: { snapshotRef: "snapshot-reader", documentRef: "document-reader", frameRef: "top", nodeRef: "node-reader", index: 0 },
      provenanceRef: "evidence-reader",
      sourceAssociations: { snapshotRefs: ["snapshot-reader"], postRefs: [], assetRefs: [] },
      candidateQualification: { status: "ok", reasons: [] },
      captureCoverage: { frameContent: "captured", directChildren: "complete" },
      properties: { tag: "div", role: null, directListChildPresent: true },
      proposal: { ruleRef: null, label: null, status: "unmatched" },
      review: { status: "verified", expectedLabel: "select", reviewerRef: "reviewer-reader", evidenceRef: "review-reader", otherReason: null },
    }],
  };
  assert.equal(readBasicKindTrainingRequest(request).rows[0].properties.directListChildPresent, true);
  delete request.rows[0].properties.directListChildPresent;
  assert.equal(readBasicKindTrainingRequest(request).rows[0].properties.directListChildPresent, null);
});

test("choice wire migration registers explicit zeros without changing old intervals", () => {
  const cells = [
    ["familyWeights", "control", "neutral_focusable_control"],
    ["familyWeights", "control", "neutral_list_choice"],
    ["familyWeights", "structure", "neutral_focusable_control"],
    ["familyWeights", "structure", "neutral_list_choice"],
    ["leafWeights", "input", "neutral_focusable_control"],
    ["leafWeights", "input", "neutral_list_choice"],
    ["leafWeights", "button", "neutral_focusable_control"],
    ["leafWeights", "button", "neutral_list_choice"],
    ["leafWeights", "select", "neutral_focusable_control"],
    ["leafWeights", "select", "neutral_list_choice"],
    ["leafWeights", "container", "neutral_focusable_control"],
    ["leafWeights", "container", "neutral_list_choice"],
    ["leafWeights", "ignore", "neutral_focusable_control"],
    ["leafWeights", "ignore", "neutral_list_choice"],
  ];
  assert.ok(BASIC_KIND_WIRE_NAMES.includes("neutral_focusable_control"));
  assert.ok(BASIC_KIND_WIRE_NAMES.includes("neutral_list_choice"));
  const old = structuredClone(LEGACY_BASIC_KIND_PROFILE);
  for (const [group, target, wire] of cells) delete old[group][target][wire];
  const before = structuredClone(old);
  const migrated = migrateBasicKindProfile(old);
  assert.deepEqual(old, before);
  for (const [group, target, wire] of cells) assert.equal(migrated[group][target][wire], 0, `${group}.${target}.${wire}`);

  const wires = extractBasicKindWires({
    tag: "div",
    role: null,
    contentEditable: false,
    directTextPresent: false,
    childElementCount: 2,
    positiveAreaChildCount: 1,
    pointerCursor: true,
    parentPointerCursor: false,
    tabIndexFocus: true,
    directListChildPresent: true,
    descendantTextPresent: true,
  });
  const familyNames = Object.keys(BASIC_KIND_FAMILIES);
  const leafNames = Object.values(BASIC_KIND_FAMILIES).flat();
  assert.deepEqual(
    computeBasicKindStageRawIntervals("family", familyNames, migrated.familyWeights, wires),
    computeBasicKindStageRawIntervals("family", familyNames, old.familyWeights, wires),
  );
  assert.deepEqual(
    computeBasicKindStageRawIntervals("leaf", leafNames, migrated.leafWeights, wires),
    computeBasicKindStageRawIntervals("leaf", leafNames, old.leafWeights, wires),
  );
});

test("combobox family migration adds zero without changing original coefficients", () => {
  const old = structuredClone(LEGACY_BASIC_KIND_PROFILE);
  delete old.familyWeights.control.input_text_combobox;
  old.familyWeights.control.nat_input_tag = 0.37;
  old.familyWeights.control.role_select = 0.29;
  old.leafWeights.input.input_type_text = 0.61;
  const before = structuredClone(old);
  const migrated = migrateBasicKindProfile(old);
  assert.deepEqual(old, before);
  assert.equal(migrated.familyWeights.control.input_text_combobox, 0);
  assert.equal(migrated.familyWeights.control.nat_input_tag, 0.37);
  assert.equal(migrated.familyWeights.control.role_select, 0.29);
  assert.equal(migrated.leafWeights.input.input_type_text, 0.61);
});

const neutralMultiChildShapeWire = "neutral_multi_child_shape";
const warmBaseOnlyCells = [
  ["familyWeights", "structure", "div_repeated_children"],
  ["leafWeights", "ignore", "div_repeated_children"],
  ["leafWeights", "ignore", "neutral_structural_heterogeneity"],
  ["leafWeights", "ignore", "neutral_structural_peers"],
  ["leafWeights", "list", "neutral_inherited_pointer_wrapper"],
  ["leafWeights", "list", "neutral_multi_child"],
];

function fullWarmLayout() {
  const profile = structuredClone(PRIORITY_BASIC_KIND_INITIAL_PROFILE);
  for (const [group, target, wire] of warmBaseOnlyCells) profile[group][target][wire] = 0;
  return validateBasicKindProfile(profile);
}

function profileCellMap(profile) {
  const cells = new Map();
  for (const [group, rows] of [["familyWeights", profile.familyWeights], ["leafWeights", profile.leafWeights]]) {
    for (const [target, weights] of Object.entries(rows)) {
      for (const [wire, value] of Object.entries(weights)) cells.set(`${group}.${target}.${wire}`, value);
    }
  }
  return cells;
}

test("neutral_multi_child_shape follows the bounded neutral-multi-child formula", () => {
  const shape = (positiveAreaChildCount, aspectRatio) => extractBasicKindWires(validateBasicKindProperties({
    tag: "div",
    role: null,
    ...complete,
    childElementCount: positiveAreaChildCount,
    positiveAreaChildCount,
    aspectRatio,
  })).neutral_multi_child_shape;

  assert.equal(shape(2, 0.25), 0.25);
  assert.equal(shape(2, 0), 0);
  assert.equal(shape(1, 0.25), 0);
  assert.equal(shape(null, 0), 0);
  assert.equal(shape(0, null), 0);
  assert.equal(shape(null, 0.25), null);
  assert.equal(shape(2, null), null);
});

test("neutral_multi_child_shape completes the public schema without a support gate", () => {
  assert.equal(BASIC_KIND_WIRE_NAMES.length, 79);
  assert.equal(new Set(BASIC_KIND_WIRE_NAMES).size, 79);
  assert.equal(LEAF_SUPPORT_WIRES.list.includes(neutralMultiChildShapeWire), false);
  assert.equal(profileCellMap(fullWarmLayout()).size, 304);
});

test("neutral_multi_child_shape migration adds exactly one list zero and preserves old coefficients", () => {
  const source = fullWarmLayout();
  delete source.leafWeights.list[neutralMultiChildShapeWire];
  source.familyWeights.structure.nat_div = 0.29;
  source.leafWeights.list.nat_list = 0.83;
  source.leafWeights.container.div_multi_child = -0.37;
  const before = profileCellMap(source);
  const snapshot = structuredClone(source);

  const migrated = migrateBasicKindProfile(source);
  assert.deepEqual(source, snapshot);
  assert.equal(migrated.leafWeights.list[neutralMultiChildShapeWire], 0);

  const after = profileCellMap(migrated);
  assert.deepEqual([...after.keys()].filter(address => !before.has(address)), [`leafWeights.list.${neutralMultiChildShapeWire}`]);
  for (const [address, value] of before) assert.equal(after.get(address), value, address);
});

test("neutral_multi_child_shape changes public list scores without hard classification", () => {
  const input = validateBasicKindProperties({
    tag: "div",
    role: null,
    ...complete,
    childElementCount: 2,
    positiveAreaChildCount: 2,
    repeatedChildGeometry: true,
    aspectRatio: 0.25,
  });
  const zero = structuredClone(migrateBasicKindProfile(DEFAULT_BASIC_KIND_PROFILE));
  zero.id = "shape-zero";
  zero.leafWeights.list[neutralMultiChildShapeWire] = 0;
  const weighted = structuredClone(zero);
  weighted.id = "shape-weighted";
  weighted.leafWeights.list[neutralMultiChildShapeWire] = 0.5;

  const before = classifyBasicKind(input, DEFAULT_BASIC_KIND_CONFIG, zero);
  const after = classifyBasicKind(input, DEFAULT_BASIC_KIND_CONFIG, weighted);
  const term = after.evidence.activeTerms.find(item =>
    item.stage === "leaf"
    && item.target === "list"
    && item.wire === neutralMultiChildShapeWire);

  assert.equal(extractBasicKindWires(input).neutral_multi_child_shape, 0.25);
  assert.equal(after.family, before.family);
  assert.equal(after.basicKind, before.basicKind);
  assert.ok(after.leafScores.list.max > before.leafScores.list.max);
  assert.equal(term?.value, 0.25);
  assert.equal(term?.weight, 0.5);
  assert.deepEqual(term?.contribution, { min: 0.125, max: 0.125 });
});
