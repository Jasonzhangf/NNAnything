import assert from "node:assert/strict";
import { test } from "node:test";

import * as atomicPolicy from "../dist/filters/browser-single-action-policy.js";
import * as feedbackPolicy from "../dist/filters/browser-feedback.js";
import * as strategyPolicy from "../dist/filters/browser-strategy.js";
import * as strategyStep from "../dist/nodes/browser-strategy.js";
import * as strategyGoal from "../dist/adapters/browser/strategy-recursive.js";

const REQUEST_SCHEMA = "nnanything.recursive-goal.request.v1";
const ROOT_GOAL = Object.freeze({
  kind: "SetExpanded",
  regionRef: "region-main",
  desired: true,
});
const ROOT_BINDINGS = Object.freeze({
  documentRef: "document-fixture",
  scopeRef: "scope",
  goalRegionRef: "region-main",
  equivalenceSetRef: "same-expansion-effect",
});
const NATIVE_SKILL = "browser.expand.native";
const ROLE_SKILL = "browser.expand.role";

function observed(value, evidenceRef) {
  return { status: "observed", value, evidenceRefs: [evidenceRef] };
}

function snapshot({
  observationId,
  revision,
  expanded = false,
  enabled = true,
  hit = true,
} = {}) {
  const evidence = [];
  const add = suffix => {
    const id = `${observationId}:${suffix}`;
    evidence.push({
      id,
      observationId,
      source: "synthetic.browser_strategy_fixture",
      fact: { suffix, expanded },
    });
    return id;
  };
  const scopeEvidence = add("scope");
  const nativeEvidence = add("native");
  const roleEvidence = add("role");
  const regionEvidence = add("region");
  const element = ({
    ref,
    parentRef = "scope",
    tag = "div",
    role = null,
    controls = [],
    enabledFact,
    hitFact,
    semantics,
    point,
    evidenceRefs,
    basicKind = "button",
  }) => ({
    ref,
    parentRef,
    tag,
    role,
    basicKind,
    judgmentStatus: "judged",
    candidateStatus: "ok",
    controls,
    enabled: enabledFact,
    hit: hitFact,
    buttonSemantics: semantics,
    point,
    evidenceRefs,
  });
  return {
    documentRef: "document-fixture",
    observationId,
    revision,
    scopeRef: "scope",
    regions: [{
      ref: "region-main",
      expanded: observed(expanded, regionEvidence),
      rendered: observed(expanded, regionEvidence),
    }],
    elements: [
      element({
        ref: "scope",
        parentRef: null,
        tag: "main",
        controls: observed([], scopeEvidence),
        enabledFact: { status: "unknown", reason: "not_applicable" },
        hitFact: { status: "unknown", reason: "not_applicable" },
        semantics: observed(false, scopeEvidence),
        point: { status: "unknown", reason: "not_applicable" },
        evidenceRefs: [scopeEvidence],
        basicKind: "container",
      }),
      element({
        ref: "native-target",
        tag: "button",
        controls: observed(["region-main"], nativeEvidence),
        enabledFact: observed(enabled, nativeEvidence),
        hitFact: observed(hit, nativeEvidence),
        semantics: observed(true, nativeEvidence),
        point: observed({ x: 20, y: 30 }, nativeEvidence),
        evidenceRefs: [nativeEvidence],
      }),
      element({
        ref: "role-target",
        role: "button",
        controls: observed(["region-main"], roleEvidence),
        enabledFact: observed(enabled, roleEvidence),
        hitFact: observed(hit, roleEvidence),
        semantics: observed(true, roleEvidence),
        point: observed({ x: 40, y: 30 }, roleEvidence),
        evidenceRefs: [roleEvidence],
      }),
      element({
        ref: "region-main",
        tag: "section",
        role: "region",
        controls: observed([], regionEvidence),
        enabledFact: { status: "unknown", reason: "not_applicable" },
        hitFact: { status: "unknown", reason: "not_applicable" },
        semantics: observed(false, regionEvidence),
        point: { status: "unknown", reason: "not_applicable" },
        evidenceRefs: [regionEvidence],
        basicKind: "container",
      }),
    ],
    evidence,
  };
}

