import { feedbackFeatures } from "nnanything/browser-feedback";
import { projectionKind } from "./projections.mjs";

const FEEDBACK_HEADS = ["completed_without_goal", "execution_rejected", "indeterminate"];

function observed(value, evidenceRefs) {
  return { status: "observed", value, evidenceRefs };
}

function unknown(reason) {
  return { status: "unknown", reason };
}

function evidenceId(caseId, phase, key) {
  return `ev:${caseId}:${phase}:${key}`;
}

/**
 * Build one explicitly synthetic single-action snapshot. The snapshot is the
 * only page input; ids and evidence facts differ per family and per case.
 */
function buildSnapshot(family, caseId, phase, revision, options) {
  const observationId = `obs:${caseId}:${phase}`;
  const scopeEvidence = evidenceId(caseId, phase, "scope");
  const regionEvidence = evidenceId(caseId, phase, "region");
  const nativeEvidence = evidenceId(caseId, phase, "native");
  const roleEvidence = evidenceId(caseId, phase, "role");
  const equivalenceEvidence = evidenceId(caseId, phase, "equivalence");
  const expandedObs = options.expanded === null
    ? unknown("synthetic expanded observation unavailable")
    : observed(options.expanded === true, [regionEvidence]);
  const renderedObs = options.rendered === null
    ? unknown("synthetic rendered observation unavailable")
    : observed(options.rendered === true, [regionEvidence]);

  const scope = {
    ref: family.scopeRef,
    parentRef: null,
    tag: family.scopeTag,
    role: null,
    basicKind: "container",
    judgmentStatus: "judged",
    candidateStatus: "ok",
    controls: observed([], [scopeEvidence]),
    enabled: unknown("scope is not actionable"),
    hit: unknown("scope has no hit target"),
    buttonSemantics: observed(false, [scopeEvidence]),
    point: unknown("scope has no point"),
    evidenceRefs: [scopeEvidence],
  };
  const region = {
    ref: family.regionRef,
    parentRef: family.scopeRef,
    tag: "section",
    role: "region",
    basicKind: "container",
    judgmentStatus: "judged",
    candidateStatus: "ok",
    controls: observed([], [regionEvidence]),
    enabled: unknown("region is not actionable"),
    hit: unknown("region has no hit target"),
    buttonSemantics: observed(false, [regionEvidence]),
    point: unknown("region has no point"),
    evidenceRefs: [regionEvidence],
  };
  const target = (strategy, evidence) => ({
    ref: strategy.targetRef,
    parentRef: family.scopeRef,
    tag: strategy.tag,
    role: strategy.role,
    basicKind: "button",
    judgmentStatus: "judged",
    candidateStatus: "ok",
    controls: observed([family.regionRef], [evidence]),
    enabled: observed(true, [evidence]),
    hit: observed(true, [evidence]),
    buttonSemantics: observed(true, [evidence]),
    point: observed(strategy.point, [evidence]),
    evidenceRefs: [evidence],
  });
  const evidence = [
    {
      id: scopeEvidence,
      observationId,
      source: family.evidenceSource,
      fact: { family: family.familyId, caseId, phase, scope: family.scopeRef },
    },
    {
      id: regionEvidence,
      observationId,
      source: family.evidenceSource,
      fact: { family: family.familyId, caseId, phase, region: family.regionRef, expanded: options.expanded, rendered: options.rendered },
    },
    {
      id: nativeEvidence,
      observationId,
      source: family.evidenceSource,
      fact: { family: family.familyId, caseId, phase, target: family.native.targetRef, kind: "native" },
    },
    {
      id: roleEvidence,
      observationId,
      source: family.evidenceSource,
      fact: { family: family.familyId, caseId, phase, target: family.role.targetRef, kind: "role" },
    },
    {
      id: equivalenceEvidence,
      observationId,
      source: family.equivalenceSource,
      fact: {
        family: family.familyId,
        caseId,
        strategyRefs: [family.native.strategyRef, family.role.strategyRef],
        equivalenceSetRef: family.equivalenceSetRef,
        regionRef: family.regionRef,
      },
    },
  ];
  return {
    documentRef: family.documentRef,
    observationId,
    revision,
    scopeRef: family.scopeRef,
    regions: [{ ref: family.regionRef, expanded: expandedObs, rendered: renderedObs }],
    elements: [scope, region, target(family.native, nativeEvidence), target(family.role, roleEvidence)],
    evidence,
  };
}

function makeReceipt(family, spec) {
  if (spec.receipt === null) return null;
  if (spec.dispatch === "unknown") {
    throw new TypeError(`${spec.id}: an unknown dispatch cannot carry a receipt`);
  }
  return {
    dispatched: spec.dispatch === "dispatched",
    ok: spec.receipt.ok,
    effectKnowledge: spec.receipt.effectKnowledge,
    source: family.receiptSource,
    error: spec.receipt.error ?? null,
  };
}

