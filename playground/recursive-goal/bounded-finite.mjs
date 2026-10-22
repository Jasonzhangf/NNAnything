import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import { runRecursiveGoal } from "nnanything/recursive-goal";

export const BOUNDED_FINITE_CAPABILITY_REF = Object.freeze({
  id: "finite.bounded-planning-capability",
  version: "1.0.1",
});

export const BOUNDED_FINITE_RESULT_MODEL_REF = Object.freeze({
  id: "finite.bounded-result-model",
  version: "1.0.0",
});

export const BOUNDED_FINITE_EVALUATOR_ID = "finite.bounded.evaluator";
export const BOUNDED_FINITE_SELECTOR_ID = "finite.bounded.selector";
export const BOUNDED_FINITE_CHECKPOINT_ID = "finite.bounded.branch-selected";

const REQUEST_SCHEMA = "nnanything.recursive-goal.request.v1";
const PLANNING_KIND = "bounded_goal_planning.v1";
const PROJECTION_SCALE_REF = Object.freeze({
  id: "finite.bounded-path-score",
  version: "1.0.0",
});

const SKILL_IDS = Object.freeze({
  probe: "bounded.probe",
  approve: "bounded.approve",
  reject: "bounded.reject",
  finish: "bounded.finish",
  title: "bounded.document.title",
  owner: "bounded.document.owner",
  revise: "bounded.document.revise",
  changePremise: "bounded.premise.change",
});

const SKILLS = Object.freeze(
  Object.values(SKILL_IDS).map(id =>
    Object.freeze({
      id,
      version: "1.0.0",
      mode: "atomic",
      capability: "finite.bounded-action",
      evaluatorId: BOUNDED_FINITE_EVALUATOR_ID,
      requiredEffects: [],
      allowedEffects: [],
      retry: "never",
      effectClass: "none",
    }),
  ),
);

const SKILL_REF_BY_ID = new Map(
  SKILLS.map(skill => [
    skill.id,
    Object.freeze({ id: skill.id, version: skill.version }),
  ]),
);

const EVALUATOR = Object.freeze({
  id: BOUNDED_FINITE_EVALUATOR_ID,
  goalType: "finite.bounded-goal",
  thresholdContract: "0..100",
  allowsPartialSatisfaction: true,
});

const SELECTOR = Object.freeze({
  id: BOUNDED_FINITE_SELECTOR_ID,
  skillIds: Object.freeze(SKILLS.map(skill => skill.id)),
});

const SCENARIO_DEFAULTS = Object.freeze({
  scenario: "branch-switch",
  actualBranch: "reject",
  expectedBranch: "reject",
  failSelected: false,
  horizonN: 4,
  maxPlanNodes: 48,
  maxPredictionCalls: 48,
  maxReplans: 3,
  maxRollbacks: 2,
  includeInitialAlternatives: true,
  checkpoint: false,
  rootEarly: false,
  unknownProbe: false,
  forceDefer: false,
  missingModel: false,
  truncated: false,
  changedPremise: false,
  wrongHead: false,
  planning: true,
});

