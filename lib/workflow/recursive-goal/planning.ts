import type { EnabledSkill } from "./contracts.js";
export type {PathCandidate, PathRanking} from "./planning-contracts.js";
import {
  sameVersionedRef,
  type BoundedPlanningCapability,
  type BoundedPlanningRequest,
  type CoverageFrontier,
  type GoalGraphPlan,
  type PathCandidate,
  type PathPreferencePolicy,
  type PathProjection,
  type PathRanking,
  type PlanControl,
  type PlanCoverage,
  type PlanEdge,
  type PlanNode,
  type PlannedResult,
  type PlanningApplicability,
  type PlanningEvaluationRef,
  type PlanningUnknown,
  type PlanningUsage,
  type PredictedState,
  type PredictionResult,
  type PriorAssessment,
  type ResultModelBinding,
  type ResultModelOutput,
  type ResultTransitionProjection,
  type SemanticProgress,
  type TransitionContinuation,
  type VersionedRef,
} from "./planning-contracts.js";

const DEFAULT_COST_UNIT = "semantic_action";
const DEFAULT_TRANSITION_COST = 1;

export interface ExpandGoalGraphInput<
  G,
  B,
  S,
  E,
  F,
  C = unknown,
> {
  readonly planId: string;
  readonly rootRef: string;
  readonly frameRef: string;
  readonly goal: G;
  readonly bindings: B;
  readonly state: S;
  readonly stateRef: string;
  readonly evidence: readonly E[];
  readonly skills: readonly EnabledSkill[];
  readonly options: BoundedPlanningRequest<G, B>;
  readonly capability: BoundedPlanningCapability<G, B, S, E, F, C>;
  readonly control: PlanControl<G, B, S, E, F>;
  readonly consumePrediction: () => boolean | Promise<boolean>;
  /**
   * Owned by the runtime root evaluator. A true value stops before prediction.
   */
  readonly rootSatisfied: boolean;
}

export interface ExpandGoalGraphOutput<G, B, S, E, F> {
  readonly plan: GoalGraphPlan<G, B, S, E, F> | null;
  readonly prediction: PredictionResult;
  readonly ranking: PathRanking | null;
  readonly priorAssessments: readonly PriorAssessment[];
  readonly usage: PlanningUsage;
}

interface ExpansionFrame<G, B, S, E, F> {
  readonly skill: EnabledSkill;
  readonly model: ResultModelBinding<G, B, S, E, F>;
  readonly state: S;
  readonly evidence: readonly E[];
  readonly depth: number;
  readonly nodeRefs: readonly string[];
  readonly selectedResults: readonly ResultTransitionProjection[];
  readonly parent: {
    readonly sourceNodeRef: string;
    readonly resultRef: string;
  } | null;
}

interface MutableExpansion<G, B, S, E, F> {
  readonly input: ExpandGoalGraphInput<G, B, S, E, F, unknown>;
  readonly nodes: PlanNode<G, B, S, E, F>[];
  readonly edges: PlanEdge<G, B, S, E>[];
  readonly paths: PathCandidate<G, B, S, E>[];
  readonly frontier: CoverageFrontier[];
  usage: PlanningUsage;
  nodeSequence: number;
  edgeSequence: number;
  pathSequence: number;
  frontierSequence: number;
  budgetExhausted: boolean;
  readonly priorAssessments: Map<string, PriorAssessment>;
}

interface NormalizedTransition<G, B, S, E, F>
  extends Omit<
    PlannedResult<G, B, S, E, F>,
    "transitionRef" | "priorExclusionRefs"
  > {
  readonly priorExclusionRefs: readonly string[];
}

interface ComparisonResult {
  readonly order: -1 | 0 | 1;
  readonly missingKey: string | null;
}

export function emptyPlanControl<G, B, S, E, F>(): PlanControl<
  G,
  B,
  S,
  E,
  F
> {
  return {
    plan: null,
    currentPathRef: null,
    alternatePathRefs: [],
    cursor: null,
    verifiedCheckpoints: [],
    recovery: {
      phase: "idle",
      recoveryRefs: [],
      reasonRefs: [],
      checkpointRef: null,
    },
    failurePriors: [],
    invalidationRefs: [],
    usage: {
      predictionCallsUsed: 0,
      replansUsed: 0,
      rollbacksUsed: 0,
    },
  };
}

