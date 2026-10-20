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

function currentViewDom() {
  const baseStyle = {
    display: "block",
    visibility: "visible",
    transform: "none",
    translate: "none",
    rotate: "none",
    scale: "none",
    perspective: "none",
    overflowX: "visible",
    overflowY: "visible",
    clipPath: "none",
    clip: "auto",
    position: "static",
    zIndex: "auto",
    opacity: "1",
    pointerEvents: "auto",
    cursor: "auto",
    content: "none",
    backgroundImage: "none",
    maskImage: "none",
    webkitMaskImage: "none",
    backgroundColor: "rgba(0, 0, 0, 0)",
    backdropFilter: "none",
    webkitBackdropFilter: "none",
    filter: "none",
    boxShadow: "none",
    borderImageSource: "none",
    outlineStyle: "none",
    outlineWidth: "0px",
    outlineColor: "rgba(0, 0, 0, 0)",
    mixBlendMode: "normal",
    isolation: "auto",
    contain: "none",
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
    paddingTop: "0px",
    paddingRight: "0px",
    paddingBottom: "0px",
    paddingLeft: "0px",
  };
  const document = { baseURI: "https://fixture.test/page", activeElement: null };
  const html = currentViewElement(document, {
    tag: "HTML",
    parent: null,
    rect: rect(0, 0, 800, 600),
    tabIndex: -1,
  });
  html.clientLeft = html.clientTop = 0;
  html.clientWidth = 800;
  html.clientHeight = 600;
  document.documentElement = html;
  document.body = html;
  document.activeElement = html;
  const window = {
    innerWidth: 800,
    innerHeight: 600,
    getComputedStyle: (element, pseudo) => pseudo ? { content: "none" } : element.currentViewStyle,
  };
  for (const element of [html]) element.currentViewStyle = baseStyle;
  return { document, window, html, baseStyle };
}

function currentViewElement(document, {
  tag = "DIV",
  parent = null,
  namespaceURI = "http://www.w3.org/1999/xhtml",
  rectValue = rect(),
  tabIndex = -1,
  isContentEditable = false,
  focusWithin = false,
  topLayer = false,
  topLayerThrows = false,
  role = null,
  title = null,
  ariaLabel = null,
  ariaLabelledby = null,
  directText = "",
} = {}) {
  const element = {
    nodeType: 1,
    tagName: tag,
    namespaceURI,
    parentElement: parent,
    ownerDocument: document,
    isConnected: true,
    id: "",
    classList: [],
    children: [],
    childElementCount: 0,
    childNodes: directText === "" ? [] : [{ nodeType: 3, textContent: directText }],
    tabIndex,
    isContentEditable,
    getBoundingClientRect: () => ({ ...rectValue }),
    getClientRects: () => [{ ...rectValue }],
    querySelectorAll: () => [],
    getAttribute: name => name === "role" ? role : name === "title" ? title : name === "aria-label" ? ariaLabel : name === "aria-labelledby" ? ariaLabelledby : null,
    hasAttribute: () => false,
    matches: selector => {
      if (selector === ":focus-within") return focusWithin;
      if ([":fullscreen", ":modal", ":popover-open"].includes(selector)) {
        if (topLayerThrows) throw new Error("native top-layer selector unavailable");
        return topLayer;
      }
      if (selector === ":read-write") return isContentEditable;
      throw new Error(`unexpected selector ${selector}`);
    },
  };
  return element;
}

function appendCurrentViewChild(parent, child) {
  child.parentElement = parent;
  parent.children = [...parent.children, child];
  parent.childElementCount = parent.children.length;
  parent.childNodes = [...parent.childNodes, child];
}

function surfaceAliasFixture({
  maskImage = "none",
  webkitMaskImage = "none",
  backdropFilter = "none",
  webkitBackdropFilter = "none",
} = {}) {
  const dom = liveMeasurementDom(), { html } = dom;
  const target = {
    ...html,
    tagName: "A",
    parentElement: html,
    children: [],
    childNodes: [{ nodeType: 3, textContent: "visible target" }],
    childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 0, width: 58, height: 62 }),
    getClientRects: () => [{ x: 100, y: 0, width: 58, height: 62 }],
  };
  const blocker = {
    ...html,
    tagName: "DIV",
    parentElement: html,
    children: [],
    childNodes: [],
    childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 0, width: 58, height: 62 }),
    getClientRects: () => [{ x: 100, y: 0, width: 58, height: 62 }],
  };
  html.children = [target, blocker];
  html.childNodes = [target, blocker];
  html.childElementCount = 2;
  const style = {
    display: "block",
    visibility: "visible",
    transform: "none",
    translate: "none",
    rotate: "none",
    scale: "none",
    perspective: "none",
    overflowX: "visible",
    overflowY: "visible",
    clipPath: "none",
    clip: "auto",
    position: "static",
    zIndex: "auto",
    opacity: "1",
    backgroundColor: "rgba(0, 0, 0, 0)",
    backgroundImage: "none",
    backgroundClip: "border-box",
    maskImage,
    webkitMaskImage,
    backdropFilter,
    webkitBackdropFilter,
    filter: "none",
    mixBlendMode: "normal",
    isolation: "auto",
    contain: "none",
    pointerEvents: "auto",
    borderTopWidth: "0px",
    borderRightWidth: "0px",
    borderBottomWidth: "0px",
    borderLeftWidth: "0px",
    borderTopLeftRadius: "0px",
    borderTopRightRadius: "0px",
    borderBottomLeftRadius: "0px",
    borderBottomRightRadius: "0px",
  };
  dom.window.getComputedStyle = (element, pseudo) => {
    if (pseudo) return { content: "none" };
    return element === blocker ? { ...style, pointerEvents: "none" } : style;
  };
  dom.document.elementsFromPoint = () => [target, html];
  return { ...dom, html, target, blocker };
}

function observedSurfaceAlias(overrides) {
  const dom = surfaceAliasFixture(overrides);
  const registry = createStableNodeRefRegistry("surface-alias-test");
  const snapshot = observeLiveDom({
    document: dom.document,
    window: dom.window,
    registry,
    excludeRoot: null,
    snapshotRef: "surface-alias",
    documentRef: "fixture",
  });
  const targetRef = stableNodeRefFor(registry, dom.target);
  const targetNode = snapshot.observation.nodes.find(node => node.nodeRef === targetRef);
  const candidates = checkCandidates(
    observeCandidates({ observation: snapshot.observation }),
    createFocusSpec(),
  );
  return { targetNode, targetRef, candidates };
}

test("empty webkit mask alias does not turn a standard no-mask surface into an uncertain blocker", () => {
  const { targetNode, targetRef, candidates } = observedSurfaceAlias({ webkitMaskImage: "" });
  assert.equal(targetNode.foreground, "visible");
  assert.deepEqual(targetNode.exposedRects, [{ x: 100, y: 0, width: 58, height: 62 }]);
  assert.ok(candidates.candidateRefs.includes(targetRef));
  assert.equal(candidates.slots.find(slot => slot.nodeRef === targetRef).status, "ok");
});

test("empty webkit backdrop alias does not turn a standard no-backdrop surface into an uncertain blocker", () => {
  const { targetNode, targetRef, candidates } = observedSurfaceAlias({ webkitBackdropFilter: "" });
  assert.equal(targetNode.foreground, "visible");
  assert.deepEqual(targetNode.exposedRects, [{ x: 100, y: 0, width: 58, height: 62 }]);
  assert.ok(candidates.candidateRefs.includes(targetRef));
  assert.equal(candidates.slots.find(slot => slot.nodeRef === targetRef).status, "ok");
});

test("genuine standard and prefixed mask or backdrop effects remain uncertain", () => {
  for (const [label, overrides] of [
    ["prefixed mask", { webkitMaskImage: "linear-gradient(#000, #000)" }],
    ["prefixed backdrop", { webkitBackdropFilter: "blur(2px)" }],
    ["standard mask", { webkitMaskImage: "", maskImage: "linear-gradient(#000, #000)" }],
    ["standard backdrop", { webkitBackdropFilter: "", backdropFilter: "blur(2px)" }],
  ]) {
    const { targetNode, targetRef, candidates } = observedSurfaceAlias(overrides);
    assert.equal(targetNode.foreground, "unassessed", label);
    assert.equal(targetNode.exposedRects, null, label);
    assert.equal(candidates.slots.find(slot => slot.nodeRef === targetRef).status, "unknown", label);
  }
});

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

