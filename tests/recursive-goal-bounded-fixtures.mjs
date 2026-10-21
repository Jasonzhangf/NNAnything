import assert from "node:assert/strict";

import {
  BOUNDED_FINITE_CHECKPOINT_ID,
  createBoundedFiniteResources as createFiniteResources,
} from "../playground/recursive-goal/bounded-finite.mjs";

const BRANCH_SWITCH = Object.freeze({
  scenario: "branch-switch",
  actualBranch: "reject",
  expectedBranch: "reject",
  includeInitialAlternatives: true,
});

export const BOUNDED_CASES = Object.freeze([
  {
    id: "B01.normal-reuse",
    denominatorId: "D-FINITE-SYNTH-NAMED",
    title: "normal plan reuse predicts the accepted path once",
    options: {
      scenario: "branch-approve",
      actualBranch: "approve",
      expectedBranch: "approve",
      includeInitialAlternatives: true,
    },
    oracle: {
      actions: ["bounded.probe", "bounded.approve", "bounded.finish"],
      completed: true,
      rootSatisfied: true,
      noPredictionAfterFirstAction: true,
    },
  },
  {
    id: "B02.existing-alternative",
    denominatorId: "D-FINITE-SYNTH-NAMED",
    title: "observed fork switches to an existing alternative without a new plan",
    options: BRANCH_SWITCH,
    oracle: {
      actions: ["bounded.probe", "bounded.reject", "bounded.finish"],
      completed: true,
      rootSatisfied: true,
      decisionKinds: ["switch"],
      noPredictionAfterFirstAction: true,
      forbiddenActions: ["bounded.approve"],
    },
  },
  {
    id: "B03.no-applicable-alternative",
    denominatorId: "D-FINITE-SYNTH-NAMED",
    title: "uncovered fork replans only after alternatives are exhausted",
    options: {
      ...BRANCH_SWITCH,
      scenario: "branch-replan",
      includeInitialAlternatives: false,
    },
    oracle: {
      actions: ["bounded.probe", "bounded.reject", "bounded.finish"],
      completed: true,
      rootSatisfied: true,
      decisionKinds: ["replan"],
      replansAtLeast: 1,
    },
  },
  {
    id: "B04.checkpoint-truth",
    denominatorId: "D-FINITE-SYNTH-NAMED",
    title: "checkpoint rolls only after its real condition is satisfied",
    options: {
      ...BRANCH_SWITCH,
      scenario: "checkpoint",
      checkpoint: true,
    },
    oracle: {
      actions: ["bounded.probe", "bounded.reject", "bounded.finish"],
      completed: true,
      checkpointId: BOUNDED_FINITE_CHECKPOINT_ID,
      checkpointAfter: "bounded.reject",
    },
  },
  {
    id: "B05.root-early",
    denominatorId: "D-FINITE-SYNTH-NAMED",
    title: "root satisfaction stops before further plan work",
    options: {
      scenario: "root-early",
      actualBranch: "approve",
      expectedBranch: "approve",
      rootEarly: true,
    },
    oracle: {
      actions: ["bounded.probe"],
      completed: true,
      rootSatisfied: true,
      noPredictionAfterFirstAction: true,
    },
  },
  {
    id: "B06.invalid-checkpoint",
    denominatorId: "D-FINITE-SYNTH-NAMED",
    title: "failed transition does not replay from an invalidated checkpoint",
    options: {
      scenario: "failure-prior",
      actualBranch: "approve",
      expectedBranch: "approve",
      failSelected: true,
      checkpoint: true,
    },
    oracle: {
      actions: ["bounded.probe", "bounded.approve"],
      completed: false,
      rootSatisfied: false,
      noRepeatedMutation: true,
      errorCodes: ["execution_failed"],
    },
  },
  {
    id: "B07.failure-prior",
    denominatorId: "D-FINITE-SYNTH-NAMED",
    title: "failure prior is scoped and becomes inapplicable after premise change",
    options: {
      scenario: "failure-prior-changed",
      actualBranch: "approve",
      expectedBranch: "approve",
      failSelected: true,
      changedPremise: true,
    },
    oracle: {
      actions: [
        "bounded.probe",
        "bounded.approve",
        "bounded.premise.change",
        "bounded.approve",
        "bounded.finish",
      ],
      completed: true,
      rootSatisfied: true,
      priorApplicability: ["applicable", "inapplicable"],
    },
  },
  {
    id: "B08.unknown-no-replay",
    denominatorId: "D-FINITE-SYNTH-NAMED",
    title: "unknown effect stops without mutation replay",
    options: {
      scenario: "unknown-lifecycle",
      actualBranch: "approve",
      expectedBranch: "approve",
      unknownProbe: true,
    },
    oracle: {
      actions: ["bounded.probe"],
      completed: false,
      noRepeatedMutation: true,
      effectKnowledge: ["unknown"],
    },
  },
  {
    id: "B09.wrong-head",
    denominatorId: "D-FINITE-SYNTH-NAMED",
    title: "selector head outside the plan entry is preserved as policy_error",
    options: {
      scenario: "wrong-head",
      actualBranch: "approve",
      expectedBranch: "approve",
      wrongHead: true,
    },
    oracle: {
      actions: [],
      rawSelectionHead: "bounded.finish",
      errorCodes: ["policy_error"],
    },
  },
  {
    id: "B10.budget-accumulation",
    denominatorId: "D-FINITE-SYNTH-NAMED",
    title: "planning usage remains monotonic across action boundaries",
    options: {
      ...BRANCH_SWITCH,
      scenario: "budget-accumulation",
      includeInitialAlternatives: false,
    },
    oracle: {
      actions: ["bounded.probe", "bounded.reject", "bounded.finish"],
      completed: true,
      replansAtLeast: 1,
      monotonicUsage: true,
    },
  },
  {
    id: "B11.predicted-actual-separation",
    denominatorId: "D-FINITE-SYNTH-NAMED",
    title: "predicted references never enter actual state, evidence, effects, or atomics",
    options: {
      scenario: "predicted-actual-separation",
      actualBranch: "approve",
      expectedBranch: "approve",
    },
    oracle: {
      actions: ["bounded.probe", "bounded.approve", "bounded.finish"],
      completed: true,
      predictedToken: "finite.predict.",
    },
  },
  {
    id: "B12.or-not-and",
    denominatorId: "D-FINITE-SYNTH-NAMED",
    title: "unselected OR alternative does not become a required action",
    options: {
      ...BRANCH_SWITCH,
      scenario: "or-not-and",
    },
    oracle: {
      actions: ["bounded.probe", "bounded.reject", "bounded.finish"],
      completed: true,
      forbiddenActions: ["bounded.approve"],
      unselectedNotRequired: "bounded.approve",
    },
  },
  {
    id: "B13.persistent-invalidation",
    denominatorId: "D-FINITE-SYNTH-NAMED",
    title: "a later document revision invalidates the earlier title fact",
    options: {
      scenario: "document-persistent",
    },
    oracle: {
      actions: [
        "bounded.document.title",
        "bounded.document.owner",
        "bounded.document.revise",
      ],
      completed: false,
      rootSatisfied: false,
      finalTitleValid: false,
    },
  },
  {
    id: "B15.rank-defer",
    denominatorId: "D-FINITE-SYNTH-NAMED",
    title: "insufficient ranking keys defer instead of using array order",
    options: {
      scenario: "rank-defer",
      forceDefer: true,
    },
    oracle: {
      actions: [],
      predictionKind: "deferred",
      noAtomicExecution: true,
    },
  },
  {
    id: "B16.missing-model",
    denominatorId: "D-FINITE-SYNTH-NAMED",
    title: "missing result model is named and never fabricates a success path",
    options: {
      scenario: "missing-model",
      missingModel: true,
    },
    oracle: {
      actions: [],
      predictionKind: "not_ready",
      predictionReason: "missing_model",
    },
  },
  {
    id: "B16.truncated-frontier",
    denominatorId: "D-FINITE-SYNTH-NAMED",
    title: "truncated prediction exposes frontier and no fake terminal path",
    options: {
      scenario: "truncated-frontier",
      horizonN: 1,
      truncated: true,
    },
    oracle: {
      actions: [],
      predictionKind: "not_ready",
      predictionReason: "horizon_exhausted",
      frontierCoverage: ["truncated", "unknown"],
    },
  },
]);