export async function expandGoalGraph<G, B, S, E, F, C = unknown>(
  input: ExpandGoalGraphInput<G, B, S, E, F, C>,
): Promise<ExpandGoalGraphOutput<G, B, S, E, F>> {
  if (input.rootSatisfied) {
    return {
      plan: input.control.plan,
      prediction: {
        kind: "stopped",
        rootRef: input.rootRef,
        startStateRef: input.stateRef,
        reason: "root_satisfied",
        refs: [input.stateRef],
        predictionCallsUsed: input.control.usage.predictionCallsUsed,
      },
      ranking: null,
      priorAssessments: [],
      usage: { ...input.control.usage },
    };
  }

  const contractFailure = planningContractFailure(input);
  if (contractFailure !== null) {
    return failureOutput(input, "invalid_contract", contractFailure);
  }

  const enabledRefs = input.skills.map(skillRef);
  const requestedModels = input.options.resultModelRefs.map(ref => {
    const binding = input.capability.resultModels.find(candidate =>
      sameVersionedRef(candidate.ref, ref),
    );
    if (binding === undefined) {
      return { ref, binding: null };
    }
    return { ref, binding };
  });
  const unavailableModel = requestedModels.find(item => item.binding === null);
  if (unavailableModel !== undefined) {
    return failureOutput(input, "missing_model", [
      `model:${unavailableModel.ref.id}@${unavailableModel.ref.version}`,
    ]);
  }

  const pairs = input.skills.flatMap(skill =>
    requestedModels.flatMap(item =>
      item.binding !== null && modelCoversSkill(item.binding, skill)
        ? [{ skill, model: item.binding }]
        : [],
    ),
  );
  if (pairs.length === 0) {
    return failureOutput(input, "missing_model", [
      ...enabledRefs.map(ref => `skill:${ref.id}@${ref.version}`),
    ]);
  }

  const expansion: MutableExpansion<G, B, S, E, F> = {
    input: input as ExpandGoalGraphInput<G, B, S, E, F, unknown>,
    nodes: [],
    edges: [],
    paths: [],
    frontier: [],
    usage: { ...input.control.usage },
    nodeSequence: 0,
    edgeSequence: 0,
    pathSequence: 0,
    frontierSequence: 0,
    budgetExhausted: false,
    priorAssessments: new Map(),
  };

  const queue: ExpansionFrame<G, B, S, E, F>[] = pairs.map(pair => ({
    skill: pair.skill,
    model: pair.model,
    state: input.state,
    evidence: input.evidence,
    depth: 0,
    nodeRefs: [],
    selectedResults: [],
    parent: null,
  }));

  while (queue.length > 0) {
    if (expansion.budgetExhausted) break;
    const frame = queue.shift();
    if (frame === undefined) break;

    const modelFailure = await expandFrame(expansion, frame, queue);
    if (modelFailure !== null) {
      return finalizeExpansion(expansion, modelFailure);
    }
  }

  return finalizeExpansion(expansion, null);
}

type ComparablePlanningPath = Pick<PathCandidate<unknown, unknown, unknown, unknown>, "pathId" | "rankOrder" | "projection">;

