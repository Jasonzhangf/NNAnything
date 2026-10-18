import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BROWSER_CAPTURE_REQUEST_EVENT_TYPE,
  BROWSER_OVERLAY_REQUEST_EVENT_TYPE,
  BrowserCaptureSession,
  buildExplorationInputs,
  DEFAULT_BASIC_KIND_CONFIG,
  DEFAULT_BASIC_KIND_PROFILE,
  LEGACY_BASIC_KIND_PROFILE,
  checkCandidates,
  classifyBasicKindBatch,
  compileWorkflow,
  createBrowserCaptureNodeDefinitions,
  createBrowserOverlayNodeDefinitions,
  createFocusSpec,
  createStableNodeRefRegistry,
  stableNodeRefFor,
  resolveStableNodeRef,
  createWorkflowInputEvent,
  extractTrainingRequestFromBundle,
  observeCandidates,
  observeLiveDom,
  parseBrowserWeightAsset,
  prepareBasicKindSamples,
  readBasicKindTrainingRequest,
  runWorkflow,
} from "nnanything/browser-classify";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const viewport = { x: 0, y: 0, width: 800, height: 600 };
const assessedCoverage = {
  geometry: "assessed",
  fragments: "assessed",
  clipping: "assessed",
};

function rect(x = 0, y = 0, width = 100, height = 40) {
  return { x, y, width, height };
}

function observationNode(nodeRef, overrides = {}) {
  const box = overrides.rect === null ? null : overrides.rect ?? rect();
  return {
    nodeRef,
    parentRef: overrides.parentRef ?? null,
    tag: overrides.tag ?? "button",
    role: overrides.role ?? null,
    rect: box,
    fragments: overrides.fragments ?? (box === null ? null : [box]),
    clippedRect: overrides.clippedRect === undefined ? box : overrides.clippedRect,
    attributes: overrides.attributes ?? {},
  };
}

function basicProperties(tag, overrides = {}) {
  return {
    tag,
    role: null,
    inputType: null,
    hrefPresent: null,
    contentEditable: false,
    directTextPresent: false,
    nonFormatDirectTextPresent: null,
    beforeContentPresent: null,
    afterContentPresent: null,
    backgroundImagePresent: null,
    maskImagePresent: null,
    childElementCount: 0,
    positiveAreaChildCount: 0,
    repeatedChildGeometry: null,
    inVerifiedListParent: null,
    svgGraphicChildren: null,
    pointerCursor: null,
    parentPointerCursor: null,
    tabIndexFocus: null,
    borderPresent: null,
    aspectRatio: null,
    descendantTextPresent: null,
    directListChildPresent: null,
    singleChildTag: null,
    singleChildSameRect: null,
    withinControlAncestor: null,
    inSvgAncestor: null,
    disabled: false,
    hidden: false,
    ...overrides,
  };
}

function snapshotFixture({ pageRef = "page-fixture", nodes, properties, evidence }) {
  const observation = {
    viewport,
    nodes: nodes.map((node) => observationNode(node.ref, node)),
    coverage: assessedCoverage,
  };
  const propertyMap = new Map(
    nodes.map((node) => [node.ref, properties[node.ref] ?? basicProperties(node.tag ?? "button")]),
  );
  const evidenceMap = new Map(
    nodes.map((node) => [node.ref, {
      nodeRef: node.ref,
      tag: node.tag ?? "button",
      id: node.ref === "button" ? "secret-id" : null,
      classList: node.ref === "button" ? ["secret-class"] : [],
      textSummary: node.ref === "button" ? "visible label" : null,
      linkPathname: null,
      rect: node.rect === undefined ? rect() : node.rect,
      clippedRect: node.clippedRect === undefined ? (node.rect === undefined ? rect() : node.rect) : node.clippedRect,
      parentTags: ["main"],
      pageRef,
      unassessedChildContent: [],
      ...(evidence?.[node.ref] ?? {}),
    }]),
  );
  return {
    snapshotRef: "snapshot-fixture",
    documentRef: "document-fixture",
    frameRef: "frame-main",
    pageRef,
    observation,
    itemObservations: nodes.map((node) => {
      const propertiesValue = propertyMap.get(node.ref);
      return {
        nodeRef: node.ref,
        inputType: propertiesValue.inputType,
        hrefPresent: propertiesValue.hrefPresent,
        contentEditable: propertiesValue.contentEditable,
        directTextPresent: propertiesValue.directTextPresent,
        nonFormatDirectTextPresent: propertiesValue.nonFormatDirectTextPresent,
        beforeContentPresent: propertiesValue.beforeContentPresent,
        afterContentPresent: propertiesValue.afterContentPresent,
        backgroundImagePresent: propertiesValue.backgroundImagePresent,
        maskImagePresent: propertiesValue.maskImagePresent,
        childElementCount: propertiesValue.childElementCount,
        positiveAreaChildCount: propertiesValue.positiveAreaChildCount,
        repeatedChildGeometry: propertiesValue.repeatedChildGeometry,
        inVerifiedListParent: propertiesValue.inVerifiedListParent,
        svgGraphicChildren: propertiesValue.svgGraphicChildren,
        pointerCursor: propertiesValue.pointerCursor,
        parentPointerCursor: propertiesValue.parentPointerCursor,
        tabIndexFocus: propertiesValue.tabIndexFocus,
        borderPresent: propertiesValue.borderPresent,
        aspectRatio: propertiesValue.aspectRatio,
        descendantTextPresent: propertiesValue.descendantTextPresent,
        directListChildPresent: propertiesValue.directListChildPresent,
        singleChildTag: propertiesValue.singleChildTag,
        singleChildSameRect: propertiesValue.singleChildSameRect,
        withinControlAncestor: propertiesValue.withinControlAncestor,
        inSvgAncestor: propertiesValue.inSvgAncestor,
      };
    }),
    properties: propertyMap,
    evidence: evidenceMap,
    coverage: {
      scope: "top_document_only",
      frameContent: "captured",
      directChildren: "complete",
      traversedElementCount: nodes.length,
      excludedElementCount: 0,
      unassessedIframeCount: 0,
      unassessedOpenShadowRootCount: 0,
      closedShadowRootDetection: "not_available",
    },
    resolveElement: () => null,
  };
}

function makeFrame() {
  const { profile, config } = fixtureWeight();
  const snapshot = snapshotFixture({
    nodes: [
      { ref: "button", tag: "button", rect: rect(10, 10, 120, 40) },
      { ref: "unknown", tag: "x-unknown", rect: rect(10, 70, 120, 20) },
      { ref: "conflict", tag: "span", role: "button", rect: rect(10, 100, 120, 20) },
      { ref: "filtered", tag: "button", rect: rect(900, 10, 120, 40) },
      { ref: "candidate-unknown", tag: "x-unknown", rect: null },
      { ref: "ignored-parent", tag: "div", rect: rect(10, 170, 120, 40) },
      { ref: "ignored-child", tag: "button", parentRef: "ignored-parent", rect: rect(10, 170, 120, 40) },
    ],
    properties: {
      button: basicProperties("button"),
      unknown: basicProperties("x-unknown"),
      conflict: basicProperties("span", { role: "button" }),
      filtered: basicProperties("button"),
      "candidate-unknown": basicProperties("x-unknown"),
      "ignored-parent": basicProperties("div", {
        directTextPresent: false,
        nonFormatDirectTextPresent: false,
        beforeContentPresent: false,
        afterContentPresent: false,
        backgroundImagePresent: false,
        maskImagePresent: false,
        childElementCount: 1,
        positiveAreaChildCount: 1,
        singleChildTag: "button",
        singleChildSameRect: true,
      }),
      "ignored-child": basicProperties("button"),
    },
  });
  const focusSpec = createFocusSpec();
  const candidateBatch = checkCandidates(observeCandidates({ observation: snapshot.observation }), focusSpec);
  const basicKindBatch = classifyBasicKindBatch(
    { ...candidateBatch, itemObservations: snapshot.itemObservations },
    config,
    profile,
  );
  const candidateSlots = basicKindBatch.slots.filter(slot => slot.candidateStatus === "ok");
  return {
    snapshot,
    focusSpec,
    profileId: profile.id,
    candidateBatch,
    basicKindBatch,
    boxes: [],
    presentation: {
      view: {
        boxes: [],
        counts: {
          totalNodes: basicKindBatch.slots.length,
          candidates: candidateSlots.length,
          judged: candidateSlots.filter(slot => slot.judgmentStatus === "judged").length,
          unknown: candidateSlots.filter(slot => slot.judgmentStatus === "unknown").length,
          conflict: candidateSlots.filter(slot => slot.judgmentStatus === "conflict").length,
          ignored: candidateSlots.filter(slot => slot.judgmentStatus === "judged" && slot.basicKind === "ignore").length,
          unresolved: candidateSlots.filter(slot => slot.judgmentStatus === "unknown" || slot.judgmentStatus === "conflict").length,
          excluded: basicKindBatch.slots.filter(slot => slot.candidateStatus !== "ok").length,
          candidateUnknown: basicKindBatch.slots.filter(slot => slot.candidateStatus === "unknown").length,
        },
        focus: null,
        coverage: snapshot.coverage,
        profileId: profile.id,
        focusSpec,
        confidenceState: "uncalibrated",
      },
      receipt: null,
    },
  };
}

