import { isDeepStrictEqual } from "node:util";

export const FINITE_SEARCH_COMPOSITE_SKILL_ID = "finite.compose";
export const FINITE_SEARCH_ATOMIC_SKILL_ID = "finite.atomic";

const EVALUATOR_ID = "finite.typed.evaluator";
const SELECTOR_ID = "finite.selector";
const RANGE_SIZE = 10;
const SLICE_SIZE = 2;

const COMPOSITE_SKILL = Object.freeze({
  id: FINITE_SEARCH_COMPOSITE_SKILL_ID,
  version: "1.0.0",
  mode: "composite",
  capability: "finite.typed.compose",
  evaluatorId: EVALUATOR_ID,
  requiredEffects: [],
  allowedEffects: [],
  retry: "never",
  effectClass: "none",
});

const ATOMIC_SKILL = Object.freeze({
  id: FINITE_SEARCH_ATOMIC_SKILL_ID,
  version: "1.0.0",
  mode: "atomic",
  capability: "finite.typed.atomic",
  evaluatorId: EVALUATOR_ID,
  requiredEffects: [],
  allowedEffects: [],
  retry: "never",
  effectClass: "none",
});

const ENABLED_EVALUATOR = Object.freeze({
  id: EVALUATOR_ID,
  goalType: "finite.typed-goal",
  thresholdContract: "0..100",
  allowsPartialSatisfaction: true,
});

const SELECTORS = Object.freeze([
  Object.freeze({
    id: SELECTOR_ID,
    skillIds: Object.freeze([
      FINITE_SEARCH_COMPOSITE_SKILL_ID,
      FINITE_SEARCH_ATOMIC_SKILL_ID,
    ]),
  }),
]);

const COMPOSITE_GOAL_KINDS = new Set([
  "search_success",
  "coverage",
  "coverage_slice",
  "document_ready",
  "document_prepare",
  "document_configure",
  "branch_ready",
]);

const ATOMIC_GOAL_KINDS = new Set([
  "coverage_item",
  "match_found",
  "document_identity",
  "document_field",
  "branch_probe",
  "branch_path",
  "branch_finish",
]);

export function createFiniteSearchHarness(name, options = {}) {
  const config = createScenarioConfig(name, options);
  const adapter = createFiniteSearchAdapter(config);
  const request = {
    schema: "nnanything.recursive-goal.request.v1",
    requestId: `finite-${name}-${options.threshold ?? "default"}-${options.observedBranch ?? "none"}`,
    rootGoal: config.rootGoal,
    satisfactionThreshold: config.satisfactionThreshold,
    rootBindings: config.bindings,
    state: config.initialState,
    rootEvaluatorId: EVALUATOR_ID,
    rootSelectorId: SELECTOR_ID,
    limits: {
      maxTransitions: 240,
      maxDepth: 6,
      maxDerivedGoals: 48,
    },
  };
  return {
    request,
    dependencies: {
      adapter,
      enabledSkills: [COMPOSITE_SKILL, ATOMIC_SKILL],
      enabledEvaluators: [ENABLED_EVALUATOR],
      selectors: SELECTORS,
      comparators: {
        sameGoal: (left, right) => isDeepStrictEqual(left, right),
        sameBindings: (left, right) => isDeepStrictEqual(left, right),
        sameFacts: (left, right) => isDeepStrictEqual(left, right),
      },
      grantedEffects: new Set(),
    },
    scenario: name,
  };
}

