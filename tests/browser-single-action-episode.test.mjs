import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const api = () => import("../dist/browser-single-action.js");

function profileForClick(apiModule) {
  const relation = (values) => apiModule.SINGLE_ACTION_RELATION_WIRES.map(
    wire => values[wire] ?? 0,
  );
  const capability = (values) => apiModule.SINGLE_ACTION_CAPABILITY_WIRES.map(
    wire => values[wire] ?? 0,
  );
  return apiModule.validateBrowserSingleActionProfile({
    contract: "browser.single-action-policy.v1",
    relationHeads: [...apiModule.SINGLE_ACTION_RELATION_HEADS],
    relationWires: [...apiModule.SINGLE_ACTION_RELATION_WIRES],
    capabilityHeads: [...apiModule.SINGLE_ACTION_CAPABILITY_HEADS],
    capabilityWires: [...apiModule.SINGLE_ACTION_CAPABILITY_WIRES],
    relationWeights: [
      relation({
        bias: -2,
        "controls.target*enabled.value*hit.value": 4,
      }),
      relation({ bias: 0 }),
    ],
    capabilityWeights: [
      capability({ bias: -1, "providers.one": 10, "regionExpanded.value": -10 }),
      capability({ "regionExpanded.value": 10 }),
      capability({}),
    ],
    calibration: "uncalibrated",
    adoption: "not_applied",
  });
}

function profileForTrainedLike(apiModule) {
  const relation = (values) => apiModule.SINGLE_ACTION_RELATION_WIRES.map(
    wire => values[wire] ?? 0,
  );
  const capability = (values) => apiModule.SINGLE_ACTION_CAPABILITY_WIRES.map(
    wire => values[wire] ?? 0,
  );
  return apiModule.validateBrowserSingleActionProfile({
    contract: "browser.single-action-policy.v1",
    relationHeads: [...apiModule.SINGLE_ACTION_RELATION_HEADS],
    relationWires: [...apiModule.SINGLE_ACTION_RELATION_WIRES],
    capabilityHeads: [...apiModule.SINGLE_ACTION_CAPABILITY_HEADS],
    capabilityWires: [...apiModule.SINGLE_ACTION_CAPABILITY_WIRES],
    relationWeights: [
      relation({
        "controls.known": 1,
        "controls.target": 5,
        "enabled.value": 5,
        "hit.value": 1,
        "buttonSemantics.value": 2,
        "controls.target*enabled.value": 3,
        "controls.target*hit.value": 3,
        "controls.target*enabled.value*hit.value": 10,
      }),
      relation({ bias: 20 }),
    ],
    capabilityWeights: [
      capability({
        bias: -10,
        "providers.one": 20,
        "regionExpanded.value": -10,
        "relationCoverage.complete": 2,
        "actionabilityCoverage.complete": 2,
      }),
      capability({ "regionExpanded.known": 1, "regionExpanded.value": 10 }),
      capability({
        bias: 30,
        "regionExpanded.known": -40,
        "providers.zero": 20,
        "providers.many": 20,
        "relationCoverage.complete": -2,
        "actionabilityCoverage.complete": -2,
      }),
    ],
    calibration: "uncalibrated",
    adoption: "not_applied",
  });
}

function sampleEpisode(apiModule, id = "train-native-caption-00") {
  const episode = apiModule.makeBrowserSingleActionSamples().find(item => item.id === id);
  assert.ok(episode);
  return structuredClone(episode);
}

function controlOf(request) {
  return {
    documentRef: request.state.documentRef,
    observationId: request.state.observationId,
    revision: request.state.revision,
  };
}

function withPostObservation(episode, expanded = true) {
  const post = structuredClone(episode.request.state);
  post.observationId = `${episode.id}:post`;
  post.revision += 1;
  const region = post.regions.find(item => item.ref === episode.request.goal.regionRef);
  assert.ok(region);
  region.expanded = {
    status: "observed",
    value: expanded,
    evidenceRefs: [post.evidence[0].id],
  };
  region.rendered = {
    status: "observed",
    value: expanded,
    evidenceRefs: [post.evidence[0].id],
  };
  for (const evidence of post.evidence) evidence.observationId = post.observationId;
  return post;
}