function validWeightAsset() {
  return {
    targetOperator: "dom.basic_kinds",
    operatorVersion: "0.1.0",
    contractVersion: 1,
    taskId: "dom.basic-kinds.v1",
    profileId: DEFAULT_BASIC_KIND_PROFILE.id,
    baseProfileId: DEFAULT_BASIC_KIND_PROFILE.id,
    calibrated: false,
    compatibility: {
      taskId: "dom.basic-kinds.v1",
      minScore: 0.7,
      minMargin: 0.2,
    },
    profile: structuredClone(DEFAULT_BASIC_KIND_PROFILE),
  };
}

function fixtureWeight(profileId = "dom-basic-kinds-overlay-fixture-v1") {
  const profile = structuredClone(DEFAULT_BASIC_KIND_PROFILE);
  for (const rows of [profile.familyWeights, profile.leafWeights]) {
    for (const row of Object.values(rows)) {
      for (const wire of Object.keys(row)) row[wire] = 0;
    }
  }
  [profile.familyWeights.structure, profile.leafWeights.ignore]
    .forEach(row => { row.neutral_same_rect_wrapper = 1; });
  [profile.familyWeights.control, profile.leafWeights.button]
    .forEach(row => { row.nat_control_button = 1; });
  profile.familyWeights.control.role_button = 0.8;
  profile.familyWeights.text.nat_span = 0.8;
  profile.id = profileId;
  const asset = validWeightAsset();
  asset.profileId = profileId;
  asset.profile = profile;
  return parseBrowserWeightAsset(asset, "fixture weights");
}

test("browser weight assets reject reports and invalid compatibility without mutating old state", () => {
  const previous = {
    profile: DEFAULT_BASIC_KIND_PROFILE,
    config: DEFAULT_BASIC_KIND_CONFIG,
  };
  const before = structuredClone(previous);
  const parsed = parseBrowserWeightAsset(JSON.stringify(validWeightAsset()), "local weight");
  assert.equal(parsed.profile.id, DEFAULT_BASIC_KIND_PROFILE.id);
  assert.deepEqual(parsed.config, { taskId: "dom.basic-kinds.v1", minScore: 0.7, minMargin: 0.2 });
  assert.equal(parsed.sourceLabel, "local weight");
  assert.equal(parsed.calibrated, false);
  assert.deepEqual(previous, before);

  assert.throws(() => parseBrowserWeightAsset("{broken"), /JSON/i);
  assert.throws(
    () => parseBrowserWeightAsset({ schemaVersion: 1, recommendation: "candidate_rejected_regression" }),
    /result|report|recommendation/i,
  );
  assert.throws(
    () => parseBrowserWeightAsset({ ...validWeightAsset(), taskId: "other.task" }),
    /task/i,
  );
  const rootMismatch = validWeightAsset();
  rootMismatch.compatibility.taskId = "other.task";
  assert.throws(() => parseBrowserWeightAsset(rootMismatch), /task/i);
  const badScore = validWeightAsset();
  badScore.compatibility.minScore = 0;
  assert.throws(() => parseBrowserWeightAsset(badScore), /minScore/i);
  assert.deepEqual(previous, before);
});

test("browser weight loading migrates old DOM profiles without adopting new defaults", () => {
  const asset = validWeightAsset();
  asset.profile = structuredClone(LEGACY_BASIC_KIND_PROFILE);
  delete asset.profile.familyWeights.media.nat_svg;
  delete asset.profile.familyWeights.media.svg_graphic_children;
  delete asset.profile.leafWeights.image.nat_svg;
  delete asset.profile.leafWeights.image.svg_graphic_children;
  delete asset.profile.familyWeights.structure.div_single_child;
  delete asset.profile.leafWeights.container.div_single_child;
  delete asset.profile.familyWeights.text.div_leaf;
  delete asset.profile.leafWeights.text.div_leaf;
  delete asset.profile.familyWeights.text.div_direct_text;
  delete asset.profile.leafWeights.text.div_direct_text;
  asset.profileId = asset.profile.id;
  const before = structuredClone(asset);
  const parsed = parseBrowserWeightAsset(asset);
  assert.deepEqual(asset, before);
  assert.equal(parsed.profile.id, LEGACY_BASIC_KIND_PROFILE.id);
  assert.equal(parsed.profile.familyWeights.media.nat_svg, 0);
  assert.equal(parsed.profile.leafWeights.image.svg_graphic_children, 0);
  assert.equal(parsed.profile.familyWeights.structure.div_single_child, 0);
  assert.equal(parsed.profile.leafWeights.container.div_single_child, 0);
  assert.equal(parsed.profile.familyWeights.text.div_leaf, 0);
  assert.equal(parsed.profile.leafWeights.text.div_direct_text, 0);
  assert.equal(parsed.config.minScore, 0.7);
});

test("selected capture requires explicit confirmation and never auto-promotes a proposal", () => {
  const frame = makeFrame();
  const session = new BrowserCaptureSession({ sessionId: "session-review", createdAt: "2026-10-17T12:00:00.000Z" });

  const correct = session.captureSelected(frame, "button", { kind: "correct" });
  assert.equal(correct.reviewStatus, "verified");
  let bundle = session.toBundle();
  assert.equal(bundle.trainingRequest.rows[0].review.expectedLabel, "button");
  assert.equal(bundle.trainingRequest.rows[0].review.reviewerRef, "human:browser-overlay");
  assert.equal(bundle.trainingRequest.rows[0].proposal.status, "matched");

  const wrong = session.captureSelected(frame, "button", { kind: "wrong" });
  assert.equal(wrong.reviewStatus, "rejected");
  assert.equal(session.stats().total, 1);
  bundle = session.toBundle();
  assert.equal(bundle.trainingRequest.rows[0].review.expectedLabel, null);
  assert.equal(bundle.trainingRequest.rows[0].review.reviewerRef, null);
  assert.equal(bundle.trainingRequest.rows[0].review.evidenceRef, null);
  const prepared = prepareBasicKindSamples(bundle.trainingRequest, {
    taskId: "dom.basic-kinds.v1",
    inputScope: "candidate_qualified",
  });
  assert.deepEqual(prepared.includedIndices, []);

  assert.throws(
    () => session.captureSelected(frame, "button", { kind: "wrong", correctedLabel: "other" }),
    /reason/i,
  );
  const other = session.captureSelected(frame, "button", {
    kind: "wrong",
    correctedLabel: "other",
    otherReason: "confirmed outside the taxonomy",
  });
  assert.equal(other.reviewStatus, "verified");
  assert.equal(session.toBundle().trainingRequest.rows[0].review.expectedLabel, "other");
  assert.equal(
    session.toBundle().trainingRequest.rows[0].review.otherReason,
    "confirmed outside the taxonomy",
  );

  const unsure = session.captureSelected(frame, "button", { kind: "unsure" });
  assert.equal(unsure.reviewStatus, "ambiguous");
  const unsureReview = session.toBundle().trainingRequest.rows[0].review;
  assert.deepEqual(unsureReview, {
    status: "ambiguous",
    expectedLabel: null,
    reviewerRef: null,
    evidenceRef: null,
    otherReason: null,
  });
});