function currentRequest(state) {
  return {
    goal: ROOT_GOAL,
    satisfactionThreshold: 100,
    state,
  };
}

function registry() {
  return [
    {
      strategyRef: "strategy-native",
      skillId: NATIVE_SKILL,
      targetRef: "native-target",
      goalRegionRef: "region-main",
      equivalenceSetRef: "same-expansion-effect",
      documentRef: "document-fixture",
      scopeRef: "scope",
      operation: "CLICK",
      evidenceRefs: ["proof:equivalence:native"],
    },
    {
      strategyRef: "strategy-role",
      skillId: ROLE_SKILL,
      targetRef: "role-target",
      goalRegionRef: "region-main",
      equivalenceSetRef: "same-expansion-effect",
      documentRef: "document-fixture",
      scopeRef: "scope",
      operation: "CLICK",
      evidenceRefs: ["proof:equivalence:role"],
    },
  ];
}

function selection(overrides = {}) {
  return {
    eligibleSkillIds: [NATIVE_SKILL, ROLE_SKILL],
    lockedSkillId: null,
    exhaustedSkillIds: [],
    remainingAtomicAttempts: 4,
    ...overrides,
  };
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

function feedbackProfile() {
  const zero = feedbackPolicy.createZeroFeedbackProfile();
  const weights = zero.weights.map(row => [...row]);
  const wire = name => zero.wires.indexOf(name);
  weights[0][wire("post.currentValid")] = 3;
  weights[0][wire("regionExpanded.known")] = 1;
  weights[0][wire("regionRendered.known")] = 1;
  weights[0][wire("regionExpanded.value")] = -2;
  weights[0][wire("regionRendered.value")] = -1;
  weights[2][wire("bias")] = 1;
  return feedbackPolicy.validateFeedbackProfile({ ...zero, weights });
}

function strategyProfile() {
  const zero = strategyPolicy.createZeroBrowserStrategyProfile();
  const weights = zero.weights.map(row => [...row]);
  const choose = zero.heads.indexOf("choose");
  const wire = name => zero.wires.indexOf(name);
  weights[choose][wire("nativeButton")] = 4;
  weights[choose][wire("explicitRoleButton")] = 1;
  weights[choose][wire("feedback.completedWithoutGoal")] = -1;
  return strategyPolicy.validateBrowserStrategyProfile({ ...zero, weights });
}

function controlOf(state) {
  return {
    documentRef: state.documentRef,
    observationId: state.observationId,
    revision: state.revision,
  };
}

function initialObservation(stateId, state, goalRegionRef) {
  return strategyGoal.createBrowserStrategyInitialObservation(
    stateId,
    state,
    goalRegionRef,
  );
}

function stepResources({
  observations,
  selectedSkillId = NATIVE_SKILL,
  selected = selection(),
  clicks = [],
  atomicCollected = [],
  stepCollected = [],
} = {}) {
  const queue = [...observations];
  let current = controlOf(queue[0]);
  return {
    profile: strategyProfile(),
    atomicProfile: atomicProfile(),
    feedbackProfile: feedbackProfile(),
    registry: registry(),
    grantedEffects: new Set(["browser.nativeClick", "filesystem.write"]),
    selection: selected,
    selectedSkillId,
    async observe() {
      const next = queue.shift();
      if (next === undefined) throw new Error("strategy fixture observation queue exhausted");
      current = controlOf(next);
      return next;
    },
    currentControl: () => current,
    async nativeClick(invocation) {
      clicks.push(invocation);
      return {
        dispatched: true,
        ok: true,
        effectKnowledge: "known",
        source: "synthetic.browser_strategy_fixture",
        error: null,
      };
    },
    async collectAtomic(result) {
      atomicCollected.push(result);
    },
    async collectStep(result) {
      stepCollected.push(result);
    },
    proveNoEffect(input) {
      const targetRef = input.result.invocation?.targetRef;
      const post = input.result.newState;
      if (targetRef === undefined || post === null) return null;
      return {
        kind: "controlled_fixture_no_effect",
        targetRef,
        documentRef: input.request.state.documentRef,
        beforeObservationId: input.request.state.observationId,
        afterObservationId: post.observationId,
        evidenceRefs: [
          ...input.request.state.evidence.map(item => item.id),
          ...post.evidence.map(item => item.id),
        ],
      };
    },
    clicks,
    atomicCollected,
    stepCollected,
  };
}

function goalResources({
  initial,
  observations,
  proveNoEffect,
}) {
  const queue = [...observations];
  const clicks = [];
  let current = controlOf(initial);
  const resources = {
    profile: strategyProfile(),
    atomicProfile: atomicProfile(),
    feedbackProfile: feedbackProfile(),
    registry: registry(),
    grantedEffects: new Set(["browser.nativeClick", "filesystem.write"]),
    observe: async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error("root fixture observation queue exhausted");
      current = controlOf(next);
      return next;
    },
    currentControl: () => current,
    nativeClick: async invocation => {
      clicks.push(invocation);
      return {
        dispatched: true,
        ok: true,
        effectKnowledge: "known",
        source: "synthetic.browser_strategy_fixture",
        error: null,
      };
    },
    collectAtomic: async () => {},
    collectStep: async () => {},
    proveNoEffect: proveNoEffect ?? (input => {
      const post = input.result.newState;
      if (post === null) return null;
      return {
        kind: "controlled_fixture_no_effect",
        targetRef: input.result.invocation.targetRef,
        documentRef: input.request.state.documentRef,
        beforeObservationId: input.request.state.observationId,
        afterObservationId: post.observationId,
        evidenceRefs: [
          ...input.request.state.evidence.map(item => item.id),
          ...post.evidence.map(item => item.id),
        ],
      };
    }),
    collectRoot: async () => ({ receiptId: "root-collection" }),
  };
  return { resources, clicks };
}

