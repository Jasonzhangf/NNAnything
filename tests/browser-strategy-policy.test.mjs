import assert from "node:assert/strict";
import { test } from "node:test";

const strategyModuleUrl = process.env.NN_BROWSER_STRATEGY_URL
  ?? new URL("../dist/filters/browser-strategy.js", import.meta.url).href;
const strategyContractModuleUrl = process.env.NN_BROWSER_STRATEGY_CONTRACT_URL
  ?? new URL("../dist/adapters/browser/strategy-contract.js", import.meta.url).href;
const atomicPolicyModuleUrl = process.env.NN_BROWSER_STRATEGY_ATOMIC_POLICY_URL
  ?? new URL("../dist/filters/browser-single-action-policy.js", import.meta.url).href;
const feedbackModuleUrl = process.env.NN_BROWSER_STRATEGY_FEEDBACK_URL
  ?? new URL("../dist/filters/browser-feedback.js", import.meta.url).href;
const feedbackContractModuleUrl = process.env.NN_BROWSER_STRATEGY_FEEDBACK_CONTRACT_URL
  ?? new URL("../dist/adapters/browser/feedback-contract.js", import.meta.url).href;

const loadStrategy = () => import(strategyModuleUrl);
const loadContract = () => import(strategyContractModuleUrl);
const loadAtomicPolicy = () => import(atomicPolicyModuleUrl);
const loadFeedback = () => import(feedbackModuleUrl);
const loadFeedbackContract = () => import(feedbackContractModuleUrl);

function observed(value, ref) {
  return { status: "observed", value, evidenceRefs: [ref] };
}

function snapshot({
  documentRef = "document-fixture",
  observationId = "observation-pre",
  revision = 3,
  expanded = false,
  reverse = false,
  rename = false,
} = {}) {
  const prefix = `${observationId}:`;
  const evidence = [];
  const add = (suffix) => {
    const id = `${prefix}${suffix}`;
    evidence.push({ id, observationId, source: "synthetic.strategy_fixture", fact: { suffix } });
    return id;
  };
  const scopeEvidence = add("scope");
  const nativeEvidence = add("native");
  const roleEvidence = add("role");
  const regionEvidence = add("region");
  const nativeRef = rename ? "native-click-target" : "native-target";
  const roleRef = rename ? "role-click-target" : "role-target";
  const regionRef = rename ? "detail-region" : "region-main";
  const element = (ref, parentRef, tag, role, controls, enabled, hit, semantics, point, evidenceRefs) => ({
    ref,
    parentRef,
    tag,
    role,
    basicKind: ref === "scope" || ref === regionRef ? "container" : "button",
    judgmentStatus: "judged",
    candidateStatus: "ok",
    controls,
    enabled,
    hit,
    buttonSemantics: semantics,
    point,
    evidenceRefs,
  });
  const targets = [
    element(
      nativeRef,
      "scope",
      "button",
      null,
      observed([regionRef], nativeEvidence),
      observed(true, nativeEvidence),
      observed(true, nativeEvidence),
      observed(true, nativeEvidence),
      observed({ x: 20, y: 30 }, nativeEvidence),
      [nativeEvidence],
    ),
    element(
      roleRef,
      "scope",
      "div",
      "button",
      observed([regionRef], roleEvidence),
      observed(true, roleEvidence),
      observed(true, roleEvidence),
      observed(true, roleEvidence),
      observed({ x: 40, y: 30 }, roleEvidence),
      [roleEvidence],
    ),
  ];
  if (reverse) targets.reverse();
  const scope = element(
    "scope",
    null,
    "main",
    null,
    observed([], scopeEvidence),
    { status: "unknown", reason: "not applicable" },
    { status: "unknown", reason: "not applicable" },
    observed(false, scopeEvidence),
    { status: "unknown", reason: "not applicable" },
    [scopeEvidence],
  );
  const region = element(
    regionRef,
    "scope",
    "section",
    "region",
    observed([], regionEvidence),
    { status: "unknown", reason: "not applicable" },
    { status: "unknown", reason: "not applicable" },
    observed(false, regionEvidence),
    { status: "unknown", reason: "not applicable" },
    [regionEvidence],
  );
  return {
    documentRef,
    observationId,
    revision,
    scopeRef: "scope",
    regions: [{
      ref: regionRef,
      expanded: observed(expanded, regionEvidence),
      rendered: observed(expanded, regionEvidence),
    }],
    elements: [scope, ...targets, region],
    evidence,
  };
}