export const CWD_DELEGATED_CASES = Object.freeze([
  {
    id: "B01.cwd-normal",
    requirement: "Use the same sandbox/session; predict once and execute only pwd/cd as required.",
  },
  {
    id: "B05.cwd-root-early",
    requirement: "Use live session cwd and revision; stop immediately when the real root is satisfied.",
  },
  {
    id: "B06.cwd-invalid-checkpoint",
    requirement: "Reject an invalidated checkpoint after target removal without replaying cd.",
  },
  {
    id: "B08.cwd-known-effect",
    requirement: "Keep a known cd effect and postcommit observation failure without compensation or replay.",
  },
  {
    id: "B14.cwd-v2",
    requirement: "Reattach only through a formal persistent session API; current status is UNVERIFIED.",
  },
]);

export function createBoundedCase(id) {
  const definition = BOUNDED_CASES.find(item => item.id === id);
  if (definition === undefined) {
    throw new TypeError(`unknown bounded case ${id}`);
  }
  return {
    ...definition,
    resources: createFiniteResources(definition.options),
  };
}

export function createBoundedFiniteResources(options = {}) {
  return createFiniteResources(options);
}

export function createBoundedCwdResources(delegate = null) {
  const requiredCapabilities = Object.freeze([
    "createSandbox",
    "createAdapter",
    "createDependencies",
    "emptyState",
    "runStep",
  ]);
  if (delegate === null) {
    return Object.freeze({
      kind: "bounded-cwd-delegation.v1",
      status: "UNVERIFIED",
      requiredCapabilities,
      note: "The cwd worker must provide a live sandbox/session and explicit saved profiles.",
    });
  }
  for (const name of requiredCapabilities) {
    if (typeof delegate[name] !== "function") {
      throw new TypeError(`bounded cwd delegate.${name} must be a function`);
    }
  }
  return Object.freeze({
    kind: "bounded-cwd-delegation.v1",
    status: "READY",
    requiredCapabilities,
    ...delegate,
  });
}