function goalRequest(options) {
  const {
    requestId,
    initial,
    continuation,
    sameFailureLimit = 2,
  } = options;
  // A caller that does not declare a total ceiling omits the property; passing
  // an explicit undefined must also omit it instead of emitting undefined.
  const maxAtomicAttempts = Object.hasOwn(options, "maxAtomicAttempts")
    ? options.maxAtomicAttempts
    : 4;
  return {
    schema: REQUEST_SCHEMA,
    requestId,
    rootGoal: ROOT_GOAL,
    satisfactionThreshold: 100,
    rootBindings: ROOT_BINDINGS,
    state: continuation?.value ?? { browser: initial, history: [] },
    rootEvaluatorId: strategyGoal.BROWSER_STRATEGY_EVALUATOR_ID,
    rootSelectorId: strategyGoal.BROWSER_STRATEGY_SELECTOR_ID,
    limits: { maxTransitions: 32, maxDepth: 4, maxDerivedGoals: 4 },
    ...(continuation === undefined
      ? {
          initialObservation: initialObservation(
            `${requestId}:initial`,
            { browser: initial, history: [] },
          ),
        }
      : { continuation: continuation.source }),
    retryPolicy: {
      kind: "bounded_strategy_retry.v1",
      selectorId: strategyGoal.BROWSER_STRATEGY_SELECTOR_ID,
      strategySkillIds: [NATIVE_SKILL, ROLE_SKILL],
      sameFailureLimit,
      ...(maxAtomicAttempts === undefined ? {} : { maxAtomicAttempts }),
    },
    invocation: { maxAtomicDispatches: 1 },
  };
}