export function rankPlanningPaths(
  candidates: readonly ComparablePlanningPath[],
  policy: PathPreferencePolicy,
): PathRanking {
  if (candidates.length === 0) {
    return {
      kind: "defer",
      missingKeys: ["candidate"],
      reason: "no legal path candidate is available",
    };
  }
  const pathIds = new Set<string>();
  for (const candidate of candidates) {
    if (pathIds.has(candidate.pathId)) {
      return {
        kind: "defer",
        missingKeys: ["pathId"],
        reason: "path candidate identifiers are not unique",
      };
    }
    pathIds.add(candidate.pathId);
  }

  const remaining = [...candidates];
  const ranked: ComparablePlanningPath[] = [];
  const missingKeys = new Set<string>();
  while (remaining.length > 0) {
    let bestIndex = 0;
    let ambiguous = false;
    for (let index = 1; index < remaining.length; index += 1) {
      const left = remaining[index];
      const right = remaining[bestIndex];
      if (left === undefined || right === undefined) break;
      const comparison = comparePlanningPaths(left, right, policy);
      if (comparison.missingKey !== null) {
        missingKeys.add(comparison.missingKey);
        ambiguous = true;
      } else if (comparison.order === -1) {
        bestIndex = index;
      } else if (comparison.order === 0) {
        missingKeys.add(`${policy.kind}.tie`);
        ambiguous = true;
      }
    }
    if (ambiguous) {
      return {
        kind: "defer",
        missingKeys: [...missingKeys],
        reason: "planning paths need a typed key or a unique decided order",
      };
    }
    const [selected] = remaining.splice(bestIndex, 1);
    if (selected !== undefined) ranked.push(selected);
  }

  return {
    kind: "ranked",
    pathRefs: ranked.map(candidate => candidate.pathId),
  };
}

