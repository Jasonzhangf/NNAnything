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
  const box = overrides.rect ?? rect();
  return {
    nodeRef,
    parentRef: null,
    tag: overrides.tag ?? "button",
    role: overrides.role ?? null,
    rect: box,
    fragments: overrides.fragments ?? [box],
    clippedRect: overrides.clippedRect ?? box,
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
      rect: node.rect ?? rect(),
      clippedRect: node.clippedRect ?? node.rect ?? rect(),
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
  const snapshot = snapshotFixture({
    nodes: [
      { ref: "button", tag: "button", rect: rect(10, 10, 120, 40) },
      { ref: "unknown", tag: "span", rect: rect(10, 70, 120, 20) },
      { ref: "conflict", tag: "span", rect: rect(10, 100, 120, 20) },
      { ref: "filtered", tag: "button", rect: rect(900, 10, 120, 40) },
      { ref: "candidate-unknown", tag: "span", rect: rect(10, 140, 120, 20) },
    ],
    properties: {
      button: basicProperties("button"),
      unknown: basicProperties("span", { directTextPresent: null }),
      conflict: basicProperties("span", { directTextPresent: null }),
      filtered: basicProperties("button"),
      "candidate-unknown": basicProperties("span", { directTextPresent: null }),
    },
  });
  const focusSpec = createFocusSpec();
  let candidateBatch = checkCandidates(observeCandidates({ observation: snapshot.observation }), focusSpec);
  candidateBatch = {
    ...candidateBatch,
    slots: candidateBatch.slots.map((slot) => {
      if (slot.nodeRef === "candidate-unknown") {
        return { ...slot, status: "unknown", reasons: ["candidate_unknown"] };
      }
      return slot;
    }),
    candidateRefs: candidateBatch.slots
      .filter((slot) => slot.nodeRef !== "candidate-unknown" && slot.status === "ok")
      .map((slot) => slot.nodeRef),
  };
  let basicKindBatch = classifyBasicKindBatch(
    { ...candidateBatch, itemObservations: snapshot.itemObservations },
    DEFAULT_BASIC_KIND_CONFIG,
    DEFAULT_BASIC_KIND_PROFILE,
  );
  basicKindBatch = {
    ...basicKindBatch,
    slots: basicKindBatch.slots.map((slot) => slot.nodeRef === "conflict" ? {
      ...slot,
      judgmentStatus: "conflict",
      basicKind: "other",
      score: null,
      margin: null,
      reasons: ["competing_basic_kinds"],
    } : slot),
  };
  return {
    snapshot,
    focusSpec,
    profileId: DEFAULT_BASIC_KIND_PROFILE.id,
    candidateBatch,
    basicKindBatch,
    boxes: [],
    presentation: {
      view: {
        boxes: [],
        counts: { totalNodes: snapshot.observation.nodes.length, candidates: 4, judged: 1, unknown: 2, conflict: 1 },
        focus: null,
        coverage: snapshot.coverage,
        profileId: DEFAULT_BASIC_KIND_PROFILE.id,
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
  const nodes = Array.from({ length: count }, (_, index) => ({
    ref: `unknown-${index}`,
    tag: "span",
    rect: rect(0, index % 500, 10, 10),
  }));
  const properties = Object.fromEntries(nodes.map((node) => [
    node.ref,
    basicProperties("span", { directTextPresent: null }),
  ]));
  const snapshot = snapshotFixture({ nodes, properties, evidence: {
    "unknown-0": { id: "secret-id", classList: ["secret-class"], textSummary: "visible label" },
  } });
  const candidateBatch = {
    observation: snapshot.observation,
    mode: "page",
    slots: nodes.map((node, index) => ({
      index,
      nodeRef: node.ref,
      status: "ok",
      reasons: [],
      evidence: { boundingBoxIntersection: "positive", fragments: "assessed", clipping: "assessed" },
    })),
    candidateRefs: nodes.map((node) => node.ref),
    ruleVersion: "0.1.0",
  };
  const basicKindBatch = classifyBasicKindBatch(
    { ...candidateBatch, itemObservations: snapshot.itemObservations },
    DEFAULT_BASIC_KIND_CONFIG,
    DEFAULT_BASIC_KIND_PROFILE,
  );
  const frame = {
    snapshot,
    focusSpec: createFocusSpec(),
    profileId: DEFAULT_BASIC_KIND_PROFILE.id,
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
