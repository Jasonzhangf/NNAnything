import assert from "node:assert/strict";
import { test } from "node:test";

const strategyModuleUrl = process.env.NN_BROWSER_STRATEGY_URL
  ?? new URL("../dist/filters/browser-strategy.js", import.meta.url).href;
const samplesModuleUrl = process.env.NN_BROWSER_STRATEGY_SAMPLES_URL
  ?? new URL("../dist/training/browser-strategy-samples.js", import.meta.url).href;
const atomicPolicyModuleUrl = process.env.NN_BROWSER_STRATEGY_ATOMIC_POLICY_URL
  ?? new URL("../dist/filters/browser-single-action-policy.js", import.meta.url).href;
const feedbackModuleUrl = process.env.NN_BROWSER_STRATEGY_FEEDBACK_URL
  ?? new URL("../dist/filters/browser-feedback.js", import.meta.url).href;

async function fixture() {
  const [strategy, samples, atomicPolicy, feedback] = await Promise.all([
    import(strategyModuleUrl),
    import(samplesModuleUrl),
    import(atomicPolicyModuleUrl),
    import(feedbackModuleUrl),
  ]);
  const zeroAtomic = atomicPolicy.createZeroBrowserSingleActionProfile();
  const relationWeights = zeroAtomic.relationWeights.map(row => [...row]);
  relationWeights[0][0] = -3;
  relationWeights[0][12] = 6;
  return {
    strategy,
    samples,
    rows: samples.makeStrategySamples(),
    profile: strategy.createZeroBrowserStrategyProfile(),
    atomicProfile: atomicPolicy.validateBrowserSingleActionProfile({ ...zeroAtomic, relationWeights }),
    feedbackProfile: feedback.createZeroFeedbackProfile(),
  };
}

function infer(strategy, row, input = row.input) {
  return strategy.predictBrowserStrategy(input, {
    profile: row.profile,
    atomicProfile: row.atomicProfile,
    feedbackProfile: row.feedbackProfile,
    registry: row.registry,
    selection: row.selection,
  });
}

function withModels(data, row) {
  return { ...row, profile: data.profile, atomicProfile: data.atomicProfile, feedbackProfile: data.feedbackProfile };
}

test("same-document future history is rejected", async () => {
  const data = await fixture();
  const row = data.rows.find(candidate => candidate.input.history.some(history => history.input.result.newState));
  const input = structuredClone(row.input);
  const history = input.history.find(candidate => candidate.input.result.newState);
  assert.equal(history.input.request.state.documentRef, input.request.state.documentRef);
  history.input.result.newState.revision = input.request.state.revision + 1;
  assert.throws(() => infer(data.strategy, withModels(data, row), input), /future|newer|history.*current/i);
});

test("invocation target must agree with the outer history candidate", async () => {
  const data = await fixture();
  const row = data.rows.find(candidate => candidate.input.history.some(history => history.input.result.invocation));
  const input = structuredClone(row.input);
  const history = input.history.find(candidate => candidate.input.result.invocation);
  const other = row.registry.find(candidate => candidate.targetRef !== history.targetRef);
  history.input.result.invocation.targetRef = other.targetRef;
  assert.throws(() => infer(data.strategy, withModels(data, row), input), /target|history/i);
});

test("expanded true with missing rendered observation cannot claim a satisfied Goal", async () => {
  const data = await fixture();
  const row = withModels(data, data.rows[0]);
  const input = structuredClone(row.input);
  const region = input.request.state.regions.find(candidate => candidate.ref === input.request.goal.regionRef);
  region.expanded = { status: "observed", value: true, evidenceRefs: region.expanded.evidenceRefs };
  region.rendered = { status: "unknown", reason: "forced_missing_rendering" };
  const prediction = infer(data.strategy, row, input);
  assert.equal(prediction.kind, "DEFER");
  assert.equal(prediction.candidates.length, 0);
  assert.match(prediction.reason, /insufficient|unknown|unavailable/i);
  assert.doesNotMatch(prediction.reason, /already satisfied/i);
});