async function expandFrame<G, B, S, E, F>(
  expansion: MutableExpansion<G, B, S, E, F>,
  frame: ExpansionFrame<G, B, S, E, F>,
  queue: ExpansionFrame<G, B, S, E, F>[],
): Promise<PredictionResult | null> {
  const { input } = expansion;
  if (
    expansion.usage.predictionCallsUsed >= input.options.limits.maxPredictionCalls
  ) {
    expansion.budgetExhausted = true;
    return stoppedPrediction(expansion, "budget_exhausted", []);
  }
  if (expansion.nodes.length >= input.options.limits.maxPlanNodes) {
    expansion.budgetExhausted = true;
    return stoppedPrediction(
      expansion,
      "budget_exhausted",
      expansion.frontier.map(item => item.frontierRef),
    );
  }
  const consumed = await input.consumePrediction();
  if (!consumed) {
    expansion.budgetExhausted = true;
    return stoppedPrediction(expansion, "budget_exhausted", []);
  }
  expansion.usage = {
    ...expansion.usage,
    predictionCallsUsed: expansion.usage.predictionCallsUsed + 1,
  };

  const obligationRef = {
    rootRef: input.rootRef,
    frameRef: input.frameRef,
    conditionRef: null,
  };
  const applicablePriors = assessPriors(
    expansion,
    frame.skill,
    obligationRef,
    frame.state,
    frame.evidence,
  );
  const output = frame.model.predict({
    context: {
      requestId: input.planId,
      planRef: input.planId,
      signal: null,
    },
    rootGoal: input.goal,
    bindings: input.bindings,
    stateProjection: frame.state,
    evidenceProjection: frame.evidence,
    skillRef: skillRef(frame.skill),
    obligationRef,
    remainingHorizon: input.options.horizonN - frame.depth,
    prior: applicablePriors,
  });

  if (output.kind !== "ready") {
    return predictionFromModelOutput(expansion, output);
  }
  if (output.transitions.length === 0) {
    return notReadyPrediction(expansion, "invalid_contract", []);
  }

  const nodeId = `plan-node:${expansion.nodeSequence}`;
  expansion.nodeSequence += 1;
  const transitions = output.transitions.map(transition => {
    const transitionRef = stableTransitionRef(
      frame.skill,
      input.frameRef,
      transition.resultRef,
    );
    const priorExclusionRefs = applicablePriors
      .filter(
        prior =>
          prior.conclusion.kind === "exclude_transition" &&
          prior.conclusion.transitionRefs.includes(transitionRef),
      )
      .map(prior => prior.id);
    return {
      ...transition,
      transitionRef,
      priorExclusionRefs,
    };
  });
  const resultRefs = new Set(transitions.map(item => item.resultRef));
  if (resultRefs.size !== transitions.length) {
    return notReadyPrediction(expansion, "invalid_contract", ["resultRef"]);
  }
  const transitionRefs = new Set(transitions.map(item => item.transitionRef));
  if (transitionRefs.size !== transitions.length) {
    return notReadyPrediction(expansion, "invalid_contract", ["transitionRef"]);
  }

  const node: PlanNode<G, B, S, E, F> = {
    id: nodeId,
    semanticDepth: frame.depth,
    obligationRef,
    skillRef: skillRef(frame.skill),
    preconditions: [],
    predictedResults: transitions,
    cost: { amount: DEFAULT_TRANSITION_COST, unit: DEFAULT_COST_UNIT },
    sourceModelRef: frame.model.ref,
  };
  expansion.nodes.push(node);
  if (frame.parent !== null) {
    addEdge(
      expansion,
      frame.parent.sourceNodeRef,
      frame.parent.resultRef,
      "node",
      nodeId,
      [],
      "covered",
    );
  }

  const nextNodeRefs = [...frame.nodeRefs, nodeId];
  for (const transition of transitions) {
    const selectedResults = [...frame.selectedResults, transition.projection];
    const nextDepth =
      frame.depth + (transition.semanticProgress === "progressed" ? 1 : 0);

    if (
      transition.priorExclusionRefs.length > 0 ||
      transition.applicability.kind !== "applicable" ||
      transition.coverage !== "covered"
    ) {
      addFrontier(
        expansion,
        node.id,
        transition.resultRef,
        transition.coverage === "covered" ? "unknown" : transition.coverage,
        Math.max(0, input.options.horizonN - nextDepth),
        transition.priorExclusionRefs.length > 0
          ? "excluded_by_failure_prior"
          : transition.applicability.kind !== "applicable"
            ? transition.applicability.reason
            : transition.unknown[0]?.reason ?? "transition coverage is incomplete",
        transition.unknown.map(item => item.ref),
      );
      continue;
    }

    if (transition.continuation.kind === "terminal") {
      const candidate: PathCandidate<G, B, S, E> = {
        pathId: `plan-path:${expansion.pathSequence}`,
        rankOrder: transition.preferenceOrder,
        entryNodeRef: nextNodeRefs[0] ?? node.id,
        nodeRefs: nextNodeRefs,
        projection: aggregatePathProjection(
          selectedResults,
          transition.continuation,
          transition.unknown,
          "covered",
        ),
        attemptOrder: nextNodeRefs.map((nodeRef, index) => ({
          order: index,
          nodeRef,
          skillRef:
            expansion.nodes.find(candidateNode => candidateNode.id === nodeRef)
              ?.skillRef ?? skillRef(frame.skill),
        })),
        invalidation: [],
        termination: transition.continuation,
      };
      expansion.pathSequence += 1;
      expansion.paths.push(candidate);
      addEdge(
        expansion,
        node.id,
        transition.resultRef,
        "terminal",
        transition.transitionRef,
        transition.preconditions,
        "covered",
      );
      continue;
    }

    if (nextDepth >= input.options.horizonN) {
      const termination={kind:"terminal" as const,terminalKind:"horizon" as const,checkpointRef:null};
      expansion.paths.push({
        pathId:`plan-path:${expansion.pathSequence++}`,rankOrder:transition.preferenceOrder,
        entryNodeRef:nextNodeRefs[0]!,nodeRefs:nextNodeRefs,
        projection:aggregatePathProjection(selectedResults,termination,transition.unknown,"covered"),
        attemptOrder:nextNodeRefs.map((nodeRef,order)=>({order,nodeRef,skillRef:expansion.nodes.find(node=>node.id===nodeRef)!.skillRef})),
        invalidation:[],termination,
      });
      addFrontier(
        expansion,
        node.id,
        transition.resultRef,
        "truncated",
        0,
        "horizon_exhausted",
        transition.unknown.map(item => item.ref),
      );
      addEdge(
        expansion,
        node.id,
        transition.resultRef,
        "terminal",
        `${transition.transitionRef}:horizon`,
        transition.preconditions,
        "truncated",
      );
      continue;
    }

    const childSkills = resolveNextSkills(input.skills, transition.continuation);
    let childrenAdded = 0;
    for (const childSkill of childSkills) {
      const childModels = expansion.input.options.resultModelRefs
        .map(ref =>
          expansion.input.capability.resultModels.find(binding =>
            sameVersionedRef(binding.ref, ref),
          ),
        )
        .filter(
          (binding): binding is ResultModelBinding<G, B, S, E, F> =>
            binding !== undefined && modelCoversSkill(binding, childSkill),
        );
      if (childModels.length === 0) {
        continue;
      }
      for (const childModel of childModels) {
        if (expansion.nodes.length + queue.length >= input.options.limits.maxPlanNodes) {
          expansion.budgetExhausted = true;
          addFrontier(
            expansion,
            node.id,
            transition.resultRef,
            "truncated",
            Math.max(0, input.options.horizonN - nextDepth),
            "plan_node_budget_exhausted",
            transition.unknown.map(item => item.ref),
          );
          break;
        }
        childrenAdded += 1;
        queue.push({
          skill: childSkill,
          model: childModel,
          state: transition.predictedState.projection.state,
          evidence: transition.predictedState.projection.evidence,
          depth: nextDepth,
          nodeRefs: nextNodeRefs,
          selectedResults,
          parent: {
            sourceNodeRef: node.id,
            resultRef: transition.resultRef,
          },
        });
      }
    }
    if (childrenAdded === 0) {
      addFrontier(
        expansion,
        node.id,
        transition.resultRef,
        "unknown",
        Math.max(0, input.options.horizonN - nextDepth),
        "missing_model",
        transition.unknown.map(item => item.ref),
      );
      addEdge(
        expansion,
        node.id,
        transition.resultRef,
        "terminal",
        `${transition.transitionRef}:missing-model`,
        transition.preconditions,
        "unknown",
      );
    }
  }

  return null;
}

