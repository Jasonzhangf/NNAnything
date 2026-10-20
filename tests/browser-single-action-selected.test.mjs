import assert from "node:assert/strict";
import { test } from "node:test";

const apiModuleUrl = process.env.NNANYTHING_BROWSER_SINGLE_ACTION_URL
  ?? new URL("../dist/browser-single-action.js", import.meta.url).href;
const api = () => import(apiModuleUrl);

function observed(value, evidenceRef = "fixture-evidence") {
  return { status: "observed", value, evidenceRefs: [evidenceRef] };
}

function unknown(reason) {
  return { status: "unknown", reason };
}

function element(ref, {
  parentRef = "scope",
  tag = "div",
  role = null,
  controls = [],
  enabled = unknown("enabled_not_applicable"),
  hit = unknown("hit_not_required"),
  point = unknown("no_hit_point"),
  buttonSemantics = observed(false),
} = {}) {
  return {
    ref,
    parentRef,
    tag,
    role,
    basicKind: null,
    judgmentStatus: "judged",
    candidateStatus: "ok",
    controls: observed(controls),
    enabled,
    hit,
    buttonSemantics,
    point,
    evidenceRefs: ["fixture-evidence"],
  };
}

function control(ref, regionRef, extra = {}) {
  return element(ref, {
    tag: extra.tag ?? "button",
    role: extra.role ?? null,
    controls: [regionRef],
    enabled: observed(extra.enabled ?? true),
    hit: observed(extra.hit ?? true),
    point: observed({ x: extra.x ?? 20, y: 20 }),
    buttonSemantics: observed(true),
  });
}

function snapshot({
  observationId = "observation-pre",
  revision = 1,
  targetEnabled = true,
  targetHit = true,
} = {}) {
  const evidenceRef = `${observationId}:evidence`;
  const decorate = value => {
    if (value.status !== "observed") return value;
    return { ...value, evidenceRefs: [evidenceRef] };
  };
  const elements = [
    element("scope", {
      parentRef: null,
      tag: "main",
      controls: [],
      buttonSemantics: observed(false),
    }),
    element("region-a", { tag: "section", role: "region" }),
    element("region-b", { tag: "section", role: "region" }),
    control("control-native", "region-a", { enabled: targetEnabled, hit: targetHit, x: 20 }),
    control("control-role", "region-a", { tag: "div", role: "button", x: 140 }),
    control("control-other", "region-b", { x: 260 }),
  ].map(item => ({
    ...item,
    controls: decorate(item.controls),
    enabled: decorate(item.enabled),
    hit: decorate(item.hit),
    buttonSemantics: decorate(item.buttonSemantics),
    point: decorate(item.point),
    evidenceRefs: [evidenceRef],
  }));
  return {
    documentRef: "document-fixture",
    observationId,
    revision,
    scopeRef: "scope",
    regions: ["region-a", "region-b"].map(ref => ({
      ref,
      expanded: observed(false, evidenceRef),
      rendered: observed(false, evidenceRef),
    })),
    elements,
    evidence: [{
      id: evidenceRef,
      observationId,
      source: "synthetic_projection",
      fact: "complete fixture observation",
    }],
  };
}

function request(state = snapshot()) {
  return {
    goal: { kind: "SetExpanded", regionRef: "region-a", desired: true },
    satisfactionThreshold: 100,
    state,
  };
}

function registry() {
  return [
    {
      strategyRef: "strategy-native",
      skillId: "browser.expand.native",
      targetRef: "control-native",
      goalRegionRef: "region-a",
      equivalenceSetRef: "equivalence-region-a",
      documentRef: "document-fixture",
      scopeRef: "scope",
      operation: "CLICK",
      evidenceRefs: ["proof:equivalence:region-a:native"],
    },
    {
      strategyRef: "strategy-role",
      skillId: "browser.expand.role",
      targetRef: "control-role",
      goalRegionRef: "region-a",
      equivalenceSetRef: "equivalence-region-a",
      documentRef: "document-fixture",
      scopeRef: "scope",
      operation: "CLICK",
      evidenceRefs: ["proof:equivalence:region-a:role"],
    },
  ];
}