/**
 * Build one typed FeedbackInput from a compact family recipe. The recipe sets
 * only observable facts; gold is derived later from the published rules.
 */
export function buildFeedbackInput(family, spec) {
  const preRevision = spec.preRevision ?? 1;
  const preExpanded = spec.preExpanded === true;
  const preRendered = spec.preRendered ?? preExpanded;
  const pre = buildSnapshot(family, spec.id, "pre", preRevision, {
    expanded: preExpanded,
    rendered: preRendered,
  });
  const request = {
    goal: { kind: "SetExpanded", regionRef: family.regionRef, desired: true },
    satisfactionThreshold: 100,
    state: pre,
  };
  const attempted = spec.target === "role" ? family.role : family.native;
  if (spec.post === "valid" && spec.invocation === false) {
    throw new TypeError(`${spec.id}: a valid posterior requires a dispatched click invocation`);
  }
  const invocation = spec.invocation === false ? null : {
    kind: "click",
    targetRef: attempted.targetRef,
    point: attempted.point,
    documentRef: pre.documentRef,
    observationId: pre.observationId,
    revision: pre.revision,
  };
  let post = null;
  let controlAtCompletion = null;
  let resultError = spec.resultError ?? null;
  if (spec.post === "valid" || spec.post === "stale" || spec.post === "invalid_binding") {
    post = buildSnapshot(family, spec.id, "post", preRevision + 1, {
      expanded: spec.expanded === null ? null : spec.expanded === true,
      rendered: spec.rendered === undefined ? spec.expanded === true : spec.rendered,
    });
    controlAtCompletion = {
      documentRef: post.documentRef,
      observationId: post.observationId,
      revision: post.revision,
    };
    if (spec.post === "stale") {
      controlAtCompletion = { ...controlAtCompletion, revision: post.revision + 1 };
    }
    if (spec.post === "invalid_binding") {
      resultError = { code: "invalid_binding", message: "Synthetic posterior no longer binds the observed scope." };
    }
  } else if (spec.post === "unchanged") {
    post = pre;
    controlAtCompletion = {
      documentRef: pre.documentRef,
      observationId: pre.observationId,
      revision: pre.revision,
    };
  } else if (spec.post !== "missing") {
    throw new TypeError(`${spec.id}: unsupported posterior recipe ${spec.post}`);
  }
  if (spec.post === "missing" && resultError === null) {
    resultError = { code: "post_observation_failed", message: "Synthetic posterior is unavailable." };
  }
  const receipt = makeReceipt(family, spec);
  return {
    request,
    result: {
      prediction: null,
      invocation,
      receipt,
      dispatchState: spec.dispatch,
      effectKnowledge: spec.effectKnowledge,
      newState: post,
      satisfaction: spec.satisfaction ?? null,
      achieved: spec.achieved === true,
      error: resultError,
      collectionError: spec.collectionError ?? null,
    },
    controlAtCompletion,
  };
}

/**
 * Derive F1 gold from the published rules and the public 12-wire projection.
 * Goal achievement is a status, not a trained head, so it is kept separate.
 */
export function deriveFeedbackGold(input) {
  const features = feedbackFeatures(input);
  const goalAchieved = input.result.achieved === true
    && input.result.satisfaction === 100
    && features[6] === 1
    && features[7] === 1 && features[8] === 1
    && features[9] === 1 && features[10] === 1;
  if (goalAchieved) return "goal_achieved";
  const explicitRejection = features[3] === 1 && features[4] === 0;
  if (explicitRejection) return "execution_rejected";
  const completed = features[2] === 1
    && features[3] === 1 && features[4] === 1 && features[5] === 0
    && features[6] === 1
    && features[7] === 1 && features[8] === 0
    && features[9] === 1
    && features[11] === 1;
  if (completed) return "completed_without_goal";
  return "indeterminate";
}

/**
 * Policy-layer F2 gold: the pure selector can distinguish an F1 category and
 * whether the atomic budget remains. It cannot see raw effect knowledge.
 */
function derivePolicyGold(record, spec) {
  const remaining = spec.remainingAtomicAttempts ?? 1;
  if (remaining === 0) return { kind: "DEFER", note: "atomic attempt budget is exhausted" };
  if (record.gold === "completed_without_goal") {
    return { kind: "SELECT", note: "completed-without-goal feedback permits the bounded retry decision" };
  }
  return { kind: "DEFER", note: `${record.gold} feedback stops the current retry decision` };
}

/**
 * Full retry-boundary gold: a known other effect blocks retry even though F1
 * still reports completed_without_goal. The core guard owns this boundary.
 */
