import assert from "node:assert/strict";
import { test } from "node:test";

import * as api from "../dist/browser-single-action.js";

const SAMPLE_ID = "train-native-caption-00";

function sampleRequest() {
  const episode = api.makeBrowserSingleActionSamples().find(item => item.id === SAMPLE_ID);
  assert.ok(episode, `missing fixture episode ${SAMPLE_ID}`);
  return structuredClone(episode.request);
}

function clickProfile() {
  const profile = structuredClone(api.createZeroBrowserSingleActionProfile());
  profile.relationWeights[0][api.SINGLE_ACTION_RELATION_WIRES.indexOf("controls.target*enabled.value*hit.value")] = 10;
  profile.relationWeights[1][0] = 1;
  profile.capabilityWeights[0][api.SINGLE_ACTION_CAPABILITY_WIRES.indexOf("providers.one")] = 10;
  return profile;
}

function positivePostObservation(request) {
  const post = structuredClone(request.state);
  post.observationId = `${post.observationId}:post`;
  post.revision += 1;
  for (const evidence of post.evidence) evidence.observationId = post.observationId;
  for (const region of post.regions) {
    const evidenceRefs = [post.evidence[0].id];
    region.expanded = { status: "observed", value: true, evidenceRefs };
    region.rendered = { status: "observed", value: true, evidenceRefs };
  }
  return post;
}

function fixture({ nativeClickError = null, observeError = null, receipt = null } = {}) {
  const request = sampleRequest();
  const post = positivePostObservation(request);
  const collected = [];
  const clicks = [];
  let reads = 0;
  let current = request.state;

  const resources = {
    profile: clickProfile(),
    grantedEffects: new Set(["browser.nativeClick", "filesystem.write"]),
    observe: async () => {
      reads += 1;
      if (reads > 1 && observeError) throw observeError;
      current = reads === 1 ? request.state : post;
      return current;
    },
    currentControl: () => current,
    nativeClick: async invocation => {
      clicks.push(invocation);
      if (nativeClickError) throw nativeClickError;
      return receipt ?? {
        dispatched: true,
        ok: true,
        effectKnowledge: "known",
        source: "test-native-executor",
        error: null,
      };
    },
    collect: async result => { collected.push(result); },
  };

  return {
    request,
    resources,
    collected,
    counts: () => ({ reads, clicks: clicks.length }),
  };
}

function run(fixtureValue) {
  return api.runBrowserSingleActionEpisode(fixtureValue.request, fixtureValue.resources);
}

test("F13.1 possibly dispatched executor throw keeps dispatch unknown", async () => {
  const failure = new Error("executor transport closed after dispatch may have crossed the input boundary");
  const f = fixture({ nativeClickError: failure });

  const result = await run(f);

  assert.deepEqual(f.counts(), { reads: 2, clicks: 1 });
  assert.equal(result.dispatchState, "unknown");
  assert.notEqual(result.dispatchState, "dispatched");
  assert.notEqual(result.dispatchState, "not_dispatched");
  assert.equal(result.effectKnowledge, "unknown");
  assert.equal(result.receipt, null);
  assert.equal(result.error.code, "native_click_failed");
  assert.equal(result.error.message, failure.message);
  assert.deepEqual(result.executionErrors, [{ code: "native_click_failed", message: failure.message }]);

  // Fresh observation may prove the Goal, but it must not rewrite dispatch or effect facts.
  assert.equal(result.observationFeedback.status, "satisfied");
  assert.equal(result.achieved, true);
  assert.equal(result.satisfaction, 100);
  assert.equal(f.collected.length, 1);
  assert.equal(f.collected[0].dispatchState, "unknown");
  assert.equal(f.collected[0].effectKnowledge, "unknown");
});