export function createBoundedFiniteResources(options = {}) {
  const config = { ...SCENARIO_DEFAULTS, ...options };
  const memory = {
    predictCalls: 0,
    predictions: [],
    selections: [],
    atomicExecutions: [],
    priorAssessments: [],
    matches: [],
  };
  const rootBindings = {
    kind: "finite.bounded-bindings",
    goalId: "bounded-finite-1",
    expectedBranch: config.expectedBranch,
    actualBranch: config.actualBranch,
    failSelected: config.failSelected,
    documentId: "bounded-document-1",
    rootEarly: config.rootEarly,
  };
  const initialState = {
    kind: "finite.bounded-state",
    phase: "start",
    observedBranch: null,
    selectedBranch: null,
    pathSucceeded: false,
    finished: false,
    titleValid: false,
    owner: null,
    operations: [],
    premise: "same",
    attemptFailed: false,
    blockedTransition: null,
    revision: 0,
  };
  const rootGoal = {
    kind:
      config.scenario.startsWith("document")
        ? "finite.bounded-document"
        : "finite.bounded-root",
    goalId: rootBindings.goalId,
    scenario: config.scenario,
  };
  const checkpointSpecs = config.checkpoint
    ? [
        {
          id: BOUNDED_FINITE_CHECKPOINT_ID,
          goal: {
            kind: "finite.bounded-checkpoint",
            goalId: rootBindings.goalId,
            checkpoint: "branch-selected",
          },
          bindings: rootBindings,
          satisfactionThreshold: 100,
          evaluatorId: BOUNDED_FINITE_EVALUATOR_ID,
          evidenceRequirementRefs: [],
          obligations: [],
          rollingRule: "next_segment",
        },
      ]
    : [];
  const planning = {
    kind: PLANNING_KIND,
    capabilityRef: BOUNDED_FINITE_CAPABILITY_REF,
    horizonN: config.horizonN,
    resultModelRefs: [BOUNDED_FINITE_RESULT_MODEL_REF],
    preference: {
      kind: "order_first",
      projectionScaleRef: PROJECTION_SCALE_REF,
    },
    checkpointSpecs,
    limits: {
      maxPlanNodes: config.maxPlanNodes,
      maxPredictionCalls: config.maxPredictionCalls,
      maxReplans: config.maxReplans,
      maxRollbacks: config.maxRollbacks,
    },
  };
  const request = {
    schema: REQUEST_SCHEMA,
    requestId: `bounded-finite-${config.scenario}`,
    rootGoal,
    satisfactionThreshold: 100,
    rootBindings,
    state: initialState,
    rootEvaluatorId: BOUNDED_FINITE_EVALUATOR_ID,
    rootSelectorId: BOUNDED_FINITE_SELECTOR_ID,
    limits: {
      maxTransitions: 96,
      maxDepth: 6,
      maxDerivedGoals: 24,
    },
    invocation: { maxAtomicDispatches: 1 },
    ...(config.planning ? { planning } : {}),
  };
  const adapter = createAdapter(config, memory);
  const capability = createPlanningCapability(config, memory);
  const dependencies = {
    adapter,
    enabledSkills: SKILLS,
    enabledEvaluators: [EVALUATOR],
    selectors: [SELECTOR],
    comparators: {
      sameGoal: isDeepStrictEqual,
      sameBindings: isDeepStrictEqual,
      sameFacts: isDeepStrictEqual,
    },
    grantedEffects: new Set(),
    ...(config.planning ? { planning: capability } : {}),
  };
  return {
    config,
    request,
    dependencies,
    memory,
    scenario: config.scenario,
  };
}

export async function runBoundedFiniteStep(resources, continuation = null) {
  const request =
    continuation === null
      ? resources.request
      : { ...resources.request, continuation };
  const response = await runRecursiveGoal(request, resources.dependencies);
  return { request, response, memory: resources.memory };
}

export async function runBoundedFiniteScenario(options = {}) {
  const resources = createBoundedFiniteResources(options);
  const runs = [];
  let continuation = null;
  for (let invocation = 0; invocation < 16; invocation += 1) {
    const step = await runBoundedFiniteStep(resources, continuation);
    step.observation = {
      invocation: invocation + 1,
      predictionCalls: resources.memory.predictCalls,
      selectionCount: resources.memory.selections.length,
      atomicExecutionCount: resources.memory.atomicExecutions.length,
      priorAssessmentCount: resources.memory.priorAssessments.length,
    };
    runs.push(step);
    if (step.response.kind !== "run_result") break;
    const next = step.response.report.continuation;
    if (next === null || step.response.report.control.outcome !== "yielded") {
      break;
    }
    continuation = next;
  }
  return {
    resources,
    runs,
    responses: runs.map(run => run.response),
    final: runs.at(-1)?.response ?? null,
  };
}

export function summarizeBoundedFiniteRun(run) {
  const reports = run.runs
    .map(step => step.response)
    .filter(response => response.kind === "run_result")
    .map(response => response.report);
  const finalReport = reports.at(-1) ?? null;
  const atomics = new Map();
  for (const report of reports) {
    for (const result of report.atomicResults) {
      atomics.set(result.dispatchId, result);
    }
  }
  return {
    scenario: run.resources.scenario,
    responses: run.responses.map(response => response.kind),
    actions: [...atomics.values()].map(result => result.skillId),
    rawSelections: run.resources.memory.selections.map(selection => ({
      run: selection.run,
      skillId: selection.skillId,
      planning: selection.planning,
    })),
    predictionCalls: run.resources.memory.predictCalls,
    predictions: run.resources.memory.predictions,
    priorAssessments: run.resources.memory.priorAssessments,
    controls: reports.map(report => report.control),
    planning: reports.map(report => report.planning ?? null),
    finalReport,
    continuation: finalReport?.continuation ?? null,
  };
}

