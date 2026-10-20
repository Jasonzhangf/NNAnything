import {
  readAtomicReceipt,
  readRecursiveGoalContinuation,
} from "nnanything/recursive-goal";
import {
  validateDirectoryRef,
  validateExplicitFileState,
  validateSessionRef,
} from "nnanything/cli-goal";

export const ROOT_COMPOSITE_SKILL = "cwd.equals.composite";
export const OBSERVE_ATOMIC_SKILL = "cwd.observe.atomic";
export const EQUALS_ATOMIC_SKILL = "cwd.equals.atomic";
export const EQUALITY_EVALUATOR = "cwd-equality";
export const OBSERVE_EVALUATOR = "cwd-observed";
export const ROOT_SELECTOR = "cwd-root-selector";
export const OBSERVE_SELECTOR = "cwd-observe-selector";
export const EQUALS_SELECTOR = "cwd-equals-selector";

const CWD_EFFECTS = Object.freeze([
  "filesystem.read",
  "process.exec",
  "session.write",
]);

export const CWD_SKILLS = Object.freeze([
  Object.freeze({
    id: ROOT_COMPOSITE_SKILL,
    version: "1.0.0",
    mode: "composite",
    capability: "cwd.resolve",
    evaluatorId: EQUALITY_EVALUATOR,
    requiredEffects: Object.freeze([]),
    allowedEffects: CWD_EFFECTS,
    retry: "never",
    effectClass: "none",
  }),
  Object.freeze({
    id: OBSERVE_ATOMIC_SKILL,
    version: "1.0.0",
    mode: "atomic",
    capability: "cwd.observe",
    evaluatorId: OBSERVE_EVALUATOR,
    requiredEffects: Object.freeze(["filesystem.read", "process.exec"]),
    allowedEffects: Object.freeze(["filesystem.read", "process.exec"]),
    retry: "never",
    effectClass: "read_only",
  }),
  Object.freeze({
    id: EQUALS_ATOMIC_SKILL,
    version: "1.0.0",
    mode: "atomic",
    capability: "cwd.equals",
    evaluatorId: EQUALITY_EVALUATOR,
    requiredEffects: CWD_EFFECTS,
    allowedEffects: CWD_EFFECTS,
    retry: "never",
    effectClass: "mutating",
  }),
]);

export const CWD_EVALUATORS = Object.freeze([
  Object.freeze({
    id: EQUALITY_EVALUATOR,
    goalType: "cli.cwd.equals",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  }),
  Object.freeze({
    id: OBSERVE_EVALUATOR,
    goalType: "cli.cwd.observe",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  }),
]);

export const CWD_SELECTORS = Object.freeze([
  Object.freeze({ id: ROOT_SELECTOR, skillIds: Object.freeze([ROOT_COMPOSITE_SKILL]) }),
  Object.freeze({ id: OBSERVE_SELECTOR, skillIds: Object.freeze([OBSERVE_ATOMIC_SKILL]) }),
  Object.freeze({ id: EQUALS_SELECTOR, skillIds: Object.freeze([EQUALS_ATOMIC_SKILL]) }),
]);