function resources(apiModule, episode, post, overrides = {}) {
  const observations = [episode.request.state, post];
  const clicks = [];
  const collected = [];
  let current = controlOf(episode.request);
  return {
    profile: overrides.profile ?? profileForClick(apiModule),
    grantedEffects: overrides.grantedEffects ?? new Set(["browser.nativeClick", "filesystem.write"]),
    observe: async () => {
      const next = observations.shift();
      if (next === undefined) throw new Error("unexpected extra observation");
      current = { documentRef: next.documentRef, observationId: next.observationId, revision: next.revision };
      return next;
    },
    currentControl: () => current,
    nativeClick: async invocation => {
      clicks.push(invocation);
      return { dispatched: true, ok: true, effectKnowledge: "known", source: "test-native", error: null };
    },
    collect: async result => { collected.push(result); },
    clicks,
    collected,
    ...overrides.public,
  };
}

test("episode clicks the unique predicted target and verifies rendered expansion", async () => {
  const library = await api();
  const episode = sampleEpisode(library);
  const resource = resources(library, episode, withPostObservation(episode, true));

  const result = await library.runBrowserSingleActionEpisode(episode.request, resource);

  assert.equal(result.prediction?.capability, "CLICK");
  assert.equal(result.invocation?.targetRef, "control-target");
  assert.equal(resource.clicks.length, 1);
  assert.equal(result.receipt?.dispatched, true);
  assert.equal(result.satisfaction, 100);
  assert.equal(result.achieved, true);
  assert.equal(result.collectionError, null);
  assert.equal(resource.collected.length, 1);
});

test("post-action observation must still match the current control resource", async () => {
  const library = await api();
  const episode = sampleEpisode(library);
  const post = withPostObservation(episode);
  let reads = 0;
  const resource = resources(library, episode, post, {
    public: { currentControl: () => {
      reads += 1;
      return reads <= 2 ? controlOf(episode.request) : {
        documentRef: post.documentRef, observationId: post.observationId, revision: post.revision + 1,
      };
    } },
  });
  const result = await library.runBrowserSingleActionEpisode(episode.request, resource);
  assert.equal(resource.clicks.length, 1);
  assert.equal(result.receipt.dispatched, true);
  assert.equal(result.effectKnowledge, "known");
  assert.equal(result.achieved, false);
  assert.equal(result.satisfaction, null);
  assert.equal(result.error?.code, "stale_reference");
});

test("post-action evidence cannot reuse the pre-action observation identity", async () => {
  const library = await api();
  const episode = sampleEpisode(library);
  const post = withPostObservation(episode);
  post.observationId = episode.request.state.observationId;
  post.revision = episode.request.state.revision;
  for (const evidence of post.evidence) evidence.observationId = post.observationId;
  const resource = resources(library, episode, post);
  const result = await library.runBrowserSingleActionEpisode(episode.request, resource);
  assert.equal(resource.clicks.length, 1);
  assert.equal(result.receipt.dispatched, true);
  assert.equal(result.achieved, false);
  assert.equal(result.satisfaction, null);
  assert.equal(result.error?.code, "stale_reference");
});

test("native callback exception preserves uncertain dispatch and effects", async () => {
  const library = await api();
  const episode = sampleEpisode(library);
  let attempts = 0;
  const resource = resources(library, episode, withPostObservation(episode), {
    public: { nativeClick: async () => { attempts += 1; throw new Error("injected native callback failure"); } },
  });
  const result = await library.runBrowserSingleActionEpisode(episode.request, resource);
  assert.equal(attempts, 1);
  assert.equal(result.receipt, null);
  assert.equal(result.dispatchState, "unknown");
  assert.equal(result.effectKnowledge, "unknown");
  assert.equal(result.satisfaction, null);
  assert.equal(result.error.code, "native_click_failed");
  assert.equal(resource.collected.length, 1);
});