function createScenarioConfig(name, options) {
  if (name === "search") {
    const threshold = options.threshold ?? 60;
    if (threshold !== 60 && threshold !== 100) {
      throw new TypeError("search threshold must be 60 or 100");
    }
    const matchAt = options.matchAt === undefined ? 4 : options.matchAt;
    if (matchAt !== null && (!Number.isInteger(matchAt) || matchAt < 0 || matchAt >= RANGE_SIZE)) {
      throw new TypeError("search matchAt must be null or a range index");
    }
    return {
      kind: "search",
      satisfactionThreshold: threshold,
      rootGoal: { kind: "search_success", rangeId: "range-10" },
      bindings: {
        kind: "search_range",
        rangeId: "range-10",
        items: Array.from({ length: RANGE_SIZE }, (_, index) => `item-${index + 1}`),
        matchAt,
      },
      initialState: {
        kind: "search_state",
        checked: [],
        matchFound: null,
      },
    };
  }

  if (name === "document") {
    return {
      kind: "document",
      satisfactionThreshold: 100,
      rootGoal: { kind: "document_ready", documentId: "document-1" },
      bindings: { kind: "document_binding", documentId: "document-1" },
      initialState: {
        kind: "document_state",
        identityBound: false,
        title: null,
        owner: null,
        titleValid: false,
        operations: [],
      },
    };
  }

  if (name === "branch") {
    const observedBranch = options.observedBranch ?? "approve";
    if (observedBranch !== "approve" && observedBranch !== "reject") {
      throw new TypeError("branch must be approve or reject");
    }
    return {
      kind: "branch",
      satisfactionThreshold: 100,
      rootGoal: { kind: "branch_ready", branchId: "branch-1" },
      bindings: {
        kind: "branch_binding",
        branchId: "branch-1",
        observedBranch,
        failSelected: options.failSelected === true,
      },
      initialState: {
        kind: "branch_state",
        observedBranch: null,
        selectedPath: null,
        pathSucceeded: false,
        finished: false,
      },
    };
  }

  throw new TypeError(`unknown finite search scenario: ${name}`);
}

function createFiniteSearchAdapter(config) {
  return {
    async validateRequest(request) {
      if (request.rootGoal?.kind !== config.rootGoal.kind) {
        throw new TypeError("root goal does not belong to the finite search scenario");
      }
      if (request.rootBindings?.kind !== config.bindings.kind) {
        throw new TypeError("root bindings do not belong to the finite search scenario");
      }
      if (request.state?.kind !== config.initialState.kind) {
        throw new TypeError("state does not belong to the finite search scenario");
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
      };
    },

    supports({ goal, skill }) {
      return (
        (skill.id === FINITE_SEARCH_COMPOSITE_SKILL_ID &&
          COMPOSITE_GOAL_KINDS.has(goal.kind)) ||
        (skill.id === FINITE_SEARCH_ATOMIC_SKILL_ID && ATOMIC_GOAL_KINDS.has(goal.kind))
      );
    },

    async evaluate(input) {
      return evaluateGoal(input);
    },

    async select(input) {
      const requiredSkillId = COMPOSITE_GOAL_KINDS.has(input.goal.kind)
        ? FINITE_SEARCH_COMPOSITE_SKILL_ID
        : ATOMIC_GOAL_KINDS.has(input.goal.kind)
          ? FINITE_SEARCH_ATOMIC_SKILL_ID
          : null;
      const selected = input.candidates.find(skill => skill.id === requiredSkillId);
      if (!selected) {
        return {
          kind: "no_capability",
          searchedSkillIds: input.candidates.map(skill => skill.id),
        };
      }
      return { kind: "selected", skillId: selected.id };
    },

    async derive(input) {
      return deriveGoal(config, input);
    },

    async executeAtomic(input) {
      return executeAtomicGoal(input);
    },

    validateAtomicReceipt(raw) {
      return readAtomicReceipt(raw);
    },

    measureProgress({ before, after, previousEvaluation, currentEvaluation }) {
      const comparable =
        previousEvaluation.satisfaction !== null && currentEvaluation.satisfaction !== null;
      const improved =
        comparable && currentEvaluation.satisfaction > previousEvaluation.satisfaction;
      return {
        improved,
        reason: improved ? "facts_improved" : "none",
        comparable,
      };
    },
  };
}

