import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BROWSER_CAPTURE_REQUEST_EVENT_TYPE,
  BROWSER_OVERLAY_REQUEST_EVENT_TYPE,
  BrowserCaptureSession,
  DEFAULT_BASIC_KIND_CONFIG,
  DEFAULT_BASIC_KIND_PROFILE,
  checkCandidates,
  classifyBasicKindBatch,
  compileWorkflow,
  createBrowserCaptureNodeDefinitions,
  createBrowserOverlayNodeDefinitions,
  createFocusSpec,
  createStableNodeRefRegistry,
  createWorkflowInputEvent,
  extractTrainingRequestFromBundle,
  observeCandidates,
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
    childElementCount: 0,
    positiveAreaChildCount: 0,
    repeatedChildGeometry: null,
    inVerifiedListParent: null,
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
        childElementCount: propertiesValue.childElementCount,
        positiveAreaChildCount: propertiesValue.positiveAreaChildCount,
        repeatedChildGeometry: propertiesValue.repeatedChildGeometry,
        inVerifiedListParent: propertiesValue.inVerifiedListParent,
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

function runtimeGraph(raw) {
  const clone = structuredClone(raw);
  clone.version = clone.version.replace(/-design$/, "");
  for (const node of clone.nodes) node.operator_version = node.operator_version.replace(/-design$/, "");
  return clone;
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

test("public overlay graph runs through compileWorkflow and runWorkflow with a no-op present callback", async () => {
  const graph = runtimeGraph(JSON.parse(readFileSync(
    new URL("../workflows/browser-visual-overlay.graph.json", import.meta.url),
    "utf8",
  )));
  const dom = fakeDom();
  let presentCalls = 0;
  const definitions = createBrowserOverlayNodeDefinitions({
    document: dom.document,
    window: dom.window,
    registry: createStableNodeRefRegistry("overlay-test"),
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
    grantedEffects: ["browser.overlay.present"],
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
});

test("capture graph enforces effects and calls the explicit download callback only on export", async () => {
  const graph = runtimeGraph(JSON.parse(readFileSync(
    new URL("../workflows/browser-capture.graph.json", import.meta.url),
    "utf8",
  )));
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