test("mock 5-node step uses one explicit selected atomic input and keeps real feedback sources", async () => {
  const preflight = snapshot({ observationId: "step-preflight", revision: 1 });
  const pre = snapshot({ observationId: "step-pre", revision: 2 });
  const post = snapshot({ observationId: "step-post", revision: 3 });
  const clicks = [];
  const atomicCollected = [];
  const stepCollected = [];
  const resources = stepResources({
    observations: [preflight, pre, post],
    clicks,
    atomicCollected,
    stepCollected,
  });

  const result = await strategyStep.runBrowserStrategyStep(
    strategyPolicy.readBrowserStrategyRequest({
      request: currentRequest(preflight),
      history: [],
    }),
    resources,
  );

  assert.equal(result.error, null);
  assert.equal(result.decision.kind, "SELECT");
  assert.equal(result.decision.skillId, NATIVE_SKILL);
  assert.equal(result.atomic.prediction.capability, "CLICK");
  assert.equal(result.atomic.invocation.targetRef, "native-target");
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].targetRef, "native-target");
  assert.equal(result.feedbackInput.request.state.observationId, "step-pre");
  assert.equal(result.feedbackInput.result.newState.observationId, "step-post");
  assert.equal(result.feedbackInput.controlAtCompletion.observationId, "step-post");
  assert.equal(result.feedback.status, "predicted");
  assert.equal(result.feedback.head, "completed_without_goal");
  assert.equal(result.effectProof.kind, "controlled_fixture_no_effect");
  assert.equal(result.effectProof.beforeObservationId, "step-pre");
  assert.equal(result.effectProof.afterObservationId, "step-post");
  assert.equal(atomicCollected.length, 1);
  assert.equal(stepCollected.length, 1);
});

test("mock bounded goal A->A->B uses the two core skill ids and one input per run", async () => {
  const initial = snapshot({ observationId: "root-initial", revision: 1 });
  const { resources, clicks } = goalResources({
    initial,
    observations: [
      snapshot({ observationId: "run1-preflight", revision: 2 }),
      snapshot({ observationId: "run1-pre", revision: 3 }),
      snapshot({ observationId: "run1-post", revision: 4 }),
      snapshot({ observationId: "run2-preflight", revision: 5 }),
      snapshot({ observationId: "run2-pre", revision: 6 }),
      snapshot({ observationId: "run2-post", revision: 7 }),
      snapshot({ observationId: "run3-preflight", revision: 8 }),
      snapshot({ observationId: "run3-pre", revision: 9 }),
      snapshot({ observationId: "run3-post", revision: 10, expanded: true }),
    ],
  });
  const request = continuation => goalRequest({
    requestId: "browser-strategy-aab",
    initial,
    continuation,
  });

  const first = await strategyGoal.runBrowserStrategyGoal(request(), resources);
  assert.equal(
    first.kind,
    "run_result",
    first.kind === "request_rejected"
      ? JSON.stringify(first.error)
      : "browser strategy goal did not return run_result",
  );
  assert.equal(
    first.report.control.outcome,
    "yielded",
    JSON.stringify(first.report.errors),
  );
  assert.equal(first.report.atomicResults.length, 1);
  const firstState = first.report.states.at(-1).value;
  assert.equal(firstState.history.length, 1);
  assert.equal(firstState.history[0].skillId, NATIVE_SKILL);

  const secondRequest = request({
    value: firstState,
    source: first.report.continuation,
  });
  const second = await strategyGoal.runBrowserStrategyGoal(secondRequest, resources);
  assert.equal(
    second.kind,
    "run_result",
    second.kind === "request_rejected"
      ? JSON.stringify(second.error)
      : "browser strategy continuation did not return run_result",
  );
  assert.equal(second.report.control.outcome, "yielded");
  const secondState = second.report.states.at(-1).value;
  assert.deepEqual(
    secondState.history.map(item => item.skillId),
    [NATIVE_SKILL, NATIVE_SKILL],
  );

  const third = await strategyGoal.runBrowserStrategyGoal(request({
    value: secondState,
    source: second.report.continuation,
  }), resources);
  assert.equal(
    third.kind,
    "run_result",
    third.kind === "request_rejected"
      ? JSON.stringify(third.error)
      : "browser strategy continuation did not return run_result",
  );
  assert.equal(third.report.control.outcome, "completed");
  assert.equal(third.report.continuation, null);
  assert.deepEqual(clicks.map(item => item.targetRef), [
    "native-target",
    "native-target",
    "role-target",
  ]);
  assert.equal(third.report.rootEvaluation.result, "satisfied");
});

