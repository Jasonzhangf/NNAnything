import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  compileWorkflow,
  createWorkflowInputEvent,
  loadWorkflow,
  runWorkflow,
} from "../dist/index.js";
import {
  DOM_CANDIDATE_REQUEST_EVENT_TYPE,
  createFocusSpec,
  domNodeDefinitions,
} from "../dist/browser.js";
import { checkCandidates, loadSavedObservation, observeCandidates, splitCandidates } from "../dist/browser.js";

const graphPath = fileURLToPath(
  new URL("../workflows/dom-candidates.graph.json", import.meta.url),
);
const observationPath = fileURLToPath(
  new URL("../playground/browser/observation.fixture.json", import.meta.url),
);
const configPath = fileURLToPath(
  new URL("../workflows/dom-candidates.workflow.json", import.meta.url),
);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const graph = JSON.parse(readFileSync(graphPath, "utf8"));
const observation = JSON.parse(readFileSync(observationPath, "utf8"));

function makeDefinition(focusSpec) {
  return {
    graph,
    bindings: {
      "筛选视口内候选": { config: focusSpec },
      "限制当前关注范围": { config: focusSpec },
      "应用黑名单": { config: focusSpec },
      "应用白名单": { config: focusSpec },
      "检查展开项的候选规则": { config: focusSpec },
    },
  };
}

async function runCandidates({
  focusSpec = createFocusSpec(),
  nodeRefs,
  observationValue = observation,
  runId = "browser-test",
} = {}) {
  const compiled = compileWorkflow(makeDefinition(focusSpec), {
    nodeDefinitions: domNodeDefinitions,
  });
  const input = createWorkflowInputEvent({
    runId,
    eventId: `${runId}:input`,
    port: "request",
    type: DOM_CANDIDATE_REQUEST_EVENT_TYPE,
    correlation: {},
    payload: {
      observation: observationValue,
      ...(nodeRefs === undefined ? {} : { nodeRefs }),
    },
  });
  return runWorkflow(compiled, input);
}

function byRef(batch) {
  return new Map(batch.slots.map((slot) => [slot.nodeRef, slot]));
}

function foregroundObservation(changes = {}) {
  return {
    viewport: { x: 0, y: 0, width: 100, height: 100 },
    nodes: [{
      nodeRef: "n", parentRef: null, tag: "button", role: null,
      rect: { x: 0, y: 0, width: 100, height: 10 },
      fragments: [{ x: 0, y: 0, width: 100, height: 10 }],
      clippedRect: { x: 0, y: 0, width: 100, height: 10 },
      ...changes,
    }],
  };
}

function checkForeground(observation, focus = {}) {
  return checkCandidates(splitCandidates(observeCandidates({ observation: loadSavedObservation(observation) })), createFocusSpec(focus));
}

test("partial visibility is retained and edge contact has zero area", async () => {
  const result = await runCandidates({
    nodeRefs: ["partial", "edge"],
  });

  assert.equal(result.status, "completed");
  assert.equal(result.outputEvent.status, "ok");
  const batch = result.outputEvent.payload;
  assert.deepEqual(batch.candidateRefs, ["partial"]);
  assert.equal(batch.slots[0].status, "ok");
  assert.equal(batch.slots[0].evidence.boundingBoxIntersection, "positive");
  assert.equal(batch.slots[0].evidence.fragments, "assessed");
  assert.equal(batch.slots[0].evidence.clipping, "assessed");
  assert.equal(batch.slots[1].status, "filtered_out");
  assert.deepEqual(batch.slots[1].reasons, ["outside_viewport"]);
});

test("skipping an offscreen or zero-geometry parent does not prune visible descendants", async () => {
  const result = await runCandidates();

  assert.equal(result.status, "completed");
  const slots = byRef(result.outputEvent.payload);
  assert.equal(slots.get("offscreen-parent").status, "filtered_out");
  assert.equal(slots.get("visible-child").status, "ok");
  assert.equal(slots.get("zero-parent").status, "skipped");
  assert.deepEqual(slots.get("zero-parent").reasons, ["zero_geometry"]);
  assert.equal(slots.get("zero-child").status, "ok");
});