test("unknown bulk includes only qualified unknown slots and preserves existing reviews", () => {
  const frame = makeFrame();
  const session = new BrowserCaptureSession({ sessionId: "session-unknown", createdAt: "2026-10-17T12:00:00.000Z" });
  assert.throws(() => session.captureSelected(frame, "unknown", { kind: "correct" }), /concrete|other/i);

  const receipt = session.collectUnknown(frame);
  assert.equal(receipt.eligibleUnknown, 1);
  assert.equal(receipt.collected, 1);
  assert.equal(receipt.existingReviewed, 0);
  const refs = session.toBundle().trainingRequest.rows.map((row) => row.inputRef.nodeRef);
  assert.deepEqual(refs, ["unknown"]);
  assert.equal(session.toBundle().trainingRequest.rows[0].review.status, "unreviewed");

  const conflict = session.captureSelected(frame, "conflict", { kind: "unsure" });
  assert.equal(conflict.reviewStatus, "ambiguous");
  session.captureSelected(frame, "unknown", { kind: "wrong", correctedLabel: "text" });
  const second = session.collectUnknown(frame);
  assert.equal(second.collected, 0);
  assert.equal(second.existingReviewed, 1);
  assert.equal(session.stats().ambiguous, 1);
});

test("unresolved bulk collects every qualified unknown and conflict without relabeling either", () => {
  const frame = makeFrame();
  const session = new BrowserCaptureSession({ sessionId: "session-unresolved", createdAt: "2026-10-17T12:00:00.000Z" });
  const receipt = session.collectUnresolved(frame);
  assert.equal(receipt.eligibleUnknown, 1);
  assert.equal(receipt.eligibleConflict, 1);
  assert.equal(receipt.collected, 2);
  const bundle = session.toBundle();
  assert.deepEqual(bundle.trainingRequest.rows.map(row => row.inputRef.nodeRef).sort(), ["conflict", "unknown"]);
  assert.deepEqual(bundle.trainingRequest.rows.map(row => row.proposal.status).sort(), ["conflict", "unknown"]);
  assert.ok(bundle.trainingRequest.rows.every(row => row.review.status === "unreviewed" && row.review.expectedLabel === null));

  session.captureSelected(frame, "conflict", { kind: "unsure" });
  session.captureSelected(frame, "unknown", { kind: "wrong", correctedLabel: "text" });
  const repeated = session.collectUnresolved(frame);
  assert.equal(repeated.collected, 0);
  assert.equal(repeated.existingReviewed, 2);
  assert.equal(repeated.existingPending, 0);

  const oldSession = new BrowserCaptureSession({ sessionId: "session-old", createdAt: "2026-10-17T12:00:00.000Z" });
  assert.equal(oldSession.collectUnknown(frame).collected, 1);
  assert.deepEqual(oldSession.toBundle().trainingRequest.rows.map(row => row.inputRef.nodeRef).sort(), ["unknown"]);
});

test("capture carries raw exploration through export and prepare without relabeling", () => {
  const frame = makeFrame();
  frame.snapshot.explorationInputs = buildExplorationInputs({ observation: frame.snapshot.observation, itemObservations: frame.snapshot.itemObservations, maxRelationHops: 4, directChildrenStatus: "complete" });
  const session = new BrowserCaptureSession({ sessionId: "exploration", createdAt: "2026-10-17T12:00:00.000Z" });
  session.captureSelected(frame, "unknown", { kind: "unsure" });
  const request = extractTrainingRequestFromBundle(JSON.parse(JSON.stringify(session.toBundle())));
  assert.deepEqual(request.rows[0].explorationInput, frame.snapshot.explorationInputs.get("unknown"));
  assert.equal(request.rows[0].review.status, "ambiguous");
  assert.equal(JSON.stringify(request.rows[0].explorationInput).includes("secret-class"), false);
  const prepared = prepareBasicKindSamples(request, { taskId: "dom.basic-kinds.v1", inputScope: "candidate_qualified" });
  assert.equal(prepared.includedIndices.length, 0);
  assert.deepEqual(prepared.rows[0].explorationInput, request.rows[0].explorationInput);
});

test("capture export preserves order, reindexes without a 2500 row cap, and keeps student fields clean", () => {
  const count = 2501;
  const { profile, config } = fixtureWeight("dom-basic-kinds-overlay-large-fixture-v1");
  const nodes = Array.from({ length: count }, (_, index) => ({
    ref: `unknown-${index}`,
    tag: "x-unknown",
    rect: rect(0, index % 500, 10, 10),
  }));
  const properties = Object.fromEntries(nodes.map((node) => [
    node.ref,
    basicProperties("x-unknown"),
  ]));
  const snapshot = snapshotFixture({ nodes, properties, evidence: {
    "unknown-0": { id: "secret-id", classList: ["secret-class"], textSummary: "visible label" },
  } });
  const candidateBatch = checkCandidates(observeCandidates({ observation: snapshot.observation }), createFocusSpec());
  const basicKindBatch = classifyBasicKindBatch(
    { ...candidateBatch, itemObservations: snapshot.itemObservations },
    config,
    profile,
  );
  assert.ok(basicKindBatch.slots.every(slot => slot.candidateStatus === "ok" && slot.judgmentStatus === "unknown"));
  const frame = {
    snapshot,
    focusSpec: createFocusSpec(),
    profileId: profile.id,
    candidateBatch,
    basicKindBatch,
    boxes: [],
    presentation: { view: {}, receipt: null },
  };
  const session = new BrowserCaptureSession({ sessionId: "session-large", createdAt: "2026-10-17T12:00:00.000Z" });
  const receipt = session.collectUnknown(frame);
  assert.equal(receipt.collected, count);
  const bundle = session.toBundle();
  assert.equal(bundle.trainingRequest.rows.length, count);
  assert.deepEqual(bundle.trainingRequest.rows.map((row) => row.inputRef.index), Array.from({ length: count }, (_, index) => index));
  assert.deepEqual(bundle.trainingRequest.rows.map((row) => row.inputRef.nodeRef), nodes.map((node) => node.ref));
  assert.doesNotThrow(() => readBasicKindTrainingRequest(bundle.trainingRequest));
  const studentText = JSON.stringify(bundle.trainingRequest);
  assert.equal(studentText.includes("secret-class"), false);
  assert.equal(studentText.includes("secret-id"), false);
  assert.equal(studentText.includes("visible label"), false);
  assert.equal(studentText.includes("input.value"), false);
  assert.equal(studentText.includes("https://"), false);
  assert.match(JSON.stringify(bundle.evidenceSidecar), /secret-class/);
});

test("bundle extraction is strict and rejects wrong kinds, corruption and unknown student fields", () => {
  const session = new BrowserCaptureSession({ sessionId: "session-strict", createdAt: "2026-10-17T12:00:00.000Z" });
  session.captureSelected(makeFrame(), "button", { kind: "correct" });
  const bundle = session.toBundle();
  assert.deepEqual(extractTrainingRequestFromBundle(bundle), bundle.trainingRequest);

  assert.throws(() => extractTrainingRequestFromBundle({ ...bundle, kind: "wrong" }), /kind/i);
  const unknownStudent = structuredClone(bundle);
  unknownStudent.trainingRequest.rows[0].properties.className = "leak";
  assert.throws(() => extractTrainingRequestFromBundle(unknownStudent), /unsupported|properties/i);
  const missingSidecar = structuredClone(bundle);
  delete missingSidecar.evidenceSidecar[missingSidecar.trainingRequest.rows[0].provenanceRef];
  assert.throws(() => extractTrainingRequestFromBundle(missingSidecar), /evidence|provenance/i);
  const sourceMismatch = structuredClone(bundle);
  sourceMismatch.trainingRequest.rows[0].sourceAssociations.snapshotRefs = ["other-snapshot"];
  assert.throws(() => extractTrainingRequestFromBundle(sourceMismatch), /snapshot/i);
});

function fakeDom() {
  const html = {
    nodeType: 1,
    tagName: "HTML",
    parentElement: null,
    children: [],
    childNodes: [],
    id: "",
    classList: [],
    getAttribute: () => null,
    hasAttribute: () => false,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    getClientRects: () => [{ x: 0, y: 0, width: 800, height: 600 }],
    querySelectorAll: () => [],
  };
  const document = {
    documentElement: html,
    body: html,
    baseURI: "https://fixture.test/page",
  };
  const style = {
    overflowX: "visible",
    overflowY: "visible",
    transform: "none",
    clipPath: "none",
    clip: "auto",
    display: "block",
    visibility: "visible",
    position: "static",
  };
  const window = {
    innerWidth: 800,
    innerHeight: 600,
    getComputedStyle: () => style,
  };
  return { document, window };
}