test("translated and positively scaled cards retain measured clipping; unsupported transforms remain unknown", () => {
  for (const [transform, measured, individual = {}] of [
    ["none", true], ["matrix(1, 0, 0, 1, 0, 0)", true],
    ["matrix(1, 0, 0, 1, 258.5, 384.59375)", true],
    ["matrix(0.8, 0, 0, 0.8, 258.5, 0)", true],
    ["matrix(0, 1, -1, 0, 0, 0)", false],
    ["matrix(1, 0, 0.25, 1, 0, 0)", false],
    ["matrix(-1, 0, 0, 1, 0, 0)", false],
    ["matrix(0, 0, 0, 0, 0, 0)", false],
    ["matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 1, 1)", false],
    ["none", false, { rotate: "10deg" }],
    ["none", false, { scale: "1.7" }],
    ["none", false, { perspective: "500px" }],
    ["none", false, { translate: "10px 20px" }],
  ]) {
    const dom = fakeDom(), root = dom.document.documentElement;
    root.clientLeft = 0; root.clientTop = 0;
    root.clientWidth = 800; root.clientHeight = 600;
    const clip = { ...root, tagName: "DIV", parentElement: root, children: [], childNodes: [],
      clientLeft: 5, clientTop: 7, clientWidth: 790, clientHeight: 100,
    };
    const card = { ...root, tagName: "SECTION", parentElement: clip, children: [], childNodes: [],
      getBoundingClientRect: () => ({ x: 200, y: 80, width: 300, height: 100 }),
      getClientRects: () => [{ x: 200, y: 80, width: 300, height: 100 }],
    };
    const child = { ...card, tagName: "IMG", parentElement: card, children: [], childNodes: [],
      getBoundingClientRect: () => ({ x: 210, y: 85, width: 100, height: 50 }),
      getClientRects: () => [{ x: 210, y: 85, width: 100, height: 50 }],
    };
    root.children = [clip]; clip.children = [card]; card.children = [child];
    const baseStyle = dom.window.getComputedStyle();
    dom.window.getComputedStyle = el => ({ ...baseStyle, ...(el === card ? individual : {}), transform: el === card ? transform : "none", overflowY: el === clip ? "hidden" : "visible" });
    const registry = createStableNodeRefRegistry("translation-test");
    const snapshot = observeLiveDom({ ...dom, registry, excludeRoot: null, snapshotRef: "translated", documentRef: "fixture" });
    assert.deepEqual(snapshot.evidence.get(stableNodeRefFor(registry, card)).clippedRect,
      measured ? { x: 200, y: 80, width: 300, height: 27 } : null, transform);
    assert.deepEqual(snapshot.evidence.get(stableNodeRefFor(registry, child)).clippedRect,
      measured ? { x: 210, y: 85, width: 100, height: 22 } : null, `${transform}: child`);
  }
});

test("positive diagonal scale keeps measured viewport rectangles without rescaling", () => {
  const dom = fakeDom(), root = dom.document.documentElement;
  root.clientLeft = 0; root.clientTop = 0;
  root.clientWidth = 800; root.clientHeight = 600;
  const card = { ...root, tagName: "SECTION", parentElement: root, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 200, y: 80, width: 120, height: 50 }),
    getClientRects: () => [{ x: 200, y: 80, width: 120, height: 50 }],
  };
  const child = { ...card, tagName: "IMG", parentElement: card, children: [], childNodes: [],
    getBoundingClientRect: () => ({ x: 210, y: 85, width: 60, height: 25 }),
    getClientRects: () => [{ x: 210, y: 85, width: 60, height: 25 }],
  };
  root.children = [card]; card.children = [child];
  const baseStyle = dom.window.getComputedStyle();
  dom.window.getComputedStyle = element => ({ ...baseStyle,
    transform: element === card ? "matrix(1.2, 0, 0, 0.5, 30, -10)" : "none",
    transformOrigin: element === card ? "10% 30%" : "0px 0px",
    overflowX: "visible", overflowY: "visible",
  });
  const registry = createStableNodeRefRegistry("scale-no-clip");
  const snapshot = observeLiveDom({ ...dom, registry, excludeRoot: null, snapshotRef: "scale", documentRef: "fixture" });
  assert.deepEqual(snapshot.evidence.get(stableNodeRefFor(registry, card)).clippedRect, { x: 200, y: 80, width: 120, height: 50 });
  assert.deepEqual(snapshot.evidence.get(stableNodeRefFor(registry, child)).clippedRect, { x: 210, y: 85, width: 60, height: 25 });
});

test("signed unit-axis HTML reflections preserve measured and outer-clipped physical rects", () => {
  const baseStyle = {
    display: "block",
    visibility: "visible",
    transform: "none",
    translate: "none",
    rotate: "none",
    scale: "none",
    perspective: "none",
    overflowX: "visible",
    overflowY: "visible",
    clipPath: "none",
    clip: "auto",
    contain: "none",
    filter: "none",
    backdropFilter: "none",
    webkitBackdropFilter: "none",
    position: "static",
  };
  const dom = fakeDom(), root = dom.document.documentElement;
  root.namespaceURI = "http://www.w3.org/1999/xhtml";
  root.clientLeft = 0; root.clientTop = 0;
  root.clientWidth = 800; root.clientHeight = 600;
  const outer = { ...root, tagName: "DIV", parentElement: root, children: [], childNodes: [],
    childElementCount: 0, clientLeft: 0, clientTop: 0, clientWidth: 50, clientHeight: 40,
    getBoundingClientRect: () => ({ x: 600, y: 340, width: 50, height: 40 }),
    getClientRects: () => [{ x: 600, y: 340, width: 50, height: 40 }],
  };
  const reflected = { ...outer, tagName: "DIV", parentElement: outer, children: [], childNodes: [],
    childElementCount: 1, clientLeft: 0, clientTop: 0, clientWidth: 60, clientHeight: 60,
    getBoundingClientRect: () => ({ x: 596, y: 330, width: 60, height: 60 }),
    getClientRects: () => [{ x: 596, y: 330, width: 60, height: 60 }],
  };
  const child = { ...reflected, tagName: "SPAN", parentElement: reflected, children: [], childNodes: [],
    childElementCount: 0, getBoundingClientRect: () => ({ x: 604, y: 344, width: 36, height: 28 }),
    getClientRects: () => [{ x: 604, y: 344, width: 36, height: 28 }],
  };
  root.children = [outer]; outer.children = [reflected]; reflected.children = [child];
  const registry = createStableNodeRefRegistry("html-reflection");
  const observe = ({
    transform = "matrix(-1, 0, 0, -1, 16, -30)",
    reflectedStyle = {},
    reflectedFragments = [{ x: 596, y: 330, width: 60, height: 60 }],
    reflectedNamespace = "http://www.w3.org/1999/xhtml",
    childStyle = {},
  } = {}) => {
    reflected.namespaceURI = reflectedNamespace;
    reflected.getClientRects = () => reflectedFragments.map(fragment => ({ ...fragment }));
    dom.window.getComputedStyle = element => ({
      ...baseStyle,
      transform: element === reflected ? transform : "none",
      overflowX: element === reflected ? reflectedStyle.overflowX ?? "visible"
        : element === outer ? "hidden" : "visible",
      overflowY: element === reflected ? reflectedStyle.overflowY ?? "visible"
        : element === outer ? "hidden" : "visible",
      ...(element === reflected ? reflectedStyle : {}),
      ...(element === child ? childStyle : {}),
    });
    return observeLiveDom({ ...dom, registry, excludeRoot: null, snapshotRef: "html-reflection", documentRef: "fixture" });
  };
  const outcome = (snapshot) => {
    const reflectedRef = stableNodeRefFor(registry, reflected);
    const observation = snapshot.observation.nodes.find(node => node.nodeRef === reflectedRef);
    const candidate = checkCandidates(
      observeCandidates({ observation: snapshot.observation }),
      createFocusSpec(),
    ).slots.find(slot => slot.nodeRef === reflectedRef);
    return { observation, candidate, clippedRect: snapshot.evidence.get(reflectedRef).clippedRect };
  };

  const measured = observe();
  assert.deepEqual(measured.evidence.get(stableNodeRefFor(registry, reflected)).clippedRect,
    { x: 600, y: 340, width: 50, height: 40 });
  assert.deepEqual(measured.evidence.get(stableNodeRefFor(registry, child)).clippedRect,
    { x: 604, y: 344, width: 36, height: 28 });

  for (const [label, transform] of [
    ["horizontal mirror", "matrix(-1, 0, 0, 1, 16, -30)"],
    ["vertical mirror", "matrix(1, 0, 0, -1, 16, -30)"],
    ["180-degree inversion", "matrix(-1, 0, 0, -1, 16, -30)"],
  ]) {
    const result = outcome(observe({ transform }));
    assert.deepEqual(result.clippedRect, { x: 600, y: 340, width: 50, height: 40 }, label);
    assert.deepEqual(result.observation.clippedRect, { x: 600, y: 340, width: 50, height: 40 }, label);
    assert.equal(result.candidate.status, "ok", label);
    assert.equal(result.candidate.evidence.clipping, "assessed", label);
  }

  const grandchild = { ...child, parentElement: child,
    getBoundingClientRect: () => ({ x: 606, y: 346, width: 12, height: 12 }),
    getClientRects: () => [{ x: 606, y: 346, width: 12, height: 12 }],
  };
  child.children = [grandchild]; child.childElementCount = 1;
  const innerClip = observe({ childStyle: { overflowX: "hidden", overflowY: "hidden" } });
  assert.equal(innerClip.evidence.get(stableNodeRefFor(registry, grandchild)).clippedRect, null,
    "client offsets below a reflected axis need an independent clipping proof");
  child.children = []; child.childElementCount = 0;

  const hiddenReflection = outcome(observe({ reflectedStyle: { overflowX: "hidden", overflowY: "hidden" } }));
  assert.equal(hiddenReflection.clippedRect, null);

  for (const [label, reflectedStyle] of [
    ["clip", { clip: "rect(0px, 60px, 60px, 0px)" }],
    ["clip-path", { clipPath: 'url("#local")' }],
    ["contain", { contain: "layout" }],
    ["filter", { filter: "blur(1px)" }],
    ["perspective", { perspective: "500px" }],
    ["standard backdrop effect", { backdropFilter: "blur(2px)" }],
    ["missing standard backdrop fact", { backdropFilter: undefined }],
    ["prefixed backdrop effect", { webkitBackdropFilter: "blur(2px)" }],
    ["missing prefixed backdrop fact", { webkitBackdropFilter: undefined }],
    ["missing overflow fact", { overflowX: undefined }],
  ]) {
    const result = outcome(observe({ reflectedStyle }));
    assert.equal(result.clippedRect, null, label);
    assert.equal(result.observation.clippedRect, null, label);
    assert.equal(result.candidate.status, "unknown", label);
    assert.deepEqual(result.candidate.reasons, ["insufficient_observation"], label);
    assert.equal(result.candidate.evidence.clipping, "unassessed", label);
  }

  const emptyPrefixedBackdrop = outcome(observe({ reflectedStyle: { webkitBackdropFilter: "" } }));
  assert.deepEqual(emptyPrefixedBackdrop.clippedRect, { x: 600, y: 340, width: 50, height: 40 });

  for (const transform of [
    "matrix(-1, 0, 0.01, -1, 16, -30)",
    "matrix(0, -1, 1, 0, 16, -30)",
    "matrix(-1, 0, 0, -2, 16, -30)",
    "matrix(-1, 0, 0, 0.5, 16, -30)",
    "matrix(0, 0, 0, 0, 0, 0)",
    "matrix3d(-1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 16, -30, 0, 1)",
    "matrix(-1, 0, 0, -1, NaN, -30)",
  ]) {
    const result = outcome(observe({ transform }));
    assert.equal(result.clippedRect, null, transform);
    assert.equal(result.candidate.status, "unknown", transform);
  }

  for (const [label, reflectStyle] of [
    ["independent translate", { translate: "10px" }],
    ["missing independent translate", { translate: undefined }],
    ["missing transform", { transform: undefined }],
  ]) {
    const result = outcome(observe({ reflectedStyle: reflectStyle }));
    assert.equal(result.clippedRect, null, label);
    assert.equal(result.candidate.status, "unknown", label);
  }

  const multiFragment = outcome(observe({
    reflectedFragments: [
      { x: 596, y: 330, width: 30, height: 60 },
      { x: 626, y: 330, width: 30, height: 60 },
    ],
  }));
  assert.equal(multiFragment.clippedRect, null);
  assert.equal(multiFragment.candidate.status, "unknown");

  const svgDomain = outcome(observe({ reflectedNamespace: "http://www.w3.org/2000/svg" }));
  assert.equal(svgDomain.clippedRect, null);
  assert.equal(svgDomain.candidate.status, "unknown");
});