function request(options = {}) {
  const state = snapshot(options);
  return {
    goal: { kind: "SetExpanded", regionRef: state.regions[0].ref, desired: true },
    satisfactionThreshold: 100,
    state,
  };
}

function registry(state, { rename = false } = {}) {
  const nativeRef = rename ? "native-click-target" : "native-target";
  const roleRef = rename ? "role-click-target" : "role-target";
  const regionRef = state.regions[0].ref;
  return [
    {
      strategyRef: "strategy-native",
      skillId: "native-click",
      targetRef: nativeRef,
      goalRegionRef: regionRef,
      equivalenceSetRef: "same-expansion-effect",
      documentRef: state.documentRef,
      scopeRef: state.scopeRef,
      operation: "CLICK",
      evidenceRefs: ["fixture-registry-proof"],
    },
    {
      strategyRef: "strategy-role",
      skillId: "role-click",
      targetRef: roleRef,
      goalRegionRef: regionRef,
      equivalenceSetRef: "same-expansion-effect",
      documentRef: state.documentRef,
      scopeRef: state.scopeRef,
      operation: "CLICK",
      evidenceRefs: ["fixture-registry-proof"],
    },
  ];
}

function selection(overrides = {}) {
  return {
    eligibleSkillIds: ["native-click", "role-click"],
    lockedSkillId: null,
    exhaustedSkillIds: [],
    remainingAtomicAttempts: 4,
    ...overrides,
  };
}

async function atomicProfile() {
  const policy = await loadAtomicPolicy();
  const zero = policy.createZeroBrowserSingleActionProfile();
  const relationWeights = zero.relationWeights.map(row => [...row]);
  relationWeights[0][0] = -3;
  relationWeights[0][12] = 6;
  return policy.validateBrowserSingleActionProfile({ ...zero, relationWeights });
}

async function feedbackProfile(kind = "indeterminate") {
  const feedback = await loadFeedback();
  const contract = await loadFeedbackContract();
  const zero = feedback.createZeroFeedbackProfile();
  const weights = zero.weights.map(row => [...row]);
  const wire = name => contract.FEEDBACK_WIRES.indexOf(name);
  if (kind === "execution") {
    weights[1][wire("executionError.present")] = 5;
    weights[2][wire("bias")] = 1;
  } else if (kind === "completed") {
    weights[0][wire("post.currentValid")] = 3;
    weights[0][wire("regionExpanded.known")] = 1;
    weights[0][wire("regionRendered.known")] = 1;
    weights[0][wire("regionExpanded.value")] = -2;
    weights[0][wire("regionRendered.value")] = -1;
    weights[2][wire("bias")] = 1;
  } else {
    weights[2][wire("bias")] = 1;
  }
  return feedback.validateFeedbackProfile({ ...zero, weights });
}

function strategyProfile(strategy, contract, weightsByHead = {}) {
  const zero = strategy.createZeroBrowserStrategyProfile();
  const weights = zero.weights.map(row => [...row]);
  for (const [headName, entries] of Object.entries(weightsByHead)) {
    const row = contract.STRATEGY_HEADS.indexOf(headName);
    for (const [wireName, value] of Object.entries(entries)) {
      weights[row][contract.STRATEGY_WIRES.indexOf(wireName)] = value;
    }
  }
  return strategy.validateBrowserStrategyProfile({ ...zero, weights });
}

function rejectionHistory(state, candidate, observationId = "history-rejected") {
  const historyRequest = {
    ...request({
      documentRef: state.documentRef,
      observationId,
      revision: state.revision - 1,
      expanded: false,
    }),
    goal: { kind: "SetExpanded", regionRef: state.regions[0].ref, desired: true },
  };
  return {
    strategyRef: candidate.strategyRef,
    skillId: candidate.skillId,
    targetRef: candidate.targetRef,
    equivalenceSetRef: candidate.equivalenceSetRef,
    input: {
      request: historyRequest,
      result: {
        prediction: null,
        invocation: null,
        receipt: {
          dispatched: false,
          ok: false,
          effectKnowledge: "none",
          source: "synthetic.fixture",
          error: { code: "native_input_rejected", message: "fixture rejection" },
        },
        dispatchState: "not_dispatched",
        effectKnowledge: "none",
        newState: null,
        satisfaction: null,
        achieved: false,
        error: null,
        collectionError: null,
      },
      controlAtCompletion: null,
    },
  };
}