function finalizeExpansion<G, B, S, E, F>(
  expansion: MutableExpansion<G, B, S, E, F>,
  failure: PredictionResult | null,
): ExpandGoalGraphOutput<G, B, S, E, F> {
  const plan = buildPlan(expansion);
  const priorAssessments = [...expansion.priorAssessments.values()];
  if (failure !== null) {
    return {
      plan,
      prediction: failure,
      ranking: null,
      priorAssessments,
      usage: expansion.usage,
    };
  }

  if (expansion.paths.length > 0) {
    const ranking = rankPlanningPaths(
      expansion.paths,
      expansion.input.options.preference,
    );
    if (ranking.kind === "defer") {
      return {
        plan,
        prediction: {
          kind: "deferred",
          rootRef: expansion.input.rootRef,
          startStateRef: expansion.input.stateRef,
          requirements: ranking.missingKeys.map(key => ({
            ref: `ranking:${key}`,
            reason: ranking.reason,
          })),
          frontier: expansion.frontier,
          predictionCallsUsed: expansion.usage.predictionCallsUsed,
        },
        ranking,
        priorAssessments,
        usage: expansion.usage,
      };
    }
    if (plan !== null) {
      return {
        plan,
        prediction: {
          kind: "ready",
          transitionRef: plan.planId,
          rootRef: expansion.input.rootRef,
          startStateRef: expansion.input.stateRef,
          planRef: plan.planId,
          rankedPathRefs: ranking.pathRefs,
          frontier: expansion.frontier,
          predictionCallsUsed: expansion.usage.predictionCallsUsed,
        },
        ranking,
        priorAssessments,
        usage: expansion.usage,
      };
    }
  }

  if (expansion.frontier.length > 0) {
    return {
      plan,
      prediction: {
        kind: "not_ready",
        rootRef: expansion.input.rootRef,
        startStateRef: expansion.input.stateRef,
        reason: "horizon_exhausted",
        frontier: expansion.frontier,
        predictionCallsUsed: expansion.usage.predictionCallsUsed,
      },
      ranking: null,
      priorAssessments,
      usage: expansion.usage,
    };
  }
  return {
    plan,
    prediction: {
      kind: "not_ready",
      rootRef: expansion.input.rootRef,
      startStateRef: expansion.input.stateRef,
      reason: "invalid_contract",
      frontier: [],
      predictionCallsUsed: expansion.usage.predictionCallsUsed,
    },
    ranking: null,
    priorAssessments,
    usage: expansion.usage,
  };
}