test("scaled overflow ancestor converts client offsets and sizes through cumulative scale", () => {
  const dom = fakeDom(), root = dom.document.documentElement;
  const scroller = { ...root, tagName: "DIV", parentElement: root, children: [], childNodes: [], childElementCount: 2,
    clientLeft: 4, clientTop: 6, clientWidth: 100, clientHeight: 50,
    getBoundingClientRect: () => ({ x: 100, y: 50, width: 300, height: 200 }),
    getClientRects: () => [{ x: 100, y: 50, width: 300, height: 200 }],
  };
  const inside = { ...scroller, tagName: "BUTTON", parentElement: scroller, children: [], childNodes: [], childElementCount: 0,
    clientLeft: 0, clientTop: 0, clientWidth: 0, clientHeight: 0,
    getBoundingClientRect: () => ({ x: 140, y: 100, width: 40, height: 30 }),
    getClientRects: () => [{ x: 140, y: 100, width: 40, height: 30 }],
  };
  const outside = { ...inside,
    getBoundingClientRect: () => ({ x: 160, y: 130, width: 20, height: 20 }),
    getClientRects: () => [{ x: 160, y: 130, width: 20, height: 20 }],
  };
  root.children = [scroller]; scroller.children = [inside, outside];
  const baseStyle = dom.window.getComputedStyle();
  dom.window.getComputedStyle = element => ({ ...baseStyle,
    transform: element === scroller ? "matrix(0.5, 0, 0, 1.2, 0, 0)" : "none",
    overflowX: element === scroller ? "hidden" : "visible",
    overflowY: element === scroller ? "hidden" : "visible",
  });
  const registry = createStableNodeRefRegistry("scaled-clip");
  const snapshot = observeLiveDom({ ...dom, registry, excludeRoot: null, snapshotRef: "scaled-clip", documentRef: "fixture" });
  assert.deepEqual(snapshot.evidence.get(stableNodeRefFor(registry, inside)).clippedRect, { x: 140, y: 100, width: 12, height: 117.2 - 100 });
  assert.deepEqual(snapshot.evidence.get(stableNodeRefFor(registry, outside)).clippedRect, { x: 160, y: 130, width: 0, height: 0 });
});

test("nested scales compose for the inner clip and a target scale does not widen an outer clip", () => {
  const dom = fakeDom(), root = dom.document.documentElement;
  root.clientLeft = 0; root.clientTop = 0;
  root.clientWidth = 1000; root.clientHeight = 1000;
  root.getBoundingClientRect = () => ({ x: 0, y: 0, width: 1000, height: 1000 });
  const outer = { ...root, tagName: "SECTION", parentElement: root, children: [], childNodes: [], childElementCount: 0,
    clientLeft: 2, clientTop: 3, clientWidth: 200, clientHeight: 100,
    getBoundingClientRect: () => ({ x: 100, y: 50, width: 400, height: 300 }),
    getClientRects: () => [{ x: 100, y: 50, width: 400, height: 300 }],
  };
  const inner = { ...outer, tagName: "DIV", parentElement: outer, children: [], childNodes: [],
    clientLeft: 0, clientTop: 0, clientWidth: 50, clientHeight: 40,
    getBoundingClientRect: () => ({ x: 120, y: 60, width: 100, height: 80 }),
    getClientRects: () => [{ x: 120, y: 60, width: 100, height: 80 }],
  };
  const deep = { ...inner, tagName: "SPAN", parentElement: inner, children: [], childNodes: [],
    clientLeft: 0, clientTop: 0, clientWidth: 0, clientHeight: 0,
    getBoundingClientRect: () => ({ x: 150, y: 80, width: 100, height: 60 }),
    getClientRects: () => [{ x: 150, y: 80, width: 100, height: 60 }],
  };
  const side = { ...inner, tagName: "BUTTON", parentElement: outer, children: [], childNodes: [],
    getBoundingClientRect: () => ({ x: 195, y: 55, width: 20, height: 20 }),
    getClientRects: () => [{ x: 195, y: 55, width: 20, height: 20 }],
  };
  root.children = [outer]; outer.children = [inner, side]; inner.children = [deep];
  const baseStyle = dom.window.getComputedStyle();
  dom.window.getComputedStyle = element => ({ ...baseStyle,
    transform: element === outer ? "matrix(0.5, 0, 0, 0.5, 0, 0)"
      : element === inner ? "matrix(2, 0, 0, 2, 0, 0)"
        : element === side ? "matrix(3, 0, 0, 3, 0, 0)" : "none",
    overflowX: element === outer || element === inner ? "hidden" : "visible",
    overflowY: element === outer || element === inner ? "hidden" : "visible",
  });
  const registry = createStableNodeRefRegistry("nested-scale");
  const snapshot = observeLiveDom({ ...dom, registry, excludeRoot: null, snapshotRef: "nested-scale", documentRef: "fixture" });
  assert.deepEqual(snapshot.evidence.get(stableNodeRefFor(registry, deep)).clippedRect, { x: 150, y: 80, width: 20, height: 20 });
  assert.deepEqual(snapshot.evidence.get(stableNodeRefFor(registry, side)).clippedRect, { x: 195, y: 55, width: 6, height: 20 });
});