function createAdapter(config, memory) {
  const adapter = {
    async validateRequest(request) {
      if (request.rootGoal?.kind !== expectedRootGoalKind(config)) {
        throw new TypeError("root goal does not belong to the bounded finite scenario");
      }
      if (request.rootBindings?.kind !== "finite.bounded-bindings") {
        throw new TypeError("root bindings do not belong to the bounded finite scenario");
      }
      if (request.state?.kind !== "finite.bounded-state") {
        throw new TypeError("state does not belong to the bounded finite scenario");
      }
      return {
        requestId: request.requestId,
        rootGoal: request.rootGoal,
        satisfactionThreshold: request.satisfactionThreshold,
        rootBindings: request.rootBindings,
        state: request.state,
        rootEvaluatorId: request.rootEvaluatorId,
        rootSelectorId: request.rootSelectorId,
        limits: request.limits,
        continuation: request.continuation ?? null,
        ...(request.planning === undefined ? {} : { planning: request.planning }),
      };
    },

    supports({ goal, skill }) {
      if (
        goal.kind !== "finite.bounded-root" &&
        goal.kind !== "finite.bounded-document" &&
        goal.kind !== "finite.bounded-checkpoint"
      ) {
        return false;
      }
      return SKILL_REF_BY_ID.has(skill.id);
    },

    async evaluate(input) {
      return evaluateGoal(config, input);
    },

    async select(input) {
      const skillId = config.wrongHead && memory.selections.length === 0 ? SKILL_IDS.finish : selectNextSkill(config, input);
      memory.selections.push({
        run: memory.selections.length + 1,
        skillId,
        planning: input.planning ?? null,
      });
      return { kind: "selected", skillId };
    },

    async derive() {
      return { conditions: [], nextCursor: null, expansion: "closed" };
    },

    async executeAtomic(input) {
      memory.atomicExecutions.push(input.skill.id);
      return executeAtomicGoal(config, input, memory);
    },

    validateAtomicReceipt(raw) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new TypeError("bounded finite receipt must be an object");
      }
      if (
        raw.executorInvoked !== true &&
        raw.executorInvoked !== false &&
        raw.executorInvoked !== "unknown"
      ) {
        throw new TypeError("bounded finite executorInvoked is invalid");
      }
      if (!["succeeded", "failed", "rejected", "unknown"].includes(raw.outcome)) {
        throw new TypeError("bounded finite outcome is invalid");
      }
      if (!Array.isArray(raw.evidence) || !Array.isArray(raw.executionErrors)) {
        throw new TypeError("bounded finite receipt collections are invalid");
      }
      return raw;
    },

    measureProgress({ before, after, previousEvaluation, currentEvaluation }) {
      const comparable =
        previousEvaluation.satisfaction !== null &&
        currentEvaluation.satisfaction !== null;
      return {
        improved:
          comparable &&
          currentEvaluation.satisfaction > previousEvaluation.satisfaction,
        reason:
          comparable &&
          currentEvaluation.satisfaction > previousEvaluation.satisfaction
            ? "facts_improved"
            : after.revision > before.revision
              ? "obligation_reduced"
              : "none",
        comparable,
      };
    },
  };
  return adapter;
}