test("a fresh observation cannot silently rebind the original Goal to a new document", async () => {
  const library = await api();
  const episode = sampleEpisode(library);
  const changed = structuredClone(episode.request.state);
  changed.documentRef = "replacement-document";
  const resource = resources(library, episode, changed, {
    public: {
      observe: async () => changed,
      currentControl: () => ({ documentRef: changed.documentRef, observationId: changed.observationId, revision: changed.revision }),
    },
  });
  const result = await library.runBrowserSingleActionEpisode(episode.request, resource);
  assert.equal(resource.clicks.length, 0);
  assert.equal(result.invocation, null);
  assert.equal(result.error.code, "invalid_binding");
});

test("post-click navigation cannot prove the original region expanded", async () => {
  const library = await api();
  const episode = sampleEpisode(library);
  const post = withPostObservation(episode, true);
  post.documentRef = "replacement-post-document";
  const resource = resources(library, episode, post);
  const result = await library.runBrowserSingleActionEpisode(episode.request, resource);
  assert.equal(resource.clicks.length, 1);
  assert.equal(result.receipt.dispatched, true);
  assert.equal(result.effectKnowledge, "known");
  assert.equal(result.satisfaction, null);
  assert.equal(result.achieved, false);
  assert.equal(result.error.code, "invalid_binding");
});

test("NOOP cannot succeed from an observation invalidated by the control resource", async () => {
  const library = await api();
  const episode = sampleEpisode(library, "train-native-caption-02");
  const resource = resources(library, episode, withPostObservation(episode), {
    profile: profileForTrainedLike(library),
    public: { currentControl: () => ({ ...controlOf(episode.request), revision: episode.request.state.revision + 1 }) },
  });
  const result = await library.runBrowserSingleActionEpisode(episode.request, resource);
  assert.equal(resource.clicks.length, 0);
  assert.equal(result.satisfaction, null);
  assert.equal(result.achieved, false);
  assert.equal(result.error.code, "stale_reference");
});

test("wrong model target is rejected without substituting the actual provider", async () => {
  const library = await api();
  const episode = sampleEpisode(library);
  const profile = structuredClone(profileForClick(library));
  profile.relationWeights[0] = library.SINGLE_ACTION_RELATION_WIRES.map(wire => ({
    bias: -1, "buttonSemantics.value": 2, "controls.target": -4,
  }[wire] ?? 0));
  // Keep exactly one unrelated candidate eligible to isolate the wrong-target failure.
  const alternate = episode.request.state.elements.find(element => element.ref === "control-alternate");
  alternate.buttonSemantics = { status: "observed", value: false, evidenceRefs: alternate.evidenceRefs };
  alternate.enabled = { status: "unknown", reason: "noninteractive_test_control" };
  const resource = resources(library, episode, withPostObservation(episode), { profile });
  const result = await library.runBrowserSingleActionEpisode(episode.request, resource);
  assert.equal(result.prediction.proposedTargetRef, "control-neighbor");
  assert.equal(resource.clicks.length, 0);
  assert.equal(result.invocation, null);
  assert.equal(result.error.code, "policy_error");
});

test("click receipt success without rendered target reports not achieved", async () => {
  const library = await api();
  const episode = sampleEpisode(library);
  const resource = resources(library, episode, withPostObservation(episode, false));

  const result = await library.runBrowserSingleActionEpisode(episode.request, resource);

  assert.equal(resource.clicks.length, 1);
  assert.equal(result.receipt?.dispatched, true);
  assert.equal(result.satisfaction, 0);
  assert.equal(result.achieved, false);
});