test("mock sameFacts ignores observation identity but keeps actual region facts", () => {
  const left = snapshot({ observationId: "facts-left", revision: 1 });
  const right = snapshot({ observationId: "facts-right", revision: 9 });
  const expanded = snapshot({
    observationId: "facts-expanded",
    revision: 10,
    expanded: true,
  });
  const leftState = { browser: left, history: [] };
  const rightState = { browser: right, history: [] };
  const expandedState = { browser: expanded, history: [] };

  assert.equal(strategyGoal.browserStrategyComparators.sameFacts(
    {
      state: leftState,
      evidence: initialObservation("facts-left-state", leftState).evidence,
      conditions: [],
    },
    {
      state: rightState,
      evidence: initialObservation("facts-right-state", rightState).evidence,
      conditions: [],
    },
  ), true);
  assert.equal(strategyGoal.browserStrategyComparators.sameFacts(
    {
      state: leftState,
      evidence: initialObservation("facts-left-state", leftState).evidence,
      conditions: [],
    },
    {
      state: expandedState,
      evidence: initialObservation("facts-expanded-state", expandedState).evidence,
      conditions: [],
    },
  ), false);
});

test("mock root already satisfied archives without input", async () => {
  const initial = snapshot({
    observationId: "already-expanded",
    revision: 1,
    expanded: true,
  });
  const { resources, clicks } = goalResources({ initial, observations: [] });
  const result = await strategyGoal.runBrowserStrategyGoal(
    goalRequest({ requestId: "browser-strategy-already", initial }),
    resources,
  );

  assert.equal(result.kind, "run_result");
  assert.equal(result.report.control.outcome, "completed");
  assert.equal(result.report.rootEvaluation.result, "satisfied");
  assert.equal(result.report.atomicResults.length, 0);
  assert.equal(clicks.length, 0);
});

test("mock known native effect is retained but cannot authorize retry", async () => {
  const initial = snapshot({ observationId: "unknown-initial", revision: 1 });
  const { resources, clicks } = goalResources({
    initial,
    observations: [
      snapshot({ observationId: "unknown-preflight", revision: 2 }),
      snapshot({ observationId: "unknown-pre", revision: 3 }),
      snapshot({ observationId: "unknown-post", revision: 4 }),
    ],
    proveNoEffect: () => null,
  });
  const result = await strategyGoal.runBrowserStrategyGoal(
    goalRequest({ requestId: "browser-strategy-unknown", initial }),
    resources,
  );

  assert.equal(result.kind, "run_result");
  assert.notEqual(result.report.control.outcome, "yielded");
  assert.equal(result.report.atomicResults.length, 1);
  assert.equal(result.report.atomicResults[0].effect.knowledge, "known");
  assert.equal(result.report.effects[0].knowledge, "known");
  assert.equal(clicks.length, 1);
});

test("mock zero-margin selection defers without a fallback native input", async () => {
  const preflight = snapshot({ observationId: "defer-preflight", revision: 1 });
  const resources = stepResources({
    observations: [preflight],
    selectedSkillId: ROLE_SKILL,
  });
  resources.profile = strategyPolicy.createZeroBrowserStrategyProfile();

  const result = await strategyStep.runBrowserStrategyStep(
    strategyPolicy.readBrowserStrategyRequest({
      request: currentRequest(preflight),
      history: [],
    }),
    resources,
  );

  assert.equal(result.atomic, null);
  assert.equal(result.error.code, "policy_deferred");
  assert.equal(resources.clicks.length, 0);
  assert.equal(resources.atomicCollected.length, 0);
  assert.equal(resources.stepCollected.length, 1);
});

test("mock fresh observation change reaches the atomic DEFER stage with no input", async () => {
  const preflight = snapshot({ observationId: "changed-preflight", revision: 1 });
  const changed = snapshot({
    observationId: "changed-pre",
    revision: 2,
    enabled: false,
  });
  const resources = stepResources({ observations: [preflight, changed] });

  const result = await strategyStep.runBrowserStrategyStep(
    strategyPolicy.readBrowserStrategyRequest({
      request: currentRequest(preflight),
      history: [],
    }),
    resources,
  );

  assert.equal(result.atomic.dispatchState, "not_dispatched");
  assert.ok(result.atomic.error);
  assert.equal(resources.clicks.length, 0);
  assert.equal(resources.atomicCollected.length, 1);
});