function selectedRequest({
  state = snapshot(),
  selectedStrategy = {
    strategyRef: "strategy-native",
    skillId: "browser.expand.native",
    targetRef: "control-native",
    goalRegionRef: "region-a",
    equivalenceSetRef: "equivalence-region-a",
    evidenceRefs: ["proof:equivalence:region-a:native"],
  },
} = {}) {
  return {
    ...request(state),
    contract: "browser.single-action.selected.v1",
    selectedStrategy,
  };
}

function cloneObservation(state, observationId, revision) {
  const result = structuredClone(state);
  result.observationId = observationId;
  result.revision = revision;
  const evidenceRef = `${observationId}:evidence`;
  result.evidence = [{
    id: evidenceRef,
    observationId,
    source: "synthetic_projection",
    fact: "fresh fixture observation",
  }];
  for (const item of result.elements) {
    item.evidenceRefs = [evidenceRef];
    for (const key of ["controls", "enabled", "hit", "buttonSemantics", "point"]) {
      if (item[key].status === "observed") item[key].evidenceRefs = [evidenceRef];
    }
  }
  for (const region of result.regions) {
    for (const key of ["expanded", "rendered"]) {
      if (region[key].status === "observed") region[key].evidenceRefs = [evidenceRef];
    }
  }
  return result;
}

function postObservation(pre) {
  const result = cloneObservation(pre, "observation-post", pre.revision + 1);
  for (const region of result.regions) {
    region.expanded = observed(region.ref === "region-a", `${result.observationId}:evidence`);
    region.rendered = observed(region.ref === "region-a", `${result.observationId}:evidence`);
  }
  return result;
}

function profileForDualProvider(library) {
  const relation = values => library.SINGLE_ACTION_RELATION_WIRES.map(wire => values[wire] ?? 0);
  const capability = values => library.SINGLE_ACTION_CAPABILITY_WIRES.map(wire => values[wire] ?? 0);
  return library.validateBrowserSingleActionProfile({
    contract: "browser.single-action-policy.v1",
    relationHeads: [...library.SINGLE_ACTION_RELATION_HEADS],
    relationWires: [...library.SINGLE_ACTION_RELATION_WIRES],
    capabilityHeads: [...library.SINGLE_ACTION_CAPABILITY_HEADS],
    capabilityWires: [...library.SINGLE_ACTION_CAPABILITY_WIRES],
    relationWeights: [
      relation({
        bias: -2,
        "controls.target*enabled.value*hit.value": 4,
      }),
      relation({}),
    ],
    capabilityWeights: [
      capability({
        bias: -1,
        "providers.one": 10,
        "regionExpanded.value": -10,
      }),
      capability({ "regionExpanded.value": 10 }),
      capability({
        "providers.zero": 5,
        "providers.many": 10,
      }),
    ],
    calibration: "uncalibrated",
    adoption: "not_applied",
  });
}

function resources(library, pre, post, {
  strategyRegistry = registry(),
  profile = profileForDualProvider(library),
  overrides = {},
} = {}) {
  const observations = [pre, post];
  const clicks = [];
  const collected = [];
  let current = {
    documentRef: pre.documentRef,
    observationId: pre.observationId,
    revision: pre.revision,
  };
  return {
    profile,
    strategyRegistry,
    grantedEffects: new Set(["browser.nativeClick", "filesystem.write"]),
    observe: async () => {
      const next = observations.shift();
      if (next === undefined) throw new Error("unexpected extra observation");
      current = {
        documentRef: next.documentRef,
        observationId: next.observationId,
        revision: next.revision,
      };
      return next;
    },
    currentControl: () => current,
    nativeClick: async invocation => {
      clicks.push(invocation);
      return {
        dispatched: true,
        ok: true,
        effectKnowledge: "known",
        source: "selected-fixture-native",
        error: null,
      };
    },
    collect: async result => { collected.push(result); },
    clicks,
    collected,
    ...overrides,
  };
}