test("deny wins over allow and explicit empty allow rejects every remaining slot", async () => {
  const denied = await runCandidates({
    nodeRefs: ["denied-button"],
    focusSpec: createFocusSpec({
      deny: [{ tag: "button" }],
      allow: [{ tag: "button" }],
    }),
  });
  assert.equal(denied.outputEvent.payload.slots[0].status, "filtered_out");
  assert.deepEqual(denied.outputEvent.payload.slots[0].reasons, ["deny_match"]);
  assert.deepEqual(denied.outputEvent.payload.candidateRefs, []);

  const emptyAllow = await runCandidates({
    nodeRefs: ["partial", "allowed-span"],
    focusSpec: createFocusSpec({ allow: [] }),
  });
  assert.deepEqual(emptyAllow.outputEvent.payload.candidateRefs, []);
  assert.deepEqual(
    emptyAllow.outputEvent.payload.slots.map((slot) => slot.status),
    ["filtered_out", "filtered_out"],
  );
  assert.deepEqual(
    emptyAllow.outputEvent.payload.slots.map((slot) => slot.reasons),
    [["allow_miss"], ["allow_miss"]],
  );
});

test("explicit nodeRefs preserve length, order, duplicates, missing refs, and do not expand", async () => {
  const result = await runCandidates({
    nodeRefs: ["allowed-span", "partial", "allowed-span", "missing-ref"],
  });

  assert.equal(result.status, "completed");
  const batch = result.outputEvent.payload;
  assert.deepEqual(
    batch.slots.map((slot) => slot.index),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    batch.slots.map((slot) => slot.nodeRef),
    ["allowed-span", "partial", "allowed-span", "missing-ref"],
  );
  assert.deepEqual(
    batch.slots.map((slot) => slot.status),
    ["ok", "ok", "ok", "unknown"],
  );
  assert.deepEqual(batch.candidateRefs, [
    "allowed-span",
    "partial",
    "allowed-span",
  ]);
  assert.deepEqual(batch.slots[3].reasons, ["missing_node_ref"]);

  const noExpansion = await runCandidates({ nodeRefs: ["visible-child"] });
  assert.deepEqual(
    noExpansion.outputEvent.payload.slots.map((slot) => slot.nodeRef),
    ["visible-child"],
  );
});

test("explicit subtree exclusion prunes descendants while self filters do not", async () => {
  const result = await runCandidates({
    focusSpec: createFocusSpec({
      excludeSubtrees: [{ tag: "section" }],
    }),
  });

  const slots = byRef(result.outputEvent.payload);
  assert.equal(slots.get("excluded-section").status, "filtered_out");
  assert.deepEqual(slots.get("excluded-section").reasons, ["subtree_excluded"]);
  assert.equal(slots.get("excluded-child").status, "filtered_out");
  assert.deepEqual(slots.get("excluded-child").reasons, ["subtree_excluded"]);
  assert.equal(slots.get("zero-child").status, "ok");
});

test("stale within and owned scope without ownership evidence are explicit unknown results", async () => {
  const stale = await runCandidates({
    focusSpec: createFocusSpec({ within: "does-not-exist" }),
  });
  assert.equal(stale.status, "completed");
  assert.equal(stale.outputEvent.status, "unknown");
  assert.equal(stale.outputEvent.payload.reason, "stale_scope");

  const owned = await runCandidates({
    focusSpec: createFocusSpec({ scopeMode: "owned" }),
  });
  assert.equal(owned.status, "completed");
  assert.equal(owned.outputEvent.status, "unknown");
  assert.equal(owned.outputEvent.payload.reason, "unsupported_scope");
});

test("missing geometry or clipping evidence remains unknown and is not a candidate", async () => {
  const result = await runCandidates({
    nodeRefs: ["unknown-clipping", "missing-geometry", "partial"],
  });

  const batch = result.outputEvent.payload;
  const slots = byRef(batch);
  assert.equal(slots.get("unknown-clipping").status, "unknown");
  assert.deepEqual(slots.get("unknown-clipping").reasons, [
    "insufficient_observation",
  ]);
  assert.equal(slots.get("unknown-clipping").evidence.clipping, "unassessed");
  assert.equal(slots.get("missing-geometry").status, "unknown");
  assert.deepEqual(slots.get("missing-geometry").reasons, [
    "insufficient_geometry",
  ]);
  assert.equal(slots.get("partial").status, "ok");
  assert.deepEqual(batch.candidateRefs, ["partial"]);
});

test("the final candidate check does not revive denied or unknown expanded slots", async () => {
  const result = await runCandidates({
    focusSpec: createFocusSpec({
      deny: [{ tag: "span" }],
      allow: [{ tag: "span" }],
    }),
  });

  const batch = result.outputEvent.payload;
  const slots = byRef(batch);
  assert.equal(slots.get("allowed-span").status, "filtered_out");
  assert.deepEqual(slots.get("allowed-span").reasons, ["deny_match"]);
  assert.equal(slots.get("unknown-clipping").status, "unknown");
  assert.equal(batch.candidateRefs.includes("allowed-span"), false);
  assert.equal(batch.candidateRefs.includes("unknown-clipping"), false);
  assert.equal("label" in batch.slots[0], false);
  assert.equal("confidence" in batch.slots[0], false);
  assert.equal("isTarget" in batch.slots[0], false);
});