function liveMeasurementDom() {
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
  const document = { documentElement: html, body: html, baseURI: "https://fixture.test/page" };
  const style = { display: "block", visibility: "visible", transform: "none", overflowX: "visible", overflowY: "visible", clipPath: "none", clip: "auto" };
  const window = { innerWidth: 800, innerHeight: 600, getComputedStyle: () => style };
  return { document, window, html };
}

test("capture excludes the injected tool subtree while retaining normal fixed and shadow nodes", () => {
  const dom = liveMeasurementDom(), { html } = dom;
  const style = { display: "block", visibility: "visible", transform: "none", overflowX: "visible", overflowY: "visible", clipPath: "none", clip: "auto", position: "fixed", content: "none", backgroundImage: "none", maskImage: "none", webkitMaskImage: "none" };
  const normalFixed = { ...html, tagName: "ASIDE", parentElement: html, children: [], childNodes: [], childElementCount: 0, id: "normal-fixed", getAttribute: () => null };
  const shadowHost = { ...html, tagName: "DIV", parentElement: html, children: [], childNodes: [], childElementCount: 0, id: "regular-shadow", shadowRoot: { mode: "open" }, getAttribute: () => null };
  const tool = { ...html, tagName: "DIV", parentElement: html, children: [], childNodes: [], childElementCount: 0, id: "codex-browser-sidebar-comments-root", shadowRoot: { mode: "open" }, getAttribute: () => null };
  const toolChild = { ...html, tagName: "SPAN", parentElement: tool, children: [], childNodes: [], childElementCount: 0, id: "tool-child", getAttribute: () => null };
  tool.children = [toolChild];
  tool.querySelectorAll = () => [toolChild];
  html.children = [normalFixed, shadowHost, tool];
  dom.window.getComputedStyle = () => style;
  const registry = createStableNodeRefRegistry("excluded-tool-root");
  const snapshot = observeLiveDom({ document: dom.document, window: dom.window, registry, excludeRoot: null, snapshotRef: "excluded", documentRef: "fixture" });
  assert.equal(snapshot.observation.nodes.some(node => node.nodeRef === stableNodeRefFor(registry, tool)), false);
  assert.equal(snapshot.observation.nodes.some(node => node.nodeRef === stableNodeRefFor(registry, toolChild)), false);
  assert.equal(snapshot.observation.nodes.some(node => node.nodeRef === stableNodeRefFor(registry, normalFixed)), true);
  assert.equal(snapshot.observation.nodes.some(node => node.nodeRef === stableNodeRefFor(registry, shadowHost)), true);
  assert.equal(snapshot.coverage.excludedElementCount, 2);
  assert.equal(snapshot.coverage.unassessedOpenShadowRootCount, 1);
  assert.equal(snapshot.itemObservations.find(item => item.nodeRef === stableNodeRefFor(registry, html)).childElementCount, 2);
  assert.equal(snapshot.explorationInputs.get(stableNodeRefFor(registry, html)).containment.childRefs.length, 2);
});

test("live appearance measurements preserve raw text and derive CSS declarations without leaking raw values", () => {
  const dom = liveMeasurementDom(), { html } = dom;
  const formatSpan = { ...html, tagName: "SPAN", parentElement: html, children: [], childElementCount: 0,
    childNodes: [{ nodeType: 3, textContent: "\u200b" }], getAttribute: () => null };
  const realText = { ...html, tagName: "B", parentElement: html, children: [], childElementCount: 0,
    childNodes: [{ nodeType: 3, textContent: "真实文字" }], getAttribute: () => null };
  const missingCss = { ...html, tagName: "SPAN", parentElement: html, children: [], childElementCount: 0,
    childNodes: [{ nodeType: 3, textContent: "e\u0301" }], getAttribute: () => null };
  html.children = [formatSpan, realText, missingCss];
  dom.window.getComputedStyle = element => element === formatSpan
    ? { display: "block", visibility: "visible", transform: "none", overflowX: "visible", overflowY: "visible", clipPath: "none", clip: "auto", content: "none", backgroundImage: "none", maskImage: "none" }
    : element === realText
      ? { display: "block", visibility: "visible", transform: "none", overflowX: "visible", overflowY: "visible", clipPath: "none", clip: "auto", content: "url(secret.svg)", backgroundImage: "url(https://secret.test/a.png)", maskImage: "none, url(#m)" }
      : { display: "block", visibility: "visible", transform: "none", overflowX: "visible", overflowY: "visible", clipPath: "none", clip: "auto" };
  const registry = createStableNodeRefRegistry("appearance-test");
  const snapshot = observeLiveDom({ document: dom.document, window: dom.window, registry, excludeRoot: null, snapshotRef: "appearance", documentRef: "fixture" });
  const properties = node => snapshot.properties.get(stableNodeRefFor(registry, node));
  assert.equal(properties(formatSpan).directTextPresent, true);
  assert.equal(properties(formatSpan).nonFormatDirectTextPresent, false);
  assert.equal(properties(realText).nonFormatDirectTextPresent, true);
  assert.equal(properties(missingCss).nonFormatDirectTextPresent, true);
  assert.equal(properties(formatSpan).beforeContentPresent, false);
  assert.equal(properties(formatSpan).backgroundImagePresent, false);
  assert.equal(properties(realText).beforeContentPresent, true);
  assert.equal(properties(realText).backgroundImagePresent, true);
  assert.equal(properties(realText).maskImagePresent, true);
  assert.equal(properties(missingCss).beforeContentPresent, null);
  assert.equal(properties(missingCss).backgroundImagePresent, null);
  assert.equal(properties(missingCss).maskImagePresent, null);
  const studentJson = JSON.stringify({ observations: snapshot.itemObservations, properties: [...snapshot.properties] });
  assert.equal(studentJson.includes("secret.svg"), false);
  assert.equal(studentJson.includes("secret.test"), false);
});

test("translated cards retain measured clipping for descendants; non-translation transforms remain unknown", () => {
  for (const [transform, measured, individual = {}] of [
    ["none", true], ["matrix(1, 0, 0, 1, 0, 0)", true],
    ["matrix(1, 0, 0, 1, 258.5, 384.59375)", true],
    ["matrix(0.8, 0, 0, 0.8, 258.5, 0)", false],
    ["matrix(0, 1, -1, 0, 0, 0)", false],
    ["matrix(1, 0, 0.25, 1, 0, 0)", false],
    ["matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 1, 1)", false],
    ["none", false, { rotate: "10deg" }],
    ["none", false, { scale: "1.7" }],
    ["none", false, { perspective: "500px" }],
    ["none", false, { translate: "10px 20px" }],
  ]) {
    const dom = fakeDom(), root = dom.document.documentElement;
    root.clientLeft = 5; root.clientTop = 7;
    root.clientWidth = 790; root.clientHeight = 100;
    const card = { ...root, tagName: "SECTION", parentElement: root, children: [], childNodes: [],
      getBoundingClientRect: () => ({ x: 200, y: 80, width: 300, height: 100 }),
      getClientRects: () => [{ x: 200, y: 80, width: 300, height: 100 }],
    };
    const child = { ...card, tagName: "IMG", parentElement: card, children: [], childNodes: [],
      getBoundingClientRect: () => ({ x: 210, y: 85, width: 100, height: 50 }),
      getClientRects: () => [{ x: 210, y: 85, width: 100, height: 50 }],
    };
    root.children = [card]; card.children = [child];
    const baseStyle = dom.window.getComputedStyle();
    dom.window.getComputedStyle = el => ({ ...baseStyle, ...(el === card ? individual : {}), transform: el === card ? transform : "none", overflowY: el === root ? "hidden" : "visible" });
    const registry = createStableNodeRefRegistry("translation-test");
    const snapshot = observeLiveDom({ ...dom, registry, excludeRoot: null, snapshotRef: "translated", documentRef: "fixture" });
    assert.deepEqual(snapshot.evidence.get(stableNodeRefFor(registry, card)).clippedRect,
      measured ? { x: 200, y: 80, width: 300, height: 27 } : null, transform);
    assert.deepEqual(snapshot.evidence.get(stableNodeRefFor(registry, child)).clippedRect,
      measured ? { x: 210, y: 85, width: 100, height: 22 } : null, `${transform}: child`);
  }
});