function evaluateGoal(input) {
  const { goal, satisfactionThreshold, state, evidence } = input;

  if (goal.kind === "search_success") {
    const coverageSatisfaction = coverageSatisfactionFor(state);
    const matchEvidence = evidenceRefs(evidence, "search_match", goal.rangeId);
    const evidenceRefsForGoal = [
      ...evidenceRefs(evidence, "search_item", goal.rangeId),
      ...matchEvidence,
    ];
    const necessaryConditionsMet =
      coverageSatisfaction >= satisfactionThreshold && state.matchFound === true;
    return evaluation(
      coverageSatisfaction,
      necessaryConditionsMet,
      evidenceRefsForGoal,
      satisfactionThreshold,
    );
  }

  if (goal.kind === "coverage") {
    const satisfaction = coverageSatisfactionFor(state);
    return evaluation(
      satisfaction,
      true,
      evidenceRefs(evidence, "search_item", goal.rangeId),
      satisfactionThreshold,
    );
  }

  if (goal.kind === "coverage_slice") {
    const indices = sliceIndices(goal);
    const checked = new Set(state.checked.map(item => item.index));
    const completed = indices.filter(index => checked.has(index)).length;
    const satisfaction = indices.length === 0 ? 0 : (completed / indices.length) * 100;
    return evaluation(
      satisfaction,
      true,
      evidenceRefs(evidence, "search_item", goal.rangeId),
    );
  }

  if (goal.kind === "coverage_item") {
    const checked = state.checked.some(item => item.index === goal.index);
    return evaluation(
      checked ? 100 : 0,
      true,
      checked ? evidenceRefs(evidence, "search_item", goal.rangeId) : [],
    );
  }

  if (goal.kind === "match_found") {
    if (state.matchFound === null) {
      return {
        evaluatorId: EVALUATOR_ID,
        result: "unknown",
        satisfaction: null,
        necessaryConditionsMet: false,
        evidenceRefs: [],
      };
    }
    return evaluation(
      state.matchFound ? 100 : 0,
      true,
      evidenceRefs(evidence, "search_match", goal.rangeId),
    );
  }

  if (goal.kind === "document_ready") {
    return evaluation(
      documentReadiness(state),
      documentReady(state),
      evidenceRefs(evidence, "document_action", goal.documentId),
    );
  }

  if (goal.kind === "document_prepare" || goal.kind === "document_identity") {
    return evaluation(
      state.identityBound ? 100 : 0,
      true,
      evidenceRefs(evidence, "document_action", goal.documentId),
    );
  }

  if (goal.kind === "document_configure") {
    const requiredOperations = ["title", "owner", "revise"];
    const completed = requiredOperations.filter(operation =>
      state.operations.includes(operation),
    ).length;
    const satisfaction = (completed / requiredOperations.length) * 100;
    return evaluation(
      satisfaction,
      completed === requiredOperations.length && state.titleValid,
      evidenceRefs(evidence, "document_action", goal.documentId),
    );
  }

  if (goal.kind === "document_field") {
    const completed = state.operations.includes(goal.field);
    const satisfied =
      goal.field === "title"
        ? state.titleValid
        : goal.field === "owner"
          ? completed && state.owner === "Agent"
          : completed;
    return evaluation(
      satisfied ? 100 : 0,
      true,
      evidenceRefs(evidence, "document_action", goal.documentId),
    );
  }

  if (goal.kind === "branch_ready") {
    const satisfied =
      state.pathSucceeded && state.selectedPath === input.bindings.observedBranch && state.finished;
    const satisfaction =
      (state.pathSucceeded ? 50 : 0) +
      (state.selectedPath === input.bindings.observedBranch ? 25 : 0) +
      (state.finished ? 25 : 0);
    return evaluation(
      satisfaction,
      state.pathSucceeded && state.finished,
      evidenceRefs(evidence, "branch_transition", goal.branchId),
    );
  }

  if (goal.kind === "branch_probe") {
    return evaluation(
      state.observedBranch === null ? 0 : 100,
      true,
      evidenceRefs(evidence, "branch_probe", goal.branchId),
    );
  }

  if (goal.kind === "branch_path") {
    const satisfied = state.pathSucceeded && state.selectedPath === goal.branch;
    return evaluation(
      satisfied ? 100 : 0,
      true,
      evidenceRefs(evidence, "branch_transition", goal.branchId),
    );
  }

  if (goal.kind === "branch_finish") {
    return evaluation(
      state.finished ? 100 : 0,
      true,
      evidenceRefs(evidence, "branch_transition", goal.branchId),
    );
  }

  throw new TypeError(`unsupported finite goal ${goal.kind}`);
}