function safeFailureHistory(state, candidate) {
  const pre = request({
    documentRef: state.documentRef,
    observationId: "history-pre",
    revision: state.revision - 2,
    expanded: false,
  });
  const postState = snapshot({
    documentRef: state.documentRef,
    observationId: "history-post",
    revision: state.revision - 1,
    expanded: false,
  });
  return {
    strategyRef: candidate.strategyRef,
    skillId: candidate.skillId,
    targetRef: candidate.targetRef,
    equivalenceSetRef: candidate.equivalenceSetRef,
    input: {
      request: pre,
      result: {
        prediction: null,
        invocation: {
          kind: "click",
          targetRef: candidate.targetRef,
          point: { x: 20, y: 30 },
          documentRef: pre.state.documentRef,
          observationId: pre.state.observationId,
          revision: pre.state.revision,
        },
        receipt: {
          dispatched: true,
          ok: true,
          effectKnowledge: "known",
          source: "synthetic.fixture",
          error: null,
        },
        dispatchState: "dispatched",
        effectKnowledge: "known",
        newState: postState,
        satisfaction: 0,
        achieved: false,
        error: null,
        collectionError: null,
      },
      controlAtCompletion: {
        documentRef: postState.documentRef,
        observationId: postState.observationId,
        revision: postState.revision,
      },
    },
  };
}

function verifiedSuccessHistory(state, candidate) {
  const pre = request({
    documentRef: state.documentRef,
    observationId: "history-success-pre",
    revision: state.revision - 2,
    expanded: false,
  });
  const postState = snapshot({
    documentRef: state.documentRef,
    observationId: "history-success-post",
    revision: state.revision - 1,
    expanded: true,
  });
  return {
    strategyRef: candidate.strategyRef,
    skillId: candidate.skillId,
    targetRef: candidate.targetRef,
    equivalenceSetRef: candidate.equivalenceSetRef,
    input: {
      request: pre,
      result: {
        prediction: null,
        invocation: {
          kind: "click",
          targetRef: candidate.targetRef,
          point: { x: 20, y: 30 },
          documentRef: pre.state.documentRef,
          observationId: pre.state.observationId,
          revision: pre.state.revision,
        },
        receipt: {
          dispatched: true,
          ok: true,
          effectKnowledge: "known",
          source: "synthetic.fixture",
          error: null,
        },
        dispatchState: "dispatched",
        effectKnowledge: "known",
        newState: postState,
        satisfaction: 100,
        achieved: true,
        error: null,
        collectionError: null,
      },
      controlAtCompletion: {
        documentRef: postState.documentRef,
        observationId: postState.observationId,
        revision: postState.revision,
      },
    },
  };
}

async function fixture() {
  const current = request();
  return {
    strategy: await loadStrategy(),
    contract: await loadContract(),
    current,
    registry: registry(current.state),
    atomicProfile: await atomicProfile(),
    feedbackProfile: await feedbackProfile("execution"),
  };
}

test("strategy profile is exactly 20 finite parameters and zero stays uncalibrated", async () => {
  const strategy = await loadStrategy();
  const contract = await loadContract();
  const zero = strategy.createZeroBrowserStrategyProfile();
  assert.deepEqual(zero.heads, contract.STRATEGY_HEADS);
  assert.deepEqual(zero.wires, contract.STRATEGY_WIRES);
  assert.equal(zero.weights.length, 2);
  assert.ok(zero.weights.every(row => row.length === 10));
  assert.equal(zero.weights.flat().length, 20);
  assert.equal(zero.calibration, "uncalibrated");
  assert.equal(zero.adoption, "not_applied");
  assert.throws(() => strategy.validateBrowserStrategyProfile({
    ...zero,
    weights: zero.weights.map(row => row.slice(1)),
  }), TypeError);
  assert.throws(() => strategy.validateBrowserStrategyProfile({
    ...zero,
    wires: [...zero.wires].reverse(),
  }), TypeError);
});