function buildPlan<G, B, S, E, F>(
  expansion: MutableExpansion<G, B, S, E, F>,
): GoalGraphPlan<G, B, S, E, F> | null {
  if (expansion.nodes.length === 0) return null;
  const { input } = expansion;
  return {
    planId: input.planId,
    rootRef: input.rootRef,
    startStateRef: input.stateRef,
    horizonN: input.options.horizonN,
    modelRefs: input.options.resultModelRefs,
    nodes: expansion.nodes,
    edges: expansion.edges,
    paths: expansion.paths,
    frontier: expansion.frontier,
    checkpoints: input.options.checkpointSpecs,
  };
}

function predictionFromModelOutput<G, B, S, E, F>(
  expansion: MutableExpansion<G, B, S, E, F>,
  output: Exclude<ResultModelOutput<G, B, S, E, F>, { kind: "ready" }>,
): PredictionResult {
  if (output.kind === "deferred") {
    return {
      kind: "deferred",
      rootRef: expansion.input.rootRef,
      startStateRef: expansion.input.stateRef,
      requirements: output.requirements,
      frontier: expansion.frontier,
      predictionCallsUsed: expansion.usage.predictionCallsUsed,
    };
  }
  if (output.kind === "not_ready") {
    return {
      kind: "not_ready",
      rootRef: expansion.input.rootRef,
      startStateRef: expansion.input.stateRef,
      reason: output.reason,
      frontier: expansion.frontier,
      predictionCallsUsed: expansion.usage.predictionCallsUsed,
    };
  }
  return {
    kind: "stopped",
    rootRef: expansion.input.rootRef,
    startStateRef: expansion.input.stateRef,
    reason: output.reason,
    refs: output.refs,
    predictionCallsUsed: expansion.usage.predictionCallsUsed,
  };
}

function notReadyPrediction<G, B, S, E, F>(
  expansion: MutableExpansion<G, B, S, E, F>,
  reason: Extract<PredictionResult, { kind: "not_ready" }>["reason"],
  refs: readonly string[],
): PredictionResult {
  return {
    kind: "not_ready",
    rootRef: expansion.input.rootRef,
    startStateRef: expansion.input.stateRef,
    reason,
    frontier: [
      ...expansion.frontier,
      ...refs.map((ref, index) => ({
        frontierRef: `planning-not-ready:${index}`,
        nodeRef: "planning",
        resultRef: ref,
        coverage: "unknown" as const,
        remainingHorizon: expansion.input.options.horizonN,
        reason,
        unknownRefs: [ref],
      })),
    ],
    predictionCallsUsed: expansion.usage.predictionCallsUsed,
  };
}

function stoppedPrediction<G, B, S, E, F>(
  expansion: MutableExpansion<G, B, S, E, F>,
  reason: Extract<PredictionResult, { kind: "stopped" }>["reason"],
  refs: readonly string[],
): PredictionResult {
  return {
    kind: "stopped",
    rootRef: expansion.input.rootRef,
    startStateRef: expansion.input.stateRef,
    reason,
    refs,
    predictionCallsUsed: expansion.usage.predictionCallsUsed,
  };
}

function failureOutput<G, B, S, E, F, C>(
  input: ExpandGoalGraphInput<G, B, S, E, F, C>,
  reason: Extract<PredictionResult, { kind: "not_ready" }>["reason"],
  refs: readonly string[],
): ExpandGoalGraphOutput<G, B, S, E, F> {
  return {
    plan: null,
    prediction: {
      kind: "not_ready",
      rootRef: input.rootRef,
      startStateRef: input.stateRef,
      reason,
      frontier: refs.map((ref, index) => ({
        frontierRef: `planning-failure:${index}`,
        nodeRef: "planning",
        resultRef: ref,
        coverage: "unknown",
        remainingHorizon: input.options.horizonN,
        reason,
        unknownRefs: [ref],
      })),
      predictionCallsUsed: input.control.usage.predictionCallsUsed,
    },
    ranking: null,
    priorAssessments: [],
    usage: { ...input.control.usage },
  };
}