export const CWD_COMPARATORS = Object.freeze({
  sameGoal: (left, right) => JSON.stringify(left) === JSON.stringify(right),
  sameBindings: (left, right) => JSON.stringify(left) === JSON.stringify(right),
  sameFacts: (left, right) => JSON.stringify(left) === JSON.stringify(right),
});

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty string without NUL`);
  }
  return value;
}

function absolutePath(value, label) {
  const path = nonEmpty(value, label);
  if (!path.startsWith("/")) throw new TypeError(`${label} must be absolute`);
  return path;
}

function readGoal(value) {
  if (!isRecord(value)) throw new TypeError("cwd goal must be an object");
  if (value.kind === "cli.cwd.observe") {
    exactKeys(value, ["kind"], "cwd observed goal");
    return Object.freeze({ kind: "cli.cwd.observe" });
  }
  if (value.kind === "cli.cwd.equals") {
    exactKeys(value, ["kind", "targetPhysical"], "cwd equals goal");
    return Object.freeze({
      kind: "cli.cwd.equals",
      targetPhysical: absolutePath(value.targetPhysical, "cwd equals goal targetPhysical"),
    });
  }
  throw new TypeError("cwd goal kind is invalid");
}

function readBindings(value) {
  exactKeys(value, ["session", "target", "targetPhysical"], "cwd bindings");
  const session = validateSessionRef(value.session, "cwd bindings session");
  const target = validateDirectoryRef(value.target, "cwd bindings target");
  const targetPhysical = absolutePath(value.targetPhysical, "cwd bindings targetPhysical");
  if (target.scenarioId !== session.scenarioId || target.sessionId !== session.sessionId) {
    throw new TypeError("cwd bindings target must belong to the bound session");
  }
  return Object.freeze({ session, target, targetPhysical });
}

function readSessionSnapshot(value) {
  exactKeys(value, ["id", "cwd", "revision", "grantedEffects"], "cwd state session");
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    !Number.isInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.grantedEffects) ||
    value.grantedEffects.some(
      effect =>
        effect !== "filesystem.read" &&
        effect !== "process.exec" &&
        effect !== "session.write",
    )
  ) {
    throw new TypeError("cwd state session snapshot is invalid");
  }
  return Object.freeze({
    id: value.id,
    cwd: absolutePath(value.cwd, "cwd state session cwd"),
    revision: value.revision,
    grantedEffects: Object.freeze([...value.grantedEffects]),
  });
}

function readState(value) {
  exactKeys(value, ["stateId", "cli", "session"], "cwd state");
  return Object.freeze({
    stateId: nonEmpty(value.stateId, "cwd state stateId"),
    cli: validateExplicitFileState(value.cli),
    session: readSessionSnapshot(value.session),
  });
}

function readEvidencePayload(value) {
  exactKeys(value, ["kind", "transitionId", "stateId", "transition"], "cwd evidence payload");
  if (value.kind !== "cli.command.transition") {
    throw new TypeError("cwd evidence payload kind is invalid");
  }
  nonEmpty(value.transitionId, "cwd evidence transitionId");
  nonEmpty(value.stateId, "cwd evidence stateId");
  if (!isRecord(value.transition)) throw new TypeError("cwd evidence transition must be an object");
  return Object.freeze({
    kind: "cli.command.transition",
    transitionId: value.transitionId,
    stateId: value.stateId,
    transition: value.transition,
  });
}

function readEffectFact(value) {
  exactKeys(value, ["kind", "sessionId", "cwd", "revision"], "cwd effect fact");
  if (value.kind !== "cli.session.cwd" || !Number.isInteger(value.revision) || value.revision < 0) {
    throw new TypeError("cwd effect fact is invalid");
  }
  return Object.freeze({
    kind: "cli.session.cwd",
    sessionId: nonEmpty(value.sessionId, "cwd effect sessionId"),
    cwd: absolutePath(value.cwd, "cwd effect cwd"),
    revision: value.revision,
  });
}

function readReceiptPayload(value) {
  if (!isRecord(value)) throw new TypeError("cwd receipt payload must be an object");
  for (const key of [
    "goal",
    "policy",
    "execution_result",
    "observed_state_after",
    "session_before",
    "session_after",
    "status",
    "satisfaction",
    "reason",
    "changed",
  ]) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`cwd receipt payload.${key} is required`);
  }
  validateExplicitFileState(value.observed_state_after);
  return Object.freeze({ ...value });
}

function readCursor(value) {
  exactKeys(value, ["phase"], "cwd cursor");
  if (
    value.phase !== "initial" &&
    value.phase !== "observed" &&
    value.phase !== "equals" &&
    value.phase !== "closed"
  ) {
    throw new TypeError("cwd cursor phase is invalid");
  }
  return Object.freeze({ phase: value.phase });
}

const DOMAIN_GUARDS = Object.freeze({
  goal: readGoal,
  state: readState,
  bindings: readBindings,
  evidencePayload: readEvidencePayload,
  effectFact: readEffectFact,
  sameEffectFact: (left, right) => JSON.stringify(left) === JSON.stringify(right),
  receiptPayload: readReceiptPayload,
  cursor: readCursor,
});

export function emptyCwdState(session, stateId) {
  return Object.freeze({
    stateId,
    session: readSessionSnapshot(session),
    cli: Object.freeze({
      session: session.id,
      cwdObservation: null,
      directoryListing: null,
    }),
  });
}

function currentCwd(state, bindings) {
  if (state.session.id !== bindings.session.sessionId) return null;
  const knowledge = state.cli.cwdObservation;
  if (knowledge === null || knowledge.revision !== state.session.revision) return null;
  if (knowledge.physicalCwd !== state.session.cwd) return null;
  return knowledge;
}

function stateEvidenceRefs(state, evidence) {
  return evidence
    .filter(item => item.validity === "valid" && item.stateRef === state.stateId)
    .map(item => item.id);
}

function evaluation(evaluatorId, result, satisfaction, evidenceRefs) {
  return Object.freeze({
    evaluatorId,
    result,
    satisfaction,
    necessaryConditionsMet: result === "satisfied",
    evidenceRefs: Object.freeze([...evidenceRefs]),
  });
}

function evaluate(input) {
  const knowledge = currentCwd(input.state, input.bindings);
  const evidenceRefs = knowledge === null ? [] : stateEvidenceRefs(input.state, input.evidence);
  if (input.goal.kind === "cli.cwd.observe") {
    return knowledge !== null && evidenceRefs.length > 0
      ? evaluation(OBSERVE_EVALUATOR, "satisfied", 100, evidenceRefs)
      : evaluation(OBSERVE_EVALUATOR, "unsatisfied", 0, []);
  }
  if (knowledge === null) {
    return evaluation(EQUALITY_EVALUATOR, "unknown", null, []);
  }
  const result = knowledge.physicalCwd === input.bindings.targetPhysical
    ? "satisfied"
    : "unsatisfied";
  if (result === "unsatisfied") {
    return evaluation(EQUALITY_EVALUATOR, result, 0, []);
  }
  return evidenceRefs.length > 0
    ? evaluation(EQUALITY_EVALUATOR, result, 100, evidenceRefs)
    : evaluation(EQUALITY_EVALUATOR, "unknown", null, []);
}

function supports(input) {
  if (input.skill.id === ROOT_COMPOSITE_SKILL) {
    return input.goal.kind === "cli.cwd.equals";
  }
  if (input.skill.id === OBSERVE_ATOMIC_SKILL) {
    return input.goal.kind === "cli.cwd.observe";
  }
  if (input.skill.id === EQUALS_ATOMIC_SKILL) {
    return input.goal.kind === "cli.cwd.equals";
  }
  return false;
}

function select(input) {
  return input.candidates.length === 0
    ? { kind: "no_capability", searchedSkillIds: [] }
    : { kind: "selected", skillId: input.candidates[0].id };
}

function condition(id, goal, bindings, selectorId, evaluatorId, allowedEffects) {
  return Object.freeze({
    id,
    goal,
    bindings,
    satisfactionThreshold: 100,
    evaluatorId,
    selectorId,
    mode: "atomic",
    dependsOn: Object.freeze([]),
    lifetime: "stage",
    activation: "required",
    allowedEffects: Object.freeze([...allowedEffects]),
  });
}

function derive(input) {
  if (input.goal.kind !== "cli.cwd.equals" || input.skill.id !== ROOT_COMPOSITE_SKILL) {
    throw new TypeError("cwd composite derivation received an incompatible frame");
  }
  const cursor = input.cursor ?? { phase: "initial" };
  const knowledge = currentCwd(input.state, input.bindings);
  if (knowledge === null && cursor.phase !== "observed") {
    return Object.freeze({
      conditions: Object.freeze([
        condition(
          "observe-current-cwd",
          Object.freeze({ kind: "cli.cwd.observe" }),
          input.bindings,
          OBSERVE_SELECTOR,
          OBSERVE_EVALUATOR,
          ["filesystem.read", "process.exec"],
        ),
      ]),
      nextCursor: Object.freeze({ phase: "observed" }),
      expansion: "more",
    });
  }
  if (
    knowledge !== null &&
    knowledge.physicalCwd !== input.bindings.targetPhysical &&
    cursor.phase !== "equals"
  ) {
    return Object.freeze({
      conditions: Object.freeze([
        condition(
          "set-current-cwd",
          input.goal,
          input.bindings,
          EQUALS_SELECTOR,
          EQUALITY_EVALUATOR,
          CWD_EFFECTS,
        ),
      ]),
      nextCursor: Object.freeze({ phase: "equals" }),
      expansion: "closed",
    });
  }
  return Object.freeze({
    conditions: Object.freeze([]),
    nextCursor: Object.freeze({ phase: "closed" }),
    expansion: "closed",
  });
}

function propertyGoal(goal, bindings) {
  const target = {
    kind: "cli.file-query",
    relation: "sessionCwd",
    session: bindings.session,
  };
  return goal.kind === "cli.cwd.observe"
    ? {
        kind: "file.property",
        property: "file.property.relation.sessionCwd",
        target,
        requirement: { kind: "observed", freshness: "this_run" },
      }
    : {
        kind: "file.property",
        property: "file.property.relation.sessionCwd",
        target,
        requirement: { kind: "equals", expected: bindings.target },
      };
}

function diagnostic(transitionId, suffix, code, stage, category, message, nativeCode = null) {
  return Object.freeze({
    diagnosticId: `${transitionId}:${suffix}`,
    code,
    stage,
    sourceCategory: category,
    message: nonEmpty(message, "cwd diagnostic message"),
    nativeCode,
    refs: Object.freeze([transitionId]),
  });
}

function outcomeOf(transition) {
  if (transition.status === "achieved") return "succeeded";
  if (transition.status === "unknown") return "unknown";
  if (transition.status === "rejected") return "rejected";
  return "failed";
}

function transitionDiagnostics(transition, transitionId) {
  const executionErrors = [];
  const verificationErrors = [];
  if (transition.status === "rejected") {
    executionErrors.push(diagnostic(
      transitionId,
      "binding",
      "invalid_binding",
      "binding",
      "cli.directory_binding",
      transition.execution_result.error ?? transition.reason,
    ));
  } else if (transition.status === "failed") {
    const failure = transition.execution_result.receipt?.execution.status === "failed"
      ? transition.execution_result.receipt.execution.error
      : null;
    executionErrors.push(diagnostic(
      transitionId,
      "execution",
      "execution_failed",
      "execution",
      "cli.command_execution",
      failure?.message ?? transition.execution_result.error ?? transition.reason,
      failure?.code ?? null,
    ));
  }
  if (transition.reason === "postcommit_observation_failed") {
    const failure = transition.postcondition?.receipt?.execution.status === "failed"
      ? transition.postcondition.receipt.execution.error
      : null;
    verificationErrors.push(diagnostic(
      transitionId,
      "postcommit-observation",
      "evidence_unavailable",
      "observation",
      "cli.postcommit_observation",
      failure?.message ?? "postcommit observation failed",
      failure?.code ?? null,
    ));
  }
  return { executionErrors, verificationErrors };
}

function atomicResult(transition, stateId, evidenceId, transitionId) {
  const changed = transition.changed === true;
  const confirmedEffects = changed
    ? [{
        kind: "cli.session.cwd",
        sessionId: transition.session_after.id,
        cwd: transition.session_after.cwd,
        revision: transition.session_after.revision,
      }]
    : [];
  const receiptRunId = transition.execution_result.receipt === null
    ? null
    : transition.execution_result.receipt.execution.runId;
  const keepsState =
    transition.status === "achieved" ||
    transition.status === "unknown" ||
    transition.status === "unmet";
  const nextState = keepsState
    ? {
        stateId,
        cli: transition.observed_state_after,
        session: transition.session_after,
      }
    : null;
  const errors = transitionDiagnostics(transition, transitionId);
  return Object.freeze({
    runId: receiptRunId,
    executorInvoked: transition.execution_result.executorInvoked,
    outcome: outcomeOf(transition),
    sourceResult: Object.freeze({
      tag: "cli.command.transition.v1",
      value: transition,
    }),
    newState: nextState === null
      ? null
      : {
          id: stateId,
          value: nextState,
        },
    evidence: nextState === null
      ? Object.freeze([])
      : Object.freeze([{
          id: evidenceId,
          stateRef: stateId,
          payload: Object.freeze({
            kind: "cli.command.transition",
            transitionId,
            stateId,
            transition,
          }),
          validity: "valid",
        }]),
    executionErrors: Object.freeze(errors.executionErrors),
    verificationErrors: Object.freeze(errors.verificationErrors),
    effect: Object.freeze({
      knowledge: confirmedEffects.length === 0 ? "none" : "known",
      confirmedEffects: Object.freeze(confirmedEffects),
      receiptRef: confirmedEffects.length === 0 ? null : transition.execution_result.receipt?.execution.runId ?? transitionId,
    }),
  });
}

export function createCwdAdapter(input) {
  const calls = {
    validateRequest: 0,
    supports: 0,
    evaluate: 0,
    select: 0,
    derive: 0,
    executeAtomic: 0,
    validateAtomicReceipt: 0,
    measureProgress: 0,
  };
  const transitions = [];
  const trace = [];
  let sequence = 0;
  let traceSequence = 0;

  const adapter = {
    async validateRequest(request) {
      calls.validateRequest += 1;
      const rootGoal = readGoal(request.rootGoal);
      const rootBindings = readBindings(request.rootBindings);
      const state = readState(request.state);
      if (
        rootGoal.kind !== "cli.cwd.equals" ||
        rootGoal.targetPhysical !== rootBindings.targetPhysical ||
        state.session.id !== rootBindings.session.sessionId
      ) {
        throw new TypeError("cwd request root goal, bindings and state must identify one target");
      }
      if (request.rootEvaluatorId !== EQUALITY_EVALUATOR || request.rootSelectorId !== ROOT_SELECTOR) {
        throw new TypeError("cwd request evaluator or selector is unsupported");
      }
      const continuation =
        request.continuation === undefined || request.continuation === null
          ? null
          : readRecursiveGoalContinuation(request.continuation, DOMAIN_GUARDS);
      return Object.freeze({
        requestId: request.requestId,
        rootGoal,
        satisfactionThreshold: request.satisfactionThreshold,
        rootBindings,
        state,
        rootEvaluatorId: request.rootEvaluatorId,
        rootSelectorId: request.rootSelectorId,
        limits: request.limits,
        continuation,
      });
    },

    supports(callback) {
      calls.supports += 1;
      return supports(callback);
    },

    async evaluate(callback) {
      calls.evaluate += 1;
      return evaluate(callback);
    },

    async select(callback) {
      calls.select += 1;
      const selection = select(callback);
      trace.push(Object.freeze({
        kind: "selection",
        sequence: ++traceSequence,
        frameId: callback.context.frameId,
        goalKind: callback.goal.kind,
        selectorId: callback.selectorId,
        selection,
      }));
      return selection;
    },

    async derive(callback) {
      calls.derive += 1;
      return derive(callback);
    },

    async executeAtomic(callback) {
      calls.executeAtomic += 1;
      const step = calls.executeAtomic;
      const request = {
        goal: propertyGoal(callback.goal, callback.bindings),
        satisfactionThreshold: callback.satisfactionThreshold,
        state: callback.state.cli,
      };
      const transition = await input.policy.step(request);
      const traceEntry = Object.freeze({
        kind: "atomic",
        sequence: ++traceSequence,
        step,
        goalKind: callback.goal.kind,
        skillId: callback.skill.id,
        request,
        transition,
      });
      transitions.push(traceEntry);
      trace.push(traceEntry);
      if (input.onTransition !== undefined) {
        await input.onTransition({ step, transition, callback });
      }
      sequence += 1;
      const transitionId = `${callback.context.requestId}:transition-${sequence}`;
      return atomicResult(
        transition,
        `${callback.context.requestId}:state-${sequence}`,
        `${callback.context.requestId}:evidence-${sequence}`,
        transitionId,
      );
    },

    validateAtomicReceipt(raw) {
      calls.validateAtomicReceipt += 1;
      return readAtomicReceipt(raw, DOMAIN_GUARDS);
    },

    measureProgress(callback) {
      calls.measureProgress += 1;
      const before = currentCwd(callback.before, input.bindings);
      const after = currentCwd(callback.after, input.bindings);
      const improved = before === null
        ? after !== null
        : after !== null &&
          (
            before.physicalCwd !== after.physicalCwd ||
            before.revision < after.revision
          );
      return {
        improved,
        reason: improved ? "facts_improved" : "none",
        comparable: true,
      };
    },
  };

  return Object.freeze({ adapter, calls, transitions, trace });
}

export function createCwdDependencies(created, grantedEffects = CWD_EFFECTS) {
  return Object.freeze({
    adapter: created.adapter,
    enabledSkills: CWD_SKILLS,
    enabledEvaluators: CWD_EVALUATORS,
    selectors: CWD_SELECTORS,
    comparators: CWD_COMPARATORS,
    grantedEffects: new Set(grantedEffects),
  });
}