test("mock root preserves a nested atomic DEFER diagnostic without fallback input", async () => {
  const initial = snapshot({ observationId: "nested-initial", revision: 1 });
  const { resources, clicks } = goalResources({
    initial,
    observations: [
      snapshot({ observationId: "nested-preflight", revision: 2 }),
      snapshot({
        observationId: "nested-pre",
        revision: 3,
        enabled: false,
      }),
    ],
  });

  const result = await strategyGoal.runBrowserStrategyGoal(
    goalRequest({ requestId: "browser-strategy-nested-defer", initial }),
    resources,
  );

  assert.equal(result.kind, "run_result");
  assert.notEqual(result.report.control.outcome, "yielded");
  assert.equal(result.report.atomicResults.length, 1);
  assert.equal(
    result.report.errors.some(error => error.code === "precondition_unsatisfied"),
    true,
    JSON.stringify(result.report.errors),
  );
  assert.equal(clicks.length, 0);
});

test("zero-dispatch stale control never promotes the old observation to a current root fact", async () => {
  const initial = snapshot({ observationId: "stale-root-initial", revision: 1 });
  const { resources, clicks } = goalResources({
    initial,
    observations: [
      snapshot({ observationId: "stale-root-preflight", revision: 2 }),
      snapshot({ observationId: "stale-root-pre", revision: 3 }),
    ],
  });
  const live = resources.currentControl;
  let calls = 0;
  resources.currentControl = () => {
    calls += 1;
    const control = live();
    // The page moves on between the observation and the dispatch attempt.
    return calls >= 2 ? { ...control, revision: control.revision + 7 } : control;
  };

  const result = await strategyGoal.runBrowserStrategyGoal(
    goalRequest({ requestId: "browser-strategy-stale-root", initial }),
    resources,
  );

  assert.equal(result.kind, "run_result");
  assert.equal(clicks.length, 0);
  assert.notEqual(result.report.rootResult, "satisfied");
  assert.equal(
    result.report.errors.some(error => error.code === "invalid_binding"),
    true,
    JSON.stringify(result.report.errors),
  );
  assert.equal(
    result.report.atomicResults.length,
    1,
    JSON.stringify(result.report.atomicResults),
  );
  assert.equal(result.report.atomicResults[0].observedStateRef, null);
  assert.equal(result.report.atomicResults[0].effect.knowledge, "none");
});

test("mock core selection mismatch fails before the atomic workflow", async () => {
  const preflight = snapshot({ observationId: "mismatch-preflight", revision: 1 });
  const resources = stepResources({
    observations: [preflight],
    selectedSkillId: ROLE_SKILL,
  });

  const result = await strategyStep.runBrowserStrategyStep(
    strategyPolicy.readBrowserStrategyRequest({
      request: currentRequest(preflight),
      history: [],
    }),
    resources,
  );

  assert.equal(result.error.code, "policy_error");
  assert.equal(result.atomic, null);
  assert.equal(resources.clicks.length, 0);
});

test("mock step collection failure preserves atomic, feedback, and effect proof", async () => {
  const preflight = snapshot({ observationId: "collect-preflight", revision: 1 });
  const pre = snapshot({ observationId: "collect-pre", revision: 2 });
  const post = snapshot({ observationId: "collect-post", revision: 3 });
  const resources = stepResources({ observations: [preflight, pre, post] });
  resources.collectStep = async () => {
    throw new Error("synthetic collection failure");
  };

  const result = await strategyStep.runBrowserStrategyStep(
    strategyPolicy.readBrowserStrategyRequest({
      request: currentRequest(preflight),
      history: [],
    }),
    resources,
  );

  assert.equal(result.collectionError, "synthetic collection failure");
  assert.equal(result.atomic.invocation.targetRef, "native-target");
  assert.equal(result.feedbackInput.request.state.observationId, "collect-pre");
  assert.equal(result.effectProof.afterObservationId, "collect-post");
});