function createPlanningCapability(config, memory) {
  return {
    contract: BOUNDED_FINITE_CAPABILITY_REF,
    resultModels: [
      {
        ref: BOUNDED_FINITE_RESULT_MODEL_REF,
        skillRefs: SKILLS.map(skill => ({
          id: skill.id,
          version: skill.version,
        })),
        predict(input) {
          memory.predictCalls += 1;
          const callRef = `finite.predict.${memory.predictCalls}`;
          memory.predictions.push({
            callRef,
            skillId: input.skillRef.id,
            remainingHorizon: input.remainingHorizon,
            priorRefs: input.prior.map(prior => prior.id),
          });
          if (config.missingModel && input.skillRef.id === SKILL_IDS.probe) {
            return { kind: "not_ready", reason: "missing_model" };
          }
          if (input.remainingHorizon < 1) {
            return { kind: "not_ready", reason: "horizon_exhausted" };
          }
          return {
            kind: "ready",
            transitions: predictedTransitions(config, input, callRef),
          };
        },
      },
    ],
    guards: {
      goal: guardGoal,
      bindings: guardBindings,
      stateProjection: guardState,
      evidenceProjection: guardEvidence,
      effectFact: guardEffect,
      cursor: guardCursor,
    },
    matchesActual(input) {
      const actualResultRef = resultRefForActual(input.skillRef.id, input.actualState);
      const resultMatches = input.predicted.resultRef === actualResultRef;
      const applicability = {
        kind:
          input.actualOutcome !== "unknown" && resultMatches
            ? "applicable"
            : input.actualOutcome === "unknown"
              ? "unknown"
              : "inapplicable",
        reason:
          input.actualOutcome === "unknown"
            ? "actual outcome is unknown"
            : resultMatches
              ? "predicted result matches observed state"
              : "predicted result does not match observed state",
        evidenceRefs: [],
      };
      memory.matches.push({
        skillId: input.skillRef.id,
        predicted: input.predicted.resultRef,
        actual: actualResultRef,
        applicability,
      });
      return applicability;
    },
    attributeFailure(input) {
      const blocked = input.state.value.blockedTransition;
      const evidenceRefs = input.evidence.filter(e => e.validity === "valid" && e.stateRef === input.state.id &&
        e.payload.blockedTransition?.skillId === input.node.skillRef.id &&
        e.payload.blockedTransition?.premise === input.state.value.premise &&
        e.payload.blockedTransition?.resultRef === blocked?.resultRef).map(e => e.id);
      if (!blocked || blocked.skillId !== input.node.skillRef.id || blocked.premise !== input.state.value.premise || !evidenceRefs.length) {
        return {kind: "unknown", reason: "no observed finite prerequisite blocks a generated result", evidenceRefs: []};
      }
      const transitionRefs = input.node.predictedResults.filter(r => r.resultRef === blocked.resultRef).map(r => r.transitionRef);
      if (!transitionRefs.length) return {kind: "unknown", reason: "blocked result was not predicted at this node", evidenceRefs};
      return {kind: "restricted", reason: "finite prerequisite blocks this result until the premise changes", evidenceRefs,
        transitionRefs, preconditions: [], invalidation: []};
    },
    assessPrior(input) {
      const samePremise =
        input.prior.scope.stateProjection.premise ===
        input.actualState.premise;
      const applicability = {
        kind: samePremise ? "applicable" : "inapplicable",
        reason: samePremise
          ? "failure prior premise still holds"
          : "failure prior premise changed",
        evidenceRefs: [],
      };
      memory.priorAssessments.push({
        priorRef: input.prior.id,
        skillId: input.skillRef.id,
        premise: input.actualState.premise,
        applicability,
      });
      return applicability;
    },
  };
}

