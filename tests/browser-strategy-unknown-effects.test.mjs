import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import * as atomicPolicy from "../dist/filters/browser-single-action-policy.js";
import * as feedbackPolicy from "../dist/filters/browser-feedback.js";
import * as strategyPolicy from "../dist/filters/browser-strategy.js";

const strategyModuleUrl = process.env.NNANYTHING_STRATEGY_GOAL_MODULE === undefined
  ? new URL("../dist/adapters/browser/strategy-recursive.js", import.meta.url)
  : pathToFileURL(resolve(process.env.NNANYTHING_STRATEGY_GOAL_MODULE));
const strategyGoal = await import(strategyModuleUrl.href);

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
}) {
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

function strategyProfile() {
  const zero = strategyPolicy.createZeroBrowserStrategyProfile();
  const weights = zero.weights.map(row => [...row]);
  const choose = zero.heads.indexOf("choose");
  const wire = name => zero.wires.indexOf(name);
  weights[choose][wire("bias")] = 1;
  weights[choose][wire("nativeButton")] = 2;
  return strategyPolicy.validateBrowserStrategyProfile({ ...zero, weights });
}

function normalFeedbackProfile() {
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

// Handwritten diagnostic only. This profile has no fit, candidate, or adopted weights.
function handwrittenWrongDiagnosticFeedbackProfile() {
  const zero = feedbackPolicy.createZeroFeedbackProfile();
  const weights = zero.weights.map(row => [...row]);
  weights[0][zero.wires.indexOf("bias")] = 1;
  return feedbackPolicy.validateFeedbackProfile({ ...zero, weights });
}

// Handwritten negative control only. It forces an indeterminate explanation so
// the test can prove F2 consumes the actual F1 prediction instead of a teacher.
function handwrittenIndeterminateDiagnosticFeedbackProfile() {
  const zero = feedbackPolicy.createZeroFeedbackProfile();
  const weights = zero.weights.map(row => [...row]);
  weights[2][zero.wires.indexOf("bias")] = 1;
  return feedbackPolicy.validateFeedbackProfile({ ...zero, weights });
}

function controlOf(state) {
  return {
    documentRef: state.documentRef,
    observationId: state.observationId,
    revision: state.revision,
  };
}

function goalRequest({ requestId, initial }) {
  return {
    schema: REQUEST_SCHEMA,
    requestId,
    rootGoal: ROOT_GOAL,
    satisfactionThreshold: 100,
    rootBindings: ROOT_BINDINGS,
    state: { browser: initial, history: [] },
    rootEvaluatorId: strategyGoal.BROWSER_STRATEGY_EVALUATOR_ID,
    rootSelectorId: strategyGoal.BROWSER_STRATEGY_SELECTOR_ID,
    limits: { maxTransitions: 32, maxDepth: 4, maxDerivedGoals: 4 },
    initialObservation: strategyGoal.createBrowserStrategyInitialObservation(
      `${requestId}:initial`,
      { browser: initial, history: [] },
      "region-main",
    ),
    retryPolicy: {
      kind: "bounded_strategy_retry.v1",
      selectorId: strategyGoal.BROWSER_STRATEGY_SELECTOR_ID,
      strategySkillIds: [NATIVE_SKILL, ROLE_SKILL],
      sameFailureLimit: 2,
      maxAtomicAttempts: 4,
    },
    invocation: { maxAtomicDispatches: 1 },
  };
}

function goalResources({
  initial,
  observations,
  feedbackProfile,
  nativeEffectKnowledge,
}) {
  const queue = [...observations];
  const clicks = [];
  const noEffectProofs = [];
  let current = controlOf(initial);
  return {
    profile: strategyProfile(),
    atomicProfile: atomicProfile(),
    feedbackProfile,
    registry: registry(),
    selection: {
      eligibleSkillIds: [NATIVE_SKILL, ROLE_SKILL],
      lockedSkillId: null,
      exhaustedSkillIds: [],
      remainingAtomicAttempts: 2,
    },
    grantedEffects: new Set(["browser.nativeClick", "filesystem.write"]),
    observe: async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error("fixture observation queue exhausted");
      current = controlOf(next);
      return next;
    },
    currentControl: () => current,
    nativeClick: async invocation => {
      clicks.push(invocation);
      return {
        dispatched: true,
        ok: true,
        effectKnowledge: nativeEffectKnowledge,
        source: "synthetic.browser_strategy_fixture",
        error: null,
      };
    },
    observationSatisfied: true,
    collectAtomic: async () => {},
    collectStep: async () => {},
    proveNoEffect: input => {
      const post = input.result.newState;
      if (post === null) return null;
      const proof = {
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
      noEffectProofs.push(proof);
      return proof;
    },
    collectRoot: async () => ({ receiptId: "root-collection" }),
    clicks,
    noEffectProofs,
  };
}

function responseReport(response) {
  assert.equal(
    response.kind,
    "run_result",
    response.kind === "request_rejected"
      ? JSON.stringify(response.error)
      : "expected a recursive goal run result",
  );
  assert.ok(
    response.report !== null
      && typeof response.report === "object"
      && Array.isArray(response.report.atomicResults),
    `unexpected report shape: ${JSON.stringify(Object.keys(response.report ?? {}))}`,
  );
  assert.equal(
    response.report.atomicResults.length,
    1,
    JSON.stringify({
      control: response.report.control,
      rootEvaluation: response.report.rootEvaluation,
      errors: response.report.errors,
    }),
  );
  assert.ok(
    response.report.atomicResults[0].sourceResult !== null
      && typeof response.report.atomicResults[0].sourceResult === "object"
      && "value" in response.report.atomicResults[0].sourceResult,
    JSON.stringify({
      control: response.report.control,
      rootEvaluation: response.report.rootEvaluation,
      sourceResult: response.report.atomicResults[0].sourceResult,
      executionErrors: response.report.errors,
    }),
  );
  return response.report;
}

async function runSingleAttempt({
  requestId,
  feedbackProfile,
  nativeEffectKnowledge,
  finalExpanded = false,
}) {
  const initial = snapshot({ observationId: `${requestId}-initial`, revision: 1 });
  const resources = goalResources({
    initial,
    observations: [
      snapshot({ observationId: `${requestId}-preflight`, revision: 2 }),
      snapshot({ observationId: `${requestId}-pre`, revision: 3 }),
      snapshot({
        observationId: `${requestId}-post`,
        revision: 4,
        expanded: finalExpanded,
      }),
    ],
    feedbackProfile,
    nativeEffectKnowledge,
  });
  const response = await strategyGoal.runBrowserStrategyGoal(
    goalRequest({ requestId, initial }),
    resources,
  );
  return { response, resources };
}

function assertUnknownEffectStopped(report, resources) {
  const atomic = report.atomicResults[0];
  const rawStep = atomic.sourceResult.value;

  assert.equal(rawStep.atomic.receipt.dispatched, true);
  assert.equal(rawStep.atomic.receipt.ok, true);
  assert.equal(rawStep.atomic.receipt.effectKnowledge, "unknown");
  assert.equal(rawStep.atomic.effectKnowledge, "unknown");
  assert.equal(rawStep.effectProof.kind, "controlled_fixture_no_effect");
  assert.equal(resources.noEffectProofs.length, 1);

  assert.equal(report.rootEvaluation.result, "unsatisfied");
  assert.equal(report.control.outcome, "error");
  assert.equal(report.control.stopReason, "fatal_error");
  assert.equal(atomic.outcome, "succeeded");
  assert.equal(atomic.effect.knowledge, "unknown");
  assert.equal(report.effects[0].knowledge, "unknown");
  assert.equal(report.atomicResults[0].sourceResult.value.atomic.effectKnowledge, "unknown");
  assert.equal(
    report.errors.some(
      error =>
        error.code === "effect_outcome_unknown"
        && error.source.category === "retry_effect_not_none",
    ),
    true,
    JSON.stringify(report.errors),
  );
  assert.equal(resources.clicks.length, 1);
  assert.ok(report.continuation);
  assert.equal(
    report.continuation.retryControl.frames[0].lastAccountedDispatchId,
    null,
  );
  assert.deepEqual(
    report.continuation.retryControl.frames[0].strategies.map(strategy => ({
      skillId: strategy.skillId,
      failures: strategy.failures.length,
      exhausted: strategy.exhausted,
    })),
    [
      { skillId: NATIVE_SKILL, failures: 0, exhausted: false },
      { skillId: ROLE_SKILL, failures: 0, exhausted: false },
    ],
  );
}

test("raw unknown effect and a valid no-effect proof stop before the handwritten diagnostic can yield", async () => {
  const { response, resources } = await runSingleAttempt({
    requestId: "handwritten-wrong-f1-unknown",
    feedbackProfile: handwrittenWrongDiagnosticFeedbackProfile(),
    nativeEffectKnowledge: "unknown",
  });
  const report = responseReport(response);

  assert.equal(
    report.atomicResults[0].sourceResult.value.feedback.head,
    "completed_without_goal",
  );
  assertUnknownEffectStopped(report, resources);
});

test("a fixed normal F1 also cannot convert raw unknown effects to none", async () => {
  const { response, resources } = await runSingleAttempt({
    requestId: "normal-f1-unknown",
    feedbackProfile: normalFeedbackProfile(),
    nativeEffectKnowledge: "unknown",
  });
  const report = responseReport(response);

  assert.equal(
    report.atomicResults[0].sourceResult.value.feedback.head,
    "completed_without_goal",
  );
  assertUnknownEffectStopped(report, resources);
});

test("raw unknown effects stay unknown when the root evaluation is actually satisfied", async () => {
  const { response, resources } = await runSingleAttempt({
    requestId: "satisfied-root-unknown-effect",
    feedbackProfile: normalFeedbackProfile(),
    nativeEffectKnowledge: "unknown",
    finalExpanded: true,
  });
  const report = responseReport(response);
  const atomic = report.atomicResults[0];

  assert.equal(report.rootEvaluation.result, "satisfied");
  assert.equal(report.control.outcome, "completed");
  assert.equal(report.continuation, null);
  assert.equal(atomic.effect.knowledge, "unknown");
  assert.equal(report.effects[0].knowledge, "unknown");
  assert.equal(
    atomic.sourceResult.value.atomic.receipt.effectKnowledge,
    "unknown",
  );
  assert.equal(atomic.sourceResult.value.effectProof.kind, "controlled_fixture_no_effect");
  assert.equal(resources.clicks.length, 1);
});

test("known no-effect receipts with a valid proof still take the existing safe retry path", async () => {
  const { response, resources } = await runSingleAttempt({
    requestId: "known-no-effect-retry",
    feedbackProfile: normalFeedbackProfile(),
    nativeEffectKnowledge: "none",
  });
  const report = responseReport(response);
  const atomic = report.atomicResults[0];

  assert.equal(report.rootEvaluation.result, "unsatisfied");
  assert.equal(report.control.outcome, "yielded");
  assert.ok(report.continuation);
  assert.equal(atomic.effect.knowledge, "none");
  assert.equal(report.effects[0].knowledge, "none");
  assert.equal(atomic.sourceResult.value.atomic.effectKnowledge, "none");
  assert.equal(atomic.sourceResult.value.effectProof.kind, "controlled_fixture_no_effect");
  assert.equal(resources.clicks.length, 1);
  assert.deepEqual(
    report.continuation.retryControl.frames[0].strategies.map(strategy => ({
      skillId: strategy.skillId,
      failures: strategy.failures.length,
    })),
    [
      { skillId: NATIVE_SKILL, failures: 1 },
      { skillId: ROLE_SKILL, failures: 0 },
    ],
  );
});

test("F2 consumes the actual F1 prediction and a wrong diagnostic head stops recovery", async () => {
  const multiRun = async (requestId, feedbackProfile) => {
    const initial = snapshot({ observationId: `${requestId}-initial`, revision: 1 });
    const resources = goalResources({
      initial,
      observations: [
        snapshot({ observationId: `${requestId}-preflight`, revision: 2 }),
        snapshot({ observationId: `${requestId}-pre`, revision: 3 }),
        snapshot({ observationId: `${requestId}-post`, revision: 4 }),
        snapshot({ observationId: `${requestId}-preflight2`, revision: 5 }),
        snapshot({ observationId: `${requestId}-pre2`, revision: 6 }),
        snapshot({ observationId: `${requestId}-post2`, revision: 7 }),
      ],
      feedbackProfile,
      nativeEffectKnowledge: "none",
    });
    const base = goalRequest({ requestId, initial });
    const segments = [];
    let request = base;
    let secondRequest = null;
    for (let index = 0; index < 2; index += 1) {
      const response = await strategyGoal.runBrowserStrategyGoal(request, resources);
      assert.equal(response.kind, "run_result", JSON.stringify(response.error ?? response.fault));
      const report = response.report;
      segments.push(report);
      if (report.control.outcome !== "yielded" || report.continuation === null) break;
      const last = report.states.at(-1).value;
      const { initialObservation: _initialObservation, ...rest } = request;
      request = { ...rest, state: last, continuation: report.continuation };
      secondRequest = {
        request: {
          goal: { kind: "SetExpanded", regionRef: "region-main", desired: true },
          satisfactionThreshold: 100,
          state: last.browser,
        },
        history: last.history,
      };
    }
    return { segments, resources, secondRequest };
  };
  const normal = await multiRun("actual-f1-normal", normalFeedbackProfile());
  const diagnostic = await multiRun(
    "actual-f1-diagnostic",
    handwrittenIndeterminateDiagnosticFeedbackProfile(),
  );
  assert.equal(normal.segments[0].atomicResults[0].sourceResult.value.feedback.head, "completed_without_goal");
  assert.equal(diagnostic.segments[0].atomicResults[0].sourceResult.value.feedback.head, "indeterminate");
  assert.equal(diagnostic.segments.length, 1, "a wrong F1 head must stop before a second dispatch");
  assert.equal(diagnostic.segments[0].control.outcome, "error");
  assert.equal(diagnostic.resources.clicks.length, 1);
  assert.ok(diagnostic.segments[0].errors.some(
    error => error.source.category === "retry_assessment:unsupported_retry",
  ), JSON.stringify(diagnostic.segments[0].errors));

  const normalSecond = normal.segments[1];
  assert.ok(normalSecond !== undefined, "the correct F1 head must allow a second segment");
  assert.equal(
    normalSecond.atomicResults.length,
    2,
    "continuation reports must retain prior atomic results for audit",
  );
  assert.notEqual(
    normalSecond.atomicResults[0].dispatchId,
    normalSecond.atomicResults[1].dispatchId,
    "continuation history must have unique dispatch ids",
  );
  const strategyWires = strategyPolicy.createZeroBrowserStrategyProfile().wires;
  const nativeCandidate = normalSecond.atomicResults.at(-1).sourceResult.value.decision.candidates
    .find(candidate => candidate.feedback !== null);
  assert.ok(nativeCandidate, "the second decision must carry an F1-backed history");
  assert.equal(nativeCandidate.feedback.head, "completed_without_goal");
  assert.equal(nativeCandidate.features[strategyWires.indexOf("feedback.completedWithoutGoal")], 1);
  assert.equal(nativeCandidate.features[strategyWires.indexOf("feedback.indeterminate")], 0);

  const diagnosticDecision = strategyPolicy.predictBrowserStrategy(normal.secondRequest, {
    ...normal.resources,
    feedbackProfile: handwrittenIndeterminateDiagnosticFeedbackProfile(),
  });
  const diagnosticCandidate = diagnosticDecision.candidates.find(candidate => candidate.feedback !== null);
  assert.ok(diagnosticCandidate, "the negative control must still expose feedback features");
  assert.equal(diagnosticCandidate.feedback.head, "indeterminate");
  assert.equal(diagnosticCandidate.features[strategyWires.indexOf("feedback.completedWithoutGoal")], 0);
  assert.equal(diagnosticCandidate.features[strategyWires.indexOf("feedback.indeterminate")], 1);
  assert.notDeepEqual(nativeCandidate.features, diagnosticCandidate.features);
  assert.equal(normalSecond.rootEvaluation.result, "unsatisfied");
});