test("legacy zero rect is empty only for absolute and fixed applicability", () => {
  const dom = fakeDom(), root = dom.document.documentElement;
  root.clientLeft = 0; root.clientTop = 0;
  root.clientWidth = 800; root.clientHeight = 600;
  const absolute = { ...root, tagName: "SPAN", parentElement: root, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 30, y: 40, width: 10, height: 10 }),
    getClientRects: () => [{ x: 30, y: 40, width: 10, height: 10 }],
  };
  const fixed = { ...absolute,
    getBoundingClientRect: () => ({ x: 60, y: 70, width: 12, height: 12 }),
    getClientRects: () => [{ x: 60, y: 70, width: 12, height: 12 }],
  };
  const clippedParent = { ...root, tagName: "DIV", parentElement: root, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 50, height: 50 }),
    getClientRects: () => [{ x: 100, y: 100, width: 50, height: 50 }],
  };
  const descendant = { ...clippedParent, tagName: "B", parentElement: clippedParent, children: [], childNodes: [],
    getBoundingClientRect: () => ({ x: 110, y: 110, width: 20, height: 20 }),
    getClientRects: () => [{ x: 110, y: 110, width: 20, height: 20 }],
  };
  clippedParent.children = [descendant];
  const staticTarget = { ...absolute,
    getBoundingClientRect: () => ({ x: 200, y: 200, width: 10, height: 10 }),
    getClientRects: () => [{ x: 200, y: 200, width: 10, height: 10 }],
  };
  const relativeTarget = { ...staticTarget,
    getBoundingClientRect: () => ({ x: 220, y: 220, width: 10, height: 10 }),
    getClientRects: () => [{ x: 220, y: 220, width: 10, height: 10 }],
  };
  root.children = [absolute, fixed, clippedParent, staticTarget, relativeTarget];
  const baseStyle = dom.window.getComputedStyle();
  dom.window.getComputedStyle = element => {
    const style = { ...baseStyle, overflowX: "visible", overflowY: "visible", clip: "auto", position: "static" };
    if (element === absolute) return { ...style, clip: "rect(0px, 0px, 0px, 0px)", position: "absolute" };
    if (element === fixed) return { ...style, clip: "rect(0px, 0px, 0px, 0px)", position: "fixed" };
    if (element === clippedParent) return { ...style, clip: "rect(0px, 0px, 0px, 0px)", position: "absolute" };
    if (element === staticTarget) return { ...style, clip: "rect(0px, 0px, 0px, 0px)", position: "static" };
    if (element === relativeTarget) return { ...style, clip: "rect(0px, 0px, 0px, 0px)", position: "relative" };
    return style;
  };
  const registry = createStableNodeRefRegistry("legacy-clip");
  const snapshot = observeLiveDom({ ...dom, registry, excludeRoot: null, snapshotRef: "legacy-clip", documentRef: "fixture" });
  const clippedRect = element => snapshot.evidence.get(stableNodeRefFor(registry, element)).clippedRect;
  assert.deepEqual(clippedRect(absolute), { x: 30, y: 40, width: 0, height: 0 });
  assert.deepEqual(clippedRect(fixed), { x: 60, y: 70, width: 0, height: 0 });
  assert.deepEqual(clippedRect(descendant), { x: 110, y: 110, width: 0, height: 0 });
  assert.deepEqual(clippedRect(staticTarget), { x: 200, y: 200, width: 10, height: 10 });
  assert.deepEqual(clippedRect(relativeTarget), { x: 220, y: 220, width: 10, height: 10 });
  assert.ok(snapshot.observation.nodes.some(node => node.nodeRef === stableNodeRefFor(registry, absolute)));
  assert.ok(snapshot.evidence.has(stableNodeRefFor(registry, descendant)));
});

test("proven HTML absolute containing block escapes only intermediate ordinary overflow", () => {
  const baseStyle = {
    display: "block",
    visibility: "visible",
    transform: "none",
    translate: "none",
    rotate: "none",
    scale: "none",
    perspective: "none",
    overflowX: "visible",
    overflowY: "visible",
    clipPath: "none",
    clip: "auto",
    contain: "none",
    filter: "none",
    backdropFilter: "none",
    webkitBackdropFilter: "",
    willChange: "auto",
    contentVisibility: "visible",
    position: "static",
  };
  const observeAbsolute = ({
    spanPosition = "static",
    spanOverflow = "hidden",
    containingBlockOverflow = "visible",
    outerOverflow = "visible",
    containingBlockHeight = 60,
    outerHeight = 60,
    pictureHeight = 0,
    imageStyle = {},
    spanStyle = {},
    containingBlockStyle = {},
    pictureStyle = {},
  } = {}) => {
    const dom = fakeDom(), root = dom.document.documentElement;
    root.namespaceURI = "http://www.w3.org/1999/xhtml";
    root.clientLeft = 0; root.clientTop = 0;
    root.clientWidth = 800; root.clientHeight = 600;
    const outer = { ...root, tagName: "DIV", parentElement: root, children: [], childNodes: [], childElementCount: 1,
      clientLeft: 0, clientTop: 0, clientWidth: 100, clientHeight: outerHeight,
      getBoundingClientRect: () => ({ x: 10, y: 20, width: 100, height: 60 }),
      getClientRects: () => [{ x: 10, y: 20, width: 100, height: 60 }],
    };
    const containingBlock = { ...outer, tagName: "DIV", parentElement: outer, children: [], childNodes: [], childElementCount: 1,
      clientHeight: containingBlockHeight,
    };
    const span = { ...containingBlock, tagName: "SPAN", parentElement: containingBlock, children: [], childNodes: [], childElementCount: 1,
      clientWidth: 100, clientHeight: 0,
      getBoundingClientRect: () => ({ x: 10, y: 20, width: 100, height: 0 }),
      getClientRects: () => [{ x: 10, y: 20, width: 100, height: 0 }],
    };
    const picture = { ...span, tagName: "PICTURE", parentElement: span, children: [], childNodes: [], childElementCount: 1,
      clientWidth: 100, clientHeight: pictureHeight,
      getBoundingClientRect: () => ({ x: 10, y: 20, width: 100, height: pictureHeight }),
      getClientRects: () => [{ x: 10, y: 20, width: 100, height: pictureHeight }],
    };
    const image = { ...picture, tagName: "IMG", parentElement: picture, children: [], childNodes: [], childElementCount: 0,
      getBoundingClientRect: () => ({ x: 10, y: 20, width: 100, height: 60 }),
      getClientRects: () => [{ x: 10, y: 20, width: 100, height: 60 }],
    };
    root.children = [outer];
    outer.children = [containingBlock];
    containingBlock.children = [span];
    span.children = [picture];
    picture.children = [image];
    dom.document.querySelectorAll = () => [];
    dom.window.getComputedStyle = element => {
      const style = { ...baseStyle };
      if (element === image) return { ...style, position: "absolute", ...imageStyle };
      if (element === picture) return { ...style, display: "inline", ...pictureStyle };
      if (element === span) return {
        ...style,
        position: spanPosition,
        overflowX: spanOverflow,
        overflowY: spanOverflow,
        ...spanStyle,
      };
      if (element === containingBlock) return {
        ...style,
        position: "absolute",
        overflowX: containingBlockOverflow,
        overflowY: containingBlockOverflow,
        ...containingBlockStyle,
      };
      if (element === outer) return { ...style, overflowX: outerOverflow, overflowY: outerOverflow };
      return style;
    };
    const registry = createStableNodeRefRegistry("absolute-containing-block");
    const snapshot = observeLiveDom({ ...dom, registry, excludeRoot: null, snapshotRef: "absolute-contain", documentRef: "fixture" });
    const imageRef = stableNodeRefFor(registry, image);
    return {
      clippedRect: snapshot.evidence.get(imageRef).clippedRect,
      candidate: checkCandidates(
        observeCandidates({ observation: snapshot.observation }),
        createFocusSpec(),
      ).slots.find(slot => slot.nodeRef === imageRef),
    };
  };

  const escaped = observeAbsolute();
  assert.deepEqual(escaped.clippedRect, { x: 10, y: 20, width: 100, height: 60 },
    "a static zero-height wrapper must not become a false zero clip");
  assert.equal(escaped.candidate.status, "ok");

  const positioned = observeAbsolute({ spanPosition: "relative" });
  assert.deepEqual(positioned.clippedRect, { x: 10, y: 20, width: 100, height: 0 });
  assert.deepEqual(positioned.candidate.reasons, ["nonrendered"]);

  const containingBlockClip = observeAbsolute({ containingBlockOverflow: "hidden", containingBlockHeight: 20 });
  assert.deepEqual(containingBlockClip.clippedRect, { x: 10, y: 20, width: 100, height: 20 });

  const outerClip = observeAbsolute({ outerOverflow: "hidden", outerHeight: 20 });
  assert.deepEqual(outerClip.clippedRect, { x: 10, y: 20, width: 100, height: 20 });

  const legacy = observeAbsolute({ imageStyle: { clip: "rect(0px, 0px, 0px, 0px)" } });
  assert.deepEqual(legacy.clippedRect, { x: 10, y: 20, width: 0, height: 0 });
  assert.deepEqual(legacy.candidate.reasons, ["nonrendered"]);

  const clipPath = observeAbsolute({ spanStyle: { clipPath: 'url("#absolute-clip")' } });
  assert.equal(clipPath.clippedRect, null);
  assert.equal(clipPath.candidate.status, "unknown");

  const unprovenContain = observeAbsolute({ spanStyle: { contain: "layout" } });
  assert.equal(unprovenContain.clippedRect, null);
  assert.equal(unprovenContain.candidate.status, "unknown");

  const missingContainingFact = observeAbsolute({ spanStyle: { willChange: undefined } });
  assert.equal(missingContainingFact.clippedRect, null);
  assert.equal(missingContainingFact.candidate.status, "unknown");

  const applicabilityCases = [
    {
      label: "identity target with immediate positioned containing block",
      result: observeAbsolute({
        spanOverflow: "visible",
        imageStyle: { transform: "matrix(1, 0, 0, 1, 0, 0)" },
        pictureStyle: { position: "relative" },
      }),
      clippedRect: { x: 10, y: 20, width: 100, height: 60 },
    },
    {
      label: "positively scaled target with immediate positioned containing block",
      result: observeAbsolute({
        spanOverflow: "visible",
        imageStyle: { transform: "matrix(1.7, 0, 0, 1.7, 0, 0)" },
        pictureStyle: { position: "relative" },
      }),
      clippedRect: { x: 10, y: 20, width: 100, height: 60 },
    },
    {
      label: "translated target with immediate positioned containing block",
      result: observeAbsolute({
        spanOverflow: "visible",
        imageStyle: { transform: "matrix(1, 0, 0, 1, -0.5, 0)" },
        pictureStyle: { position: "relative" },
      }),
      clippedRect: { x: 10, y: 20, width: 100, height: 60 },
    },
    {
      label: "outer translation with hidden immediate containing block",
      result: observeAbsolute({
        spanOverflow: "visible",
        pictureHeight: 20,
        pictureStyle: { position: "relative", overflowX: "hidden", overflowY: "hidden" },
        containingBlockStyle: { transform: "matrix(1, 0, 0, 1, 50, 0)" },
      }),
      clippedRect: { x: 10, y: 20, width: 100, height: 20 },
    },
    {
      label: "farther containing block with all intermediate overflow visible",
      result: observeAbsolute({
        spanOverflow: "visible",
        imageStyle: { transform: "matrix(1, 0, 0, 1, 0, 0)" },
        pictureStyle: { overflowX: "visible", overflowY: "visible" },
        containingBlockStyle: { transform: "matrix(1, 0, 0, 1, 50, 0)" },
      }),
      clippedRect: { x: 10, y: 20, width: 100, height: 60 },
    },
  ];
  assert.deepEqual(
    applicabilityCases.map(({ label, result }) => ({
      label,
      clippedRect: result.clippedRect,
      candidateStatus: result.candidate.status,
    })),
    applicabilityCases.map(({ label, clippedRect }) => ({
      label,
      clippedRect,
      candidateStatus: "ok",
    })),
  );

  const staticIdentityContainingBlock = observeAbsolute({
    pictureStyle: { transform: "matrix(1, 0, 0, 1, 0, 0)" },
  });
  assert.equal(staticIdentityContainingBlock.clippedRect, null);
  assert.equal(staticIdentityContainingBlock.candidate.status, "unknown");
});