function predictedTransitions(config, input, callRef) {
  const state = input.stateProjection;
  const skillId = input.skillRef.id;
  const transition = (resultRef, nextState, coverage = "covered", unknown = []) => ({
    resultRef,
    preferenceOrder: config.forceDefer ? null : nextState.observedBranch === "reject" ? 2 : 1,
    semanticProgress: "progressed",
    continuation: nextState.finished || nextState.operations.includes("revise") || (config.rootEarly && skillId === SKILL_IDS.probe)
      ? {kind:"terminal",terminalKind:"root_satisfied",checkpointRef:null}
      : {kind:"continued",nextSkillRefs:[SKILL_REF_BY_ID.get(selectNextSkill(config,{state:nextState}))]},
    projection:{terminalSatisfaction:100,riskLevels:[],cost:{amount:1,unit:"action"}},
    predictedState: {
      kind: "predicted",
      projection: { state: nextState, evidence: [] },
      assumptions: [],
      unknown,
      source: {
        modelRef: BOUNDED_FINITE_RESULT_MODEL_REF,
        predictionCallRef: `${callRef}:${resultRef}`,
      },
    },
    predictedEffects: [],
    applicability: {
      kind: skillId === selectNextSkill(config,{state}) && !(config.scenario.startsWith("document") && state.operations.includes("revise")) ? "applicable" : "inapplicable",
      reason: "finite transition prerequisite is its current phase",
      evidenceRefs: [],
    },
    coverage,
    unknown,
    preconditions: [],
  });

  if (skillId === SKILL_IDS.probe) {
    const branches =
      config.includeInitialAlternatives && !config.changedPremise
        ? ["approve", "reject"]
        : state.observedBranch === null
          ? ["approve"]
          : [state.observedBranch];
    return branches.map(branch =>
      transition(
        `result:probe:${branch}`,
        {
          ...state,
          phase: "branch-observed",
          observedBranch: branch,
          revision: state.revision + 1,
        },
        config.truncated ? "truncated" : "covered",
        config.truncated
          ? [{ ref: `unknown:probe:${branch}`, reason: "prediction horizon ended" }]
          : [],
      ),
    );
  }
  if (skillId === SKILL_IDS.approve || skillId === SKILL_IDS.reject) {
    const branch = skillId === SKILL_IDS.approve ? "approve" : "reject";
    return [
      transition(`result:branch:${branch}:succeeded`, {
        ...state,
        phase: "branch-selected",
        selectedBranch: branch,
        pathSucceeded: true,
        revision: state.revision + 1,
      }),
    ];
  }
  if (skillId === SKILL_IDS.finish) {
    return [
      transition("result:branch:finished", {
        ...state,
        phase: "done",
        finished: true,
        revision: state.revision + 1,
      }),
    ];
  }
  if (skillId === SKILL_IDS.title) {
    return [
      transition("result:document:title", {
        ...state,
        phase: "document-title",
        titleValid: true,
        operations: [...state.operations, "title"],
        revision: state.revision + 1,
      }),
    ];
  }
  if (skillId === SKILL_IDS.owner) {
    return [
      transition("result:document:owner", {
        ...state,
        phase: "document-owner",
        owner: "agent",
        operations: [...state.operations, "owner"],
        revision: state.revision + 1,
      }),
    ];
  }
  if (skillId === SKILL_IDS.revise) {
    return [
      transition("result:document:revise", {
        ...state,
        phase: "document-revised",
        titleValid: true,
        operations: [...state.operations, "revise"],
        revision: state.revision + 1,
      }),
    ];
  }
  if (skillId === SKILL_IDS.changePremise) {
    return [
      transition("result:premise:changed", {
        ...state,
        premise: "changed",
        revision: state.revision + 1,
      }),
    ];
  }
  return [{ ...transition("result:unsupported", state, "unknown"), coverage: "unknown" }];
}

function evaluateGoal(config, input) {
  const state = input.state;
  const evidenceRefs = input.evidence
    .filter(evidence => evidence.validity === "valid" && evidence.payload.revision===state.revision)
    .map(evidence => evidence.id);
  let satisfaction = 0;
  let necessaryConditionsMet = false;
  if (input.goal.kind === "finite.bounded-root") {
    if (config.rootEarly) {
      necessaryConditionsMet = state.operations.includes("probe");
      satisfaction = necessaryConditionsMet ? 100 : 0;
    } else {
      necessaryConditionsMet =
        state.finished &&
        state.pathSucceeded &&
        state.selectedBranch === input.bindings.expectedBranch;
      satisfaction =
        (state.observedBranch === null ? 0 : 25) +
        (state.pathSucceeded ? 50 : 0) +
        (state.finished ? 25 : 0);
    }
  } else if (input.goal.kind === "finite.bounded-document") {
    necessaryConditionsMet =
      state.titleValid &&
      state.owner === "agent" &&
      state.operations.includes("title") &&
      state.operations.includes("owner") &&
      state.operations.includes("revise");
    satisfaction =
      (state.operations.includes("title") ? 20 : 0) +
      (state.operations.includes("owner") ? 20 : 0) +
      (state.operations.includes("revise") ? 20 : 0) +
      (state.owner === "agent" ? 20 : 0) +
      (state.titleValid ? 20 : 0);
  } else if (input.goal.kind === "finite.bounded-checkpoint") {
    necessaryConditionsMet =
      state.pathSucceeded &&
      state.selectedBranch === input.bindings.expectedBranch;
    satisfaction = necessaryConditionsMet ? 100 : 0;
  }
  const satisfied =
    satisfaction >= input.satisfactionThreshold &&
    necessaryConditionsMet &&
    evidenceRefs.length > 0;
  return {
    evaluatorId: BOUNDED_FINITE_EVALUATOR_ID,
    result: satisfied ? "satisfied" : "unsatisfied",
    satisfaction: Math.max(0, Math.min(100, satisfaction)),
    necessaryConditionsMet,
    evidenceRefs: satisfied ? evidenceRefs : [],
  };
}