test("the real workflow config loads the project graph and schedules all seven nodes", async () => {
  const definition = await loadWorkflow({
    configPath,
    allowedRoot: projectRoot,
  });
  const compiled = compileWorkflow(definition, {
    nodeDefinitions: domNodeDefinitions,
  });
  const input = createWorkflowInputEvent({
    runId: "browser-config-test",
    eventId: "browser-config-test:input",
    port: "request",
    type: DOM_CANDIDATE_REQUEST_EVENT_TYPE,
    correlation: {},
    payload: { observation },
  });
  const result = await runWorkflow(compiled, input);

  assert.equal(result.status, "completed");
  assert.equal(result.outputEvent.status, "ok");
  const executed = new Set(result.events.map((event) => event.producer.nodeId));
  for (const node of graph.nodes) {
    assert.equal(executed.has(node.id), true, `missing event from ${node.id}`);
  }
  const slots = byRef(result.outputEvent.payload);
  assert.equal(slots.get("partial").status, "ok");
  assert.equal(slots.get("denied-button").status, "filtered_out");
  assert.equal(slots.get("excluded-child").status, "filtered_out");
  assert.equal(slots.get("unknown-clipping").status, "unknown");
});

test("FocusSpec validation rejects fixed-rule violations and arbitrary rule expressions", () => {
  assert.throws(() => createFocusSpec({ viewportOnly: false }), /viewportOnly/);
  assert.throws(
    () => createFocusSpec({ deny: [{ class: "site-card" }] }),
    /unsupported condition field/,
  );
  assert.throws(() => createFocusSpec({ deny: [{}] }), /empty condition/);
  assert.throws(
    () => createFocusSpec({ allow: [{ attributes: { onclick: "run()" } }] }),
    /unsafe attribute/,
  );
});

test("foreground eligibility filters proven occlusion and preserves legacy saved observations", () => {
  const occluded = checkForeground(foregroundObservation({ foreground: "occluded", exposedRects: [] }));
  assert.deepEqual(occluded.slots[0].reasons, ["occluded"]);
  assert.equal(occluded.slots[0].evidence.foreground, "occluded");
  assert.deepEqual(occluded.candidateRefs, []);

  const unassessed = checkForeground(foregroundObservation({ foreground: "unassessed", exposedRects: null }));
  assert.equal(unassessed.slots[0].status, "unknown");
  assert.deepEqual(unassessed.slots[0].reasons, ["insufficient_observation"]);

  const legacy = checkForeground(foregroundObservation());
  assert.deepEqual(legacy.candidateRefs, ["n"]);
  assert.equal("foreground" in legacy.slots[0].evidence, false);
});

test("exposed rectangles select only proven visible fragments inside Focus", () => {
  const split = foregroundObservation({
    fragments: [{ x: 0, y: 0, width: 100, height: 10 }],
    exposedRects: [{ x: 0, y: 0, width: 10, height: 10 }, { x: 90, y: 0, width: 10, height: 10 }],
  });
  assert.deepEqual(checkForeground(split).candidateRefs, ["n"]);
  const hiddenFocus = checkForeground(split, { region: { x: 40, y: 0, width: 10, height: 10 } });
  assert.deepEqual(hiddenFocus.candidateRefs, []);
  assert.deepEqual(hiddenFocus.slots[0].reasons, ["outside_focus"]);
  assert.deepEqual(checkForeground(split, { region: { x: 0, y: 0, width: 10, height: 10 } }).candidateRefs, ["n"]);
});

