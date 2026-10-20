import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BASIC_KIND_WIRE_NAMES,
  DEFAULT_BASIC_KIND_CONFIG,
  PRIORITY_BASIC_KIND_INITIAL_PROFILE,
  buildExplorationInputs,
  classifyBasicKind,
  createStableNodeRefRegistry,
  deriveBasicKindContentRelations,
  extractBasicKindWires,
  migrateBasicKindProfile,
  observeLiveDom,
  stableNodeRefFor,
  validateBasicKindProperties,
} from "nnanything/browser-classify";
import { inspectBasicKindNumericSample } from "nnanything/training";

const handwiredRoot = "/Volumes/extension/code/handwired";
const coverage = { geometry: "assessed", fragments: "assessed", clipping: "assessed" };
const measured = {
  contentEditable: false,
  directTextPresent: false,
  nonFormatDirectTextPresent: false,
  beforeContentPresent: false,
  afterContentPresent: false,
  backgroundImagePresent: false,
  maskImagePresent: false,
  pointerCursor: false,
  parentPointerCursor: false,
  tabIndexFocus: false,
  descendantTextPresent: false,
};

function rect(x = 0, y = 0, width = 80, height = 40) {
  return { x, y, width, height };
}

function profileWith(assignments) {
  const profile = structuredClone(migrateBasicKindProfile(PRIORITY_BASIC_KIND_INITIAL_PROFILE));
  for (const group of ["familyWeights", "leafWeights"]) {
    for (const weights of Object.values(profile[group])) {
      for (const wire of Object.keys(weights)) weights[wire] = 0;
    }
  }
  for (const [group, target, wire, value] of assignments) profile[group][target][wire] = value;
  profile.id = "named-content-test";
  return profile;
}

function explorationFor({ child, hops = 2, backgroundImagePresent = false, role = null, tag = "span" }) {
  const parentRect = rect(0, 0, 120, 80);
  const childRect = rect(10, 10, 80, 40);
  const grandchildRect = rect(20, 15, 24, 24);
  const nodes = [
    { nodeRef: "parent", parentRef: null, tag: "span", role: null, rect: parentRect, fragments: [parentRect], clippedRect: parentRect, attributes: {} },
    { nodeRef: "child", parentRef: "parent", tag, role, rect: childRect, fragments: [childRect], clippedRect: childRect, attributes: {} },
    { nodeRef: "graphic", parentRef: "child", tag: child, role: null, rect: grandchildRect, fragments: [grandchildRect], clippedRect: grandchildRect, attributes: {} },
  ];
  const itemObservations = [
    { nodeRef: "parent", ...measured, childElementCount: 1, positiveAreaChildCount: 1 },
    { nodeRef: "child", ...measured, backgroundImagePresent, childElementCount: 1, positiveAreaChildCount: 1 },
    { nodeRef: "graphic", ...measured, childElementCount: 0, positiveAreaChildCount: 0 },
  ];
  return buildExplorationInputs({
    observation: { viewport: rect(0, 0, 640, 480), nodes, coverage },
    itemObservations,
    directChildrenStatus: "complete",
    maxRelationHops: hops,
    rootNodeRef: "parent",
  }).get("parent");
}

function namedOwnerProperties(overrides = {}) {
  return validateBasicKindProperties({
    tag: "span",
    role: null,
    ...measured,
    childElementCount: 1,
    positiveAreaChildCount: 1,
    ownLabelPresent: true,
    graphicDescendantPresent: true,
    ...overrides,
  });
}

function fakeElement(tag, box, children = [], options = {}) {
  const attributes = options.attributes ?? {};
  const element = {
    tagName: tag.toUpperCase(),
    parentElement: null,
    children,
    childNodes: options.childNodes ?? [],
    id: options.id ?? "",
    classList: [],
    getAttribute: name => attributes[name] ?? null,
    hasAttribute: name => Object.hasOwn(attributes, name),
    getBoundingClientRect: () => box,
    getClientRects: () => [box],
    querySelectorAll: () => [],
  };
  for (const child of children) child.parentElement = element;
  return element;
}