function selectNextSkill(config, input) {
  const state = input.state;
  if (config.scenario.startsWith("document")) {
    if (!state.operations.includes("title")) return SKILL_IDS.title;
    if (!state.operations.includes("owner")) return SKILL_IDS.owner;
    if (!state.operations.includes("revise")) return SKILL_IDS.revise;
    return SKILL_IDS.finish;
  }
  if (state.observedBranch === null) return SKILL_IDS.probe;
  if (
    config.changedPremise &&
    state.attemptFailed &&
    !state.pathSucceeded &&
    state.premise === "same"
  ) {
    return SKILL_IDS.changePremise;
  }
  if (!state.pathSucceeded) {
    return state.observedBranch === "approve"
      ? SKILL_IDS.approve
      : SKILL_IDS.reject;
  }
  return SKILL_IDS.finish;
}

function executeAtomicGoal(config, input, memory) {
  const state = input.state;
  const skillId = input.skill.id;
  if (skillId === SKILL_IDS.probe && config.unknownProbe) {
    return {
      runId: input.context.requestId,
      executorInvoked: "unknown",
      outcome: "unknown",
      sourceResult: {
        tag: "finite.bounded",
        value: { operation: "probe", outcome: "unknown" },
      },
      newState: null,
      evidence: [],
      executionErrors: [],
      verificationErrors: [],
      effect: {
        knowledge: "unknown",
        confirmedEffects: [],
        receiptRef: "finite://unknown-probe",
      },
    };
  }
  if (
    (skillId === SKILL_IDS.approve || skillId === SKILL_IDS.reject) &&
    skillId === SKILL_IDS.approve &&
    ((config.failSelected && memory.atomicExecutions.filter(id => id === SKILL_IDS.approve).length === 1) ||
      (state.blockedTransition?.skillId === skillId && state.blockedTransition?.premise === state.premise))
  ) {
    return failedReceipt(input, "selected-branch-failed");
  }

  const sequence = state.revision + 1;
  const stateId = `finite:bounded:state:${sequence}`;
  const evidenceId = `finite:bounded:evidence:${sequence}`;
  let nextState = { ...state, revision: sequence };
  let resultRef = "result:noop";
  let operation = "unknown";
  if (skillId === SKILL_IDS.probe) {
    nextState = {
      ...nextState,
      phase: "branch-observed",
      observedBranch: input.bindings.actualBranch,
      operations: [...nextState.operations, "probe"],
    };
    resultRef = `result:probe:${input.bindings.actualBranch}`;
    operation = "probe";
  } else if (skillId === SKILL_IDS.approve || skillId === SKILL_IDS.reject) {
    const branch = skillId === SKILL_IDS.approve ? "approve" : "reject";
    if (branch !== state.observedBranch) {
      return failedReceipt(input, "unselected-branch");
    }
    nextState = {
      ...nextState,
      phase: "branch-selected",
      selectedBranch: branch,
      pathSucceeded: true,
      operations: [...nextState.operations, branch],
    };
    resultRef = `result:branch:${branch}:succeeded`;
    operation = branch;
  } else if (skillId === SKILL_IDS.finish) {
    nextState = { ...nextState, phase: "done", finished: true };
    resultRef = "result:branch:finished";
    operation = "finish";
  } else if (skillId === SKILL_IDS.title) {
    nextState = {
      ...nextState,
      phase: "document-title",
      titleValid: true,
      operations: [...nextState.operations, "title"],
    };
    resultRef = "result:document:title";
    operation = "title";
  } else if (skillId === SKILL_IDS.owner) {
    nextState = {
      ...nextState,
      phase: "document-owner",
      owner: "agent",
      operations: [...nextState.operations, "owner"],
    };
    resultRef = "result:document:owner";
    operation = "owner";
  } else if (skillId === SKILL_IDS.revise) {
    nextState = {
      ...nextState,
      phase: "document-revised",
      titleValid: false,
      operations: [...nextState.operations, "revise"],
    };
    resultRef = "result:document:revise";
    operation = "revise";
  } else if (skillId === SKILL_IDS.changePremise) {
    nextState = { ...nextState, premise: "changed" };
    resultRef = "result:premise:changed";
    operation = "change-premise";
  }
  return {
    runId: input.context.requestId,
    executorInvoked: true,
    outcome: "succeeded",
    sourceResult: {
      tag: "finite.bounded",
      value: { operation, resultRef },
    },
    newState: { id: stateId, value: nextState },
    evidence: [
      {
        id: evidenceId,
        stateRef: stateId,
        payload: {
          kind: "finite.bounded-evidence",
          goalId: input.goal.goalId,
          resultRef,
          operation,
          revision:nextState.revision,
        },
        validity: "valid",
      },
    ],
    executionErrors: [],
    verificationErrors: [],
    effect: {
      knowledge: "none",
      confirmedEffects: [],
      receiptRef: null,
    },
  };
}