test("zero strategy DEFER preserves every eligible candidate feature and feedback result", async () => {
  const { strategy, current, registry: strategies, atomicProfile: atomic, feedbackProfile: feedback } = await fixture();
  const input = strategy.readBrowserStrategyRequest({ request: current, history: [] });
  const zero = strategy.createZeroBrowserStrategyProfile();
  const prediction = strategy.predictBrowserStrategy(input, {
    profile: zero,
    atomicProfile: atomic,
    feedbackProfile: feedback,
    registry: strategies,
    selection: selection(),
  });
  assert.equal(prediction.kind, "DEFER");
  assert.equal(prediction.candidates.length, 2);
  assert.ok(prediction.candidates.every(candidate => candidate.features.length === 10));
  assert.ok(prediction.candidates.every(candidate => candidate.logits.every(value => value === 0)));
  assert.ok(prediction.candidates.every(candidate => candidate.margin === 0));
  assert.equal(prediction.candidates.find(candidate => candidate.skillId === "native-click").features[1], 1);
  assert.equal(prediction.candidates.find(candidate => candidate.skillId === "native-click").features[2], 0);
  assert.equal(prediction.candidates.find(candidate => candidate.skillId === "role-click").features[1], 0);
  assert.equal(prediction.candidates.find(candidate => candidate.skillId === "role-click").features[2], 1);
  const relationMargin = prediction.candidates[0].features[3];
  assert.ok(relationMargin > 0.5 && relationMargin < 1);
});

test("unique highest positive margin selects and registry order cannot break ties", async () => {
  const { strategy, contract, current, registry: strategies, atomicProfile: atomic, feedbackProfile: feedback } = await fixture();
  const profile = strategyProfile(strategy, contract, { choose: { nativeButton: 2 } });
  const input = strategy.readBrowserStrategyRequest({ request: current, history: [] });
  const first = strategy.predictBrowserStrategy(input, {
    profile, atomicProfile: atomic, feedbackProfile: feedback, registry: strategies, selection: selection(),
  });
  assert.equal(first.kind, "SELECT");
  assert.equal(first.skillId, "native-click");
  const reversed = strategy.predictBrowserStrategy(input, {
    profile, atomicProfile: atomic, feedbackProfile: feedback,
    registry: [...strategies].reverse(), selection: selection(),
  });
  assert.equal(reversed.kind, "SELECT");
  assert.equal(reversed.skillId, "native-click");
  const tied = strategyProfile(strategy, contract, { choose: { nativeButton: 2, explicitRoleButton: 2 } });
  const tiePrediction = strategy.predictBrowserStrategy(input, {
    profile: tied, atomicProfile: atomic, feedbackProfile: feedback, registry: strategies, selection: selection(),
  });
  assert.equal(tiePrediction.kind, "DEFER");
  assert.match(tiePrediction.reason, /tie/);
});

test("candidate history is matched exactly and never broadcast from native to role", async () => {
  const { strategy, contract, current, registry: strategies, atomicProfile: atomic, feedbackProfile: feedback } = await fixture();
  const native = strategies[0];
  const profile = strategyProfile(strategy, contract, {
    choose: { nativeButton: 1, explicitRoleButton: 1 },
    defer: { nativeButton: 2 },
  });
  const input = strategy.readBrowserStrategyRequest({
    request: current,
    history: [rejectionHistory(current.state, native)],
  });
  const prediction = strategy.predictBrowserStrategy(input, {
    profile, atomicProfile: atomic, feedbackProfile: feedback, registry: strategies, selection: selection(),
  });
  const nativeRow = prediction.candidates.find(candidate => candidate.skillId === native.skillId);
  const roleRow = prediction.candidates.find(candidate => candidate.skillId === "role-click");
  assert.deepEqual(nativeRow.features.slice(4), [1, 0, 1, 0, 1, 0]);
  assert.deepEqual(roleRow.features.slice(4), [0, 0, 0, 0, 0, 0]);
  assert.equal(prediction.kind, "SELECT");
  assert.equal(prediction.skillId, "role-click");
});