function liveFixture() {
  const parentBox = rect(0, 0, 120, 80);
  const childBox = rect(10, 10, 80, 40);
  const graphic = fakeElement("svg", rect(20, 15, 24, 24));
  const child = fakeElement("span", childBox, [graphic]);
  const html = fakeElement("html", rect(0, 0, 640, 480));
  const parent = fakeElement("span", parentBox, [child], {
    attributes: { title: "\u200b", "aria-label": "Synthetic media owner" },
  });
  html.children = [parent];
  parent.parentElement = html;
  const document = { documentElement: html, baseURI: "https://fixture.test/page" };
  const baseStyle = {
    display: "block", visibility: "visible", opacity: "1", position: "static", zIndex: "auto",
    transform: "none", translate: "none", rotate: "none", scale: "none", perspective: "none",
    overflowX: "visible", overflowY: "visible", clipPath: "none", clip: "auto", contain: "",
    pointerEvents: "auto", cursor: "auto", content: "none", backgroundImage: "none", maskImage: "none",
    webkitMaskImage: "none", backgroundColor: "transparent", backdropFilter: "none", filter: "none",
    isolation: "auto", mixBlendMode: "normal", backgroundClip: "border-box",
    borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: "0px", borderLeftWidth: "0px",
    borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none",
    borderTopColor: "rgba(0,0,0,0)", borderRightColor: "rgba(0,0,0,0)",
    borderBottomColor: "rgba(0,0,0,0)", borderLeftColor: "rgba(0,0,0,0)",
    borderTopLeftRadius: "0px", borderTopRightRadius: "0px", borderBottomLeftRadius: "0px", borderBottomRightRadius: "0px",
  };
  const window = {
    innerWidth: 640,
    innerHeight: 480,
    getComputedStyle: () => baseStyle,
  };
  return { document, window, parent };
}

test("recorded exploration proves actual graphic descendants without treating text-like cues as graphics", () => {
  assert.equal(deriveBasicKindContentRelations(explorationFor({ child: "svg" })).graphicDescendantPresent, true);
  assert.equal(deriveBasicKindContentRelations(explorationFor({ child: "span", backgroundImagePresent: true })).graphicDescendantPresent, true);
  assert.equal(deriveBasicKindContentRelations(explorationFor({ child: "span", role: "img" })).graphicDescendantPresent, true);

  const pseudoOnly = explorationFor({ child: "span" });
  pseudoOnly.containment.descendantEdges.find(edge => edge.targetRef === "child").target.beforeContentPresent = true;
  assert.equal(deriveBasicKindContentRelations(pseudoOnly).graphicDescendantPresent, false);

  const figureOnly = explorationFor({ child: "div", role: "figure" });
  assert.equal(deriveBasicKindContentRelations(figureOnly).graphicDescendantPresent, false);

  const incomplete = explorationFor({ child: "span" });
  incomplete.containment.descendantEdges.find(edge => edge.targetRef === "child").target.backgroundImagePresent = null;
  assert.equal(deriveBasicKindContentRelations(incomplete).graphicDescendantPresent, null);
  assert.equal(deriveBasicKindContentRelations(explorationFor({ child: "span", hops: 1 })).graphicDescendantPresent, null);
});

test("live DOM records bounded labels and graphic facts without raw label strings", () => {
  const fixture = liveFixture();
  const registry = createStableNodeRefRegistry("named-content-live");
  const snapshot = observeLiveDom({
    document: fixture.document,
    window: fixture.window,
    registry,
    excludeRoot: null,
    snapshotRef: "named-content",
    documentRef: "fixture",
  });
  const parentRef = stableNodeRefFor(registry, fixture.parent);
  const item = snapshot.itemObservations.find(observation => observation.nodeRef === parentRef);
  const properties = snapshot.properties.get(parentRef);
  const exploration = snapshot.explorationInputs.get(parentRef);
  assert.equal(item.ownLabelPresent, true);
  assert.equal(item.graphicDescendantPresent, true);
  assert.equal(properties.ownLabelPresent, true);
  assert.equal(properties.graphicDescendantPresent, true);
  assert.equal(exploration.measurementCoverage.ownLabelPresent, "measured");
  assert.equal(exploration.measurementCoverage.graphicDescendantPresent, "measured");
  assert.equal(Object.hasOwn(properties, "title"), false);
  assert.equal(Object.hasOwn(properties, "aria-label"), false);
});