function evaluation(
  satisfaction,
  necessaryConditionsMet,
  evidenceRefsForGoal,
  satisfactionThreshold = 100,
) {
  const numeric = Math.max(0, Math.min(100, satisfaction));
  const satisfied =
    numeric >= satisfactionThreshold &&
    necessaryConditionsMet &&
    evidenceRefsForGoal.length > 0
      ? "satisfied"
      : "unsatisfied";
  return {
    evaluatorId: EVALUATOR_ID,
    result: satisfied,
    satisfaction: numeric,
    necessaryConditionsMet,
    evidenceRefs: evidenceRefsForGoal,
  };
}

function evidenceRefs(evidence, kind, ownerId) {
  return evidence
    .filter(
      record =>
        record.validity === "valid" &&
        record.payload?.kind === kind &&
        record.payload?.ownerId === ownerId,
    )
    .map(record => record.id);
}

function coverageSatisfactionFor(state) {
  return (new Set(state.checked.map(item => item.index)).size / RANGE_SIZE) * 100;
}

function documentReadiness(state) {
  return (
    (state.identityBound ? 20 : 0) +
    (state.operations.includes("title") ? 20 : 0) +
    (state.operations.includes("owner") ? 20 : 0) +
    (state.operations.includes("revise") ? 20 : 0) +
    (state.titleValid ? 20 : 0)
  );
}

function documentReady(state) {
  return (
    state.identityBound &&
    state.operations.includes("title") &&
    state.operations.includes("owner") &&
    state.operations.includes("revise") &&
    state.titleValid
  );
}

