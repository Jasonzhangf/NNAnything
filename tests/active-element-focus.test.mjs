import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BASIC_KIND_FAMILIES,
  DEFAULT_BASIC_KIND_CONFIG,
  DEFAULT_BASIC_KIND_PROFILE,
  LEGACY_BASIC_KIND_PROFILE,
  buildExplorationInputs,
  classifyBasicKind,
  computeBasicKindStageRawIntervals,
  createStableNodeRefRegistry,
  extractBasicKindWires,
  migrateBasicKindProfile,
  observeLiveDom,
  readBasicKindTrainingRequest,
  stableNodeRefFor,
  validateBasicKindProperties,
  validateExplorationInput,
} from "nnanything/browser-classify";

const style = {
  display: "block",
  visibility: "visible",
  position: "static",
  transform: "none",
  translate: "none",
  rotate: "none",
  scale: "none",
  perspective: "none",
  overflowX: "visible",
  overflowY: "visible",
  clipPath: "none",
  clip: "auto",
  opacity: "1",
  zIndex: "auto",
  pointerEvents: "auto",
  cursor: "auto",
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  borderTopStyle: "none",
  borderRightStyle: "none",
  borderBottomStyle: "none",
  borderLeftStyle: "none",
  borderTopColor: "rgba(0, 0, 0, 0)",
  borderRightColor: "rgba(0, 0, 0, 0)",
  borderBottomColor: "rgba(0, 0, 0, 0)",
  borderLeftColor: "rgba(0, 0, 0, 0)",
  borderTopLeftRadius: "0px",
  borderTopRightRadius: "0px",
  borderBottomLeftRadius: "0px",
  borderBottomRightRadius: "0px",
  backgroundColor: "rgba(0, 0, 0, 0)",
  backgroundImage: "none",
  backgroundClip: "border-box",
  maskImage: "none",
  webkitMaskImage: "none",
  backdropFilter: "none",
  webkitBackdropFilter: "none",
  filter: "none",
  mixBlendMode: "normal",
  isolation: "auto",
  contain: "none",
  content: "none",
};

function focusDom() {
  const html = {
    nodeType: 1,
    tagName: "HTML",
    parentElement: null,
    children: [],
    childNodes: [],
    childElementCount: 0,
    id: "",
    classList: [],
    getAttribute: () => null,
    hasAttribute: () => false,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    getClientRects: () => [{ x: 0, y: 0, width: 800, height: 600 }],
    querySelectorAll: () => [],
  };
  const wrapper = {
    ...html,
    tagName: "DIV",
    parentElement: html,
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 200, height: 40 }),
    getClientRects: () => [{ x: 10, y: 10, width: 200, height: 40 }],
    getAttribute: name => name === "tabindex" ? "-1" : null,
  };
  const sibling = {
    ...html,
    tagName: "DIV",
    parentElement: html,
    getBoundingClientRect: () => ({ x: 10, y: 60, width: 200, height: 40 }),
    getClientRects: () => [{ x: 10, y: 60, width: 200, height: 40 }],
  };
  html.children = [wrapper, sibling];
  html.childNodes = [wrapper, sibling];
  html.childElementCount = 2;
  const document = {
    documentElement: html,
    body: html,
    baseURI: "https://fixture.test/page",
    activeElement: wrapper,
  };
  const window = { innerWidth: 800, innerHeight: 600, getComputedStyle: () => style };
  return { document, window, html, wrapper, sibling };
}

function observe(dom, registry = createStableNodeRefRegistry("active-focus")) {
  const snapshot = observeLiveDom({
    document: dom.document,
    window: dom.window,
    registry,
    excludeRoot: null,
    snapshotRef: "active-focus",
    documentRef: "fixture",
  });
  return {
    registry,
    snapshot,
    wrapperRef: stableNodeRefFor(registry, dom.wrapper),
    siblingRef: stableNodeRefFor(registry, dom.sibling),
  };
}

test("original observer keeps current focus separate from negative tabindex capability", () => {
  const dom = focusDom();
  const { snapshot, wrapperRef, siblingRef } = observe(dom);
  const wrapper = snapshot.properties.get(wrapperRef);
  assert.equal(wrapper.activeElementFocus, true);
  assert.equal(wrapper.tabIndexFocus, false);
  assert.equal(snapshot.properties.get(siblingRef).activeElementFocus, false);
  assert.equal(snapshot.itemObservations.find(item => item.nodeRef === wrapperRef).activeElementFocus, true);

  dom.document.activeElement = dom.sibling;
  const second = observe(dom);
  assert.equal(second.snapshot.properties.get(wrapperRef).activeElementFocus, false);
  assert.equal(second.snapshot.properties.get(siblingRef).activeElementFocus, true);
});