function failedReceipt(input, category) {
  const stateId=`${input.context.requestId}:failed-state:${input.state.revision+1}`;
  const blockedTransition = category === "selected-branch-failed"
    ? {skillId: input.skill.id, premise: input.state.premise, resultRef: "result:branch:approve:succeeded"}
    : null;
  return {
    runId: input.context.requestId,
    executorInvoked: true,
    outcome: "failed",
    sourceResult: {
      tag: "finite.bounded",
      value: { operation: "failed", category },
    },
    newState: {id:stateId,value:{...input.state,attemptFailed:true,blockedTransition,revision:input.state.revision+1}},
    evidence: [{id:`${stateId}:evidence`,stateRef:stateId,validity:"valid",payload:{kind:"finite.bounded-evidence",goalId:input.goal.goalId,resultRef:"result:failed",operation:"failure-observation",blockedTransition,revision:input.state.revision+1}}],
    executionErrors: [
      {
        diagnosticId: `finite:bounded:error:${category}`,
        code: "execution_failed",
        stage: "execution",
        message: "bounded finite selected transition failed",
        sourceCategory: category,
        nativeCode: null,
        refs: [],
      },
    ],
    verificationErrors: [],
    effect: {
      knowledge: "none",
      confirmedEffects: [],
      receiptRef: null,
    },
  };
}

function resultRefForActual(skillId, state) {
  if (skillId === SKILL_IDS.probe) {
    return state.observedBranch === null
      ? "result:probe:unknown"
      : `result:probe:${state.observedBranch}`;
  }
  if (skillId === SKILL_IDS.approve || skillId === SKILL_IDS.reject) {
    const branch = skillId === SKILL_IDS.approve ? "approve" : "reject";
    return state.pathSucceeded
      ? `result:branch:${branch}:succeeded`
      : `result:branch:${branch}:failed`;
  }
  if (skillId === SKILL_IDS.finish) return "result:branch:finished";
  if (skillId === SKILL_IDS.title) return "result:document:title";
  if (skillId === SKILL_IDS.owner) return "result:document:owner";
  if (skillId === SKILL_IDS.revise) return "result:document:revise";
  if (skillId === SKILL_IDS.changePremise) return "result:premise:changed";
  return "result:unsupported";
}

function expectedRootGoalKind(config) {
  return config.scenario.startsWith("document")
    ? "finite.bounded-document"
    : "finite.bounded-root";
}

function guardGoal(value) {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new TypeError("bounded finite goal must be an object with kind");
  }
  return value;
}

function guardBindings(value) {
  if (!isRecord(value) || value.kind !== "finite.bounded-bindings") {
    throw new TypeError("bounded finite bindings are invalid");
  }
  return value;
}

function guardState(value) {
  if (!isRecord(value) || value.kind !== "finite.bounded-state") {
    throw new TypeError("bounded finite state is invalid");
  }
  return value;
}

function guardEvidence(value) {
  if (!isRecord(value) || value.kind !== "finite.bounded-evidence") {
    throw new TypeError("bounded finite evidence is invalid");
  }
  return value;
}

function guardEffect(value) {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new TypeError("bounded finite effect is invalid");
  }
  return value;
}

function guardCursor(value) {
  if (!isRecord(value)) {
    throw new TypeError("bounded finite cursor must be an object");
  }
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const input = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const resources = createBoundedFiniteResources(input.options ?? {});
    const step = await runBoundedFiniteStep(resources, input.continuation ?? null);
    console.log(
      JSON.stringify({
        response: step.response,
        memory: resources.memory,
      }),
    );
    return;
  }
  const run = await runBoundedFiniteScenario({});
  console.log(JSON.stringify(summarizeBoundedFiniteRun(run), null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