test("selected request requires an explicit registered equivalence proof and binding", async () => {
  const library = await api();
  assert.equal(typeof library.readSelectedSingleActionRequest, "function");

  const read = value => library.readSelectedSingleActionRequest(value, registry());
  assert.equal(read(selectedRequest()).selectedStrategy.targetRef, "control-native");
  assert.throws(
    () => library.predictBrowserSingleAction(
      selectedRequest(),
      profileForDualProvider(library),
    ),
    /standalone.*selected/i,
  );
  const pre = snapshot();
  await assert.rejects(
    library.runBrowserSingleActionEpisode(
      selectedRequest({ state: pre }),
      resources(library, pre, postObservation(pre)),
    ),
    /unsupported field contract/,
  );

  const unknownStrategy = selectedRequest();
  unknownStrategy.selectedStrategy.strategyRef = "missing-strategy";
  assert.throws(() => read(unknownStrategy), /strategyRef|registry|registered/i);

  const wrongProof = selectedRequest();
  wrongProof.selectedStrategy.evidenceRefs = ["proof:not-registered"];
  assert.throws(() => read(wrongProof), /evidence|registry|registered/i);

  const noProofRegistry = registry();
  noProofRegistry[0].evidenceRefs = [];
  assert.throws(
    () => library.readSelectedSingleActionRequest(selectedRequest(), noProofRegistry),
    /evidence|proof/i,
  );

  const wrongDocumentRegistry = registry();
  wrongDocumentRegistry[0].documentRef = "other-document";
  assert.throws(
    () => library.readSelectedSingleActionRequest(selectedRequest(), wrongDocumentRegistry),
    /document|registry/i,
  );
});

test("the same complete dual-provider snapshot stays standalone DEFER and selected CLICK once", async () => {
  const library = await api();
  const pre = snapshot();
  const baseRequest = request(pre);
  const standaloneResources = resources(library, pre, postObservation(pre));
  const standalone = await library.runBrowserSingleActionEpisode(baseRequest, standaloneResources);
  assert.equal(standalone.prediction.capability, "DEFER");
  assert.equal(standalone.invocation, null);
  assert.equal(standaloneResources.clicks.length, 0);
  assert.equal(
    standalone.prediction.relations.filter(item => item.judgment === "actionable_provider").length,
    2,
  );

  const selectedResources = resources(library, pre, postObservation(pre));
  const selected = await library.runSelectedBrowserSingleActionEpisode(
    selectedRequest({ state: pre }),
    selectedResources,
  );
  assert.equal(selected.prediction.capability, "CLICK");
  assert.equal(selected.prediction.proposedTargetRef, "control-native");
  assert.equal(selected.invocation.targetRef, "control-native");
  assert.equal(selectedResources.clicks.length, 1);
  assert.equal(selectedResources.clicks[0].targetRef, "control-native");
  assert.equal(selected.achieved, true);
  assert.equal(selected.satisfaction, 100);
  assert.equal(selectedResources.collected.length, 1);
  assert.equal(
    selected.prediction.relations.filter(item => item.judgment === "actionable_provider").length,
    2,
  );
  assert.deepEqual(
    selected.prediction.relations.map(item => item.ref),
    pre.elements.map(item => item.ref),
  );
});

test("the targeted pure projection uses all relations but scopes providers and proposal", async () => {
  const library = await api();
  const pre = snapshot();
  const baseRequest = request(pre);
  const standalone = library.predictBrowserSingleAction(
    baseRequest,
    profileForDualProvider(library),
  );
  const selected = library.predictBrowserSingleActionForTarget(
    baseRequest,
    profileForDualProvider(library),
    { targetRef: "control-native", goalRegionRef: "region-a" },
  );

  assert.equal(standalone.capability, "DEFER");
  assert.equal(standalone.proposedTargetRef, null);
  assert.equal(selected.capability, "CLICK");
  assert.equal(selected.proposedTargetRef, "control-native");
  assert.deepEqual(
    selected.relations.map(item => item.ref),
    baseRequest.state.elements.map(item => item.ref),
  );
  assert.equal(
    selected.relations.filter(item => item.judgment === "actionable_provider").length,
    2,
  );
  assert.equal(
    selected.capabilityFeatures[
      library.SINGLE_ACTION_CAPABILITY_WIRES.indexOf("providers.one")
    ],
    1,
  );
  assert.equal(
    selected.capabilityFeatures[
      library.SINGLE_ACTION_CAPABILITY_WIRES.indexOf("providers.many")
    ],
    0,
  );
  const targetedFeatures = library.singleActionCapabilityFeaturesForTarget(
    baseRequest,
    selected.relations,
    { targetRef: "control-native", goalRegionRef: "region-a" },
  );
  assert.deepEqual(targetedFeatures, selected.capabilityFeatures);
});