test("unknown feedback is indeterminate and candidate-specific verified success requires real F1 evidence", async () => {
  const { strategy, current, registry: strategies, atomicProfile: atomic } = await fixture();
  const native = strategies[0];
  const zero = strategy.createZeroBrowserStrategyProfile();
  const unknownPrediction = strategy.predictBrowserStrategy(
    strategy.readBrowserStrategyRequest({ request: current, history: [rejectionHistory(current.state, native)] }),
    {
      profile: zero, atomicProfile: atomic, feedbackProfile: await feedbackProfile("indeterminate"),
      registry: strategies, selection: selection(),
    },
  );
  const unknownFeatures = unknownPrediction.candidates.find(candidate => candidate.skillId === native.skillId).features;
  assert.equal(unknownFeatures[7], 1);
  assert.equal(unknownFeatures[8], 1);
  assert.equal(unknownFeatures[9], 0);

  const completedPrediction = strategy.predictBrowserStrategy(
    strategy.readBrowserStrategyRequest({
      request: current,
      history: [safeFailureHistory(current.state, native)],
    }),
    {
      profile: zero, atomicProfile: atomic, feedbackProfile: await feedbackProfile("completed"),
      registry: strategies, selection: selection(),
    },
  );
  const completedFeatures = completedPrediction.candidates.find(candidate => candidate.skillId === native.skillId).features;
  assert.deepEqual(completedFeatures.slice(4), [1, 1, 0, 0, 1, 0]);

  const successPrediction = strategy.predictBrowserStrategy(
    strategy.readBrowserStrategyRequest({
      request: current,
      history: [verifiedSuccessHistory(current.state, native)],
    }),
    {
      profile: zero, atomicProfile: atomic, feedbackProfile: await feedbackProfile("completed"),
      registry: strategies, selection: selection(),
    },
  );
  const successFeatures = successPrediction.candidates.find(candidate => candidate.skillId === native.skillId).features;
  assert.deepEqual(successFeatures.slice(4), [1, 0, 0, 0, 1, 1]);
});

test("ambiguous duplicate histories are rejected instead of silently using the first", async () => {
  const { strategy, current, registry: strategies, atomicProfile: atomic, feedbackProfile: feedback } = await fixture();
  const native = strategies[0];
  const input = strategy.readBrowserStrategyRequest({
    request: current,
    history: [
      rejectionHistory(current.state, native, "history-duplicate"),
      rejectionHistory(current.state, native, "history-duplicate"),
    ],
  });
  assert.throws(() => strategy.predictBrowserStrategy(input, {
    profile: strategy.createZeroBrowserStrategyProfile(),
    atomicProfile: atomic,
    feedbackProfile: feedback,
    registry: strategies,
    selection: selection(),
  }), /ambiguous strategy history/i);
});

test("invalid target facts, exhausted candidates, and contradictory selection cannot reach execution", async () => {
  const { strategy, current, registry: strategies, atomicProfile: atomic, feedbackProfile: feedback } = await fixture();
  const input = strategy.readBrowserStrategyRequest({ request: current, history: [] });
  const zero = strategy.createZeroBrowserStrategyProfile();
  const exhausted = strategy.predictBrowserStrategy(input, {
    profile: zero, atomicProfile: atomic, feedbackProfile: feedback, registry: strategies,
    selection: selection({ exhaustedSkillIds: ["native-click"], eligibleSkillIds: ["role-click"] }),
  });
  assert.equal(exhausted.kind, "DEFER");
  assert.deepEqual(exhausted.candidates.map(candidate => candidate.skillId), ["role-click"]);

  const noBudget = strategy.predictBrowserStrategy(input, {
    profile: zero, atomicProfile: atomic, feedbackProfile: feedback, registry: strategies,
    selection: selection({ remainingAtomicAttempts: 0 }),
  });
  assert.equal(noBudget.kind, "DEFER");
  assert.equal(noBudget.candidates.length, 2);
  assert.match(noBudget.reason, /budget/);

  const lockConflict = strategy.predictBrowserStrategy(input, {
    profile: zero, atomicProfile: atomic, feedbackProfile: feedback, registry: strategies,
    selection: selection({ lockedSkillId: "native-click" }),
  });
  assert.equal(lockConflict.kind, "DEFER");
  assert.match(lockConflict.reason, /selection/);

  const missing = structuredClone(current);
  missing.state.elements.find(element => element.ref === "native-target").controls = {
    status: "unknown",
    reason: "fixture controls missing",
  };
  const missingPrediction = strategy.predictBrowserStrategy(
    strategy.readBrowserStrategyRequest({ request: missing, history: [] }),
    {
      profile: zero, atomicProfile: atomic, feedbackProfile: feedback, registry: strategies,
      selection: selection({ eligibleSkillIds: ["native-click"] }),
    },
  );
  assert.equal(missingPrediction.kind, "DEFER");
  assert.equal(missingPrediction.candidates.length, 0);
  assert.match(missingPrediction.reason, /controls/);
});