test("live DOM measures declared list parent, repeated geometry and SVG children without closest", () => {
  const dom = liveMeasurementDom(), { html } = dom;
  const style = { display: "block", visibility: "visible", transform: "none", overflowX: "visible", overflowY: "visible", clipPath: "none", clip: "auto" };
  const list = { ...html, tagName: "UL", parentElement: html, children: [], childNodes: [], childElementCount: 0, getAttribute: () => null };
  const first = { ...html, tagName: "DIV", parentElement: list, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 10, y: 20, width: 60, height: 30 }) };
  const second = { ...html, tagName: "DIV", parentElement: list, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 72, y: 20, width: 60, height: 30 }) };
  const svg = { ...html, tagName: "SVG", parentElement: html, children: [], childNodes: [], childElementCount: 1,
    getAttribute: name => name === "role" ? null : null };
  const path = { ...html, tagName: "PATH", parentElement: svg, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 20, y: 20, width: 10, height: 10 }) };
  const emptySvg = { ...html, tagName: "SVG", parentElement: html, children: [], childNodes: [], childElementCount: 0 };
  const unresolvedSvg = { ...html, tagName: "SVG", parentElement: html, children: [], childNodes: [], childElementCount: 0 };
  list.children = [first, second]; first.children = []; second.children = [];
  svg.children = [path]; path.parentElement = svg;
  html.children = [list, svg, emptySvg, unresolvedSvg]; list.parentElement = html; svg.parentElement = html; emptySvg.parentElement = html; unresolvedSvg.parentElement = html;
  dom.window.getComputedStyle = element => element === unresolvedSvg
    ? { ...style, visibility: "hidden" }
    : { display: "block", visibility: "visible", transform: "none", overflowX: "visible", overflowY: "visible", clipPath: "none", clip: "auto" };
  const registry = createStableNodeRefRegistry("measurement-test");
  const snapshot = observeLiveDom({ ...dom, registry, excludeRoot: null, snapshotRef: "measurements", documentRef: "fixture" });
  const observation = node => snapshot.itemObservations.find(item => item.nodeRef === stableNodeRefFor(registry, node));
  assert.equal(observation(second).inVerifiedListParent, true);
  assert.equal(observation(second).repeatedChildGeometry, false);
  assert.equal(observation(svg).svgGraphicChildren, true);
  assert.equal(observation(emptySvg).svgGraphicChildren, false);
  assert.equal(observation(path).svgGraphicChildren, false);
  assert.equal(typeof first.closest, "undefined");

  const repeatedParent = { ...html, tagName: "DIV", parentElement: html, children: [first, second], childNodes: [], childElementCount: 2 };
  const alignedFirst = { ...first, parentElement: repeatedParent, getBoundingClientRect: () => ({ x: 10, y: 20, width: 60, height: 30 }) };
  const alignedSecond = { ...second, parentElement: repeatedParent, getBoundingClientRect: () => ({ x: 72, y: 21, width: 62, height: 31 }) };
  repeatedParent.children = [alignedFirst, alignedSecond];
  html.children = [repeatedParent, svg];
  const repeatedRegistry = createStableNodeRefRegistry("repeated-test");
  dom.window.getComputedStyle = () => ({ display: "block", visibility: "visible", transform: "none", overflowX: "visible", overflowY: "visible", clipPath: "none", clip: "auto" });
  const repeatedSnapshot = observeLiveDom({ ...dom, registry: repeatedRegistry, excludeRoot: null, snapshotRef: "repeated", documentRef: "fixture" });
  assert.equal(repeatedSnapshot.itemObservations.find(item => item.nodeRef === stableNodeRefFor(repeatedRegistry, repeatedParent)).repeatedChildGeometry, true);
  assert.equal(repeatedSnapshot.itemObservations.find(item => item.nodeRef === stableNodeRefFor(repeatedRegistry, alignedFirst)).repeatedChildGeometry, false);
});

test("live DOM measures the nine optional interaction facts without inventing missing values", () => {
  const dom = liveMeasurementDom(), { html } = dom;
  const style = { display: "block", visibility: "visible", transform: "none", overflowX: "visible", overflowY: "visible", clipPath: "none", clip: "auto",
    pointerEvents: "auto", cursor: "auto", tabIndex: "0", borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: "0px", borderLeftWidth: "0px",
    borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none", borderTopColor: "rgba(0,0,0,0)",
    borderRightColor: "rgba(0,0,0,0)", borderBottomColor: "rgba(0,0,0,0)", borderLeftColor: "rgba(0,0,0,0)", content: "none", backgroundImage: "none", maskImage: "none" };
  const wrapper = { ...html, tagName: "DIV", parentElement: html, children: [], childNodes: [], childElementCount: 1, getAttribute: name => name === "tabindex" ? "-1" : null };
  const child = { ...html, tagName: "DIV", parentElement: wrapper, children: [], childNodes: [{ nodeType: 3, textContent: "hidden by script" }], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 200, height: 100 }), getAttribute: name => name === "tabindex" ? "0" : null };
  const script = { ...html, tagName: "SCRIPT", parentElement: child, children: [], childNodes: [{ nodeType: 3, textContent: "not student text" }], childElementCount: 0 };
  const text = { ...html, tagName: "SPAN", parentElement: child, children: [], childNodes: [{ nodeType: 3, textContent: "descendant text" }], childElementCount: 0 };
  const svg = { ...html, tagName: "SVG", parentElement: child, children: [], childNodes: [], childElementCount: 1, getAttribute: () => null };
  const path = { ...html, tagName: "PATH", parentElement: svg, children: [], childNodes: [], childElementCount: 0, getBoundingClientRect: () => ({ x: 0, y: 0, width: 20, height: 10 }), getAttribute: () => null };
  const button = { ...html, tagName: "BUTTON", parentElement: child, children: [], childNodes: [], childElementCount: 0, getAttribute: () => null };
  wrapper.children = [child, button]; child.children = [svg]; child.childNodes = [{ nodeType: 1, tagName: "SCRIPT", textContent: "not student text" }, { nodeType: 3, textContent: "own direct text" }];
  svg.children = [path]; html.children = [wrapper];
  dom.window.getComputedStyle = element => element === child ? { ...style, cursor: "pointer", pointerEvents: "auto", borderTopWidth: "1px", borderTopStyle: "solid", borderTopColor: "rgb(1,2,3)" }
    : element === wrapper ? { ...style, cursor: "pointer" } : { ...style, cursor: "auto" };
  const registry = createStableNodeRefRegistry("interaction-test");
  const snapshot = observeLiveDom({ document: dom.document, window: dom.window, registry, excludeRoot: null, snapshotRef: "interaction", documentRef: "fixture" });
  const properties = node => snapshot.properties.get(stableNodeRefFor(registry, node));
  assert.equal(properties(wrapper).pointerCursor, true);
  assert.equal(properties(child).parentPointerCursor, true);
  assert.equal(properties(child).tabIndexFocus, true);
  assert.equal(properties(wrapper).tabIndexFocus, false);
  assert.equal(properties(child).borderPresent, true);
  assert.equal(properties(child).aspectRatio, 0.5);
  assert.equal(properties(child).descendantTextPresent, true);
  assert.equal(properties(child).singleChildTag, "svg");
  assert.equal(properties(child).withinControlAncestor, false);
  assert.equal(properties(button).withinControlAncestor, false);
  assert.equal(properties(path).inSvgAncestor, true);
  assert.equal(properties(svg).inSvgAncestor, false);
  assert.equal(properties(wrapper).inSvgAncestor, false);
  assert.equal('textContent' in properties(child), false);
});