function deriveSafetyGold(record, spec) {
  const remaining = spec.remainingAtomicAttempts ?? 1;
  if (remaining === 0) return { kind: "DEFER", note: "atomic attempt budget is exhausted" };
  if (record.gold === "completed_without_goal") {
    if (record.input.result.effectKnowledge === "none") {
      return { kind: "SELECT", note: "safe no-effect failure permits the bounded retry decision" };
    }
    return { kind: "DEFER", note: "known or unresolved effects do not authorize retry" };
  }
  return { kind: "DEFER", note: `${record.gold} feedback stops the current retry decision` };
}

function currentState(family, spec, input) {
  const pre = input.request.state;
  const post = input.result.newState;
  const valid = feedbackFeatures(input)[6] === 1;
  if (valid && post !== null) {
    return post === pre
      ? { snapshot: pre, phase: "pre" }
      : { snapshot: post, phase: "post" };
  }
  const revision = (post?.revision ?? pre.revision) + 1;
  return {
    snapshot: buildSnapshot(family, spec.id, "current", revision, { expanded: false, rendered: false }),
    phase: "current",
  };
}

function currentEvidence(family, spec, phase, kind) {
  return evidenceId(spec.id, phase, kind);
}

function buildStrategyDecision(family, spec, record) {
  const attempted = spec.target === "role" ? family.role : family.native;
  const current = currentState(family, spec, record.input);
  const request = {
    goal: { kind: "SetExpanded", regionRef: family.regionRef, desired: true },
    satisfactionThreshold: 100,
    state: current.snapshot,
  };
  const history = [{
    strategyRef: attempted.strategyRef,
    skillId: attempted.skillId,
    targetRef: attempted.targetRef,
    equivalenceSetRef: family.equivalenceSetRef,
    input: record.input,
  }];
  const currentEquivalence = currentEvidence(family, spec, current.phase, "equivalence");
  const registry = [family.native, family.role].map(strategy => ({
    strategyRef: strategy.strategyRef,
    skillId: strategy.skillId,
    targetRef: strategy.targetRef,
    goalRegionRef: family.regionRef,
    equivalenceSetRef: family.equivalenceSetRef,
    documentRef: family.documentRef,
    scopeRef: family.scopeRef,
    operation: "CLICK",
    evidenceRefs: [
      currentEquivalence,
      currentEvidence(family, spec, current.phase, strategy === family.native ? "native" : "role"),
    ],
  }));
  const policy = derivePolicyGold(record, spec);
  const safety = deriveSafetyGold(record, spec);
  const selection = {
    eligibleSkillIds: [attempted.skillId],
    lockedSkillId: attempted.skillId,
    exhaustedSkillIds: [],
    remainingAtomicAttempts: spec.remainingAtomicAttempts ?? 1,
  };
  const episode = {
    id: `${spec.id}:strategy`,
    family: `strategy.${family.familyId}`,
    partition: "verification",
    input: { request, history },
    registry,
    selection,
    teacher: {
      selectedSkillId: policy.kind === "SELECT" ? attempted.skillId : null,
      source: "synthetic_projection",
      evidenceRefs: [currentEquivalence],
      note: policy.note,
    },
  };
  return {
    episode,
    policy,
    safety,
    attemptedSkillId: attempted.skillId,
    attemptedStrategyRef: attempted.strategyRef,
    currentObservationId: current.snapshot.observationId,
    currentRevision: current.snapshot.revision,
    currentPhase: current.phase,
  };
}

/** Materialize a family definition into 12 independent verification cases. */
export function materializeFamily(family) {
  if (!Array.isArray(family.cases) || family.cases.length !== 12) {
    throw new TypeError(`${family.familyId}: a family must define exactly 12 base cases`);
  }
  return family.cases.map(spec => {
    const input = buildFeedbackInput(family, spec);
    const features = feedbackFeatures(input);
    const gold = deriveFeedbackGold(input);
    const expected = gold === "goal_achieved"
      ? { status: "goal_achieved", head: null }
      : { status: "predicted", head: gold };
    const teacher = gold === "goal_achieved" ? null : {
      head: gold,
      source: "synthetic_projection",
      evidenceRefs: [evidenceId(spec.id, "pre", "region")],
      note: spec.title,
    };
    const record = {
      id: spec.id,
      family: family.familyId,
      partition: "verification",
      title: spec.title,
      input,
      features,
      gold,
      expected,
      projectionKind: projectionKind(features),
      sourceType: projectionKind(features) === "old-projection"
        ? "new-source-old-projection"
        : "new-source-new-projection",
      teacher,
    };
    record.f2 = buildStrategyDecision(family, spec, record);
    return record;
  });
}

export { FEEDBACK_HEADS };