test("stale control and missing native effect authorization take zero click input", async () => {
  const library = await api();
  const staleEpisode = sampleEpisode(library);
  const staleResource = resources(library, staleEpisode, withPostObservation(staleEpisode), {
    public: {
      currentControl: () => ({
        ...controlOf(staleEpisode.request),
        revision: staleEpisode.request.state.revision + 1,
      }),
    },
  });
  const stale = await library.runBrowserSingleActionEpisode(staleEpisode.request, staleResource);
  assert.equal(stale.error?.code, "stale_reference");
  assert.equal(stale.satisfaction, null);
  assert.equal(staleResource.clicks.length, 0);

  const authorizedEpisode = sampleEpisode(library);
  let observeCount = 0;
  const unauthorizedResource = resources(library, authorizedEpisode, withPostObservation(authorizedEpisode), {
    grantedEffects: new Set(["filesystem.write"]),
    public: {
      observe: async () => {
        observeCount += 1;
        return authorizedEpisode.request.state;
      },
    },
  });
  await assert.rejects(
    library.runBrowserSingleActionEpisode(authorizedEpisode.request, unauthorizedResource),
    /Unauthorized effect browser\.nativeClick/,
  );
  assert.equal(observeCount, 0);
  assert.equal(unauthorizedResource.clicks.length, 0);
});

test("guard keeps a model-selected provider and never substitutes another control", async () => {
  const library = await api();
  const episode = sampleEpisode(library);
  const request = structuredClone(episode.request);
  const target = request.state.elements.find(element => element.ref === "control-target");
  const neighbor = request.state.elements.find(element => element.ref === "control-neighbor");
  assert.ok(target && neighbor);
  target.controls = { status: "unknown", reason: "forced_missing" };
  neighbor.controls = {
    status: "observed",
    value: [request.goal.regionRef],
    evidenceRefs: [request.state.evidence[0].id],
  };
  const resource = resources(library, { request }, withPostObservation(episode), {
    public: {
      observe: async () => request.state,
      currentControl: () => controlOf(request),
    },
  });

  const result = await library.runBrowserSingleActionEpisode(request, resource);

  assert.equal(result.prediction?.proposedTargetRef, "control-neighbor");
  assert.equal(resource.clicks.length, 1);
  assert.equal(resource.clicks[0].targetRef, "control-neighbor");
});

test("already expanded goal is NOOP with zero native input", async () => {
  const library = await api();
  const episode = sampleEpisode(library, "train-native-caption-02");
  const resource = resources(library, episode, withPostObservation(episode, true), {
    profile: profileForTrainedLike(library),
  });

  const result = await library.runBrowserSingleActionEpisode(episode.request, resource);

  assert.equal(result.prediction?.capability, "NOOP");
  assert.equal(result.invocation, null);
  assert.equal(resource.clicks.length, 0);
  assert.equal(result.satisfaction, 100);
  assert.equal(result.achieved, true);
});

test("missing expanded evidence yields DEFER with zero native input", async () => {
  const library = await api();
  const episode = sampleEpisode(library, "train-native-caption-03");
  const resource = resources(library, episode, withPostObservation(episode, true), {
    profile: profileForTrainedLike(library),
  });

  const result = await library.runBrowserSingleActionEpisode(episode.request, resource);

  assert.equal(result.prediction?.capability, "DEFER");
  assert.equal(result.invocation, null);
  assert.equal(resource.clicks.length, 0);
  assert.equal(result.satisfaction, null);
  assert.equal(result.achieved, false);
  assert.equal(result.error?.code, "observation_insufficient");
});

test("disabled target control yields DEFER with zero native input", async () => {
  const library = await api();
  const episode = sampleEpisode(library, "train-native-caption-04");
  const resource = resources(library, episode, withPostObservation(episode, true), {
    profile: profileForTrainedLike(library),
  });

  const result = await library.runBrowserSingleActionEpisode(episode.request, resource);

  assert.equal(result.prediction?.capability, "DEFER");
  assert.equal(result.prediction?.proposedTargetRef, null);
  assert.equal(result.invocation, null);
  assert.equal(resource.clicks.length, 0);
  assert.equal(result.satisfaction, null);
  assert.equal(result.error?.code, "precondition_unsatisfied");
});

test("two actionable providers remain ambiguous with zero native input", async () => {
  const library = await api();
  const episode = sampleEpisode(library, "train-native-caption-06");
  const resource = resources(library, episode, withPostObservation(episode, true), {
    profile: profileForTrainedLike(library),
  });

  const result = await library.runBrowserSingleActionEpisode(episode.request, resource);
  const providers = result.prediction?.relations.filter(relation => relation.judgment === "actionable_provider") ?? [];

  assert.equal(providers.length, 2);
  assert.equal(result.error?.code, "binding_ambiguous");
  assert.equal(result.prediction?.capability, "DEFER");
  assert.equal(result.prediction?.proposedTargetRef, null);
  assert.equal(result.invocation, null);
  assert.equal(resource.clicks.length, 0);
});