test("F13.2 zero dispatch cannot produce a successful Goal fact", async () => {
  const cases = [
    {
      name: "executor claims ok without dispatch",
      receipt: {
        dispatched: false,
        ok: true,
        effectKnowledge: "none",
        source: "zero-dispatch-ok",
        error: null,
      },
    },
    {
      name: "executor rejects before dispatch",
      receipt: {
        dispatched: false,
        ok: false,
        effectKnowledge: "none",
        source: "zero-dispatch-rejected",
        error: { code: "zero_dispatch_rejected", message: "executor rejected before dispatch" },
      },
    },
  ];

  for (const zero of cases) {
    const f = fixture({ receipt: zero.receipt });
    const result = await run(f);

    assert.deepEqual(f.counts(), { reads: 1, clicks: 1 }, zero.name);
    assert.equal(result.dispatchState, "not_dispatched", zero.name);
    assert.equal(result.effectKnowledge, "none", zero.name);
    assert.equal(result.receipt.dispatched, false, zero.name);
    assert.equal(result.achieved, false, zero.name);
    assert.equal(result.satisfaction, null, zero.name);
    assert.notEqual(result.observationFeedback.status, "satisfied", zero.name);
    assert.equal(result.newState, null, zero.name);
    assert.equal(f.collected.length, 1, zero.name);
    assert.equal(f.collected[0].dispatchState, "not_dispatched", zero.name);
    assert.equal(f.collected[0].effectKnowledge, "none", zero.name);
    assert.equal(f.collected[0].achieved, false, zero.name);
    assert.equal(f.collected[0].satisfaction, null, zero.name);
  }
});

test("F13.3 explicit failure cannot clear unknown effects", async () => {
  const receipt = {
    dispatched: true,
    ok: false,
    effectKnowledge: "unknown",
    source: "explicit-failure-executor",
    error: { code: "executor_rejected", message: "executor rejected after dispatch; effect remains unknown" },
  };
  const f = fixture({ receipt });

  const result = await run(f);

  assert.deepEqual(f.counts(), { reads: 2, clicks: 1 });
  assert.equal(result.dispatchState, "dispatched");
  assert.equal(result.effectKnowledge, "unknown");
  assert.equal(result.receipt.ok, false);
  assert.equal(result.receipt.effectKnowledge, "unknown");
  assert.equal(result.receipt.source, receipt.source);
  assert.deepEqual(result.executionErrors, [receipt.error]);
  assert.deepEqual(result.error, receipt.error);
  assert.equal(result.observationFeedback.status, "satisfied");
  assert.equal(result.achieved, true);
  assert.equal(f.collected.length, 1);
  assert.equal(f.collected[0].effectKnowledge, "unknown");
  assert.deepEqual(f.collected[0].executionErrors, [receipt.error]);
  assert.equal(f.collected[0].error.code, receipt.error.code);
});

test("F13.4 execution and observation errors keep separate sources and original messages", async () => {
  const executionFailure = new Error("execute bridge: transport closed after dispatch");
  const observationFailure = new Error("observe bridge: sensor unavailable after dispatch");
  const f = fixture({ nativeClickError: executionFailure, observeError: observationFailure });

  const result = await run(f);

  assert.deepEqual(f.counts(), { reads: 2, clicks: 1 });
  assert.equal(result.dispatchState, "unknown");
  assert.equal(result.effectKnowledge, "unknown");
  assert.equal(result.executionErrors.length, 1);
  assert.equal(result.executionErrors[0].code, "native_click_failed");
  assert.equal(result.executionErrors[0].message, executionFailure.message);
  assert.equal(result.error.code, "native_click_failed");
  assert.equal(result.error.message, executionFailure.message);
  assert.equal(result.observationFeedback.status, "failed");
  assert.equal(result.observationFeedback.errors.length, 1);
  assert.equal(result.observationFeedback.errors[0].code, "post_observation_failed");
  assert.equal(result.observationFeedback.errors[0].message, observationFailure.message);
  assert.equal(result.executionErrors.some(error => error.message === observationFailure.message), false);
  assert.equal(result.observationFeedback.errors.some(error => error.message === executionFailure.message), false);
  assert.equal(result.newState, null);
  assert.equal(result.satisfaction, null);
  assert.equal(result.achieved, false);

  const executionErrors = api.readBrowserObservationErrors(result.executionErrors);
  const observationFeedback = api.readBrowserObservationFeedback(result.observationFeedback);
  assert.equal(executionErrors[0].message, executionFailure.message);
  assert.equal(observationFeedback.errors[0].message, observationFailure.message);

  assert.equal(f.collected.length, 1);
  assert.equal(f.collected[0].executionErrors[0].message, executionFailure.message);
  assert.equal(f.collected[0].observationFeedback.errors[0].message, observationFailure.message);
});