test("unsupported transforms, legacy rects and SVG clipping remain unknown", () => {
  for (const [name, transform] of [
    ["unmeasured", undefined],
    ["empty", ""],
    ["rotation", "matrix(0, 1, -1, 0, 0, 0)"],
    ["skew", "matrix(1, 0, 0.25, 1, 0, 0)"],
    ["reflection", "matrix(-1, 0, 0, 1, 0, 0)"],
    ["zero-scale", "matrix(0, 0, 0, 0, 0, 0)"],
    ["3d", "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 1, 1)"],
    ["malformed", "matrix(0.5, 0, 0)"],
  ]) {
    const dom = fakeDom(), root = dom.document.documentElement;
    root.clientLeft = 0; root.clientTop = 0;
    root.clientWidth = 800; root.clientHeight = 600;
    const target = { ...root, tagName: "DIV", parentElement: root, children: [], childNodes: [], childElementCount: 0,
      getBoundingClientRect: () => ({ x: 10, y: 10, width: 100, height: 40 }),
      getClientRects: () => [{ x: 10, y: 10, width: 100, height: 40 }],
    };
    root.children = [target];
    const baseStyle = dom.window.getComputedStyle();
    dom.window.getComputedStyle = element => ({ ...baseStyle, transform: element === target ? transform : "none" });
    const registry = createStableNodeRefRegistry(`unsupported-${name}`);
    const snapshot = observeLiveDom({ ...dom, registry, excludeRoot: null, snapshotRef: name, documentRef: "fixture" });
    assert.equal(snapshot.evidence.get(stableNodeRefFor(registry, target)).clippedRect, null, name);
  }

  for (const [name, position, clip] of [
    ["nonzero legacy rect", "absolute", "rect(0px, 10px, 10px, 0px)"],
    ["missing legacy position", "", "rect(0px, 0px, 0px, 0px)"],
  ]) {
    const dom = fakeDom(), root = dom.document.documentElement;
    root.clientLeft = 0; root.clientTop = 0;
    root.clientWidth = 800; root.clientHeight = 600;
    const target = { ...root, tagName: "SPAN", parentElement: root, children: [], childNodes: [], childElementCount: 0,
      getBoundingClientRect: () => ({ x: 10, y: 10, width: 100, height: 40 }),
      getClientRects: () => [{ x: 10, y: 10, width: 100, height: 40 }],
    };
    root.children = [target];
    const baseStyle = dom.window.getComputedStyle();
    dom.window.getComputedStyle = element => ({ ...baseStyle,
      ...(element === target ? { clip, position } : {}),
    });
    const registry = createStableNodeRefRegistry(`legacy-unsupported-${name}`);
    const snapshot = observeLiveDom({ ...dom, registry, excludeRoot: null, snapshotRef: name, documentRef: "fixture" });
    assert.equal(snapshot.evidence.get(stableNodeRefFor(registry, target)).clippedRect, null, name);
  }

  const dom = fakeDom(), root = dom.document.documentElement;
  root.clientLeft = 0; root.clientTop = 0;
  root.clientWidth = 800; root.clientHeight = 600;
  const svg = { ...root, tagName: "svg", parentElement: root, children: [], childNodes: [], childElementCount: 1,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    getClientRects: () => [{ x: 0, y: 0, width: 100, height: 100 }],
  };
  const path = { ...svg, tagName: "path", parentElement: svg, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 20, height: 20 }),
    getClientRects: () => [{ x: 10, y: 10, width: 20, height: 20 }],
  };
  svg.children = [path]; root.children = [svg];
  const baseStyle = dom.window.getComputedStyle();
  dom.window.getComputedStyle = element => ({ ...baseStyle, clipPath: element === svg ? 'url("#a")' : "none" });
  const registry = createStableNodeRefRegistry("svg-clip");
  const snapshot = observeLiveDom({ ...dom, registry, excludeRoot: null, snapshotRef: "svg-clip", documentRef: "fixture" });
  assert.equal(snapshot.evidence.get(stableNodeRefFor(registry, path)).clippedRect, null);

  const overflowDom = fakeDom(), overflowRoot = overflowDom.document.documentElement;
  overflowRoot.clientLeft = 0; overflowRoot.clientTop = 0;
  overflowRoot.clientWidth = 800; overflowRoot.clientHeight = 600;
  const overflowSvg = { ...overflowRoot, tagName: "svg", parentElement: overflowRoot, children: [], childNodes: [], childElementCount: 1,
    clientWidth: 100, clientHeight: 100,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    getClientRects: () => [{ x: 0, y: 0, width: 100, height: 100 }],
  };
  const overflowPath = { ...overflowSvg, tagName: "path", parentElement: overflowSvg, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 20, height: 20.78125 }),
    getClientRects: () => [{ x: 10, y: 10, width: 20, height: 20.78125 }],
  };
  overflowSvg.children = [overflowPath]; overflowRoot.children = [overflowSvg];
  const overflowBase = overflowDom.window.getComputedStyle();
  overflowDom.window.getComputedStyle = element => ({ ...overflowBase,
    overflowX: element === overflowSvg ? "hidden" : "visible",
    overflowY: element === overflowSvg ? "hidden" : "visible",
  });
  const overflowRegistry = createStableNodeRefRegistry("svg-overflow");
  const overflowSnapshot = observeLiveDom({ ...overflowDom, registry: overflowRegistry, excludeRoot: null, snapshotRef: "svg-overflow", documentRef: "fixture" });
  assert.deepEqual(overflowSnapshot.evidence.get(stableNodeRefFor(overflowRegistry, overflowPath)).clippedRect,
    { x: 10, y: 10, width: 20, height: 20.78125 });
  const nestedSvg = { ...overflowSvg, parentElement: overflowSvg, clientWidth: 0, clientHeight: 0, children: [overflowPath] };
  overflowPath.parentElement = nestedSvg;
  overflowSvg.children = [nestedSvg];
  overflowDom.window.getComputedStyle = element => ({ ...overflowBase,
    overflowX: element === nestedSvg ? "hidden" : "visible",
    overflowY: element === nestedSvg ? "hidden" : "visible",
  });
  const nestedSnapshot = observeLiveDom({ ...overflowDom, registry: overflowRegistry, excludeRoot: null, snapshotRef: "nested-svg", documentRef: "fixture" });
  assert.equal(nestedSnapshot.evidence.get(stableNodeRefFor(overflowRegistry, overflowPath)).clippedRect, null);
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
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 100, height: 40 }), getAttribute: () => null,
    isContentEditable: false };
  const child = { ...html, tagName: "BUTTON", parentElement: parent, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 11, y: 11, width: 98, height: 38 }), getAttribute: () => null,
    isContentEditable: false };
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

test("unread OBJECT document is explicit coverage, not an empty inspected interior", () => {
  const dom = fakeDom(), html = dom.document.documentElement;
  const embedded = { ...html, tagName: "OBJECT", parentElement: html, children: [], childNodes: [],
    get contentDocument() { throw new Error("the top-document observer must not inspect the embedded document"); },
  };
  html.children = [embedded];
  const registry = createStableNodeRefRegistry("object-coverage");
  const snapshot = observeLiveDom({ ...dom, registry, excludeRoot: null, snapshotRef: "object-coverage", documentRef: "fixture" });
  assert.equal(snapshot.observation.nodes.length, 2);
  assert.deepEqual(snapshot.evidence.get(stableNodeRefFor(registry, embedded)).unassessedChildContent, ["object_content"]);
  assert.equal(snapshot.coverage.unassessedObjectCount, 1);
  const exploration = snapshot.explorationInputs.get(stableNodeRefFor(registry, embedded));
  assert.deepEqual(exploration.measurementCoverage.unassessedInterior, ["object_content"]);
});