test("missing and unmappable activeElement stay null instead of becoming false", () => {
  const dom = focusDom();
  dom.document.activeElement = null;
  const missingNull = observe(dom);
  assert.equal(missingNull.snapshot.properties.get(missingNull.wrapperRef).activeElementFocus, null);
  assert.equal(missingNull.snapshot.properties.get(missingNull.siblingRef).activeElementFocus, null);

  delete dom.document.activeElement;
  const missingKey = observe(dom);
  assert.equal(missingKey.snapshot.properties.get(missingKey.wrapperRef).activeElementFocus, null);

  dom.document.activeElement = { nodeType: 1, tagName: "DIV" };
  const unmappable = observe(dom);
  assert.equal(unmappable.snapshot.properties.get(unmappable.wrapperRef).activeElementFocus, null);
  assert.equal(unmappable.snapshot.properties.get(unmappable.siblingRef).activeElementFocus, null);
});

test("same-document focus outside the observed subtree is false for observed nodes", () => {
  const dom = focusDom();
  const tool = {
    ...dom.html,
    tagName: "DIV",
    parentElement: dom.html,
    id: "codex-browser-sidebar-comments-root",
  };
  dom.html.children = [dom.wrapper, dom.sibling, tool];
  dom.html.childNodes = [dom.wrapper, dom.sibling, tool];
  dom.html.childElementCount = 3;
  dom.document.activeElement = tool;
  const { snapshot, wrapperRef, siblingRef } = observe(dom);
  assert.equal(snapshot.properties.get(wrapperRef).activeElementFocus, false);
  assert.equal(snapshot.properties.get(siblingRef).activeElementFocus, false);
});

test("loss of focus is visible on the next snapshot", () => {
  const dom = focusDom();
  const { snapshot, wrapperRef } = observe(dom);
  assert.equal(snapshot.properties.get(wrapperRef).activeElementFocus, true);

  dom.document.activeElement = dom.html;
  const moved = observe(dom);
  assert.equal(moved.snapshot.properties.get(wrapperRef).activeElementFocus, false);

  dom.document.activeElement = null;
  const lost = observe(dom);
  assert.equal(lost.snapshot.properties.get(wrapperRef).activeElementFocus, null);
});

test("active focus survives exploration, training and capture property projection", () => {
  const dom = focusDom();
  const { snapshot, wrapperRef } = observe(dom);
  const properties = snapshot.properties.get(wrapperRef);
  assert.equal(validateBasicKindProperties(properties).activeElementFocus, true);
  assert.equal(validateBasicKindProperties({ tag: "div", role: null }).activeElementFocus, null);
  assert.throws(() => validateBasicKindProperties({ tag: "div", role: null, activeElementFocus: "true" }), /activeElementFocus/);

  const exploration = buildExplorationInputs({
    observation: snapshot.observation,
    itemObservations: snapshot.itemObservations,
    maxRelationHops: 4,
  }).get(wrapperRef);
  assert.equal(exploration.measurementCoverage.activeElementFocus, "measured");
  assert.equal(validateExplorationInput(JSON.parse(JSON.stringify(exploration))).measurementCoverage.activeElementFocus, "measured");
  const legacyExploration = structuredClone(exploration);
  delete legacyExploration.measurementCoverage.activeElementFocus;
  assert.equal(validateExplorationInput(legacyExploration).measurementCoverage.activeElementFocus, "unmeasured");

  const row = {
    sampleId: "active-focus-row",
    inputRef: { snapshotRef: "active-focus", documentRef: "fixture", frameRef: "top", nodeRef: wrapperRef, index: 0 },
    provenanceRef: "active-focus-evidence",
    sourceAssociations: { snapshotRefs: ["active-focus"], postRefs: [], assetRefs: [] },
    candidateQualification: { status: "ok", reasons: [] },
    captureCoverage: { frameContent: "not_applicable", directChildren: "complete" },
    properties,
    proposal: { ruleRef: null, label: null, status: "unmatched" },
    review: { status: "verified", expectedLabel: "container", reviewerRef: "reviewer", evidenceRef: "active-focus-evidence", otherReason: null },
  };
  const request = readBasicKindTrainingRequest({ schemaVersion: 1, taskId: "dom.basic-kinds.v1", rows: [row] });
  assert.equal(request.rows[0].properties.activeElementFocus, true);
});

