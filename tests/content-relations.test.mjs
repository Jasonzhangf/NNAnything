import assert from "node:assert/strict";
import { test } from "node:test";

import {
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
  validateExplorationInput,
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

function childSpec(ref, box, options = {}) {
  return {
    ref,
    tag: options.tag ?? "div",
    rect: box,
    role: options.role ?? null,
    directTextPresent: options.directTextPresent ?? false,
    nonFormatDirectTextPresent: options.nonFormatDirectTextPresent ?? false,
    beforeContentPresent: options.beforeContentPresent ?? false,
    afterContentPresent: options.afterContentPresent ?? false,
    backgroundImagePresent: options.backgroundImagePresent ?? false,
    maskImagePresent: options.maskImagePresent ?? false,
    childElementCount: options.childElementCount,
    unassessedInterior: options.unassessedInterior ?? null,
    grandchildren: options.grandchildren ?? [{ ref: `${ref}-g`, tag: "span", rect: rect(box.x + 4, box.y + 4, 20, 20) }],
  };
}

function contentRelationsExploration({ parentRect = rect(0, 0, 400, 100), children, maxRelationHops = 2 }) {
  const nodes = [{ nodeRef: "parent", parentRef: null, tag: "div", role: null, rect: parentRect, fragments: [parentRect], clippedRect: parentRect, attributes: {} }];
  const unassessedInteriors = new Map();
  const itemObservations = [{
    nodeRef: "parent", ...measured, childElementCount: children.length,
    positiveAreaChildCount: children.filter(child => child.rect.width > 0 && child.rect.height > 0).length,
  }];
  for (const child of children) {
    nodes.push({ nodeRef: child.ref, parentRef: "parent", tag: child.tag, role: child.role, rect: child.rect, fragments: [child.rect], clippedRect: child.rect, attributes: {} });
    if (child.unassessedInterior !== null) unassessedInteriors.set(child.ref, child.unassessedInterior);
    itemObservations.push({
      nodeRef: child.ref,
      contentEditable: false,
      directTextPresent: child.directTextPresent,
      nonFormatDirectTextPresent: child.nonFormatDirectTextPresent,
      beforeContentPresent: child.beforeContentPresent,
      afterContentPresent: child.afterContentPresent,
      backgroundImagePresent: child.backgroundImagePresent,
      maskImagePresent: child.maskImagePresent,
      childElementCount: child.childElementCount ?? child.grandchildren.length,
      positiveAreaChildCount: child.grandchildren.filter(grandchild => grandchild.rect.width > 0 && grandchild.rect.height > 0).length,
    });
    for (const grandchild of child.grandchildren) {
      nodes.push({
        nodeRef: grandchild.ref,
        parentRef: child.ref,
        tag: grandchild.tag,
        role: grandchild.role ?? null,
        rect: grandchild.rect,
        fragments: [grandchild.rect],
        clippedRect: grandchild.rect,
        attributes: {},
      });
      if (grandchild.unassessedInterior) unassessedInteriors.set(grandchild.ref, grandchild.unassessedInterior);
      itemObservations.push({
        nodeRef: grandchild.ref,
        directTextPresent: grandchild.directTextPresent ?? false,
        nonFormatDirectTextPresent: grandchild.nonFormatDirectTextPresent ?? false,
        beforeContentPresent: grandchild.beforeContentPresent ?? false,
        afterContentPresent: grandchild.afterContentPresent ?? false,
        backgroundImagePresent: grandchild.backgroundImagePresent ?? false,
        maskImagePresent: grandchild.maskImagePresent ?? false,
        childElementCount: 0,
        positiveAreaChildCount: 0,
      });
    }
  }
  return buildExplorationInputs({
    observation: { viewport: rect(0, 0, 1000, 800), nodes, coverage },
    itemObservations,
    directChildrenStatus: "complete",
    maxRelationHops,
    rootNodeRef: "parent",
    ...(unassessedInteriors.size > 0 ? { unassessedInteriors } : {}),
  }).get("parent");
}

function profileWith(assignments) {
  const profile = structuredClone(migrateBasicKindProfile(PRIORITY_BASIC_KIND_INITIAL_PROFILE));
  for (const group of ["familyWeights", "leafWeights"]) {
    for (const weights of Object.values(profile[group])) {
      for (const wire of Object.keys(weights)) weights[wire] = 0;
    }
  }
  for (const [group, target, wire, value] of assignments) profile[group][target][wire] = value;
  profile.id = "content-relations-test";
  return profile;
}

test("variable text sizes do not erase repeated shallow link structure", () => {
  const sizes = [[108.9, 16], [140.5, 16], [284.3, 42], [228.9, 42], [284.7, 42]];
  const links = sizes.map(([width, height], i) => childSpec(`link-${i}`, rect(0, i * 50, width, height), {
    tag: "a", directTextPresent: true, nonFormatDirectTextPresent: true, grandchildren: [],
  }));
  assert.equal(deriveBasicKindContentRelations(contentRelationsExploration({ children: links })).shallowStructuralPeerRatio, 1);
  const mixed = [130, 52, 52, 107.5].map((width, i) => childSpec(`anchor-${i}`, rect(i * 140, 0, width, 26), {
    tag: "a", directTextPresent: true, nonFormatDirectTextPresent: true, grandchildren: [],
  }));
  mixed.push(...[90, 38].map((width, i) => childSpec(`button-${i}`, rect(i * 100, 40, width, 22), {
    tag: "button", directTextPresent: true, nonFormatDirectTextPresent: true, grandchildren: [],
  })));
  assert.equal(deriveBasicKindContentRelations(contentRelationsExploration({ children: mixed })).shallowStructuralPeerRatio, 4 / 6);
});

function scorePeerShapes(exploration) {
  const relations = deriveBasicKindContentRelations(exploration);
  const properties = validateBasicKindProperties({
    tag: "div",
    role: null,
    ...measured,
    childElementCount: exploration.childComposition.children.length,
    positiveAreaChildCount: exploration.containment.positiveAreaChildRefs?.length ?? null,
    ...relations,
  });
  const profile = profileWith([
    ["familyWeights", "structure", "neutral_structural_peers", 0.7],
    ["familyWeights", "structure", "neutral_structural_heterogeneity", 0.7],
    ["leafWeights", "list", "neutral_structural_peers", 0.7],
    ["leafWeights", "container", "neutral_structural_heterogeneity", 0.7],
  ]);
  return { relations, wires: extractBasicKindWires(properties), judgment: classifyBasicKind(properties, DEFAULT_BASIC_KIND_CONFIG, profile) };
}

test("shallow peers separate four repeated DIV content units from mixed DIV components", () => {
  const peers = [0, 100, 200, 300].map(index => childSpec(`peer-${index}`, rect(index, 10, 80, 40)));
  const repeated = scorePeerShapes(contentRelationsExploration({ children: peers }));
  assert.equal(repeated.relations.shallowStructuralPeerRatio, 1);
  assert.equal(repeated.wires.neutral_structural_peers, 1);
  assert.equal(repeated.judgment.basicKind, "list");

  const mixed = [
    childSpec("mixed-0", rect(0, 10, 80, 40), { grandchildren: [{ ref: "mixed-0-g", tag: "span", rect: rect(2, 12, 20, 20) }] }),
    childSpec("mixed-1", rect(100, 10, 80, 40), { grandchildren: [{ ref: "mixed-1-g", tag: "button", rect: rect(102, 12, 20, 20) }] }),
    childSpec("mixed-2", rect(200, 10, 80, 40), { grandchildren: [{ ref: "mixed-2-g", tag: "svg", rect: rect(202, 12, 20, 20) }] }),
    childSpec("mixed-3", rect(300, 10, 80, 40), { grandchildren: [{ ref: "mixed-3-g", tag: "picture", rect: rect(302, 12, 20, 20) }] }),
  ];
  const heterogeneous = scorePeerShapes(contentRelationsExploration({ children: mixed }));
  assert.equal(heterogeneous.relations.shallowStructuralPeerRatio, 0);
  assert.equal(heterogeneous.wires.neutral_structural_heterogeneity, 1);
  assert.equal(heterogeneous.judgment.basicKind, "container");

  const unknown = contentRelationsExploration({ children: peers, maxRelationHops: 1 });
  assert.equal(deriveBasicKindContentRelations(unknown).shallowStructuralPeerRatio, null);
  assert.equal(extractBasicKindWires(validateBasicKindProperties({ tag: "div", role: null, ...measured, childElementCount: 4, positiveAreaChildCount: 4 })).neutral_structural_peers, null);
});

test("same-tag repeated anchors separate navigation from a mixed toolbar", () => {
  const repeated = [0, 100, 200, 300, 400].map(index => childSpec(`nav-${index}`, rect(index, 10, 80, 40)));
  const nav = scorePeerShapes(contentRelationsExploration({ parentRect: rect(0, 0, 500, 100), children: repeated }));
  assert.equal(nav.relations.shallowStructuralPeerRatio, 1);
  assert.equal(nav.judgment.basicKind, "list");

  const toolbar = repeated.map((child, index) => childSpec(child.ref, child.rect, {
    directTextPresent: index % 2 === 0,
    nonFormatDirectTextPresent: index % 2 === 0,
    grandchildren: [{ ref: `${child.ref}-g`, tag: ["span", "svg", "img", "input", "div"][index], rect: rect(index * 100 + 4, 14, 20, 20) }],
  }));
  const mixed = scorePeerShapes(contentRelationsExploration({ parentRect: rect(0, 0, 500, 100), children: toolbar }));
  assert.equal(mixed.relations.shallowStructuralPeerRatio, 0);
  assert.equal(mixed.judgment.basicKind, "container");
});

test("coincident layers separate an overlapping graphics wrapper from side-by-side graphics", () => {
  const layered = contentRelationsExploration({
    parentRect: rect(0, 0, 120, 80),
    children: [
      childSpec("svg-layer", rect(0, 0, 120, 80), { grandchildren: [{ ref: "svg-layer-g", tag: "path", rect: rect(10, 10, 100, 60) }] }),
      childSpec("background-layer", rect(0, 0, 120, 80), { backgroundImagePresent: true, grandchildren: [{ ref: "background-layer-g", tag: "div", rect: rect(0, 0, 120, 80) }] }),
    ],
  });
  assert.equal(deriveBasicKindContentRelations(layered).coincidentChildPairRatio, 1);
  const properties = validateBasicKindProperties({ tag: "div", role: null, ...measured, childElementCount: 2, positiveAreaChildCount: 2, ...deriveBasicKindContentRelations(layered) });
  const profile = profileWith([
    ["familyWeights", "structure", "neutral_coincident_layer_wrapper", 0.7],
    ["leafWeights", "ignore", "neutral_coincident_layer_wrapper", 0.7],
  ]);
  assert.equal(extractBasicKindWires(properties).neutral_coincident_layer_wrapper, 1);
  assert.equal(classifyBasicKind(properties, DEFAULT_BASIC_KIND_CONFIG, profile).basicKind, "ignore");

  const sideBySide = contentRelationsExploration({
    parentRect: rect(0, 0, 240, 80),
    children: [
      childSpec("left-graphic", rect(0, 0, 110, 80), { grandchildren: [{ ref: "left-graphic-g", tag: "path", rect: rect(10, 10, 80, 60) }] }),
      childSpec("right-graphic", rect(130, 0, 110, 80), { grandchildren: [{ ref: "right-graphic-g", tag: "path", rect: rect(140, 10, 80, 60) }] }),
    ],
  });
  assert.equal(deriveBasicKindContentRelations(sideBySide).coincidentChildPairRatio, 0);
  const sideProperties = validateBasicKindProperties({ tag: "div", role: null, ...measured, childElementCount: 2, positiveAreaChildCount: 2, ...deriveBasicKindContentRelations(sideBySide) });
  assert.equal(extractBasicKindWires(sideProperties).neutral_coincident_layer_wrapper, 0);
});

test("single positive wrapper survives zero-width support but not independent own carriers", () => {
  const base = { tag: "div", role: null, ...measured, childElementCount: 2, positiveAreaChildCount: 1, shallowStructuralPeerRatio: 0, coincidentChildPairRatio: 0 };
  assert.equal(extractBasicKindWires(base).neutral_single_positive_wrapper, 1);
  for (const counterexample of [
    { pointerCursor: true, parentPointerCursor: false },
    { tabIndexFocus: true },
    { directTextPresent: true, nonFormatDirectTextPresent: true },
    { backgroundImagePresent: true },
  ]) {
    assert.equal(extractBasicKindWires({ ...base, ...counterexample }).neutral_single_positive_wrapper, 0, JSON.stringify(counterexample));
  }
  assert.equal(extractBasicKindWires({ ...base, maskImagePresent: null }).neutral_single_positive_wrapper, null);
});

test("old properties stay null and migration adds only zero new coefficients", () => {
  const old = validateBasicKindProperties({ tag: "div", role: null });
  assert.equal(old.shallowStructuralPeerRatio, null);
  assert.equal(old.coincidentChildPairRatio, null);

  const profile = structuredClone(migrateBasicKindProfile(PRIORITY_BASIC_KIND_INITIAL_PROFILE));
  for (const [group, target, wire] of [
    ["familyWeights", "structure", "neutral_structural_peers"],
    ["familyWeights", "structure", "neutral_structural_heterogeneity"],
    ["familyWeights", "structure", "neutral_single_positive_wrapper"],
    ["familyWeights", "structure", "neutral_coincident_layer_wrapper"],
    ["leafWeights", "list", "neutral_structural_peers"],
    ["leafWeights", "list", "neutral_structural_heterogeneity"],
    ["leafWeights", "container", "neutral_structural_peers"],
    ["leafWeights", "container", "neutral_structural_heterogeneity"],
    ["leafWeights", "container", "neutral_single_positive_wrapper"],
    ["leafWeights", "container", "neutral_coincident_layer_wrapper"],
    ["leafWeights", "ignore", "neutral_single_positive_wrapper"],
    ["leafWeights", "ignore", "neutral_coincident_layer_wrapper"],
  ]) {
    profile[group][target][wire] = 0;
  }
  const oldProfile = structuredClone(profile);
  for (const row of Object.values(oldProfile.familyWeights)) for (const wire of Object.keys(row)) if (wire.startsWith("neutral_structural_") || wire === "neutral_single_positive_wrapper" || wire === "neutral_coincident_layer_wrapper") delete row[wire];
  for (const row of Object.values(oldProfile.leafWeights)) for (const wire of Object.keys(row)) if (wire.startsWith("neutral_structural_") || wire === "neutral_single_positive_wrapper" || wire === "neutral_coincident_layer_wrapper") delete row[wire];
  const migrated = migrateBasicKindProfile(oldProfile);
  assert.equal(migrated.familyWeights.structure.neutral_structural_peers, 0);
  assert.equal(migrated.leafWeights.ignore.neutral_single_positive_wrapper, 0);

  const cases = [
    { tag: "button", role: null },
    { tag: "div", role: null, ...measured, childElementCount: 4, positiveAreaChildCount: 4 },
    { tag: "div", role: null, ...measured, childElementCount: 2, positiveAreaChildCount: 2 },
  ];
  for (const properties of cases) {
    assert.deepEqual(
      classifyBasicKind(properties, DEFAULT_BASIC_KIND_CONFIG, migrated),
      classifyBasicKind(properties, DEFAULT_BASIC_KIND_CONFIG, oldProfile),
    );
  }
});

test("unmeasured child counts and missing hop-one records remain unknown", () => {
  const complete = contentRelationsExploration({ children: [] });
  const unmeasured = structuredClone(complete);
  unmeasured.childComposition.directChildrenStatus = "unknown";
  unmeasured.containment.positiveAreaChildRefs = null;
  unmeasured.measurementCoverage.positiveAreaChildCount = "unmeasured";
  assert.deepEqual(deriveBasicKindContentRelations(unmeasured), {
    shallowStructuralPeerRatio: null, coincidentChildPairRatio: null,
    graphicDescendantPresent: null,
  });
  const withChildren = contentRelationsExploration({ children: [childSpec("one", rect()), childSpec("two", rect(100))] });
  const missingEdges = structuredClone(withChildren);
  missingEdges.containment.descendantEdges = [];
  assert.equal(deriveBasicKindContentRelations(missingEdges).shallowStructuralPeerRatio, null);
});

test("relative topology distinguishes unread hop-two interiors from unread hop-one children", () => {
  const children = [
    childSpec("left", rect(0, 0, 180, 80), {
      tag: "div",
      grandchildren: [{ ref: "left-frame", tag: "iframe", rect: rect(10, 10, 160, 60), unassessedInterior: ["iframe"] }],
    }),
    childSpec("right", rect(200, 0, 180, 80), {
      tag: "div",
      grandchildren: [{ ref: "right-image", tag: "img", rect: rect(210, 10, 160, 60) }],
    }),
  ];
  const deeperInterior = contentRelationsExploration({ children });
  assert.equal(deeperInterior.containment.descendantBoundary, "incomplete_observation");
  assert.deepEqual(
    deeperInterior.containment.descendantEdges.find(edge => edge.targetRef === "left-frame").target.unassessedInterior,
    ["iframe"],
  );
  assert.equal(deriveBasicKindContentRelations(deeperInterior).shallowStructuralPeerRatio, 0);

  const unreadHopOne = contentRelationsExploration({
    children: children.map(child => child.ref === "left" ? { ...child, unassessedInterior: ["iframe"] } : child),
  });
  assert.equal(deriveBasicKindContentRelations(unreadHopOne).shallowStructuralPeerRatio, null);

  const countMismatch = contentRelationsExploration({
    children: children.map(child => child.ref === "left" ? { ...child, childElementCount: 2 } : child),
  });
  assert.equal(deriveBasicKindContentRelations(countMismatch).shallowStructuralPeerRatio, null);
});

test("coincident textarea peers occupy one spatial slot without changing variable link peers", () => {
  const duplicated = contentRelationsExploration({
    parentRect: rect(0, 0, 300, 45),
    children: [
      childSpec("textarea-a", rect(0, 0, 300, 40.78), { tag: "textarea", grandchildren: [] }),
      childSpec("textarea-b", rect(0, 0, 300, 40.78), { tag: "textarea", grandchildren: [] }),
    ],
  });
  const relations = deriveBasicKindContentRelations(duplicated);
  assert.equal(relations.shallowStructuralPeerRatio, 0);
  assert.equal(relations.coincidentChildPairRatio, 0);

  const sizes = [[108.9, 16], [140.5, 16], [284.3, 42], [228.9, 42], [284.7, 42]];
  const links = sizes.map(([width, height], index) => childSpec(`link-${index}`, rect(0, index * 50, width, height), {
    tag: "a", directTextPresent: true, nonFormatDirectTextPresent: true, grandchildren: [],
  }));
  assert.equal(deriveBasicKindContentRelations(contentRelationsExploration({ children: links })).shallowStructuralPeerRatio, 1);
});

test("legacy relative summaries keep the old complete fallback and do not invent incomplete coverage", () => {
  const peers = [0, 100, 200, 300].map(index => childSpec(`peer-${index}`, rect(index, 10, 80, 40)));
  const complete = contentRelationsExploration({ children: peers });
  assert.equal(complete.containment.descendantEdges[0].target.childElementCount, 1);
  assert.equal(complete.containment.descendantEdges[0].target.directChildrenStatus, "complete");
  assert.deepEqual(complete.containment.descendantEdges[0].target.unassessedInterior, []);

  const legacy = structuredClone(complete);
  for (const edge of legacy.containment.descendantEdges) {
    delete edge.target.childElementCount;
    delete edge.target.directChildrenStatus;
    delete edge.target.unassessedInterior;
  }
  for (const child of legacy.childComposition.children) {
    delete child.childElementCount;
    delete child.directChildrenStatus;
    delete child.unassessedInterior;
  }
  const restored = validateExplorationInput(JSON.parse(JSON.stringify(legacy)));
  assert.equal(Object.hasOwn(restored.containment.descendantEdges[0].target, "childElementCount"), false);
  assert.equal(Object.hasOwn(restored.containment.descendantEdges[0].target, "directChildrenStatus"), false);
  assert.equal(Object.hasOwn(restored.containment.descendantEdges[0].target, "unassessedInterior"), false);
  assert.equal(deriveBasicKindContentRelations(legacy).shallowStructuralPeerRatio, 1);

  const incomplete = structuredClone(legacy);
  incomplete.containment.descendantBoundary = "incomplete_observation";
  assert.equal(deriveBasicKindContentRelations(incomplete).shallowStructuralPeerRatio, null);
});

test("graphic evidence stays positive while bounded negative coverage remains complete", () => {
  const complete = contentRelationsExploration({
    children: [childSpec("plain", rect(0, 0, 180, 80), {
      tag: "div",
      grandchildren: [{ ref: "plain-child", tag: "span", rect: rect(10, 10, 160, 60) }],
    })],
  });
  assert.equal(deriveBasicKindContentRelations(complete).graphicDescendantPresent, false);

  const positiveWithUnreadInterior = contentRelationsExploration({
    children: [childSpec("media", rect(0, 0, 180, 80), {
      tag: "div",
      unassessedInterior: ["iframe"],
      grandchildren: [{ ref: "media-image", tag: "img", rect: rect(10, 10, 160, 60) }],
    })],
  });
  assert.equal(deriveBasicKindContentRelations(positiveWithUnreadInterior).graphicDescendantPresent, true);

  const boundedUnknown = contentRelationsExploration({
    children: [childSpec("unknown", rect(0, 0, 180, 80), {
      tag: "div",
      unassessedInterior: ["iframe"],
      grandchildren: [{ ref: "unknown-child", tag: "span", rect: rect(10, 10, 160, 60) }],
    })],
  });
  assert.equal(deriveBasicKindContentRelations(boundedUnknown).graphicDescendantPresent, null);
});

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

function liveDomFixture() {
  const parentBox = rect(0, 0, 400, 100);
  const children = [0, 100, 200, 300].map(index => {
    const grandchild = fakeElement("span", rect(index + 4, 14, 20, 20));
    return fakeElement("div", rect(index, 10, 80, 40), [grandchild]);
  });
  const html = fakeElement("html", parentBox);
  const parent = fakeElement("div", parentBox, children, { id: "relations-parent" });
  html.children = [parent];
  parent.parentElement = html;
  const document = { documentElement: html, baseURI: "https://fixture.test/page" };
  const style = {
    display: "block", visibility: "visible", opacity: "1", position: "static", zIndex: "auto",
    transform: "none", translate: "none", rotate: "none", scale: "none", perspective: "none",
    overflowX: "visible", overflowY: "visible", clipPath: "none", clip: "auto", contain: "",
    pointerEvents: "auto", cursor: "auto", content: "none", backgroundImage: "none", maskImage: "none",
    webkitMaskImage: "none", backgroundColor: "transparent", backdropFilter: "none", filter: "none",
    isolation: "auto", mixBlendMode: "normal", backgroundClip: "border-box",
    borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: "0px", borderLeftWidth: "0px",
    borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none",
    borderTopColor: "rgba(0,0,0,0)", borderRightColor: "rgba(0,0,0,0)", borderBottomColor: "rgba(0,0,0,0)", borderLeftColor: "rgba(0,0,0,0)",
    borderTopLeftRadius: "0px", borderTopRightRadius: "0px", borderBottomLeftRadius: "0px", borderBottomRightRadius: "0px",
  };
  const window = { innerWidth: 1000, innerHeight: 800, getComputedStyle: () => style };
  return { document, window, parent };
}

test("public live consumer and numeric graph share the new relation cells", async () => {
  const properties = validateBasicKindProperties({
    tag: "div", role: null, ...measured, childElementCount: 4, positiveAreaChildCount: 4,
    shallowStructuralPeerRatio: 0.75, coincidentChildPairRatio: 0.25,
  });
  const profile = profileWith([
    ["familyWeights", "structure", "neutral_structural_peers", 0.4],
    ["leafWeights", "list", "neutral_structural_peers", 0.4],
    ["leafWeights", "container", "neutral_structural_heterogeneity", 0.3],
    ["leafWeights", "ignore", "neutral_single_positive_wrapper", 0.2],
    ["leafWeights", "ignore", "neutral_coincident_layer_wrapper", 0.2],
  ]);
  const formal = classifyBasicKind(properties, DEFAULT_BASIC_KIND_CONFIG, profile);
  const numeric = await inspectBasicKindNumericSample({
    handwiredRoot,
    properties,
    expectedLabel: "list",
    profile,
    config: {
      taskId: DEFAULT_BASIC_KIND_CONFIG.taskId,
      minScore: DEFAULT_BASIC_KIND_CONFIG.minScore,
      minMargin: DEFAULT_BASIC_KIND_CONFIG.minMargin,
      objective: { targetScore: 0.8, rivalCeiling: 0.4, otherGap: 0.05 },
      fit: { epochs: 0, learningRate: 0.01, anchorLambda: 0 },
    },
  });
  assert.ok(Math.abs(numeric.family.structure.min - formal.familyScores.structure.min) <= 2e-5);
  assert.ok(Math.abs(numeric.leaf.list.min - formal.leafScores.list.min) <= 2e-5);
  assert.ok(Math.abs(numeric.familyGradients.structure.neutral_structural_peers) > 0);

  const dom = liveDomFixture();
  const registry = createStableNodeRefRegistry("content-relations-live");
  const snapshot = observeLiveDom({ document: dom.document, window: dom.window, registry, excludeRoot: null, snapshotRef: "relations", documentRef: "fixture" });
  const parentRef = stableNodeRefFor(registry, dom.parent);
  const exploration = snapshot.explorationInputs.get(parentRef);
  const expected = deriveBasicKindContentRelations(exploration);
  const item = snapshot.itemObservations.find(observation => observation.nodeRef === parentRef);
  assert.equal(item.shallowStructuralPeerRatio, expected.shallowStructuralPeerRatio);
  assert.equal(item.coincidentChildPairRatio, expected.coincidentChildPairRatio);
  assert.equal(snapshot.properties.get(parentRef).shallowStructuralPeerRatio, expected.shallowStructuralPeerRatio);
  assert.equal(snapshot.properties.get(parentRef).coincidentChildPairRatio, expected.coincidentChildPairRatio);

  const old = structuredClone(exploration);
  delete old.measurementCoverage.shallowStructuralPeerRatio;
  delete old.measurementCoverage.coincidentChildPairRatio;
  assert.doesNotThrow(() => validateBasicKindProperties({ tag: "div", role: null }));
});