test("live currentView records nine HTML facts and does not pretend an SVG element is HTML", () => {
  const dom = currentViewDom();
  const transparent = currentViewElement(dom.document, {
    tag: "DIV",
    parent: dom.html,
    rectValue: rect(10, 10, 120, 40),
  });
  const embedded = currentViewElement(dom.document, {
    tag: "OBJECT",
    parent: transparent,
    rectValue: rect(10, 10, 120, 40),
  });
  const svg = currentViewElement(dom.document, {
    tag: "DIV",
    parent: transparent,
    namespaceURI: "http://www.w3.org/2000/svg",
    rectValue: rect(20, 20, 40, 20),
  });
  appendCurrentViewChild(dom.html, transparent);
  appendCurrentViewChild(transparent, embedded);
  appendCurrentViewChild(transparent, svg);
  transparent.currentViewStyle = { ...dom.baseStyle, opacity: "0", pointerEvents: "none" };
  embedded.currentViewStyle = { ...dom.baseStyle, opacity: "1", pointerEvents: "none" };
  svg.currentViewStyle = { ...dom.baseStyle, opacity: "0", pointerEvents: "none" };

  const registry = createStableNodeRefRegistry("current-view-facts");
  const snapshot = observeLiveDom({
    document: dom.document,
    window: dom.window,
    registry,
    excludeRoot: null,
    snapshotRef: "current-view-facts",
    documentRef: "fixture",
  });
  const transparentRecord = snapshot.observation.nodes.find(node => node.nodeRef === stableNodeRefFor(registry, transparent));
  const embeddedRecord = snapshot.observation.nodes.find(node => node.nodeRef === stableNodeRefFor(registry, embedded));
  const svgRecord = snapshot.observation.nodes.find(node => node.nodeRef === stableNodeRefFor(registry, svg));

  assert.deepEqual(transparentRecord.currentView, {
    zeroOpacityInCurrentPaintPath: true,
    pointerEventsNone: true,
    activeElementFocus: false,
    focusWithin: false,
    nativeTabIndex: -1,
    contentEditable: false,
    directTextPresent: false,
    ownLabelPresent: false,
    topLayer: false,
  });
  assert.equal(embeddedRecord.currentView.zeroOpacityInCurrentPaintPath, true);
  assert.equal(Object.hasOwn(svgRecord, "currentView"), false);
});

test("currentView opacity proof requires a non-top-layer path and never infers zero from invalid or underflowing values", () => {
  const dom = currentViewDom();
  const zeroParent = currentViewElement(dom.document, { parent: dom.html });
  const inherited = currentViewElement(dom.document, { tag: "OBJECT", parent: zeroParent });
  const topLayerTrue = currentViewElement(dom.document, { tag: "OBJECT", parent: zeroParent, topLayer: true });
  const topLayerUnknown = currentViewElement(dom.document, { tag: "OBJECT", parent: zeroParent, topLayerThrows: true });
  const selfZero = currentViewElement(dom.document, { parent: dom.html, topLayer: true });
  const underflowOuter = currentViewElement(dom.document, { parent: dom.html });
  const underflowInner = currentViewElement(dom.document, { parent: underflowOuter });
  const underflowTarget = currentViewElement(dom.document, { tag: "OBJECT", parent: underflowInner });
  const invalidParent = currentViewElement(dom.document, { parent: dom.html });
  const invalidTarget = currentViewElement(dom.document, { tag: "OBJECT", parent: invalidParent });
  for (const [parent, child] of [
    [dom.html, zeroParent],
    [zeroParent, inherited],
    [zeroParent, topLayerTrue],
    [zeroParent, topLayerUnknown],
    [dom.html, selfZero],
    [dom.html, underflowOuter],
    [underflowOuter, underflowInner],
    [underflowInner, underflowTarget],
    [dom.html, invalidParent],
    [invalidParent, invalidTarget],
  ]) appendCurrentViewChild(parent, child);
  zeroParent.currentViewStyle = { ...dom.baseStyle, opacity: "0" };
  inherited.currentViewStyle = { ...dom.baseStyle, opacity: "1" };
  topLayerTrue.currentViewStyle = { ...dom.baseStyle, opacity: "1" };
  topLayerUnknown.currentViewStyle = { ...dom.baseStyle, opacity: "1" };
  selfZero.currentViewStyle = { ...dom.baseStyle, opacity: "0" };
  underflowOuter.currentViewStyle = { ...dom.baseStyle, opacity: "1e-200" };
  underflowInner.currentViewStyle = { ...dom.baseStyle, opacity: "1e-200" };
  underflowTarget.currentViewStyle = { ...dom.baseStyle, opacity: "1" };
  invalidParent.currentViewStyle = { ...dom.baseStyle, opacity: "" };
  invalidTarget.currentViewStyle = { ...dom.baseStyle, opacity: "1" };

  const registry = createStableNodeRefRegistry("current-view-opacity");
  const snapshot = observeLiveDom({
    document: dom.document,
    window: dom.window,
    registry,
    excludeRoot: null,
    snapshotRef: "current-view-opacity",
    documentRef: "fixture",
  });
  const opacity = element => snapshot.observation.nodes
    .find(node => node.nodeRef === stableNodeRefFor(registry, element))
    .currentView.zeroOpacityInCurrentPaintPath;
  assert.equal(opacity(inherited), true);
  assert.equal(opacity(topLayerTrue), null);
  assert.equal(opacity(topLayerUnknown), null);
  assert.equal(opacity(selfZero), true);
  assert.equal(opacity(underflowTarget), false);
  assert.equal(opacity(invalidTarget), null);

  // An invalid target opacity cannot borrow a valid zero from its ancestor.
  for (const value of ["not-opacity", "NaN", "Infinity", "-0.5", "1.5", "0x0"]) {
    inherited.currentViewStyle = { ...dom.baseStyle, opacity: value };
    const invalid = observeLiveDom({ document: dom.document, window: dom.window, registry,
      excludeRoot: null, snapshotRef: "invalid-current-opacity", documentRef: "fixture" });
    assert.equal(invalid.observation.nodes.find(node => node.nodeRef === stableNodeRefFor(registry, inherited))
      .currentView.zeroOpacityInCurrentPaintPath, null, value);
  }
});

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

test("live currentView records supported SVG svg/use under a strict zero-opacity ancestry with null edit facts", () => {
  const dom = currentViewDom();
  const transparent = currentViewElement(dom.document, { parent: dom.html, rectValue: rect(10, 10, 120, 40) });
  const svg = currentViewElement(dom.document, {
    tag: "svg",
    namespaceURI: SVG_NAMESPACE,
    parent: transparent,
    rectValue: rect(10, 10, 120, 40),
  });
  const use = currentViewElement(dom.document, {
    tag: "use",
    namespaceURI: SVG_NAMESPACE,
    parent: svg,
    rectValue: rect(10, 10, 120, 40),
  });
  appendCurrentViewChild(dom.html, transparent);
  appendCurrentViewChild(transparent, svg);
  appendCurrentViewChild(svg, use);
  transparent.currentViewStyle = { ...dom.baseStyle, opacity: "0", pointerEvents: "none" };
  svg.currentViewStyle = { ...dom.baseStyle, opacity: "1", pointerEvents: "none" };
  use.currentViewStyle = { ...dom.baseStyle, opacity: "1", pointerEvents: "none" };

  const registry = createStableNodeRefRegistry("svg-current-view");
  const snapshot = observeLiveDom({
    document: dom.document,
    window: dom.window,
    registry,
    excludeRoot: null,
    snapshotRef: "svg-current-view",
    documentRef: "fixture",
  });
  const svgRef = stableNodeRefFor(registry, svg);
  const useRef = stableNodeRefFor(registry, use);
  const record = ref => snapshot.observation.nodes.find(node => node.nodeRef === ref);
  const expected = {
    namespaceURI: SVG_NAMESPACE,
    zeroOpacityInCurrentPaintPath: true,
    pointerEventsNone: true,
    activeElementFocus: false,
    focusWithin: false,
    nativeTabIndex: -1,
    contentEditable: null,
    editingContextActive: false,
    directTextPresent: false,
    ownLabelPresent: false,
    topLayer: false,
  };
  assert.deepEqual(record(svgRef).currentView, expected);
  assert.deepEqual(record(useRef).currentView, expected);
  assert.equal(snapshot.itemObservations.find(item => item.nodeRef === svgRef).contentEditable, null);
  assert.equal(snapshot.itemObservations.find(item => item.nodeRef === useRef).contentEditable, null);

  const batch = checkCandidates(
    observeCandidates({ observation: snapshot.observation }),
    createFocusSpec(),
  );
  const slot = ref => batch.slots.find(candidate => candidate.nodeRef === ref);
  assert.deepEqual(slot(svgRef).reasons, ["current_view_nonrendered"]);
  assert.deepEqual(slot(useRef).reasons, ["current_view_nonrendered"]);
  assert.equal(snapshot.observation.nodes.length, 4);
});

