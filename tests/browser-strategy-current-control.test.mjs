import assert from "node:assert/strict";
import { test } from "node:test";

import * as atomicPolicy from "../dist/filters/browser-single-action-policy.js";
import * as feedbackPolicy from "../dist/filters/browser-feedback.js";
import * as strategyPublic from "../dist/browser-strategy.js";

const strategyStepUrl = process.env.NNANYTHING_BROWSER_STRATEGY_URL
  ?? new URL("../dist/nodes/browser-strategy.js", import.meta.url).href;
const strategyStep = () => import(strategyStepUrl);

const EPISODE_ID = "strategy-native-preference-00";

function episodeFixture() {
  const episode = strategyPublic.makeStrategySamples().find(item => item.id === EPISODE_ID);
  assert.ok(episode);
  return structuredClone(episode);
}

function controlOf(state) {
  return {
    documentRef: state.documentRef,
    observationId: state.observationId,
    revision: state.revision,
  };
}

function strategyProfile() {
  const zero = strategyPublic.createZeroBrowserStrategyProfile();
  const weights = zero.weights.map(row => [...row]);
  const choose = zero.heads.indexOf("choose");
  const wire = name => zero.wires.indexOf(name);
  weights[choose][wire("nativeButton")] = 4;
  weights[choose][wire("explicitRoleButton")] = 1;
  return strategyPublic.validateBrowserStrategyProfile({ ...zero, weights });
}

function atomicProfile() {
  const zero = atomicPolicy.createZeroBrowserSingleActionProfile();
  const relationWeights = zero.relationWeights.map(row => [...row]);
  relationWeights[0][0] = -3;
  relationWeights[0][12] = 6;
  const capabilityWeights = zero.capabilityWeights.map(row => [...row]);
  const click = zero.capabilityHeads.indexOf("CLICK");
  capabilityWeights[click][zero.capabilityWires.indexOf("bias")] = 2;
  capabilityWeights[click][zero.capabilityWires.indexOf("providers.zero")] = -4;
  capabilityWeights[click][zero.capabilityWires.indexOf("providers.one")] = 4;
  return atomicPolicy.validateBrowserSingleActionProfile({
    ...zero,
    relationWeights,
    capabilityWeights,
  });
}

function cloneObservation(state, observationId, revision, expanded = false) {
  const next = structuredClone(state);
  next.observationId = observationId;
  next.revision = revision;

  const evidenceIds = new Map();
  next.evidence = next.evidence.map((item, index) => {
    const id = `${observationId}:evidence:${index}`;
    evidenceIds.set(item.id, id);
    return { ...item, id, observationId };
  });
  const remap = fact => {
    if (fact.status !== "observed") return fact;
    return {
      ...fact,
      evidenceRefs: fact.evidenceRefs.map(ref => evidenceIds.get(ref) ?? ref),
    };
  };
  for (const element of next.elements) {
    element.evidenceRefs = element.evidenceRefs.map(ref => evidenceIds.get(ref) ?? ref);
    for (const key of ["controls", "enabled", "hit", "buttonSemantics", "point"]) {
      element[key] = remap(element[key]);
    }
  }
  for (const region of next.regions) {
    region.expanded = remap(region.expanded);
    region.rendered = remap(region.rendered);
    if (region.ref === "region-main") {
      region.expanded = { ...region.expanded, value: expanded };
      region.rendered = { ...region.rendered, value: expanded };
    }
  }
  return next;
}