test("full-tree control scope keeps bounded exploration and descendant text evidence", () => {
  const dom = liveMeasurementDom(), { html } = dom;
  const baseStyle = { display: "block", visibility: "visible", transform: "none", overflowX: "visible", overflowY: "visible", clipPath: "none", clip: "auto",
    pointerEvents: "auto", cursor: "auto", borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: "0px", borderLeftWidth: "0px",
    borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none", borderTopColor: "rgba(0,0,0,0)",
    borderRightColor: "rgba(0,0,0,0)", borderBottomColor: "rgba(0,0,0,0)", borderLeftColor: "rgba(0,0,0,0)", content: "none", backgroundImage: "none", maskImage: "none" };
  const control = { ...html, tagName: "BUTTON", parentElement: html, children: [], childNodes: [], childElementCount: 0, getAttribute: () => null };
  const wrappers = Array.from({ length: 5 }, () => ({ ...html, tagName: "DIV", parentElement: null,
    children: [], childNodes: [], childElementCount: 0, getAttribute: () => null }));
  for (let index = 1; index < wrappers.length; index++) wrappers[index].parentElement = wrappers[index - 1];
  wrappers[0].parentElement = control; control.children = [wrappers[0]];
  const target = wrappers[4];
  const script = { ...html, tagName: "SCRIPT", parentElement: target, children: [], childNodes: [{ nodeType: 3, textContent: "hidden" }], childElementCount: 0 };
  const tool = { ...html, tagName: "DIV", parentElement: target, id: "codex-browser-sidebar-comments-root", children: [], childNodes: [{ nodeType: 3, textContent: "tool text" }], childElementCount: 0, getAttribute: () => null };
  const text = { ...html, tagName: "SPAN", parentElement: target, children: [], childNodes: [{ nodeType: 3, textContent: "real" }], childElementCount: 0 };
  target.children = [];
  target.childNodes = [
    { nodeType: 1, tagName: "SCRIPT", id: "", childNodes: [{ nodeType: 3, textContent: "hidden" }] },
    { nodeType: 1, tagName: "SPAN", id: "", childNodes: [{ nodeType: 3, textContent: "real" }] },
  ];
  wrappers[0].children = [wrappers[1]]; wrappers[1].children = [wrappers[2]]; wrappers[2].children = [wrappers[3]]; wrappers[3].children = [target];
  control.children = [wrappers[0]]; control.childElementCount = 1;
  html.children = [control];
  dom.window.getComputedStyle = () => baseStyle;
  const registry = createStableNodeRefRegistry("bounded-ancestor-test");
  const snapshot = observeLiveDom({ document: dom.document, window: dom.window, registry, excludeRoot: null, snapshotRef: "bounded", documentRef: "fixture" });
  const properties = node => snapshot.properties.get(stableNodeRefFor(registry, node));
  assert.equal(properties(target).withinControlAncestor, true);
  assert.equal(properties(wrappers[0]).withinControlAncestor, true);
  assert.equal(properties(target).inSvgAncestor, false);
  assert.equal(properties(target).descendantTextPresent, true);
  assert.equal(properties(target).singleChildTag, null);
  const exploration = snapshot.explorationInputs.get(stableNodeRefFor(registry, target));
  assert.equal(exploration.containment.maxRelationHops, 4);
  assert.deepEqual(exploration.containment.ancestorEdges.map(edge => edge.relativeHops), [1, 2, 3, 4]);
  assert.equal(exploration.containment.ancestorBoundary, "hop_limit_reached");
});

test("existential ancestor facts cover the full tree while relation arrays stay bounded", () => {
  const dom = liveMeasurementDom(), { html } = dom;
  const style = { display: "block", visibility: "visible", transform: "none", overflowX: "visible", overflowY: "visible", clipPath: "none", clip: "auto",
    pointerEvents: "auto", cursor: "auto", borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: "0px", borderLeftWidth: "0px",
    borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none", borderTopColor: "rgba(0,0,0,0)",
    borderRightColor: "rgba(0,0,0,0)", borderBottomColor: "rgba(0,0,0,0)", borderLeftColor: "rgba(0,0,0,0)", content: "none", backgroundImage: "none", maskImage: "none" };
  const element = (tagName, parentElement) => ({ ...html, tagName, parentElement, children: [], childNodes: [], childElementCount: 0, getAttribute: () => null });
  const attach = (parent, child) => {
    parent.children.push(child); parent.childNodes.push(child); parent.childElementCount = parent.children.length;
    return child;
  };
  const chain = (parent, tags) => tags.reduce((current, tag) => attach(current, element(tag, current)), parent);
  const plainTarget = chain(html, Array(6).fill("DIV"));
  const button = attach(html, element("BUTTON", html));
  const buttonTarget = chain(button, Array(5).fill("DIV"));
  const svg = attach(html, element("SVG", html));
  const svgTarget = chain(svg, Array(5).fill("G"));
  const htmlG = attach(html, element("G", html));
  const htmlGTarget = attach(htmlG, element("SPAN", htmlG));
  dom.window.getComputedStyle = () => style;
  const registry = createStableNodeRefRegistry("full-tree-ancestor-test");
  const snapshot = observeLiveDom({ document: dom.document, window: dom.window, registry, excludeRoot: null, snapshotRef: "full-tree", documentRef: "fixture" });
  const properties = node => snapshot.properties.get(stableNodeRefFor(registry, node));

  assert.equal(properties(plainTarget).withinControlAncestor, false);
  assert.equal(properties(plainTarget).inSvgAncestor, false);
  assert.equal(properties(buttonTarget).withinControlAncestor, true);
  assert.equal(properties(svgTarget).inSvgAncestor, true);
  assert.equal(properties(htmlGTarget).inSvgAncestor, false);

  const exploration = snapshot.explorationInputs.get(stableNodeRefFor(registry, plainTarget));
  assert.equal(exploration.containment.maxRelationHops, 4);
  assert.deepEqual(exploration.containment.ancestorEdges.map(edge => edge.relativeHops), [1, 2, 3, 4]);
  assert.equal(exploration.containment.ancestorBoundary, "hop_limit_reached");
  assert.equal(exploration.containment.descendantBoundary, "complete");
  assert.equal(Object.hasOwn(exploration, "ancestorBoundary"), false);
});

test("singleChildSameRect uses real parent and sole child geometry with nullable coverage", () => {
  const dom = liveMeasurementDom(), { html } = dom;
  const style = { display: "block", visibility: "visible", transform: "none", overflowX: "visible", overflowY: "visible", clipPath: "none", clip: "auto",
    pointerEvents: "auto", cursor: "auto", borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: "0px", borderLeftWidth: "0px",
    borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none", borderTopColor: "rgba(0,0,0,0)",
    borderRightColor: "rgba(0,0,0,0)", borderBottomColor: "rgba(0,0,0,0)", borderLeftColor: "rgba(0,0,0,0)", content: "none", backgroundImage: "none", maskImage: "none" };
  const parent = { ...html, tagName: "DIV", parentElement: html, children: [], childNodes: [], childElementCount: 1,
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 100, height: 40 }), getAttribute: () => null };
  const child = { ...html, tagName: "BUTTON", parentElement: parent, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 11, y: 11, width: 98, height: 38 }), getAttribute: () => null };
  parent.children = [child]; html.children = [parent];
  dom.window.getComputedStyle = () => style;
  const registry = createStableNodeRefRegistry("single-rect-test");
  const parentRef = stableNodeRefFor(registry, parent), childRef = stableNodeRefFor(registry, child);
  const observe = () => observeLiveDom({ document: dom.document, window: dom.window, registry, excludeRoot: null, snapshotRef: "same-rect", documentRef: "fixture" });
  const measured = observe();
  assert.equal(measured.properties.get(parentRef).singleChildSameRect, true);
  const candidateBatch = checkCandidates(observeCandidates({ observation: measured.observation }), createFocusSpec());
  const classified = classifyBasicKindBatch({ ...candidateBatch, itemObservations: measured.itemObservations }, DEFAULT_BASIC_KIND_CONFIG, DEFAULT_BASIC_KIND_PROFILE);
  assert.equal(classified.slots.find(slot => slot.nodeRef === parentRef).evidence.wires.neutral_same_rect_wrapper, 1);
  assert.equal(observe().properties.get(childRef).singleChildSameRect, false);
  child.getBoundingClientRect = () => ({ x: 30, y: 10, width: 30, height: 20 });
  assert.equal(observe().properties.get(parentRef).singleChildSameRect, false);
  parent.children = []; parent.childNodes = []; parent.childElementCount = 0;
  assert.equal(observe().properties.get(parentRef).singleChildSameRect, false);
  parent.children = [child]; parent.childNodes = [child]; parent.childElementCount = 1;
  child.getBoundingClientRect = () => ({ x: 0, y: 0, width: Number.NaN, height: 20 });
  assert.equal(observe().properties.get(parentRef).singleChildSameRect, null);
  html.children = [parent];
  const exploration = buildExplorationInputs({ observation: { ...observe().observation }, itemObservations: observe().itemObservations, maxRelationHops: 4 }).get(parentRef);
  assert.equal(exploration.measurementCoverage.singleChildSameRect, 'unmeasured');
});