test("SVG editing context trusts native SVG and complete HTML edit measurements without a designMode gate", () => {
  const editingContextFor = prepare => {
    const dom = currentViewDom();
    const host = currentViewElement(dom.document, { parent: dom.html });
    const svg = currentViewElement(dom.document, {
      tag: "svg",
      namespaceURI: SVG_NAMESPACE,
      parent: host,
    });
    appendCurrentViewChild(dom.html, host);
    appendCurrentViewChild(host, svg);
    host.currentViewStyle = { ...dom.baseStyle, opacity: "1", pointerEvents: "none" };
    svg.currentViewStyle = { ...dom.baseStyle, opacity: "1", pointerEvents: "none" };
    prepare(dom, host, svg);
    const registry = createStableNodeRefRegistry("svg-editing-context");
    const snapshot = observeLiveDom({
      document: dom.document,
      window: dom.window,
      registry,
      excludeRoot: null,
      snapshotRef: "svg-editing-context",
      documentRef: "fixture",
    });
    return snapshot.observation.nodes
      .find(node => node.nodeRef === stableNodeRefFor(registry, svg))
      ?.currentView?.editingContextActive;
  };

  assert.equal(editingContextFor((dom, host, svg) => {
    svg.isContentEditable = true;
  }), true);

  assert.equal(editingContextFor((dom, host, svg) => {
    delete svg.isContentEditable;
    host.isContentEditable = true;
  }), true);

  assert.equal(editingContextFor((dom, host, svg) => {
    delete svg.isContentEditable;
    delete host.isContentEditable;
  }), false);

  assert.equal(editingContextFor((dom, host, svg) => {
    delete svg.isContentEditable;
    delete host.isContentEditable;
    delete host.matches;
  }), null);

  assert.equal(editingContextFor((dom, host, svg) => {
    delete svg.isContentEditable;
    delete host.isContentEditable;
    delete host.matches;
    dom.document.designMode = "on";
  }), true);

  assert.equal(editingContextFor((dom, host, svg) => {
    delete svg.isContentEditable;
    delete host.isContentEditable;
    delete host.matches;
    dom.document.designMode = "off";
  }), false);

  const boundaryContextFor = boundaryNamespace => {
    const dom = currentViewDom();
    const host = currentViewElement(dom.document, { parent: dom.html });
    const boundary = currentViewElement(dom.document, {
      tag: boundaryNamespace === SVG_NAMESPACE ? "foreignObject" : "g",
      namespaceURI: boundaryNamespace,
      parent: host,
    });
    const svg = currentViewElement(dom.document, {
      tag: "svg",
      namespaceURI: SVG_NAMESPACE,
      parent: boundary,
    });
    appendCurrentViewChild(dom.html, host);
    appendCurrentViewChild(host, boundary);
    appendCurrentViewChild(boundary, svg);
    for (const element of [host, boundary, svg]) {
      element.currentViewStyle = { ...dom.baseStyle, opacity: "1", pointerEvents: "none" };
    }
    const registry = createStableNodeRefRegistry("svg-editing-boundary");
    const snapshot = observeLiveDom({
      document: dom.document,
      window: dom.window,
      registry,
      excludeRoot: null,
      snapshotRef: "svg-editing-boundary",
      documentRef: "fixture",
    });
    return snapshot.observation.nodes
      .find(node => node.nodeRef === stableNodeRefFor(registry, svg))
      ?.currentView?.editingContextActive;
  };
  assert.equal(boundaryContextFor(SVG_NAMESPACE), null);
  assert.equal(boundaryContextFor("urn:fixture:unknown"), null);
});

test("SVG current-view opacity proof uses only an actual zero on a fully non-top-layer chain", () => {
  const opacityFor = ({ outer, inner, target, outerTopLayer = false, outerThrows = false }) => {
    const dom = currentViewDom();
    const outerElement = currentViewElement(dom.document, {
      parent: dom.html,
      topLayer: outerTopLayer,
      topLayerThrows: outerThrows,
    });
    const svg = currentViewElement(dom.document, {
      tag: "svg",
      namespaceURI: SVG_NAMESPACE,
      parent: outerElement,
    });
    const use = currentViewElement(dom.document, {
      tag: "use",
      namespaceURI: SVG_NAMESPACE,
      parent: svg,
    });
    appendCurrentViewChild(dom.html, outerElement);
    appendCurrentViewChild(outerElement, svg);
    appendCurrentViewChild(svg, use);
    outerElement.currentViewStyle = { ...dom.baseStyle, opacity: outer, pointerEvents: "none" };
    svg.currentViewStyle = { ...dom.baseStyle, opacity: inner, pointerEvents: "none" };
    use.currentViewStyle = { ...dom.baseStyle, opacity: target, pointerEvents: "none" };
    const registry = createStableNodeRefRegistry("svg-opacity");
    const snapshot = observeLiveDom({
      document: dom.document,
      window: dom.window,
      registry,
      excludeRoot: null,
      snapshotRef: "svg-opacity",
      documentRef: "fixture",
    });
    const zero = element => snapshot.observation.nodes
      .find(node => node.nodeRef === stableNodeRefFor(registry, element))
      ?.currentView?.zeroOpacityInCurrentPaintPath;
    return { svg: zero(svg), use: zero(use) };
  };

  assert.deepEqual(opacityFor({ outer: "0", inner: "1", target: "1" }), { svg: true, use: true });
  assert.deepEqual(opacityFor({ outer: "0", inner: "1", target: "1", outerTopLayer: true }), { svg: null, use: null });
  assert.deepEqual(opacityFor({ outer: "0", inner: "1", target: "1", outerThrows: true }), { svg: null, use: null });
  assert.deepEqual(opacityFor({ outer: "1e-200", inner: "1e-200", target: "1" }), { svg: false, use: false });
  assert.deepEqual(opacityFor({ outer: "1", inner: "0", target: "1" }), { svg: true, use: true });
});

test("SVG current-view focus protection covers actual focus with negative tabindex and focus-within", () => {
  const dom = currentViewDom();
  const transparent = currentViewElement(dom.document, { parent: dom.html, rectValue: rect(10, 10, 120, 40) });
  const svg = currentViewElement(dom.document, {
    tag: "svg",
    namespaceURI: SVG_NAMESPACE,
    parent: transparent,
    rectValue: rect(10, 10, 120, 40),
  });
  const use = currentViewElement(dom.document, {
    tag: "use",
    namespaceURI: SVG_NAMESPACE,
    parent: svg,
    tabIndex: -1,
    rectValue: rect(10, 10, 120, 40),
  });
  appendCurrentViewChild(dom.html, transparent);
  appendCurrentViewChild(transparent, svg);
  appendCurrentViewChild(svg, use);
  transparent.currentViewStyle = { ...dom.baseStyle, opacity: "0", pointerEvents: "none" };
  svg.currentViewStyle = { ...dom.baseStyle, opacity: "1", pointerEvents: "none" };
  use.currentViewStyle = { ...dom.baseStyle, opacity: "1", pointerEvents: "none" };
  let useFocused = true;
  const baseSvgMatches = svg.matches;
  svg.matches = selector => selector === ":focus-within" ? useFocused : baseSvgMatches(selector);
  dom.document.activeElement = use;

  const registry = createStableNodeRefRegistry("svg-focus");
  const snapshot = observeLiveDom({
    document: dom.document,
    window: dom.window,
    registry,
    excludeRoot: null,
    snapshotRef: "svg-focus",
    documentRef: "fixture",
  });
  const svgRef = stableNodeRefFor(registry, svg);
  const useRef = stableNodeRefFor(registry, use);
  const record = ref => snapshot.observation.nodes.find(node => node.nodeRef === ref).currentView;
  assert.equal(record(useRef).activeElementFocus, true);
  assert.equal(record(useRef).nativeTabIndex, -1);
  assert.equal(record(svgRef).focusWithin, true);
  let batch = checkCandidates(
    observeCandidates({ observation: snapshot.observation }),
    createFocusSpec(),
  );
  assert.equal(batch.slots.find(slot => slot.nodeRef === useRef).reasons.includes("current_view_nonrendered"), false);
  assert.equal(batch.slots.find(slot => slot.nodeRef === svgRef).reasons.includes("current_view_nonrendered"), false);

  dom.document.activeElement = dom.html;
  useFocused = false;
  use.tabIndex = 0;
  const sequential = observeLiveDom({
    document: dom.document,
    window: dom.window,
    registry,
    excludeRoot: null,
    snapshotRef: "svg-sequential-focus",
    documentRef: "fixture",
  });
  batch = checkCandidates(
    observeCandidates({ observation: sequential.observation }),
    createFocusSpec(),
  );
  assert.equal(sequential.observation.nodes.find(node => node.nodeRef === useRef).currentView.nativeTabIndex, 0);
  assert.equal(batch.slots.find(slot => slot.nodeRef === useRef).reasons.includes("current_view_nonrendered"), false);

  use.tabIndex = -1;
  const restored = observeLiveDom({
    document: dom.document,
    window: dom.window,
    registry,
    excludeRoot: null,
    snapshotRef: "svg-focus-restored",
    documentRef: "fixture",
  });
  batch = checkCandidates(
    observeCandidates({ observation: restored.observation }),
    createFocusSpec(),
  );
  assert.deepEqual(batch.slots.find(slot => slot.nodeRef === useRef).reasons, ["current_view_nonrendered"]);
});