test("neutral_actual_focus is an independent nullable wire", () => {
  const base = {
    tag: "div",
    role: null,
    contentEditable: false,
    activeElementFocus: true,
    tabIndexFocus: false,
  };
  const active = extractBasicKindWires(base);
  assert.equal(active.neutral_actual_focus, 1);
  assert.equal(active.neutral_focusable_control, 0);
  assert.equal(extractBasicKindWires({ ...base, activeElementFocus: false }).neutral_actual_focus, 0);
  assert.equal(extractBasicKindWires({ ...base, activeElementFocus: null }).neutral_actual_focus, null);
  assert.equal(extractBasicKindWires({ ...base, tag: "button", activeElementFocus: true }).neutral_actual_focus, 0);

  const absent = extractBasicKindWires({ ...base, activeElementFocus: undefined });
  const explicitNull = extractBasicKindWires({ ...base, activeElementFocus: null });
  assert.deepEqual(absent, explicitNull);
});

test("neutral_actual_focus migrates to zero and does not change old scores when absent", () => {
  const addresses = [
    ["familyWeights", "control", "neutral_actual_focus"],
    ["familyWeights", "structure", "neutral_actual_focus"],
    ["leafWeights", "input", "neutral_actual_focus"],
    ["leafWeights", "button", "neutral_actual_focus"],
    ["leafWeights", "select", "neutral_actual_focus"],
    ["leafWeights", "container", "neutral_actual_focus"],
    ["leafWeights", "ignore", "neutral_actual_focus"],
  ];
  const old = structuredClone(LEGACY_BASIC_KIND_PROFILE);
  for (const [group, target, wire] of addresses) delete old[group][target][wire];
  const before = structuredClone(old);
  const migrated = migrateBasicKindProfile(old);
  assert.deepEqual(old, before);
  for (const [group, target, wire] of addresses) assert.equal(migrated[group][target][wire], 0, `${group}.${target}.${wire}`);

  const properties = {
    tag: "div",
    role: null,
    contentEditable: false,
    directTextPresent: false,
    childElementCount: 0,
    positiveAreaChildCount: 0,
    pointerCursor: false,
    parentPointerCursor: false,
    tabIndexFocus: false,
  };
  const wires = extractBasicKindWires(properties);
  assert.equal(wires.neutral_actual_focus, null);
  assert.deepEqual(
    computeBasicKindStageRawIntervals("family", Object.keys(BASIC_KIND_FAMILIES), migrated.familyWeights, wires),
    computeBasicKindStageRawIntervals("family", Object.keys(BASIC_KIND_FAMILIES), LEGACY_BASIC_KIND_PROFILE.familyWeights, wires),
  );
  assert.deepEqual(
    computeBasicKindStageRawIntervals("leaf", Object.values(BASIC_KIND_FAMILIES).flat(), migrated.leafWeights, wires),
    computeBasicKindStageRawIntervals("leaf", Object.values(BASIC_KIND_FAMILIES).flat(), LEGACY_BASIC_KIND_PROFILE.leafWeights, wires),
  );
});

test("explicit synthetic coefficient keeps an actually focused neutral container", () => {
  const profile = structuredClone(DEFAULT_BASIC_KIND_PROFILE);
  profile.id = "active-focus-synthetic";
  profile.topology = "priority_staged_v1";
  for (const rows of [profile.familyWeights, profile.leafWeights]) {
    for (const weights of Object.values(rows)) {
      for (const wire of Object.keys(weights)) weights[wire] = 0;
    }
  }
  profile.familyWeights.structure.neutral_actual_focus = 0.85;
  profile.leafWeights.container.neutral_actual_focus = 0.85;

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
    childElementCount: 0,
    positiveAreaChildCount: 0,
    repeatedChildGeometry: false,
    inVerifiedListParent: false,
    svgGraphicChildren: false,
    pointerCursor: false,
    parentPointerCursor: false,
    tabIndexFocus: false,
    borderPresent: false,
    aspectRatio: 1,
    descendantTextPresent: false,
    directListChildPresent: false,
    singleChildTag: null,
    singleChildSameRect: false,
    withinControlAncestor: false,
    inSvgAncestor: false,
    activeElementFocus: true,
  };
  const focused = classifyBasicKind(properties, DEFAULT_BASIC_KIND_CONFIG, profile);
  assert.equal(focused.judgmentStatus, "judged");
  assert.equal(focused.basicKind, "container");

  const unfocused = classifyBasicKind({ ...properties, activeElementFocus: false }, DEFAULT_BASIC_KIND_CONFIG, profile);
  assert.notEqual(unfocused.basicKind, "container");
});
