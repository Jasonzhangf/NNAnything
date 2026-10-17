import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compileWorkflow, createWorkflowInputEvent, loadWorkflow, runWorkflow } from "nnanything";
import { classifyBasicKind, classifyBasicKindBatch, domBasicKindsNode, migrateBasicKindProfile, validateBasicKindProfile, validateBasicKindProperties, LEGACY_BASIC_KIND_PROFILE, DEFAULT_BASIC_KIND_PROFILE, DEFAULT_BASIC_KIND_CONFIG, observeCandidates, validateCandidateRequest } from "nnanything/browser";

const complete = { contentEditable: false, directTextPresent: false, childElementCount: 0, positiveAreaChildCount: 0, repeatedChildGeometry: false, inVerifiedListParent: false, svgGraphicChildren: false };
const classify = (tag, fields = {}, profile) => classifyBasicKind({ tag, role: null, ...complete, ...fields }, DEFAULT_BASIC_KIND_CONFIG, profile);
const rect = { x: 10, y: 10, width: 80, height: 30 };
function batch() {
  return observeCandidates(validateCandidateRequest({ observation: { viewport: { x: 0, y: 0, width: 800, height: 600 }, nodes: [{ nodeRef: "one", tag: "button", role: null, parentRef: null, rect, fragments: [rect], clippedRect: rect, attributes: {} }] }, nodeRefs: ["one", "one", "missing"] }));
}

test("coarse family wins before only its leaf kinds execute", () => {
  const cases = [["button", {}, "control", "button"], ["textarea", {}, "control", "input"], ["select", {}, "control", "select"], ["img", {}, "media", "image"], ["video", {}, "media", "video"], ["audio", {}, "media", "audio"], ["a", { hrefPresent: true }, "navigation", "link"], ["p", {}, "text", "text"], ["article", {}, "structure", "container"], ["ul", {}, "structure", "list"], ["li", {}, "structure", "listitem"]];
  const leaves = { control: ["button", "input", "select"], media: ["image", "video", "audio"], navigation: ["link"], text: ["text"], structure: ["container", "list", "listitem"] };
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