test("directListChildPresent measures complete structural children independent of visibility", () => {
  const dom = liveMeasurementDom(), { html } = dom;
  const style = { display: "block", visibility: "visible", transform: "none", overflowX: "visible", overflowY: "visible", clipPath: "none", clip: "auto",
    pointerEvents: "auto", cursor: "auto", borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: "0px", borderLeftWidth: "0px",
    borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none", borderTopColor: "rgba(0,0,0,0)",
    borderRightColor: "rgba(0,0,0,0)", borderBottomColor: "rgba(0,0,0,0)", borderLeftColor: "rgba(0,0,0,0)", content: "none", backgroundImage: "none", maskImage: "none" };
  const element = (tagName, parentElement, role = null) => ({
    ...html,
    tagName,
    parentElement,
    children: [],
    childNodes: [],
    childElementCount: 0,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 30 }),
    getAttribute: name => name === "role" ? role : null,
  });
  const hiddenListParent = element("DIV", html);
  const hiddenUl = element("UL", hiddenListParent);
  hiddenUl.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0 });
  const hiddenParagraph = element("P", hiddenListParent);
  hiddenListParent.children = [hiddenUl, hiddenParagraph];
  hiddenListParent.childElementCount = 2;

  const plainParent = element("DIV", html);
  const svg = element("SVG", plainParent), span = element("SPAN", plainParent), button = element("BUTTON", plainParent);
  plainParent.children = [svg, span, button];
  plainParent.childElementCount = 3;

  const roleParent = element("DIV", html);
  const roleListbox = element("DIV", roleParent, "listbox");
  roleParent.children = [roleListbox];
  roleParent.childElementCount = 1;

  const nativeSelect = element("SELECT", html);
  nativeSelect.options = [{ tagName: "OPTION" }];

  const excludedParent = element("DIV", html);
  const toolRoot = element("DIV", excludedParent);
  toolRoot.id = "codex-browser-sidebar-comments-root";
  const normalSpan = element("SPAN", excludedParent);
  excludedParent.children = [toolRoot, normalSpan];
  excludedParent.childElementCount = 2;

  html.children = [hiddenListParent, plainParent, roleParent, nativeSelect, excludedParent];
  dom.window.getComputedStyle = elementValue => elementValue === hiddenUl ? { ...style, display: "none" } : style;
  const registry = createStableNodeRefRegistry("direct-list-child-test");
  const snapshot = observeLiveDom({ document: dom.document, window: dom.window, registry, excludeRoot: null, snapshotRef: "direct-list-child", documentRef: "fixture" });
  const properties = node => snapshot.properties.get(stableNodeRefFor(registry, node));
  const exploration = node => snapshot.explorationInputs.get(stableNodeRefFor(registry, node));

  assert.equal(properties(hiddenListParent).directListChildPresent, true);
  assert.equal(properties(plainParent).directListChildPresent, false);
  assert.equal(properties(roleParent).directListChildPresent, true);
  assert.equal(properties(nativeSelect).directListChildPresent, false);
  assert.equal(properties(excludedParent).directListChildPresent, false);
  assert.equal(exploration(hiddenListParent).measurementCoverage.directListChildPresent, "measured");
});

test("unsupported border and tabindex evidence remains unknown while known absence stays false", () => {
  const dom = liveMeasurementDom(), { html } = dom;
  const unsupported = { display: "block", visibility: "visible", transform: "none", overflowX: "visible", overflowY: "visible", clipPath: "none", clip: "auto",
    pointerEvents: "auto", content: "none", backgroundImage: "none", maskImage: "none" };
  const target = { ...html, tagName: "DIV", parentElement: html, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 20, height: 20 }), getAttribute: name => name === "tabindex" ? "not-an-integer" : null };
  html.children = [target];
  dom.window.getComputedStyle = () => unsupported;
  const registry = createStableNodeRefRegistry("unknown-style-test");
  const ref = stableNodeRefFor(registry, target);
  const first = observeLiveDom({ document: dom.document, window: dom.window, registry, excludeRoot: null, snapshotRef: "unknown-style", documentRef: "fixture" });
  assert.equal(first.properties.get(ref).borderPresent, null);
  assert.equal(first.properties.get(ref).tabIndexFocus, null);
  assert.equal(first.properties.get(ref).pointerCursor, null);
  assert.equal(first.properties.get(ref).parentPointerCursor, null);
  const exploration = buildExplorationInputs({ observation: first.observation, itemObservations: first.itemObservations, maxRelationHops: 4 }).get(ref);
  assert.equal(exploration.measurementCoverage.pointerCursor, "unmeasured");
  assert.equal(exploration.measurementCoverage.parentPointerCursor, "unmeasured");
  target.getAttribute = () => null;
  const absent = observeLiveDom({ document: dom.document, window: dom.window, registry, excludeRoot: null, snapshotRef: "absent-tabindex", documentRef: "fixture" });
  assert.equal(absent.properties.get(ref).tabIndexFocus, false);
  dom.window.getComputedStyle = () => ({ ...unsupported, borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: "0px", borderLeftWidth: "0px" });
  const zero = observeLiveDom({ document: dom.document, window: dom.window, registry, excludeRoot: null, snapshotRef: "zero-border", documentRef: "fixture" });
  assert.equal(zero.properties.get(ref).borderPresent, false);
  dom.window.getComputedStyle = () => ({ ...unsupported, borderTopWidth: "2px", borderRightWidth: "0px", borderBottomWidth: "0px", borderLeftWidth: "0px", borderTopStyle: "solid", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none", getPropertyValue: () => "not-a-css-color" });
  const invalidColor = observeLiveDom({ document: dom.document, window: dom.window, registry, excludeRoot: null, snapshotRef: "invalid-border", documentRef: "fixture" });
  assert.equal(invalidColor.properties.get(ref).borderPresent, null);
});

test("SVG scope detects only an actual svg ancestor, not HTML g or text tags", () => {
  const dom = liveMeasurementDom(), { html } = dom;
  const style = { display: "block", visibility: "visible", transform: "none", overflowX: "visible", overflowY: "visible", clipPath: "none", clip: "auto",
    pointerEvents: "auto", cursor: "auto", borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: "0px", borderLeftWidth: "0px",
    borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none", borderTopColor: "rgba(0,0,0,0)",
    borderRightColor: "rgba(0,0,0,0)", borderBottomColor: "rgba(0,0,0,0)", borderLeftColor: "rgba(0,0,0,0)", content: "none", backgroundImage: "none", maskImage: "none" };
  const g = { ...html, tagName: "G", parentElement: html, children: [], childNodes: [], childElementCount: 1, getAttribute: () => null };
  const target = { ...html, tagName: "SPAN", parentElement: g, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 20, height: 20 }), getAttribute: () => null };
  g.children = [target]; html.children = [g];
  dom.window.getComputedStyle = () => style;
  const registry = createStableNodeRefRegistry("svg-scope-test");
  const snapshot = observeLiveDom({ document: dom.document, window: dom.window, registry, excludeRoot: null, snapshotRef: "svg-scope", documentRef: "fixture" });
  assert.equal(snapshot.properties.get(stableNodeRefFor(registry, target)).inSvgAncestor, false);
});

test("overlay node definitions expose only the production graph nodes", () => {
  const definitions = createBrowserOverlayNodeDefinitions({ document: {}, window: {}, registry: createStableNodeRefRegistry("no-hooks"), excludeHost: null,
    present: () => undefined });
  assert.deepEqual(definitions.map(definition => definition.operator), ["browser.observe_live", "browser.qualify_live", "browser.classify_live", "overlay.present"]);
});