test("initial observation requires an explicit region when the snapshot has multiple regions", () => {
  const browser = snapshot({ observationId: "multi-region", revision: 1 });
  const state = {
    browser: {
      ...browser,
      regions: [
        ...browser.regions,
        { ...browser.regions[0], ref: "region-other" },
      ],
      elements: [
        ...browser.elements,
        {
          ...browser.elements.find(element => element.ref === "region-main"),
          ref: "region-other",
        },
      ],
    },
    history: [],
  };

  assert.throws(
    () => initialObservation("multi-region-state", state),
    /goalRegionRef is required/,
  );
  const observation = initialObservation(
    "multi-region-state",
    state,
    "region-main",
  );
  assert.equal(observation.stateId, "multi-region-state");
});

test("root request rejects initial evidence that differs from the observed snapshot", async () => {
  const initial = snapshot({ observationId: "tampered-initial", revision: 1 });
  const { resources } = goalResources({ initial, observations: [] });
  const request = goalRequest({
    requestId: "browser-strategy-tampered-evidence",
    initial,
  });
  request.initialObservation = {
    ...request.initialObservation,
    evidence: request.initialObservation.evidence.map((item, index) =>
      index === 0
        ? {
            ...item,
            payload: {
              ...item.payload,
              fact: { suffix: "forged", expanded: true },
            },
          }
        : item),
  };

  const result = await strategyGoal.runBrowserStrategyGoal(request, resources);
  assert.equal(result.kind, "request_rejected");
});

test("root request rejects duplicated initial evidence that omits a snapshot fact", async () => {
  const initial = snapshot({ observationId: "duplicated-initial", revision: 1 });
  const { resources } = goalResources({ initial, observations: [] });
  const request = goalRequest({
    requestId: "browser-strategy-duplicated-evidence",
    initial,
  });
  request.initialObservation = {
    ...request.initialObservation,
    evidence: request.initialObservation.evidence.map((item, index) =>
      index === 1
        ? {
            ...item,
            id: `${item.id}:duplicate`,
            payload: {
              ...item.payload,
              originalId: request.initialObservation.evidence[0].payload.originalId,
            },
          }
        : item),
  };

  const result = await strategyGoal.runBrowserStrategyGoal(request, resources);
  assert.equal(result.kind, "request_rejected");
  assert.match(result.error.diagnosticMessage, /cover the current snapshot exactly|current state snapshot/);
});

test("recursive receipt separates executor and post-observation failures", async () => {
  const initial = snapshot({ observationId: "double-initial", revision: 1 });
  const { resources } = goalResources({ initial, observations: [
    snapshot({ observationId: "double-preflight", revision: 2 }),
    snapshot({ observationId: "double-pre", revision: 3 }),
  ] });
  let clicks = 0;
  resources.nativeClick = async () => { clicks++; throw new Error("execution transport failed"); };
  const result = await strategyGoal.runBrowserStrategyGoal(goalRequest({ requestId: "double-errors", initial }), resources);
  assert.equal(result.kind, "run_result");
  const atomic = result.report.atomicResults[0];
  assert.ok(atomic.executionErrorIds.length > 0);
  assert.ok(atomic.verificationErrorIds.length > 0);
  assert.equal(atomic.effect.knowledge, "unknown");
  assert.notEqual(result.report.rootEvaluation.result, "satisfied");
  assert.equal(clicks, 1);
});

test("stale achieved-looking post-state cannot become recursive root evidence", async () => {
  const initial = snapshot({ observationId: "stale-initial", revision: 1 });
  const { resources } = goalResources({ initial, observations: [
    snapshot({ observationId: "stale-preflight", revision: 2 }),
    snapshot({ observationId: "stale-pre", revision: 3 }),
    snapshot({ observationId: "stale-post", revision: 3, expanded: true }),
  ], proveNoEffect: () => null });
  let clicks = 0;
  resources.nativeClick = async () => { clicks++; throw new Error("execution transport failed"); };
  const result = await strategyGoal.runBrowserStrategyGoal(goalRequest({ requestId: "stale-errors", initial }), resources);
  assert.equal(result.kind, "run_result");
  assert.notEqual(result.report.rootEvaluation.result, "satisfied");
  assert.ok(result.report.atomicResults[0].verificationErrorIds.length > 0);
  assert.equal(clicks, 1);
});