function deriveGoal(config, input) {
  if (input.goal.kind === "search_success") {
    if (input.conditions.length > 0) {
      return closedDerivation({ stage: "search", done: true });
    }
    return {
      conditions: [
        condition({
          id: "condition:search:coverage",
          goal: { kind: "coverage", rangeId: input.goal.rangeId },
          bindings: input.bindings,
          satisfactionThreshold: input.satisfactionThreshold,
          mode: "composite",
          dependsOn: [],
          lifetime: "persistent",
        }),
        condition({
          id: "condition:search:match",
          goal: { kind: "match_found", rangeId: input.goal.rangeId },
          bindings: input.bindings,
          satisfactionThreshold: 100,
          mode: "atomic",
          dependsOn: ["condition:search:coverage"],
          lifetime: "persistent",
        }),
      ],
      nextCursor: { stage: "search", done: true },
      expansion: "closed",
    };
  }

  if (input.goal.kind === "coverage") {
    const requiredCount = Math.ceil(input.satisfactionThreshold / 10);
    if (input.state.checked.length >= requiredCount) {
      return closedDerivation({ stage: "coverage", nextIndex: input.state.checked.length });
    }
    const start = input.state.checked.length;
    const size = Math.min(SLICE_SIZE, requiredCount - start, RANGE_SIZE - start);
    return {
      conditions: [
        condition({
          id: `condition:coverage:slice-${start}`,
          goal: { kind: "coverage_slice", rangeId: input.goal.rangeId, start, size },
          bindings: input.bindings,
          satisfactionThreshold: 100,
          mode: "composite",
          dependsOn: [],
          lifetime: "persistent",
        }),
      ],
      nextCursor: { stage: "coverage", nextIndex: start + size },
      expansion: start + size < requiredCount ? "more" : "closed",
    };
  }

  if (input.goal.kind === "coverage_slice") {
    if (input.conditions.length > 0) {
      return closedDerivation({ stage: "slice", done: true });
    }
    const indices = sliceIndices(input.goal);
    return {
      conditions: indices.map((index, offset) =>
        condition({
          id: `condition:coverage:item-${index}`,
          goal: {
            kind: "coverage_item",
            rangeId: input.goal.rangeId,
            index,
          },
          bindings: input.bindings,
          satisfactionThreshold: 100,
          mode: "atomic",
          dependsOn: offset === 0 ? [] : [`condition:coverage:item-${indices[offset - 1]}`],
          lifetime: "persistent",
        }),
      ),
      nextCursor: { stage: "slice", done: true },
      expansion: "closed",
    };
  }

  if (input.goal.kind === "document_ready") {
    if (input.conditions.length > 0) {
      return closedDerivation({ stage: "document", done: true });
    }
    return {
      conditions: [
        condition({
          id: "condition:document:prepare",
          goal: { kind: "document_prepare", documentId: input.goal.documentId },
          bindings: input.bindings,
          satisfactionThreshold: 100,
          mode: "composite",
          dependsOn: [],
          lifetime: "stage",
        }),
      ],
      nextCursor: { stage: "document", done: true },
      expansion: "closed",
    };
  }

  if (input.goal.kind === "document_prepare") {
    if (input.conditions.length > 0) {
      return closedDerivation({ stage: "prepare", done: true });
    }
    return {
      conditions: [
        condition({
          id: "condition:prepare:identity",
          goal: { kind: "document_identity", documentId: input.goal.documentId },
          bindings: input.bindings,
          satisfactionThreshold: 100,
          mode: "atomic",
          dependsOn: [],
          lifetime: "stage",
        }),
        condition({
          id: "condition:prepare:configure",
          goal: { kind: "document_configure", documentId: input.goal.documentId },
          bindings: input.bindings,
          satisfactionThreshold: 100,
          mode: "composite",
          dependsOn: ["condition:prepare:identity"],
          lifetime: "stage",
        }),
      ],
      nextCursor: { stage: "prepare", done: true },
      expansion: "closed",
    };
  }

  if (input.goal.kind === "document_configure") {
    if (input.conditions.length > 0) {
      return closedDerivation({ stage: "configure", done: true });
    }
    return {
      conditions: [
        condition({
          id: "condition:configure:title",
          goal: { kind: "document_field", documentId: input.goal.documentId, field: "title" },
          bindings: input.bindings,
          satisfactionThreshold: 100,
          mode: "atomic",
          dependsOn: [],
          lifetime: "persistent",
        }),
        condition({
          id: "condition:configure:owner",
          goal: { kind: "document_field", documentId: input.goal.documentId, field: "owner" },
          bindings: input.bindings,
          satisfactionThreshold: 100,
          mode: "atomic",
          dependsOn: ["condition:configure:title"],
          lifetime: "stage",
        }),
        condition({
          id: "condition:configure:revise",
          goal: { kind: "document_field", documentId: input.goal.documentId, field: "revise" },
          bindings: input.bindings,
          satisfactionThreshold: 100,
          mode: "atomic",
          dependsOn: ["condition:configure:owner"],
          lifetime: "stage",
        }),
      ],
      nextCursor: { stage: "configure", done: true },
      expansion: "closed",
    };
  }

  if (input.goal.kind === "branch_ready") {
    if (input.state.observedBranch === null) {
      return {
        conditions: [
          condition({
            id: "condition:branch:probe",
            goal: { kind: "branch_probe", branchId: input.goal.branchId },
            bindings: input.bindings,
            satisfactionThreshold: 100,
            mode: "atomic",
            dependsOn: [],
            lifetime: "stage",
          }),
        ],
        nextCursor: { stage: "branch", probeObserved: false },
        expansion: "more",
      };
    }
    if (
      input.conditions.some(conditionResult =>
        ["condition:branch:approve", "condition:branch:reject"].includes(
          conditionResult.conditionId,
        ),
      )
    ) {
      return closedDerivation({ stage: "branch", done: true });
    }
    const selectedConditionId =
      input.state.observedBranch === "approve"
        ? "condition:branch:approve"
        : "condition:branch:reject";
    return {
      conditions: [
        condition({
          id: "condition:branch:approve",
          goal: { kind: "branch_path", branchId: input.goal.branchId, branch: "approve" },
          bindings: input.bindings,
          satisfactionThreshold: 100,
          mode: "atomic",
          dependsOn: [],
          lifetime: "stage",
          activation: input.state.observedBranch === "approve" ? "required" : "not_applicable",
        }),
        condition({
          id: "condition:branch:reject",
          goal: { kind: "branch_path", branchId: input.goal.branchId, branch: "reject" },
          bindings: input.bindings,
          satisfactionThreshold: 100,
          mode: "atomic",
          dependsOn: [],
          lifetime: "stage",
          activation: input.state.observedBranch === "reject" ? "required" : "not_applicable",
        }),
        condition({
          id: "condition:branch:finish",
          goal: { kind: "branch_finish", branchId: input.goal.branchId },
          bindings: input.bindings,
          satisfactionThreshold: 100,
          mode: "atomic",
          dependsOn: [selectedConditionId],
          lifetime: "stage",
        }),
      ],
      nextCursor: { stage: "branch", done: true },
      expansion: "closed",
    };
  }

  return closedDerivation({ stage: config.kind, done: true });
}