test("SVG current-view exclusion preserves label, text, role and positive-opacity protection", () => {
  const protectedSvg = prepare => {
    const dom = currentViewDom();
    const transparent = currentViewElement(dom.document, { parent: dom.html });
    const svg = currentViewElement(dom.document, {
      tag: "svg",
      namespaceURI: SVG_NAMESPACE,
      parent: transparent,
    });
    appendCurrentViewChild(dom.html, transparent);
    appendCurrentViewChild(transparent, svg);
    transparent.currentViewStyle = { ...dom.baseStyle, opacity: "0", pointerEvents: "none" };
    svg.currentViewStyle = { ...dom.baseStyle, opacity: "1", pointerEvents: "none" };
    prepare(dom, svg);
    const registry = createStableNodeRefRegistry("svg-protection");
    const snapshot = observeLiveDom({
      document: dom.document,
      window: dom.window,
      registry,
      excludeRoot: null,
      snapshotRef: "svg-protection",
      documentRef: "fixture",
    });
    const svgRef = stableNodeRefFor(registry, svg);
    const node = snapshot.observation.nodes.find(candidate => candidate.nodeRef === svgRef);
    const batch = checkCandidates(
      observeCandidates({ observation: snapshot.observation }),
      createFocusSpec(),
    );
    return {
      currentView: node.currentView,
      role: node.role,
      filtered: batch.slots.find(slot => slot.nodeRef === svgRef).reasons.includes("current_view_nonrendered"),
    };
  };

  const titleAttribute = protectedSvg((dom, svg) => {
    svg.getAttribute = name => name === "title" ? "named icon" : null;
  });
  assert.equal(titleAttribute.currentView.ownLabelPresent, true);
  assert.equal(titleAttribute.filtered, false);

  const labelledBy = protectedSvg((dom, svg) => {
    svg.getAttribute = name => name === "aria-labelledby" ? "label-id" : null;
  });
  assert.equal(labelledBy.currentView.ownLabelPresent, true);
  assert.equal(labelledBy.filtered, false);

  const titleChild = protectedSvg((dom, svg) => {
    const title = currentViewElement(dom.document, {
      tag: "title",
      namespaceURI: SVG_NAMESPACE,
      parent: svg,
      directText: "named icon",
    });
    title.textContent = "named icon";
    title.currentViewStyle = { ...dom.baseStyle };
    appendCurrentViewChild(svg, title);
  });
  assert.equal(titleChild.currentView.ownLabelPresent, true);
  assert.equal(titleChild.filtered, false);

  const directText = protectedSvg((dom, svg) => {
    svg.childNodes = [{ nodeType: 3, textContent: "readable text" }];
  });
  assert.equal(directText.currentView.directTextPresent, true);
  assert.equal(directText.filtered, false);

  const knownRole = protectedSvg((dom, svg) => {
    svg.getAttribute = name => name === "role" ? "img" : null;
  });
  assert.equal(knownRole.role, "img");
  assert.equal(knownRole.filtered, false);

  const positiveOpacity = protectedSvg((dom, svg) => {
    svg.parentElement.currentViewStyle = { ...dom.baseStyle, opacity: "1", pointerEvents: "none" };
    svg.currentViewStyle = { ...dom.baseStyle, opacity: "1", pointerEvents: "none" };
    svg.getAttribute = name => name === "title" ? "readable icon" : null;
  });
  assert.equal(positiveOpacity.currentView.zeroOpacityInCurrentPaintPath, false);
  assert.equal(positiveOpacity.filtered, false);
});

test("current-view paint-path facts are measured once per snapshot rather than once per descendant", () => {
  for (const size of [40, 80, 160]) {
    const dom = currentViewDom();
    let parent = dom.html, selectors = 0;
    for (let index = 0; index < size; index++) {
      const element = currentViewElement(dom.document, { parent });
      element.currentViewStyle = dom.baseStyle;
      const matches = element.matches;
      element.matches = selector => { selectors++; return matches(selector); };
      appendCurrentViewChild(parent, element);
      parent = element;
    }
    const snapshot = observeLiveDom({ document: dom.document, window: dom.window,
      registry: createStableNodeRefRegistry("paint-path-cost"), excludeRoot: null,
      snapshotRef: "paint-path-cost", documentRef: "fixture" });
    assert.equal(snapshot.observation.nodes.length, size + 1);
    assert.ok(snapshot.observation.nodes.slice(1).every(node => node.currentView.zeroOpacityInCurrentPaintPath === false));
    assert.ok(selectors <= 15 * size, `${size} nodes made ${selectors} native selector calls`);
  }
});

test("public overlay workflow excludes current-view surfaces without pruning focus or OBJECT coverage", async () => {
  const graph = JSON.parse(readFileSync(
    new URL("../workflows/browser-visual-overlay.graph.json", import.meta.url),
    "utf8",
  ));
  const dom = currentViewDom();
  const transparent = currentViewElement(dom.document, { parent: dom.html, rectValue: rect(10, 10, 120, 40) });
  const embedded = currentViewElement(dom.document, { tag: "OBJECT", parent: transparent, rectValue: rect(10, 10, 120, 40) });
  const focused = currentViewElement(dom.document, { tag: "INPUT", parent: transparent, tabIndex: 0, rectValue: rect(20, 20, 40, 20) });
  appendCurrentViewChild(dom.html, transparent);
  appendCurrentViewChild(transparent, embedded);
  appendCurrentViewChild(transparent, focused);
  transparent.currentViewStyle = { ...dom.baseStyle, opacity: "0", pointerEvents: "none" };
  embedded.currentViewStyle = { ...dom.baseStyle, opacity: "1", pointerEvents: "none" };
  focused.currentViewStyle = { ...dom.baseStyle, opacity: "1", pointerEvents: "auto" };
  dom.document.activeElement = focused;

  const registry = createStableNodeRefRegistry("current-view-workflow");
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
    runId: "current-view-overlay-run",
    eventId: "current-view-overlay-run:input",
    port: "overlay_request",
    type: BROWSER_OVERLAY_REQUEST_EVENT_TYPE,
    correlation: {},
    payload: { snapshotRef: "current-view-overlay", documentRef: "fixture" },
  }));

  assert.equal(result.status, "completed");
  assert.equal(result.outputEvent.status, "ok");
  assert.equal(presentCalls, 1);
  const frame = result.outputEvent.payload;
  const transparentRef = stableNodeRefFor(registry, transparent);
  const embeddedRef = stableNodeRefFor(registry, embedded);
  const focusedRef = stableNodeRefFor(registry, focused);
  const candidateSlots = new Map(frame.candidateBatch.slots.map(slot => [slot.nodeRef, slot]));
  assert.deepEqual(candidateSlots.get(transparentRef).reasons, ["current_view_nonrendered"]);
  assert.deepEqual(candidateSlots.get(embeddedRef).reasons, ["current_view_nonrendered"]);
  assert.equal(candidateSlots.get(focusedRef).status, "ok");
  assert.equal(frame.snapshot.itemObservations.find(item => item.nodeRef === focusedRef).activeElementFocus, true);
  assert.equal(frame.basicKindBatch.slots.find(slot => slot.nodeRef === embeddedRef).candidateStatus, "filtered_out");
  assert.deepEqual(frame.snapshot.evidence.get(embeddedRef).unassessedChildContent, ["object_content"]);
  assert.equal(frame.snapshot.coverage.unassessedObjectCount, 1);
});

test("optional resource producer requires explicit read effect before workflow execution", () => {
  const graph = JSON.parse(readFileSync(new URL("../workflows/browser-visual-overlay.graph.json", import.meta.url), "utf8"));
  let reads = 0;
  const definitions = createBrowserOverlayNodeDefinitions({
    document: {}, window: {}, registry: createStableNodeRefRegistry("resource-effects"), excludeHost: null,
    imageResources: { read: async () => { reads++; return { status: "unavailable", reason: "read-failed" }; }, peek: () => undefined },
    present: () => undefined,
  });
  assert.throws(() => compileWorkflow({ graph, bindings: {
    "筛选当前视口与关注候选": { config: { viewportOnly: true, scopeMode: "subtree" } },
    "判断DOM基础种类": { config: DEFAULT_BASIC_KIND_CONFIG },
  } }, { nodeDefinitions: definitions, grantedEffects: ["browser.dom.read", "browser.overlay.present"] }),
  error => error.code === "COMPILE_EFFECT_UNAUTHORIZED");
  assert.equal(reads, 0);
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
  html.clientHeight = 600;
  const clip = { ...html, tagName: "DIV", parentElement: html, isConnected: true,
    clientLeft: 0, clientTop: 0, clientWidth: 800, clientHeight: 30,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 800, height: 30 }),
    getClientRects: () => [{ x: 0, y: 0, width: 800, height: 30 }],
  };
  const child = { ...html, tagName: "BUTTON", parentElement: clip, isConnected: true,
    getBoundingClientRect: () => ({ x: 0, y: 20, width: 100, height: 40 }),
    getClientRects: () => [{ x: 0, y: 20, width: 100, height: 40 }],
  };
  html.children = [clip]; clip.children = [child];
  const getStyle = dom.window.getComputedStyle;
  dom.window.getComputedStyle = element => ({ ...getStyle(), overflowY: element === clip ? "hidden" : "visible" });
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