test("saved currentView facts exclude only qualified neutral surfaces through the public candidate workflow", async () => {
  const currentView = {
    zeroOpacityInCurrentPaintPath: true,
    pointerEventsNone: true,
    activeElementFocus: false,
    focusWithin: false,
    nativeTabIndex: -1,
    contentEditable: false,
    directTextPresent: false,
    ownLabelPresent: false,
    topLayer: false,
  };
  const box = { x: 10, y: 10, width: 100, height: 40 };
  const observationValue = {
    viewport: { x: 0, y: 0, width: 320, height: 200 },
    nodes: [
      {
        nodeRef: "root",
        parentRef: null,
        tag: "div",
        role: "main",
        rect: { x: 0, y: 0, width: 320, height: 200 },
        fragments: [{ x: 0, y: 0, width: 320, height: 200 }],
        clippedRect: { x: 0, y: 0, width: 320, height: 200 },
      },
      {
        nodeRef: "transparent-div",
        parentRef: "root",
        tag: "div",
        role: null,
        rect: box,
        fragments: [box],
        clippedRect: box,
        currentView,
      },
      {
        nodeRef: "transparent-object",
        parentRef: "transparent-div",
        tag: "object",
        role: null,
        rect: box,
        fragments: [box],
        clippedRect: box,
        currentView,
      },
      {
        nodeRef: "focused-descendant",
        parentRef: "transparent-div",
        tag: "input",
        role: null,
        rect: { x: 20, y: 20, width: 40, height: 20 },
        fragments: [{ x: 20, y: 20, width: 40, height: 20 }],
        clippedRect: { x: 20, y: 20, width: 40, height: 20 },
      },
      {
        nodeRef: "legacy-node",
        parentRef: "root",
        tag: "div",
        role: null,
        rect: { x: 150, y: 10, width: 60, height: 40 },
        fragments: [{ x: 150, y: 10, width: 60, height: 40 }],
        clippedRect: { x: 150, y: 10, width: 60, height: 40 },
      },
    ],
  };

  const result = await runCandidates({ observationValue });
  assert.equal(result.status, "completed");
  const slots = byRef(result.outputEvent.payload);
  for (const ref of ["transparent-div", "transparent-object"]) {
    assert.equal(slots.get(ref).status, "filtered_out", ref);
    assert.deepEqual(slots.get(ref).reasons, ["current_view_nonrendered"], ref);
  }
  assert.equal(slots.get("focused-descendant").status, "ok");
  assert.equal(slots.get("legacy-node").status, "ok");

  const loaded = loadSavedObservation(observationValue);
  assert.deepEqual(loaded.nodes.find(node => node.nodeRef === "transparent-div").currentView, currentView);
});

function currentViewObservation(overrides = {}, omitCurrentView = false) {
  const currentView = {
    zeroOpacityInCurrentPaintPath: true,
    pointerEventsNone: true,
    activeElementFocus: false,
    focusWithin: false,
    nativeTabIndex: -1,
    contentEditable: false,
    directTextPresent: false,
    ownLabelPresent: false,
    topLayer: false,
    ...overrides.currentView,
  };
  const observation = foregroundObservation({
    tag: "div",
    role: null,
    ...overrides,
    ...(omitCurrentView ? {} : { currentView }),
  });
  if (omitCurrentView) delete observation.nodes[0].currentView;
  return observation;
}

test("current-view qualification preserves every required human interaction and unknown case", () => {
  const cases = [
    ["actual focus", { currentView: { activeElementFocus: true } }],
    ["focus-within", { currentView: { focusWithin: true } }],
    ["native keyboard focus", { currentView: { nativeTabIndex: 0 } }],
    ["editable", { currentView: { contentEditable: true } }],
    ["known role", { role: "status" }],
    ["own label", { currentView: { ownLabelPresent: true } }],
    ["direct text", { currentView: { directTextPresent: true } }],
    ["positive opacity", { currentView: { zeroOpacityInCurrentPaintPath: false } }],
    ["pointer-events none alone", { currentView: { zeroOpacityInCurrentPaintPath: false, pointerEventsNone: true } }],
    ["native input", { tag: "input" }],
    ["unknown facts", { currentView: {
      zeroOpacityInCurrentPaintPath: null,
      pointerEventsNone: null,
      activeElementFocus: null,
      focusWithin: null,
      nativeTabIndex: null,
      contentEditable: null,
      directTextPresent: null,
      ownLabelPresent: null,
      topLayer: null,
    } }],
    ["missing record", {}],
  ];

  for (const [label, overrides] of cases) {
    const batch = checkForeground(currentViewObservation(overrides, label === "missing record"));
    assert.deepEqual(batch.candidateRefs, ["n"], label);
    assert.equal(
      batch.slots[0].reasons.includes("current_view_nonrendered"),
      false,
      label,
    );
  }
});

test("partial current-view records preserve missing facts without filtering or rejecting the snapshot", () => {
  const complete = currentViewObservation();
  for (const field of Object.keys(complete.nodes[0].currentView)) {
    const partial = currentViewObservation();
    delete partial.nodes[0].currentView[field];
    const loaded = loadSavedObservation(partial);
    assert.equal(Object.hasOwn(loaded.nodes[0].currentView, field), false, field);
    if (field !== "topLayer") assert.deepEqual(checkForeground(partial).candidateRefs, ["n"], field);
  }
});