function condition({
  id,
  goal,
  bindings,
  satisfactionThreshold,
  mode,
  dependsOn,
  lifetime,
  activation = "required",
}) {
  return {
    id,
    goal,
    bindings,
    satisfactionThreshold,
    evaluatorId: EVALUATOR_ID,
    selectorId: SELECTOR_ID,
    mode,
    dependsOn,
    lifetime,
    activation,
    allowedEffects: [],
  };
}

function closedDerivation(nextCursor) {
  return {
    conditions: [],
    nextCursor,
    expansion: "closed",
  };
}

function sliceIndices(goal) {
  return Array.from({ length: goal.size }, (_, offset) => goal.start + offset);
}

function executeAtomicGoal(input) {
  if (input.goal.kind === "coverage_item") {
    const { index } = input.goal;
    const value = input.bindings.items[index];
    if (typeof value !== "string") {
      return failedReceipt(input, "invalid-coverage-item", "coverage item is outside the range");
    }
    const nextState = {
      ...input.state,
      checked: input.state.checked.some(item => item.index === index)
        ? input.state.checked
        : [...input.state.checked, { index, value }],
    };
    return succeededReceipt(
      input,
      nextState,
      {
        operation: "check-item",
        rangeId: input.goal.rangeId,
        index,
        value,
      },
      {
        kind: "search_item",
        ownerId: input.goal.rangeId,
        rangeId: input.goal.rangeId,
        index,
        value,
      },
    );
  }

  if (input.goal.kind === "match_found") {
    const checkedIndices = input.state.checked.map(item => item.index);
    const matchFound =
      input.bindings.matchAt !== null && checkedIndices.includes(input.bindings.matchAt);
    const nextState = {
      ...input.state,
      matchFound,
    };
    return succeededReceipt(
      input,
      nextState,
      {
        operation: "find-match",
        matchFound,
        checkedIndices,
      },
      {
        kind: "search_match",
        ownerId: input.goal.rangeId,
        rangeId: input.goal.rangeId,
        matchFound,
        checkedIndices,
      },
    );
  }

  if (input.goal.kind === "document_identity") {
    const nextState = { ...input.state, identityBound: true };
    return succeededReceipt(
      input,
      nextState,
      {
        operation: "bind-document-identity",
        documentId: input.goal.documentId,
      },
      documentEvidence(input.goal.documentId, "identity", nextState),
    );
  }

  if (input.goal.kind === "document_field") {
    const operations = input.state.operations.includes(input.goal.field)
      ? input.state.operations
      : [...input.state.operations, input.goal.field];
    const nextState =
      input.goal.field === "title"
        ? { ...input.state, title: "Draft title", titleValid: true, operations }
        : input.goal.field === "owner"
          ? { ...input.state, owner: "Agent", operations }
          : { ...input.state, title: "Invalidated title", titleValid: false, operations };
    return succeededReceipt(
      input,
      nextState,
      {
        operation: "set-document-field",
        documentId: input.goal.documentId,
        field: input.goal.field,
      },
      documentEvidence(input.goal.documentId, input.goal.field, nextState),
    );
  }

  if (input.goal.kind === "branch_probe") {
    const nextState = {
      ...input.state,
      observedBranch: input.bindings.observedBranch,
    };
    return succeededReceipt(
      input,
      nextState,
      {
        operation: "observe-branch",
        branchId: input.goal.branchId,
        observedBranch: input.bindings.observedBranch,
      },
      {
        kind: "branch_probe",
        ownerId: input.goal.branchId,
        branchId: input.goal.branchId,
        observedBranch: input.bindings.observedBranch,
      },
    );
  }

  if (input.goal.kind === "branch_path") {
    if (input.goal.branch !== input.bindings.observedBranch) {
      return failedReceipt(
        input,
        "unselected-branch",
        "adapter was asked to execute an unselected branch",
      );
    }
    if (input.bindings.failSelected) {
      return failedReceipt(
        input,
        "selected-branch-failed",
        "selected branch failed after the branch was observed",
      );
    }
    const nextState = {
      ...input.state,
      selectedPath: input.goal.branch,
      pathSucceeded: true,
    };
    return succeededReceipt(
      input,
      nextState,
      {
        operation: "execute-branch",
        branchId: input.goal.branchId,
        branch: input.goal.branch,
      },
      {
        kind: "branch_transition",
        ownerId: input.goal.branchId,
        branchId: input.goal.branchId,
        branch: input.goal.branch,
        transition: "branch-executed",
      },
    );
  }

  if (input.goal.kind === "branch_finish") {
    const nextState = { ...input.state, finished: true };
    return succeededReceipt(
      input,
      nextState,
      {
        operation: "finish-branch",
        branchId: input.goal.branchId,
      },
      {
        kind: "branch_transition",
        ownerId: input.goal.branchId,
        branchId: input.goal.branchId,
        transition: "branch-finished",
      },
    );
  }

  return failedReceipt(input, "unsupported-atomic-goal", `unsupported ${input.goal.kind}`);
}