test("element order does not change the selected target", async () => {
  const library = await api();
  const episode = sampleEpisode(library);
  const request = structuredClone(episode.request);
  request.state.elements.reverse();
  const resource = resources(library, { request }, withPostObservation(episode, true), {
    profile: profileForTrainedLike(library),
  });

  const result = await library.runBrowserSingleActionEpisode(request, resource);

  assert.equal(result.prediction?.proposedTargetRef, "control-target");
  assert.equal(result.invocation?.targetRef, "control-target");
  assert.equal(resource.clicks.length, 1);
  assert.equal(result.satisfaction, 100);
});

test("unknown effect keeps the receipt and reports unknown satisfaction", async () => {
  const library = await api();
  const episode = sampleEpisode(library);
  const post = withPostObservation(episode, false);
  for (const region of post.regions) {
    region.expanded = { status: "unknown", reason: "post_expanded_missing" };
    region.rendered = { status: "unknown", reason: "post_rendered_missing" };
  }
  let clicks = 0;
  const resource = resources(library, episode, post, {
    public: {
      nativeClick: async () => {
        clicks += 1;
        return {
          dispatched: true,
          ok: true,
          effectKnowledge: "unknown",
          source: "test-native",
          error: null,
        };
      },
    },
  });

  const result = await library.runBrowserSingleActionEpisode(episode.request, resource);

  assert.equal(clicks, 1);
  assert.equal(result.receipt?.dispatched, true);
  assert.equal(result.receipt?.effectKnowledge, "unknown");
  assert.equal(result.satisfaction, null);
  assert.equal(result.achieved, false);
  assert.equal(result.error, null);
});

test("post-observation failure preserves the native receipt and unknown satisfaction", async () => {
  const library = await api();
  const episode = sampleEpisode(library);
  let observation = 0;
  const resource = resources(library, episode, withPostObservation(episode), {
    public: {
      observe: async () => {
        observation += 1;
        if (observation === 2) throw new Error("post observation unavailable");
        return episode.request.state;
      },
    },
  });

  const result = await library.runBrowserSingleActionEpisode(episode.request, resource);

  assert.equal(result.receipt?.dispatched, true);
  assert.equal(result.error?.code, "post_observation_failed");
  assert.equal(result.satisfaction, null);
  assert.equal(result.achieved, false);
});

test("collection failure is separate from the action result", async () => {
  const library = await api();
  const episode = sampleEpisode(library);
  const resource = resources(library, episode, withPostObservation(episode, true), {
    public: {
      collect: async () => { throw new Error("local collection unavailable"); },
    },
  });

  const result = await library.runBrowserSingleActionEpisode(episode.request, resource);

  assert.equal(result.achieved, true);
  assert.equal(result.error, null);
  assert.match(result.collectionError, /local collection unavailable/);
});

test("fixture server reports dynamic PID/port and serves structural cases", async () => {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("../playground/browser/single-action/fixture-server.mjs", import.meta.url)),
    "--port",
    "0",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const line = await new Promise((resolve, reject) => {
      const reader = createInterface({ input: child.stdout });
      reader.once("line", resolve);
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`fixture server exited before startup: ${code}`)));
    });
    const started = JSON.parse(line);
    assert.equal(started.pid, child.pid);
    assert.ok(started.port > 0);
    const cases = await fetch(`http://127.0.0.1:${started.port}/api/cases?cases=native-button,role-button`).then(response => response.json());
    assert.deepEqual(cases.cases, ["native-button", "role-button"]);
    const html = await fetch(`http://127.0.0.1:${started.port}/?cases=native-button,role-button`).then(response => response.text());
    assert.match(html, /<button[^>]+class="toggle native-control"/);
    assert.match(html, /role="button"/);
    assert.match(html, /addEventListener\("click"/);
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("exit", resolve));
  }
});