test("unexecuted Goal evidence cannot become candidate success from the F1 category", async () => {
  const data = await fixture();
  const row = withModels(
    data,
    data.rows.find(candidate => candidate.input.history.some(history =>
      history.input.result.achieved && history.input.result.newState)),
  );
  const input = structuredClone(row.input);
  const history = input.history.find(candidate => candidate.input.result.achieved && candidate.input.result.newState);
  const pre = history.input.request.state;
  const state = structuredClone(pre);
  const region = state.regions.find(candidate => candidate.ref === state.regions[0].ref);
  history.input.result.newState = state;
  history.input.controlAtCompletion = {
    documentRef: state.documentRef,
    observationId: state.observationId,
    revision: state.revision,
  };
  region.expanded = { status: "observed", value: true, evidenceRefs: region.expanded.evidenceRefs };
  region.rendered = { status: "observed", value: true, evidenceRefs: region.rendered.evidenceRefs };
  history.input.result.invocation = null;
  history.input.result.receipt = null;
  history.input.result.dispatchState = "not_dispatched";
  history.input.result.effectKnowledge = "none";

  const prediction = infer(data.strategy, row, input);
  const candidate = prediction.candidates.find(candidate => candidate.skillId === history.skillId);
  assert.ok(candidate);
  assert.equal(candidate.feedback.status, "goal_achieved");
  assert.deepEqual(candidate.features.slice(8), [0, 0]);
});

test("history from a foreign document is ignored instead of becoming same-document future feedback", async () => {
  const data = await fixture();
  const row = withModels(
    data,
    data.rows.find(candidate => candidate.input.history.some(history => history.input.result.newState)),
  );
  const input = structuredClone(row.input);
  const history = input.history.find(candidate => candidate.input.result.newState);
  history.input.request.state.documentRef = "document:foreign";
  history.input.result.newState.documentRef = "document:foreign";
  if (history.input.result.invocation !== null) history.input.result.invocation.documentRef = "document:foreign";
  if (history.input.controlAtCompletion !== null) {
    history.input.controlAtCompletion.documentRef = "document:foreign";
  }

  const prediction = infer(data.strategy, row, input);
  const candidate = prediction.candidates.find(candidate => candidate.skillId === history.skillId);
  assert.ok(candidate);
  assert.deepEqual(candidate.features.slice(4), [0, 0, 0, 0, 0, 0]);
});

test("synthetic history stays within its current document and revision", async () => {
  const data = await fixture();
  for (const row of data.rows) {
    const current = row.input.request.state;
    for (const region of current.regions) {
      if (region.expanded.status === "observed" && region.rendered.status === "observed") {
        assert.equal(region.rendered.value, region.expanded.value, row.id);
      }
    }
    for (const history of row.input.history) {
      const pre = history.input.request.state;
      const post = history.input.result.newState;
      const strategy = row.registry.find(candidate => candidate.skillId === history.skillId);
      assert.equal(pre.documentRef, current.documentRef, row.id);
      assert.ok(pre.revision <= current.revision, row.id);
      assert.equal(history.targetRef, strategy.targetRef, row.id);
      assert.equal(history.strategyRef, strategy.strategyRef, row.id);
      assert.equal(history.equivalenceSetRef, strategy.equivalenceSetRef, row.id);
      if (post !== null) {
        assert.equal(post.documentRef, current.documentRef, row.id);
        assert.ok(post.revision > pre.revision, row.id);
        assert.ok(post.revision <= current.revision, row.id);
        for (const region of post.regions) {
          if (region.expanded.status === "observed" && region.rendered.status === "observed") {
            assert.equal(region.rendered.value, region.expanded.value, row.id);
          }
        }
      }
      if (history.input.result.invocation !== null) {
        assert.equal(history.input.result.invocation.documentRef, current.documentRef, row.id);
      }
      if (history.input.controlAtCompletion !== null) {
        assert.equal(history.input.controlAtCompletion.documentRef, current.documentRef, row.id);
      }
    }
  }
});

test("strategy episode reader accepts a null remaining budget and round-trips it", async () => {
  const data = await fixture();
  const episode = structuredClone(data.rows[0]);
  episode.selection.remainingAtomicAttempts = null;
  const [read] = data.samples.readStrategyEpisodes([episode]);
  assert.equal(read.selection.remainingAtomicAttempts, null);
});

test("strategy episode reader rejects malformed remaining budget values", async () => {
  const data = await fixture();
  for (const bad of [undefined, -1, 1.5, "3", NaN, Infinity]) {
    const episode = structuredClone(data.rows[0]);
    episode.selection.remainingAtomicAttempts = bad;
    assert.throws(
      () => data.samples.readStrategyEpisodes([episode]),
      /remainingAtomicAttempts must be null or a nonnegative safe integer/,
      `expected rejection for ${String(bad)}`,
    );
  }
});