test("named graphic owner balances media support against wrapper ignore without changing direct controls", () => {
  const named = namedOwnerProperties();
  assert.ok(BASIC_KIND_WIRE_NAMES.includes("neutral_named_graphic_owner"));
  assert.equal(extractBasicKindWires(named).neutral_named_graphic_owner, 1);
  assert.equal(extractBasicKindWires(namedOwnerProperties({ ownLabelPresent: false })).neutral_named_graphic_owner, 0);
  assert.equal(extractBasicKindWires(namedOwnerProperties({ graphicDescendantPresent: false })).neutral_named_graphic_owner, 0);
  assert.equal(extractBasicKindWires(namedOwnerProperties({ graphicDescendantPresent: null })).neutral_named_graphic_owner, null);
  assert.equal(extractBasicKindWires(namedOwnerProperties({ nonFormatDirectTextPresent: true })).neutral_named_graphic_owner, 0);

  const profile = profileWith([
    ["familyWeights", "media", "neutral_named_graphic_owner", 1],
    ["leafWeights", "image", "neutral_named_graphic_owner", 1],
    ["familyWeights", "structure", "neutral_named_graphic_owner", -0.7],
    ["leafWeights", "ignore", "neutral_named_graphic_owner", -0.7],
    ["familyWeights", "structure", "neutral_single_element_wrapper", 1],
    ["leafWeights", "ignore", "neutral_single_element_wrapper", 1],
    ["familyWeights", "control", "nat_control_button", 1],
    ["leafWeights", "button", "nat_control_button", 1],
    ["familyWeights", "control", "nat_input_tag", 1],
    ["leafWeights", "input", "nat_input_tag", 1],
    ["familyWeights", "control", "role_button", 1],
    ["leafWeights", "button", "role_button", 1],
  ]);
  assert.equal(classifyBasicKind(named, DEFAULT_BASIC_KIND_CONFIG, profile).basicKind, "image");
  assert.equal(classifyBasicKind(namedOwnerProperties({ ownLabelPresent: false }), DEFAULT_BASIC_KIND_CONFIG, profile).basicKind, "ignore");
  assert.notEqual(classifyBasicKind(namedOwnerProperties({ graphicDescendantPresent: false }), DEFAULT_BASIC_KIND_CONFIG, profile).basicKind, "image");
  assert.equal(classifyBasicKind(namedOwnerProperties({ tag: "button" }), DEFAULT_BASIC_KIND_CONFIG, profile).basicKind, "button");
  assert.equal(classifyBasicKind(namedOwnerProperties({ tag: "input", inputType: "text" }), DEFAULT_BASIC_KIND_CONFIG, profile).basicKind, "input");
  assert.equal(classifyBasicKind(namedOwnerProperties({ role: "button" }), DEFAULT_BASIC_KIND_CONFIG, profile).basicKind, "button");
});

test("old rows remain null and migration adds only zero named-owner addresses", () => {
  const old = validateBasicKindProperties({ tag: "span", role: null });
  assert.equal(old.ownLabelPresent, null);
  assert.equal(old.graphicDescendantPresent, null);

  const migrated = migrateBasicKindProfile(PRIORITY_BASIC_KIND_INITIAL_PROFILE);
  for (const [group, target] of [
    ["familyWeights", "media"],
    ["leafWeights", "image"],
    ["familyWeights", "structure"],
    ["leafWeights", "ignore"],
  ]) {
    assert.equal(migrated[group][target].neutral_named_graphic_owner, 0);
  }
  const oldProfile = structuredClone(migrated);
  for (const rows of [oldProfile.familyWeights, oldProfile.leafWeights]) {
    for (const weights of Object.values(rows)) delete weights.neutral_named_graphic_owner;
  }
  const cases = [namedOwnerProperties(), namedOwnerProperties({ ownLabelPresent: false })];
  for (const properties of cases) {
    assert.deepEqual(
      classifyBasicKind(properties, DEFAULT_BASIC_KIND_CONFIG, migrated),
      classifyBasicKind(properties, DEFAULT_BASIC_KIND_CONFIG, oldProfile),
    );
  }
});

test("formal and numeric paths share the named graphic owner intervals", async () => {
  const properties = namedOwnerProperties();
  const profile = profileWith([
    ["familyWeights", "media", "neutral_named_graphic_owner", 0.7],
    ["leafWeights", "image", "neutral_named_graphic_owner", 0.7],
    ["familyWeights", "structure", "neutral_single_element_wrapper", 0.2],
    ["leafWeights", "ignore", "neutral_single_element_wrapper", 0.2],
  ]);
  const formal = classifyBasicKind(properties, DEFAULT_BASIC_KIND_CONFIG, profile);
  const numeric = await inspectBasicKindNumericSample({
    handwiredRoot,
    properties,
    expectedLabel: "image",
    profile,
    config: {
      taskId: DEFAULT_BASIC_KIND_CONFIG.taskId,
      minScore: DEFAULT_BASIC_KIND_CONFIG.minScore,
      minMargin: DEFAULT_BASIC_KIND_CONFIG.minMargin,
      objective: { targetScore: 0.8, rivalCeiling: 0.4, otherGap: 0.05 },
      fit: { epochs: 0, learningRate: 0.01, anchorLambda: 0 },
    },
  });
  for (const family of ["media", "structure"]) {
    assert.ok(Math.abs(numeric.family[family].min - formal.familyScores[family].min) <= 2e-5, family);
    assert.ok(Math.abs(numeric.family[family].max - formal.familyScores[family].max) <= 2e-5, family);
  }
  assert.ok(Math.abs(numeric.leaf.image.min - formal.leafScores.image.min) <= 2e-5);
  assert.ok(Math.abs(numeric.leaf.ignore.min - formal.leafScores.ignore.min) <= 2e-5);
  assert.ok(Math.abs(numeric.familyGradients.media.neutral_named_graphic_owner) > 0);
});