function documentEvidence(documentId, field, state) {
  return {
    kind: "document_action",
    ownerId: documentId,
    documentId,
    field,
    titleValid: state.titleValid,
    operations: state.operations,
  };
}

function succeededReceipt(input, nextState, sourceValue, evidencePayload) {
  const stateId = `state:${input.context.frameId}:${nextState.operations?.length ?? nextState.checked?.length ?? 1}`;
  const evidenceId = `evidence:${input.context.frameId}:${evidencePayload.kind}`;
  return {
    runId: input.context.requestId,
    executorInvoked: true,
    outcome: "succeeded",
    sourceResult: {
      tag: "finite.compute",
      value: sourceValue,
    },
    newState: {
      id: stateId,
      value: nextState,
    },
    evidence: [
      {
        id: evidenceId,
        stateRef: stateId,
        payload: evidencePayload,
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

function failedReceipt(input, category, message) {
  return {
    runId: input.context.requestId,
    executorInvoked: true,
    outcome: "failed",
    sourceResult: {
      tag: "finite.compute",
      value: {
        operation: "failed",
        category,
      },
    },
    newState: null,
    evidence: [],
    executionErrors: [
      {
        diagnosticId: `diagnostic:${input.context.frameId}:${category}`,
        code: "execution_failed",
        stage: "execution",
        sourceCategory: category,
        message,
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

function readAtomicReceipt(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("atomic receipt must be an object");
  }
  if (
    raw.executorInvoked !== true &&
    raw.executorInvoked !== false &&
    raw.executorInvoked !== "unknown"
  ) {
    throw new TypeError("atomic receipt executorInvoked is invalid");
  }
  if (!["succeeded", "failed", "rejected", "unknown"].includes(raw.outcome)) {
    throw new TypeError("atomic receipt outcome is invalid");
  }
  if (!Array.isArray(raw.evidence) || !Array.isArray(raw.executionErrors)) {
    throw new TypeError("atomic receipt collections are invalid");
  }
  if (!Array.isArray(raw.verificationErrors)) {
    throw new TypeError("atomic receipt verificationErrors is invalid");
  }
  if (raw.effect?.knowledge === "none" && raw.effect.confirmedEffects?.length > 0) {
    throw new TypeError("effect none cannot contain confirmed effects");
  }
  if (
    raw.effect?.knowledge === "known" ||
    raw.effect?.knowledge === "mixed"
  ) {
    if (!Array.isArray(raw.effect.confirmedEffects) || raw.effect.confirmedEffects.length === 0) {
      throw new TypeError("known or mixed effect requires confirmed effects");
    }
  }
  if (
    raw.newState !== null &&
    (typeof raw.newState !== "object" ||
      typeof raw.newState.id !== "string" ||
      typeof raw.newState.value !== "object" ||
      raw.newState.value === null)
  ) {
    throw new TypeError("newState is invalid");
  }
  return raw;
}
