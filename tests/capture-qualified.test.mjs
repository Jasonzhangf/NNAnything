import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  BROWSER_CAPTURE_REQUEST_EVENT_TYPE,
  BrowserCaptureSession,
  checkCandidates,
  classifyBasicKindBatch,
  compileWorkflow,
  createBrowserCaptureNodeDefinitions,
  createFocusSpec,
  createWorkflowInputEvent,
  DEFAULT_BASIC_KIND_PROFILE,
  observeCandidates,
  parseBrowserWeightAsset,
  runWorkflow,
} from "nnanything/browser-classify";

const viewport = { x: 0, y: 0, width: 800, height: 600 };
const assessedCoverage = {
  geometry: "assessed",
  fragments: "assessed",
  clipping: "assessed",
};

function rect(x = 0, y = 0, width = 100, height = 40) {
  return { x, y, width, height };
}

function properties(tag, overrides = {}) {
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

function fixtureWeight() {
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
  const profileId = "dom-basic-kinds-capture-qualified-fixture-v1";
  profile.id = profileId;
  return parseBrowserWeightAsset({
    targetOperator: "dom.basic_kinds",
    operatorVersion: "0.1.0",
    contractVersion: 1,
    taskId: "dom.basic-kinds.v1",
    profileId,
    baseProfileId: DEFAULT_BASIC_KIND_PROFILE.id,
    calibrated: false,
    compatibility: {
      taskId: "dom.basic-kinds.v1",
      minScore: 0.7,
      minMargin: 0.2,
    },
    profile,
  }, "capture qualified fixture");
}

function makeMixedFrame() {
  const { profile, config } = fixtureWeight();
  const nodes = [
    { ref: "known-button", tag: "button", rect: rect(10, 10, 120, 40) },
    { ref: "unknown-kind", tag: "x-unknown", rect: rect(10, 60, 120, 20) },
    { ref: "conflict-kind", tag: "span", role: "button", rect: rect(10, 90, 120, 20) },
    { ref: "filtered-out", tag: "button", rect: rect(900, 10, 120, 40) },
    { ref: "candidate-unknown", tag: "x-unknown", rect: null },
    { ref: "ignored-parent", tag: "div", rect: rect(10, 130, 120, 40) },
    { ref: "ignored-child", tag: "button", parentRef: "ignored-parent", rect: rect(10, 130, 120, 40) },
  ];
  const propertyMap = new Map(nodes.map(node => [
    node.ref,
    node.ref === "conflict-kind"
      ? properties("span", { role: "button" })
      : node.ref === "ignored-parent"
        ? properties("div", {
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
        })
        : properties(node.tag),
  ]));
  const observation = {
    viewport,
    nodes: nodes.map(node => ({
      nodeRef: node.ref,
      parentRef: node.parentRef ?? null,
      tag: node.tag,
      role: node.role ?? null,
      rect: node.rect,
      fragments: node.rect === null ? null : [node.rect],
      clippedRect: node.rect,
      attributes: {},
    })),
    coverage: assessedCoverage,
  };
  const evidence = new Map(nodes.map(node => [node.ref, {
    nodeRef: node.ref,
    tag: node.tag,
    id: null,
    classList: [],
    textSummary: null,
    linkPathname: null,
    inputValue: null,
    placeholder: null,
    mediaSrc: null,
    mediaType: null,
    accessibleName: null,
    accessibleNameSource: null,
    accessibleNameCoverage: null,
    labelledByRefs: [],
    labelledByUnresolved: false,
    readonlyState: null,
    selectedDeclaration: null,
    rect: node.rect,
    clippedRect: node.rect,
    parentTags: [],
    pageRef: "page-capture-qualified",
    unassessedChildContent: [],
  }]));
  const snapshot = {
    snapshotRef: "snapshot-capture-qualified",
    documentRef: "document-capture-qualified",
    frameRef: "frame-main",
    pageRef: "page-capture-qualified",
    observation,
    itemObservations: nodes.map(node => {
      const value = propertyMap.get(node.ref);
      return {
        nodeRef: node.ref,
        inputType: value.inputType,
        hrefPresent: value.hrefPresent,
        contentEditable: value.contentEditable,
        directTextPresent: value.directTextPresent,
        nonFormatDirectTextPresent: value.nonFormatDirectTextPresent,
        beforeContentPresent: value.beforeContentPresent,
        afterContentPresent: value.afterContentPresent,
        backgroundImagePresent: value.backgroundImagePresent,
        maskImagePresent: value.maskImagePresent,
        childElementCount: value.childElementCount,
        positiveAreaChildCount: value.positiveAreaChildCount,
        repeatedChildGeometry: value.repeatedChildGeometry,
        inVerifiedListParent: value.inVerifiedListParent,
        svgGraphicChildren: value.svgGraphicChildren,
        pointerCursor: value.pointerCursor,
        parentPointerCursor: value.parentPointerCursor,
        tabIndexFocus: value.tabIndexFocus,
        borderPresent: value.borderPresent,
        aspectRatio: value.aspectRatio,
        descendantTextPresent: value.descendantTextPresent,
        directListChildPresent: value.directListChildPresent,
        singleChildTag: value.singleChildTag,
        singleChildSameRect: value.singleChildSameRect,
        withinControlAncestor: value.withinControlAncestor,
        inSvgAncestor: value.inSvgAncestor,
      };
    }),
    properties: propertyMap,
    evidence,
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
  const focusSpec = createFocusSpec();
  const candidateBatch = checkCandidates(observeCandidates({ observation }), focusSpec);
  const basicKindBatch = classifyBasicKindBatch(
    { ...candidateBatch, itemObservations: snapshot.itemObservations },
    config,
    profile,
  );
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
          candidates: basicKindBatch.slots.filter(slot => slot.candidateStatus === "ok").length,
          judged: basicKindBatch.slots.filter(slot => slot.judgmentStatus === "judged").length,
          unknown: basicKindBatch.slots.filter(slot => slot.candidateStatus === "ok" && slot.judgmentStatus === "unknown").length,
          conflict: basicKindBatch.slots.filter(slot => slot.candidateStatus === "ok" && slot.judgmentStatus === "conflict").length,
          ignored: basicKindBatch.slots.filter(slot => slot.judgmentStatus === "judged" && slot.basicKind === "ignore").length,
          unresolved: basicKindBatch.slots.filter(slot => slot.candidateStatus === "ok" && (slot.judgmentStatus === "unknown" || slot.judgmentStatus === "conflict")).length,
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

test("collect_qualified captures every qualified status as unreviewed and exports the same rows", async () => {
  const graph = JSON.parse(readFileSync(
    new URL("../workflows/browser-capture.graph.json", import.meta.url),
    "utf8",
  ));
  const frame = makeMixedFrame();
  const qualified = frame.basicKindBatch.slots
    .filter(slot => slot.candidateStatus === "ok")
    .map(slot => slot.nodeRef)
    .sort();
  assert.deepEqual(qualified, ["conflict-kind", "ignored-child", "ignored-parent", "known-button", "unknown-kind"]);
  assert.equal(frame.basicKindBatch.slots.find(slot => slot.nodeRef === "ignored-parent")?.basicKind, "ignore");
  assert.equal(frame.basicKindBatch.slots.find(slot => slot.nodeRef === "filtered-out")?.candidateStatus, "filtered_out");
  assert.equal(frame.basicKindBatch.slots.find(slot => slot.nodeRef === "candidate-unknown")?.candidateStatus, "unknown");

  const session = new BrowserCaptureSession({
    sessionId: "capture-qualified-session",
    createdAt: "2026-10-18T12:00:00.000Z",
  });
  let downloaded;
  const compiled = compileWorkflow({ graph, bindings: {} }, {
    nodeDefinitions: createBrowserCaptureNodeDefinitions({
      session,
      download: bundle => {
        downloaded = bundle;
        return { receiptId: "capture-qualified-download" };
      },
    }),
    grantedEffects: ["browser.capture.download"],
  });
  const execute = action => runWorkflow(compiled, createWorkflowInputEvent({
    runId: `capture-qualified-${action}`,
    eventId: `capture-qualified-${action}:input`,
    port: "capture_request",
    type: BROWSER_CAPTURE_REQUEST_EVENT_TYPE,
    correlation: {},
    payload: { action, frame },
  }));

  const collected = await execute("collect_qualified");
  assert.equal(collected.status, "completed");
  assert.equal(collected.outputEvent.payload.action, "collect_qualified");
  assert.equal(collected.outputEvent.payload.receipt.eligible, 5);
  assert.equal(collected.outputEvent.payload.receipt.collected, 5);

  const bundle = session.toBundle();
  assert.deepEqual(bundle.trainingRequest.rows.map(row => row.inputRef.nodeRef).sort(), qualified);
  assert.ok(bundle.trainingRequest.rows.every(row => row.review.status === "unreviewed"));
  assert.ok(bundle.trainingRequest.rows.every(row => row.review.expectedLabel === null));
  assert.deepEqual(
    Object.fromEntries(bundle.trainingRequest.rows.map(row => [row.inputRef.nodeRef, row.proposal.status])),
    {
      "conflict-kind": "conflict",
      "ignored-child": "matched",
      "ignored-parent": "matched",
      "known-button": "matched",
      "unknown-kind": "unknown",
    },
  );

  const exported = await execute("export");
  assert.equal(exported.status, "completed");
  assert.equal(exported.outputEvent.payload.receipt.rowCount, 5);
  assert.equal(downloaded.trainingRequest.rows.length, 5);
  assert.equal(exported.outputEvent.payload.receipt.downloadReceipt.receiptId, "capture-qualified-download");
});

test("classification capture never carries a form value into the exported bundle", async () => {
  const graph = JSON.parse(readFileSync(
    new URL("../workflows/browser-capture.graph.json", import.meta.url),
    "utf8",
  ));
  const frame = makeMixedFrame();
  // Simulate a host node whose observation carried an explicit content read.
  // The bundle must still drop it, so a password field can never be exported.
  const secret = "classification-must-not-export-this";
  const hostEvidence = frame.snapshot.evidence.get("known-button");
  assert.ok(hostEvidence, "fixture must expose evidence for the collected node");
  frame.snapshot.evidence.set("known-button", { ...hostEvidence, inputValue: secret });

  const session = new BrowserCaptureSession({
    sessionId: "capture-sensitive-session",
    createdAt: "2026-10-18T12:00:00.000Z",
  });
  const compiled = compileWorkflow({ graph, bindings: {} }, {
    nodeDefinitions: createBrowserCaptureNodeDefinitions({
      session,
      download: () => ({ receiptId: "capture-sensitive-download" }),
    }),
    grantedEffects: ["browser.capture.download"],
  });
  const execute = action => runWorkflow(compiled, createWorkflowInputEvent({
    runId: `capture-sensitive-${action}`,
    eventId: `capture-sensitive-${action}:input`,
    port: "capture_request",
    type: BROWSER_CAPTURE_REQUEST_EVENT_TYPE,
    correlation: {},
    payload: { action, frame },
  }));

  assert.equal((await execute("collect_qualified")).status, "completed");
  const bundle = session.toBundle();
  const sidecar = Object.values(bundle.evidenceSidecar);
  assert.equal(sidecar.length > 0, true);
  // No sidecar entry owns the field at all, and the value never appears anywhere.
  assert.equal(sidecar.every(entry => !Object.hasOwn(entry, "inputValue")), true);
  assert.equal(JSON.stringify(bundle).includes(secret), false);
});