function planningContractFailure<G, B, S, E, F, C>(
  input: ExpandGoalGraphInput<G, B, S, E, F, C>,
): readonly string[] | null {
  if (!sameVersionedRef(input.options.capabilityRef, input.capability.contract)) {
    return ["planning.capabilityRef"];
  }
  const capabilityRefs = input.capability.resultModels.map(model => model.ref);
  const unavailable = input.options.resultModelRefs.filter(
    ref => !capabilityRefs.some(candidate => sameVersionedRef(candidate, ref)),
  );
  return unavailable.length === 0
    ? null
    : unavailable.map(ref => `model:${ref.id}@${ref.version}`);
}

function assessPriors<G, B, S, E, F>(
  expansion: MutableExpansion<G, B, S, E, F>,
  skill: EnabledSkill,
  obligationRef: PlanNode<G, B, S, E, F>["obligationRef"],
  state: S,
  evidence: readonly E[],
): PlanControl<G, B, S, E, F>["failurePriors"] {
  const applicable: PlanControl<G, B, S, E, F>["failurePriors"][number][] = [];
  for (const prior of expansion.input.control.failurePriors) {
    const assessment = expansion.input.capability.assessPrior({
      prior,
      obligationRef,
      skillRef: skillRef(skill),
      actualState: state,
      actualEvidence: evidence,
      invalidation: prior.invalidation,
    });
    mergePriorAssessment(expansion, prior.id, assessment);
    if (assessment.kind === "applicable") applicable.push(prior);
  }
  return applicable;
}

function mergePriorAssessment<G, B, S, E, F>(
  expansion: MutableExpansion<G, B, S, E, F>,
  priorRef: string,
  assessment: PlanningApplicability,
): void {
  const previous = expansion.priorAssessments.get(priorRef);
  if (previous === undefined) {
    expansion.priorAssessments.set(priorRef, { priorRef, applicability: assessment });
    return;
  }
  if (
    previous.applicability.kind === "applicable" ||
    assessment.kind === "inapplicable"
  ) {
    return;
  }
  expansion.priorAssessments.set(priorRef, { priorRef, applicability: assessment });
}

function addEdge<G, B, S, E, F>(
  expansion: MutableExpansion<G, B, S, E, F>,
  sourceNodeRef: string,
  resultRef: string,
  targetKind: "node" | "checkpoint" | "terminal",
  targetRef: string,
  conditions: PlanEdge<G, B, S, E>["conditions"],
  coverage: PlanCoverage,
): void {
  expansion.edges.push({
    id: `plan-edge:${expansion.edgeSequence}`,
    source: { nodeRef: sourceNodeRef, resultRef },
    target: { kind: targetKind, targetRef },
    conditions,
    coverage,
  });
  expansion.edgeSequence += 1;
}

function addFrontier<G, B, S, E, F>(
  expansion: MutableExpansion<G, B, S, E, F>,
  nodeRef: string,
  resultRef: string,
  coverage: PlanCoverage,
  remainingHorizon: number,
  reason: string,
  unknownRefs: readonly string[],
): void {
  expansion.frontier.push({
    frontierRef: `plan-frontier:${expansion.frontierSequence}`,
    nodeRef,
    resultRef,
    coverage,
    remainingHorizon,
    reason,
    unknownRefs,
  });
  expansion.frontierSequence += 1;
}

function aggregatePathProjection(
  projections: readonly ResultTransitionProjection[],
  termination: Extract<TransitionContinuation, { kind: "terminal" }>,
  unknown: readonly PlanningUnknown[],
  coverage: PlanCoverage,
): PathProjection {
  const riskByScale = new Map<
    string,
    { scaleRef: VersionedRef; level: string; ordinal: number }
  >();
  for (const risk of projections.flatMap(item => item.riskLevels)) {
    const key = `${risk.scaleRef.id}\0${risk.scaleRef.version}`;
    const previous = riskByScale.get(key);
    if (previous === undefined || risk.ordinal > previous.ordinal) {
      riskByScale.set(key, risk);
    }
  }
  const costs = projections
    .map(item => item.cost)
    .filter((cost): cost is { amount: number; unit: string } => cost !== null);
  const units = new Set(costs.map(cost => cost.unit));
  const completeCost = costs.length === projections.length && units.size <= 1;
  const unknownRefs = [
    ...new Set([
      ...unknown.map(item => item.ref),
    ]),
  ];
  return {
    terminalSatisfaction: projections.at(-1)?.terminalSatisfaction ?? null,
    riskLevels: [...riskByScale.values()],
    maximumCost: completeCost
      ? costs.reduce((sum, cost) => sum + cost.amount, 0)
      : null,
    costUnit: completeCost && units.size === 1 ? [...units][0] ?? null : null,
    unknownRefs,
    coverage,
  };
}