test("registry proof ids are historical resources and do not freeze fresh DOM evidence", async () => {
  const library = await api();
  const initial = snapshot();
  const fresh = cloneObservation(initial, "observation-fresh", 7);
  const selectedResources = resources(library, fresh, postObservation(fresh));
  const selected = await library.runSelectedBrowserSingleActionEpisode(
    selectedRequest({ state: initial }),
    selectedResources,
  );

  assert.equal(selected.error, null);
  assert.equal(selected.prediction.proposedTargetRef, "control-native");
  assert.equal(selectedResources.clicks.length, 1);
  assert.equal(selectedResources.clicks[0].observationId, "observation-fresh");
});

test("fresh disabled, stale control, and stale posterior facts remain zero-compensation", async () => {
  const library = await api();
  const initial = snapshot();
  const disabled = cloneObservation(initial, "observation-disabled", 2);
  const disabledTarget = disabled.elements.find(item => item.ref === "control-native");
  disabledTarget.enabled = observed(false, "observation-disabled:evidence");
  const disabledResources = resources(library, disabled, postObservation(disabled));
  const disabledResult = await library.runSelectedBrowserSingleActionEpisode(
    selectedRequest({ state: initial }),
    disabledResources,
  );
  assert.equal(disabledResult.error?.code, "precondition_unsatisfied");
  assert.equal(disabledResult.invocation, null);
  assert.equal(disabledResources.clicks.length, 0);

  const stalePre = cloneObservation(initial, "observation-stale", 3);
  const staleResources = resources(library, stalePre, postObservation(stalePre), {
    overrides: {
      currentControl: () => ({
        documentRef: stalePre.documentRef,
        observationId: stalePre.observationId,
        revision: stalePre.revision + 1,
      }),
    },
  });
  const staleResult = await library.runSelectedBrowserSingleActionEpisode(
    selectedRequest({ state: initial }),
    staleResources,
  );
  assert.equal(staleResult.error?.code, "stale_reference");
  assert.equal(staleResources.clicks.length, 0);

  const post = cloneObservation(stalePre, initial.observationId, initial.revision);
  post.documentRef = initial.documentRef;
  const stalePostResources = resources(library, stalePre, post);
  const stalePostResult = await library.runSelectedBrowserSingleActionEpisode(
    selectedRequest({ state: initial }),
    stalePostResources,
  );
  assert.equal(stalePostResources.clicks.length, 1);
  assert.equal(stalePostResult.error?.code, "stale_reference");
  assert.equal(stalePostResult.satisfaction, null);
  assert.equal(stalePostResources.collected.length, 1);
});

test("a non-selected provider is not substituted when the selected target lacks actionability", async () => {
  const library = await api();
  const pre = snapshot({ targetEnabled: false });
  const profile = structuredClone(profileForDualProvider(library));
  profile.capabilityWeights[0] = library.SINGLE_ACTION_CAPABILITY_WIRES.map(wire => ({
    "providers.zero": 10,
  }[wire] ?? 0));
  profile.capabilityWeights[1] = library.SINGLE_ACTION_CAPABILITY_WIRES.map(() => 0);
  profile.capabilityWeights[2] = library.SINGLE_ACTION_CAPABILITY_WIRES.map(() => 0);
  const selectedResources = resources(library, pre, postObservation(pre), {
    profile: library.validateBrowserSingleActionProfile(profile),
  });
  const selected = await library.runSelectedBrowserSingleActionEpisode(
    selectedRequest({ state: pre }),
    selectedResources,
  );

  assert.equal(selected.prediction.capability, "CLICK");
  assert.equal(selected.prediction.proposedTargetRef, null);
  assert.equal(selected.invocation, null);
  assert.equal(selected.error?.code, "missing_click_target");
  assert.equal(selectedResources.clicks.length, 0);
  assert.ok(
    selected.prediction.relations.some(item =>
      item.ref === "control-role" && item.judgment === "actionable_provider"),
  );
});