export function createSelectorInjection({ head, planningAware = false } = {}) {
  return {
    wrapSelect(select) {
      return async input => {
        if (planningAware && input.planning === undefined) {
          return { kind: "defer", reason: "planning view is required" };
        }
        if (typeof head === "string") {
          return { kind: "selected", skillId: head };
        }
        return select(input);
      };
    },
  };
}

export function roundTripContinuation(continuation) {
  assert.equal(
    continuation?.schema,
    "nnanything.recursive-goal.continuation.v2",
  );
  const json = JSON.stringify(continuation);
  const restored = JSON.parse(json);
  assert.deepEqual(restored, continuation);
  return restored;
}

export function reportOf(response) {
  assert.equal(response.kind, "run_result", JSON.stringify(response, null, 2));
  return response.report;
}

export function uniqueAtomicResults(run) {
  const results = new Map();
  for (const response of run.responses) {
    if (response.kind !== "run_result") continue;
    for (const result of response.report.atomicResults) {
      results.set(result.dispatchId, result);
    }
  }
  return [...results.values()];
}

export function planningDecisions(run) {
  return run.responses
    .filter(response => response.kind === "run_result")
    .map(response => response.report.planning?.decision)
    .filter(Boolean);
}

export function planningUsages(run) {
  return run.responses
    .filter(response => response.kind === "run_result")
    .map(response => response.report.continuation?.planControl?.usage)
    .filter(Boolean);
}