function createResources(episode, observations) {
  const queue = [...observations];
  const clicks = [];
  const atomicCollected = [];
  const stepCollected = [];
  let live = controlOf(episode.input.request.state);
  const resources = {
    profile: strategyProfile(),
    atomicProfile: atomicProfile(),
    feedbackProfile: feedbackPolicy.createZeroFeedbackProfile(),
    registry: episode.registry,
    selection: episode.selection,
    selectedSkillId: episode.teacher.selectedSkillId,
    grantedEffects: new Set(["browser.nativeClick", "filesystem.write"]),
    async observe() {
      const next = queue.shift();
      if (next === undefined) throw new Error("current-control fixture observation queue exhausted");
      live = controlOf(next);
      return next;
    },
    currentControl: () => live,
    liveControl: () => live,
    async nativeClick(invocation) {
      clicks.push(invocation);
      return {
        dispatched: true,
        ok: true,
        effectKnowledge: "known",
        source: "current-control-fixture",
        error: null,
      };
    },
    async collectAtomic(result) {
      atomicCollected.push(result);
    },
    async collectStep(result) {
      stepCollected.push(result);
    },
    proveNoEffect() {
      return null;
    },
    clicks,
    atomicCollected,
    stepCollected,
  };
  return resources;
}

test("atomic apply rechecks live control after observation and takes zero input when revision changes", async () => {
  const episode = episodeFixture();
  const preflight = structuredClone(episode.input.request.state);
  const pre = structuredClone(episode.input.request.state);
  const post = cloneObservation(pre, "current-control-post", pre.revision + 1);
  const resources = createResources(episode, [preflight, pre, post]);
  let live = controlOf(pre);
  let controlCalls = 0;
  resources.currentControl = () => {
    controlCalls += 1;
    if (controlCalls === 2) {
      queueMicrotask(() => {
        live = { ...live, revision: 3 };
      });
    }
    return live;
  };

  const module = await strategyStep();
  const result = await module.runBrowserStrategyStep(episode.input, resources);

  assert.equal(controlCalls >= 3, true);
  assert.equal(resources.clicks.length, 0);
  assert.equal(result.atomic?.error?.code, "stale_reference");
  assert.equal(result.atomic?.dispatchState, "not_dispatched");
  assert.equal(result.atomic?.receipt, null);
  assert.equal(result.atomic?.satisfaction, null);
  assert.equal(result.atomic?.achieved, false);
  assert.equal(result.atomic?.newState, null);
  assert.equal(resources.atomicCollected.length, 1);
});

test("strategy apply accepts an asynchronous live control source", async () => {
  const episode = episodeFixture();
  const preflight = structuredClone(episode.input.request.state);
  const pre = structuredClone(episode.input.request.state);
  const post = cloneObservation(pre, "async-control-post", pre.revision + 1, true);
  const resources = createResources(episode, [preflight, pre, post]);
  let controlCalls = 0;
  resources.currentControl = async () => {
    await Promise.resolve();
    controlCalls += 1;
    return resources.liveControl();
  };

  const module = await strategyStep();
  const result = await module.runBrowserStrategyStep(episode.input, resources);

  assert.equal(controlCalls >= 4, true);
  assert.equal(resources.clicks.length, 1);
  assert.equal(resources.clicks[0].targetRef, "native-target");
  assert.equal(result.atomic?.error, null);
  assert.equal(result.atomic?.achieved, true);
  assert.equal(result.atomic?.satisfaction, 100);
});

test("a failing live control callback stops before native input", async () => {
  const episode = episodeFixture();
  const preflight = structuredClone(episode.input.request.state);
  const pre = structuredClone(episode.input.request.state);
  const resources = createResources(episode, [preflight, pre]);
  let controlCalls = 0;
  resources.currentControl = () => {
    controlCalls += 1;
    if (controlCalls === 2) throw new Error("live control unavailable");
    return controlOf(pre);
  };

  const module = await strategyStep();
  const result = await module.runBrowserStrategyStep(episode.input, resources);

  assert.equal(controlCalls >= 2, true);
  assert.equal(resources.clicks.length, 0);
  assert.equal(result.atomic?.error?.code, "control_unavailable");
  assert.equal(result.atomic?.dispatchState, "not_dispatched");
  assert.equal(result.atomic?.receipt, null);
  assert.equal(result.atomic?.achieved, false);
});