function comparePlanningPaths(
  left: ComparablePlanningPath,
  right: ComparablePlanningPath,
  policy: PathPreferencePolicy,
): ComparisonResult {
  if (
    left.projection.coverage !== "covered" ||
    right.projection.coverage !== "covered"
  ) {
    return { order: 0, missingKey: "coverage" };
  }
  const keys = preferenceKeys(policy);
  for (const key of keys) {
    const compared = comparePathKey(left, right, key);
    if (typeof compared === "number") {
      if (compared !== 0) return { order: compared, missingKey: null };
    } else {
      return compared;
    }
  }
  return { order: 0, missingKey: null };
}

function preferenceKeys(
  policy: PathPreferencePolicy,
): readonly ("satisfaction" | "risk" | "rankOrder")[] {
  switch (policy.kind) {
    case "score_first":
      return ["satisfaction", "rankOrder"];
    case "order_first":
      return ["rankOrder", "satisfaction"];
    case "conservative":
      return ["risk", "satisfaction", "rankOrder"];
    case "aggressive":
      return ["satisfaction", "risk", "rankOrder"];
  }
}

function comparePathKey(
  left: ComparablePlanningPath,
  right: ComparablePlanningPath,
  key: "satisfaction" | "risk" | "rankOrder",
): -1 | 0 | 1 | ComparisonResult {
  if (key === "satisfaction") {
    if (
      left.projection.terminalSatisfaction === null ||
      right.projection.terminalSatisfaction === null
    ) {
      return { order: 0, missingKey: "terminalSatisfaction" };
    }
    return left.projection.terminalSatisfaction >
      right.projection.terminalSatisfaction
      ? -1
      : left.projection.terminalSatisfaction <
          right.projection.terminalSatisfaction
        ? 1
        : 0;
  }
  if (key === "rankOrder") {
    if (left.rankOrder === null || right.rankOrder === null) {
      return { order: 0, missingKey: "rankOrder" };
    }
    return left.rankOrder < right.rankOrder
      ? -1
      : left.rankOrder > right.rankOrder
        ? 1
        : 0;
  }
  if (
    left.projection.riskLevels.length !== 1 ||
    right.projection.riskLevels.length !== 1
  ) {
    return { order: 0, missingKey: "riskLevel" };
  }
  const leftRisk = left.projection.riskLevels[0];
  const rightRisk = right.projection.riskLevels[0];
  if (
    leftRisk === undefined ||
    rightRisk === undefined ||
    !sameVersionedRef(leftRisk.scaleRef, rightRisk.scaleRef)
  ) {
    return { order: 0, missingKey: "riskScale" };
  }
  return leftRisk.ordinal < rightRisk.ordinal
    ? -1
    : leftRisk.ordinal > rightRisk.ordinal
      ? 1
      : 0;
}

function resolveNextSkills(
  skills: readonly EnabledSkill[],
  continuation: Extract<TransitionContinuation, { kind: "continued" }>,
): readonly EnabledSkill[] {
  return continuation.nextSkillRefs.flatMap(ref => {
    const skill = skills.find(candidate =>
      candidate.id === ref.id && candidate.version === ref.version,
    );
    return skill === undefined ? [] : [skill];
  });
}

function modelCoversSkill<G, B, S, E, F>(
  model: ResultModelBinding<G, B, S, E, F>,
  skill: EnabledSkill,
): boolean {
  return model.skillRefs.some(ref =>
    ref.id === skill.id && ref.version === skill.version,
  );
}

function skillRef(skill: EnabledSkill): VersionedRef {
  return { id: skill.id, version: skill.version };
}

function stableTransitionRef(
  skill: EnabledSkill,
  frameRef: string,
  resultRef: string,
): string {
  return `${skill.id}@${skill.version}:${frameRef}:${resultRef}`;
}