test("public overlay graph runs through compileWorkflow and runWorkflow with a no-op present callback", async () => {
  const graph = JSON.parse(readFileSync(
    new URL("../workflows/browser-visual-overlay.graph.json", import.meta.url),
    "utf8",
  ));
  const dom = fakeDom();
  const html = dom.document.documentElement;
  html.clientLeft = html.clientTop = 0;
  html.clientWidth = 800;
  html.clientHeight = 30;
  const child = { ...html, tagName: "BUTTON", parentElement: html, isConnected: true,
    getBoundingClientRect: () => ({ x: 0, y: 20, width: 100, height: 40 }),
    getClientRects: () => [{ x: 0, y: 20, width: 100, height: 40 }],
  };
  html.children = [child];
  const getStyle = dom.window.getComputedStyle;
  dom.window.getComputedStyle = element => ({ ...getStyle(), overflowY: element === html ? "hidden" : "visible" });
  const registry = createStableNodeRefRegistry("overlay-test");
  let presentCalls = 0;
  const definitions = createBrowserOverlayNodeDefinitions({
    document: dom.document,
    window: dom.window,
    registry,
    excludeHost: null,
    present: () => {
      presentCalls += 1;
    },
  });
  const compiled = compileWorkflow({
    graph,
    bindings: {
      "筛选当前视口与关注候选": { config: { viewportOnly: true, scopeMode: "subtree" } },
      "判断DOM基础种类": { config: DEFAULT_BASIC_KIND_CONFIG, profileId: "default" },
    },
  }, {
    nodeDefinitions: definitions,
    profiles: { default: DEFAULT_BASIC_KIND_PROFILE },
    grantedEffects: ["browser.dom.read", "browser.overlay.present"],
  });
  const result = await runWorkflow(compiled, createWorkflowInputEvent({
    runId: "overlay-public-run",
    eventId: "overlay-public-run:input",
    port: "overlay_request",
    type: BROWSER_OVERLAY_REQUEST_EVENT_TYPE,
    correlation: {},
    payload: { snapshotRef: "snapshot-public", documentRef: "document-public" },
  }));
  assert.equal(result.status, "completed");
  assert.equal(result.outputEvent.status, "ok");
  assert.equal(presentCalls, 1);
  assert.equal(result.outputEvent.payload.snapshot.snapshotRef, "snapshot-public");
  assert.equal(result.outputEvent.payload.presentation.view.confidenceState, "uncalibrated");
  assert.equal(result.outputEvent.payload.presentation.receipt, undefined);
  const frame = result.outputEvent.payload;
  const ref = stableNodeRefFor(registry, child);
  assert.deepEqual(frame.boxes.find(box => box.nodeRef === ref).rect, { x: 0, y: 20, width: 100, height: 10 });
  assert.equal(frame.basicKindBatch.slots.find(slot => slot.nodeRef === ref).evidence.wires.state_disabled, 0);
  assert.equal(frame.snapshot.properties.get(ref).disabled, false);
  child.isConnected = false;
  assert.equal(resolveStableNodeRef(registry, ref), null);
  child.isConnected = true;
  assert.equal(resolveStableNodeRef(registry, ref), child);
});

test("capture graph enforces effects and calls the explicit download callback only on export", async () => {
  const graph = JSON.parse(readFileSync(
    new URL("../workflows/browser-capture.graph.json", import.meta.url),
    "utf8",
  ));
  const session = new BrowserCaptureSession({ sessionId: "session-node", createdAt: "2026-10-17T12:00:00.000Z" });
  let downloadCalls = 0;
  const download = async () => {
    downloadCalls += 1;
    return { receiptId: "download-receipt-1" };
  };
  const definitions = createBrowserCaptureNodeDefinitions({ session, download });

  assert.throws(
    () => compileWorkflow({ graph, bindings: {} }, { nodeDefinitions: definitions }),
    (error) => error.code === "COMPILE_EFFECT_UNAUTHORIZED",
  );
  assert.equal(downloadCalls, 0);

  const compiled = compileWorkflow({ graph, bindings: {} }, {
    nodeDefinitions: definitions,
    grantedEffects: ["browser.capture.download"],
  });
  const frame = makeFrame();
  const selected = await runWorkflow(compiled, createWorkflowInputEvent({
    runId: "capture-selected-run",
    eventId: "capture-selected-run:input",
    port: "capture_request",
    type: BROWSER_CAPTURE_REQUEST_EVENT_TYPE,
    correlation: {},
    payload: {
      action: "capture_selected",
      frame,
      nodeRef: "button",
      annotation: { kind: "correct" },
    },
  }));
  assert.equal(selected.status, "completed");
  assert.equal(selected.outputEvent.payload.action, "capture_selected");
  assert.equal(selected.outputEvent.payload.receipt.reviewStatus, "verified");
  assert.equal(downloadCalls, 0);

  const exported = await runWorkflow(compiled, createWorkflowInputEvent({
    runId: "capture-export-run",
    eventId: "capture-export-run:input",
    port: "capture_request",
    type: BROWSER_CAPTURE_REQUEST_EVENT_TYPE,
    correlation: {},
    payload: { action: "export" },
  }));
  assert.equal(exported.status, "completed");
  assert.equal(exported.outputEvent.payload.action, "export");
  assert.equal(exported.outputEvent.payload.receipt.downloadReceipt.receiptId, "download-receipt-1");
  assert.equal(downloadCalls, 1);
});

test("capture graph accepts unresolved collection while the old unknown action remains compatible", async () => {
  const graph = JSON.parse(readFileSync(
    new URL("../workflows/browser-capture.graph.json", import.meta.url),
    "utf8",
  ));
  const session = new BrowserCaptureSession({ sessionId: "session-contract", createdAt: "2026-10-17T12:00:00.000Z" });
  const compiled = compileWorkflow({ graph, bindings: {} }, {
    nodeDefinitions: createBrowserCaptureNodeDefinitions({ session, download: () => ({ receiptId: "unused" }) }),
    grantedEffects: ["browser.capture.download"],
  });
  const execute = action => runWorkflow(compiled, createWorkflowInputEvent({
    runId: `capture-${action}`,
    eventId: `capture-${action}:input`,
    port: "capture_request",
    type: BROWSER_CAPTURE_REQUEST_EVENT_TYPE,
    correlation: {},
    payload: { action, frame: makeFrame() },
  }));
  const unresolved = await execute("collect_unresolved");
  assert.equal(unresolved.status, "completed");
  assert.equal(unresolved.outputEvent.payload.action, "collect_unresolved");
  assert.equal(unresolved.outputEvent.payload.receipt.collected, 2);
  await assert.rejects(createBrowserCaptureNodeDefinitions({ session, download: () => undefined })
    .find(definition => definition.operator === "browser.capture").execute({ inputs: [{ status: "ok", payload: { action: "unknown_action" } }], emit: () => undefined }), /Unsupported browser capture action/);
});

test("overlay presentation counts ignore separately and keeps its boxes available for opt-in viewing", async () => {
  const frame = makeFrame();
  const ignored = frame.basicKindBatch.slots.filter(slot => slot.judgmentStatus === "judged" && slot.basicKind === "ignore");
  assert.deepEqual(ignored.map(slot => slot.nodeRef), ["ignored-parent"]);
  assert.equal(frame.basicKindBatch.slots.find(slot => slot.nodeRef === "ignored-child").basicKind, "button");
  assert.deepEqual(
    frame.basicKindBatch.slots.filter(slot => slot.candidateStatus === "ok" && slot.judgmentStatus === "unknown").map(slot => slot.nodeRef),
    ["unknown"],
  );
  assert.deepEqual(
    frame.basicKindBatch.slots.filter(slot => slot.judgmentStatus === "conflict").map(slot => slot.nodeRef),
    ["conflict"],
  );
  const definitions = createBrowserOverlayNodeDefinitions({ document: {}, window: {}, registry: createStableNodeRefRegistry("presentation"), excludeHost: null,
    present: () => undefined });
  const present = definitions.find(definition => definition.operator === "overlay.present");
  const graph = JSON.parse(readFileSync(new URL("../workflows/browser-visual-overlay.graph.json", import.meta.url), "utf8"));
  assert.ok(graph.nodes.some(node => node.operator === "overlay.present"));
  const execution = await present.execute({
    inputs: [{ status: "ok", payload: frame }],
    emit: (payload, options) => ({ payload, options }),
  });
  assert.equal(execution.payload.presentation.view.counts.ignored, 1);
  assert.equal(execution.payload.presentation.view.counts.unknown, 1);
  assert.equal(execution.payload.presentation.view.counts.conflict, 1);
  assert.equal(execution.payload.presentation.view.counts.unresolved, 2);
  assert.equal(execution.payload.basicKindBatch.slots.length, frame.candidateBatch.slots.length);
  assert.ok(execution.payload.presentation.view.boxes.some(box => box.basicKind === "ignore"));
});