test("recursive goal fact survives execution transport error without safe-retry fiction", async () => {
  const initial = snapshot({ observationId: "achieved-error-initial", revision: 1 });
  const { resources } = goalResources({ initial, observations: [
    snapshot({ observationId: "achieved-error-preflight", revision: 2 }),
    snapshot({ observationId: "achieved-error-pre", revision: 3 }),
    snapshot({ observationId: "achieved-error-post", revision: 4, expanded: true }),
  ], proveNoEffect: () => null });
  let clicks = 0;
  resources.nativeClick = async () => { clicks++; throw new Error("execution transport failed"); };
  const result = await strategyGoal.runBrowserStrategyGoal(goalRequest({ requestId: "achieved-error", initial }), resources);
  assert.equal(result.kind, "run_result");
  assert.equal(result.report.rootEvaluation.result, "satisfied", JSON.stringify({states: result.report.states, atomic: result.report.atomicResults, errors: result.report.errors}));
  assert.equal(result.report.atomicResults[0].effect.knowledge, "unknown");
  assert.ok(result.report.atomicResults[0].executionErrorIds.length > 0);
  assert.notEqual(result.report.control.outcome, "yielded");
  assert.equal(clicks, 1);
});

test("omitted maxAtomicAttempts reaches a strategy selection with a null remaining budget", async () => {
  const initial = snapshot({ observationId: "null-budget-initial", revision: 1 });
  const { resources, clicks } = goalResources({
    initial,
    observations: [
      snapshot({ observationId: "null-budget-preflight", revision: 2 }),
      snapshot({ observationId: "null-budget-pre", revision: 3 }),
    ],
  });
  const request = goalRequest({
    requestId: "browser-strategy-null-budget",
    initial,
    maxAtomicAttempts: undefined,
  });
  assert.equal(
    Object.hasOwn(request.retryPolicy, "maxAtomicAttempts"),
    false,
    "request must omit retryPolicy.maxAtomicAttempts",
  );

  const result = await strategyGoal.runBrowserStrategyGoal(request, resources);
  assert.equal(
    result.kind,
    "run_result",
    result.kind === "request_rejected"
      ? JSON.stringify(result.error)
      : "nullable ceiling must not be rejected at the selection stage",
  );
  assert.equal(
    result.report.atomicResults.length,
    1,
    JSON.stringify(result.report.errors),
  );
  assert.equal(clicks.length, 1, JSON.stringify(result.report.errors));
  assert.equal(clicks[0].targetRef, "native-target");
});

test("explicit zero remaining budget still defers with exhausted semantics", () => {
  const pre = snapshot({ observationId: "zero-budget-pre", revision: 2 });
  const input = strategyPolicy.readBrowserStrategyRequest({
    request: currentRequest(pre),
    history: [],
  });
  const prediction = strategyPolicy.predictBrowserStrategy(input, {
    profile: strategyProfile(),
    atomicProfile: atomicProfile(),
    feedbackProfile: feedbackProfile(),
    registry: registry(),
    selection: selection({ remainingAtomicAttempts: 0 }),
  });
  assert.equal(prediction.kind, "DEFER");
  assert.match(prediction.reason, /atomic attempt budget is exhausted/);
});

test("runtime strategy selection rejects malformed remainingAtomicAttempts values", () => {
  const pre = snapshot({ observationId: "malformed-pre", revision: 2 });
  const input = strategyPolicy.readBrowserStrategyRequest({
    request: currentRequest(pre),
    history: [],
  });
  const models = {
    profile: strategyProfile(),
    atomicProfile: atomicProfile(),
    feedbackProfile: feedbackProfile(),
    registry: registry(),
  };
  const base = selection();
  for (const bad of [undefined, -1, 1.5, "3", NaN, Infinity]) {
    assert.throws(
      () => strategyPolicy.predictBrowserStrategy(input, {
        ...models,
        selection: { ...base, remainingAtomicAttempts: bad },
      }),
      /remainingAtomicAttempts must be null or a nonnegative safe integer/,
      `expected rejection for ${String(bad)}`,
    );
  }
});
