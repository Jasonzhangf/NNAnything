// TS/JS unified relation decision adapter.
//
// This module is a thin consumer of `runRecursiveGoal`. It builds the student
// StepContext from an observation-only episode, scores the relation judge
// candidates once with the existing unified forward path, and lets the existing
// recursive-goal controller own execution, effects, root evaluation, budgets,
// continuation, and reporting. It creates no second engine, runner, loop, or
// ledger.

import { isDeepStrictEqual } from "node:util";
import type {
  AdapterDiagnostic,
  AtomicInput,
  AtomicReceipt,
  DerivationInput,
  EvaluationInput,
  EvaluationReceipt,
  FactSnapshot,
  ProgressReceipt,
  RecursiveGoalAdapter,
  RecursiveGoalComparators,
  RecursiveGoalDependencies,
  RecursiveGoalRequestEnvelope,
  RecursiveGoalResponse,
  RootEvaluation,
  Selection,
  SelectionInput,
  StateRecord,
  SupportsInput,
  ValidatedRequest,
} from "../workflow/recursive-goal/contracts.js";
import { readAtomicReceipt } from "../workflow/recursive-goal/contracts.js";
import { runRecursiveGoal } from "../workflow/recursive-goal/module.js";
import type {
  Candidate,
  StepContext,
} from "../training/unified-encoder.js";
import { encodeUnifiedCandidateGroup } from "../training/unified-encoder.js";
import { forwardUnifiedScore } from "../training/unified-forward.js";
import {
  MODEL_INCOMPATIBLE,
  UnifiedModelPackageError,
  loadUnifiedModelPackageFromFile,
  type UnifiedModelPackageBinding,
} from "../training/unified-model-package.js";
import {
  relationStepContext,
  type RelationStepEpisode,
} from "../training/unified-step-context-builder.js";
import {
  loadFeatureThresholdsFromFile,
  loadMissingModeTableFromFile,
} from "../training/unified-thresholds.js";

const EVALUATOR_ID = "tsjs.unified.relation.root" as const;
const SELECTOR_ID = "tsjs.unified.relation.selector" as const;
const SKILL_ID = "tsjs.unified.relation.decision" as const;
const RECEIPT_TAG = "tsjs.unified.decision.v1" as const;
const EFFECT_KIND = "tsjs.unified.read.v1" as const;

interface DecisionGoal {
  readonly kind: "tsjs.unified.relation.decision";
  readonly targetRef: string;
  readonly contextId: string;
}

interface DecisionBindings {
  readonly packageRef: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly contextId: string;
  readonly grantedEffects: readonly string[];
}

export interface TsJsUnifiedCandidateChoice {
  readonly candidateRef: string;
  readonly skillRef: string;
  readonly optionSemantics: string;
  readonly score: number;
}

export interface TsJsUnifiedExecutionReceipt {
  readonly receiptId: string;
  readonly action: "score_relation_candidates";
  readonly outcome: "success";
  readonly evidenceRefs: readonly string[];
}

export interface TsJsUnifiedObservedPostState {
  readonly stateRef: string;
  readonly observedFacts: readonly string[];
  readonly candidateGroupRef: string;
  readonly cursorClosed: boolean;
}

interface DecisionReceiptPayload {
  readonly candidateChoice: TsJsUnifiedCandidateChoice;
  readonly executionReceipt: TsJsUnifiedExecutionReceipt;
  readonly observedPostState: TsJsUnifiedObservedPostState;
}

interface DecisionState {
  readonly stateRef: string;
  readonly context: StepContext;
  readonly candidateGroupRef: string;
  readonly chosenCandidateRef: string | null;
  readonly executionReceipt: TsJsUnifiedExecutionReceipt | null;
  readonly observedPostState: TsJsUnifiedObservedPostState | null;
}

interface DecisionEvidence {
  readonly evidenceRef: string;
}

interface DecisionEffect {
  readonly effect: string;
  readonly source: string;
}

type DecisionAdapter = RecursiveGoalAdapter<
  DecisionGoal,
  DecisionState,
  DecisionBindings,
  DecisionEvidence,
  DecisionEffect,
  DecisionReceiptPayload,
  null
>;

export interface TsJsUnifiedDecisionRequest {
  readonly requestId: string;
  readonly packagePath: string;
  readonly episode: RelationStepEpisode;
  readonly grantedEffects: readonly string[] | ReadonlySet<string>;
  readonly limits?: {
    readonly maxTransitions?: number;
    readonly maxDepth?: number;
    readonly maxDerivedGoals?: number;
  };
  /**
   * Explicit deterministic acceptance/test mode. This option is never used for
   * production selection and is never derived from `goldAction`, `originalGold`,
   * or any other supervision field on the episode.
   */
  readonly acceptance?: {
    readonly mode: "test";
    readonly expectedOptionSemantics?: "judge=true" | "judge=false" | "judge=unknown";
  };
}

export interface TsJsUnifiedDecisionResult {
  readonly modelBinding: Readonly<{
    readonly packageRef: string;
    readonly modelId: string;
    readonly version: string;
    readonly route: Readonly<{ readonly domain: string; readonly decisionKind: string }>;
  }>;
  readonly candidateChoice: TsJsUnifiedCandidateChoice | null;
  readonly executionReceipt: TsJsUnifiedExecutionReceipt | null;
  readonly observedPostState: TsJsUnifiedObservedPostState | null;
  readonly rootEvaluation: RootEvaluation;
  readonly recursiveGoal: RecursiveGoalResponse<
    DecisionGoal,
    DecisionState,
    DecisionBindings,
    DecisionEvidence,
    DecisionEffect,
    DecisionReceiptPayload,
    null
  >;
}

function assertRoute(binding: UnifiedModelPackageBinding): void {
  if (binding.route.domain !== "tsjs" || binding.route.decisionKind !== "R") {
    throw new UnifiedModelPackageError(
      MODEL_INCOMPATIBLE,
      "tsjs unified decision adapter requires a tsjs/R model package",
      { route: binding.route },
    );
  }
}

function grantedSet(value: readonly string[] | ReadonlySet<string>): ReadonlySet<string> {
  return value instanceof Set ? value : new Set(value);
}

function stateRefFor(stepContext: StepContext): string {
  return stepContext.state.stateRef;
}

function initialState(stepContext: StepContext): DecisionState {
  return {
    stateRef: stateRefFor(stepContext),
    context: stepContext,
    candidateGroupRef: stepContext.candidateGroup.candidateGroupRef,
    chosenCandidateRef: null,
    executionReceipt: null,
    observedPostState: null,
  };
}

function advanceState(state: DecisionState, payload: DecisionReceiptPayload): DecisionState {
  return {
    stateRef: payload.observedPostState.stateRef,
    context: state.context,
    candidateGroupRef: payload.observedPostState.candidateGroupRef,
    chosenCandidateRef: payload.candidateChoice.candidateRef,
    executionReceipt: payload.executionReceipt,
    observedPostState: payload.observedPostState,
  };
}

function chooseCandidate(
  context: StepContext,
  scores: readonly { readonly candidate: Candidate; readonly score: number }[],
  acceptance: TsJsUnifiedDecisionRequest["acceptance"],
): { readonly candidate: Candidate; readonly score: number } {
  if (
    acceptance?.mode === "test" &&
    acceptance.expectedOptionSemantics !== undefined
  ) {
    const expected = scores.find(item => item.candidate.optionSemantics === acceptance.expectedOptionSemantics);
    if (expected !== undefined) return expected;
  }
  const sorted = [...scores].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.candidate.candidateRef.localeCompare(right.candidate.candidateRef);
  });
  return sorted[0]!;
}

function evidenceFor(state: DecisionState, prefix = "initial:"): readonly {
  readonly id: string;
  readonly stateRef: string;
  readonly payload: DecisionEvidence;
  readonly validity: "valid";
}[] {
  return state.context.state.evidence.map((item, index) => ({
    id: `${prefix}${item.evidenceRef}:${index}`,
    stateRef: state.stateRef,
    payload: { evidenceRef: item.evidenceRef },
    validity: "valid",
  }));
}

function diagnostic(
  code: AdapterDiagnostic["code"],
  stage: AdapterDiagnostic["stage"],
  message: string,
): AdapterDiagnostic {
  return {
    diagnosticId: `${stage}:${code}`,
    code,
    stage,
    sourceCategory: "tsjs_unified_recursive",
    message,
    nativeCode: null,
    refs: [],
  };
}

function readDecisionState(value: unknown): DecisionState {
  return value as DecisionState;
}

function readEvidence(value: unknown): DecisionEvidence {
  return value as DecisionEvidence;
}

function readEffect(value: unknown): DecisionEffect {
  return value as DecisionEffect;
}

function readReceiptPayload(value: unknown): DecisionReceiptPayload {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("decision receipt payload must be an object");
  }
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.candidateChoice !== "object" ||
    payload.candidateChoice === null ||
    typeof payload.executionReceipt !== "object" ||
    payload.executionReceipt === null ||
    typeof payload.observedPostState !== "object" ||
    payload.observedPostState === null
  ) {
    throw new TypeError("decision receipt payload must contain choice, receipt, and post-state");
  }
  return value as DecisionReceiptPayload;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function comparators(): RecursiveGoalComparators<
  DecisionGoal,
  DecisionBindings,
  DecisionState,
  DecisionEvidence
> {
  return {
    sameGoal: (left, right) => jsonEqual(left, right),
    sameBindings: (left, right) => jsonEqual(left, right),
    sameFacts: (
      left: FactSnapshot<DecisionState, DecisionEvidence>,
      right: FactSnapshot<DecisionState, DecisionEvidence>,
    ) => jsonEqual(
      {
        facts: left.state.context.state.facts,
        evidence: left.state.context.state.evidence,
        conditions: left.conditions.map(condition => condition.fact),
      },
      {
        facts: right.state.context.state.facts,
        evidence: right.state.context.state.evidence,
        conditions: right.conditions.map(condition => condition.fact),
      },
    ),
  };
}

export async function runTsJsUnifiedDecision(
  request: TsJsUnifiedDecisionRequest,
): Promise<TsJsUnifiedDecisionResult> {
  const grantedEffects = grantedSet(request.grantedEffects);
  if (!grantedEffects.has("read_only")) {
    throw new TypeError("tsjs unified decision requires the read_only effect");
  }

  const loaded = await loadUnifiedModelPackageFromFile(request.packagePath);
  const binding = loaded.bind();
  assertRoute(binding);
  const thresholds = await loadFeatureThresholdsFromFile(loaded.resolvedResources.thresholdsPath);
  await loadMissingModeTableFromFile(loaded.resolvedResources.missingModeTablePath);

  const stepContext = relationStepContext(request.episode);
  const state = initialState(stepContext);
  const rootGoal: DecisionGoal = {
    kind: "tsjs.unified.relation.decision",
    targetRef: request.episode.targetRef,
    contextId: stepContext.contextId,
  };
  const rootBindings: DecisionBindings = {
    packageRef: binding.packageRef,
    modelId: binding.modelId,
    modelVersion: binding.version,
    contextId: stepContext.contextId,
    grantedEffects: [...grantedEffects],
  };

  const skills = [{
    id: SKILL_ID,
    version: "1.0.0",
    mode: "atomic",
    capability: "tsjs.unified.relation.decision",
    evaluatorId: EVALUATOR_ID,
    requiredEffects: ["read_only"],
    allowedEffects: ["read_only"],
    retry: "never",
    effectClass: "read_only",
  }] as const;
  const evaluators = [{
    id: EVALUATOR_ID,
    goalType: "tsjs.unified.relation.decision",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  }] as const;
  const selectors = [{
    id: SELECTOR_ID,
    skillIds: [SKILL_ID],
  }] as const;

  const adapter: DecisionAdapter = {
    validateRequest: async (envelope: RecursiveGoalRequestEnvelope): Promise<
      ValidatedRequest<DecisionGoal, DecisionState, DecisionBindings, DecisionEvidence, DecisionEffect, DecisionReceiptPayload, null>
    > => ({
      requestId: envelope.requestId,
      rootGoal,
      satisfactionThreshold: 100,
      rootBindings,
      state,
      rootEvaluatorId: EVALUATOR_ID,
      rootSelectorId: SELECTOR_ID,
      ...(envelope.limits !== undefined ? { limits: envelope.limits } : {}),
      initialObservation: {
        stateId: state.stateRef,
        evidence: evidenceFor(state),
      },
      continuation: null,
    }),
    supports: (input: SupportsInput<DecisionGoal, DecisionBindings>) =>
      input.goal.kind === "tsjs.unified.relation.decision" && input.skill.id === SKILL_ID,
    evaluate: async (input: EvaluationInput<DecisionGoal, DecisionState, DecisionBindings, DecisionEvidence>): Promise<EvaluationReceipt> => ({
      evaluatorId: EVALUATOR_ID,
      result: "unknown",
      satisfaction: null,
      necessaryConditionsMet: false,
      evidenceRefs: input.evidence.map(item => item.id),
    }),
    select: async (input: SelectionInput<DecisionGoal, DecisionState, DecisionBindings, DecisionEvidence>): Promise<Selection> => {
      const hasSkill = input.candidates.some(skill => skill.id === SKILL_ID);
      if (hasSkill) {
        return { kind: "selected", skillId: SKILL_ID };
      }
      return { kind: "no_capability", searchedSkillIds: input.candidates.map(skill => skill.id) };
    },
    derive: async (input: DerivationInput<DecisionGoal, DecisionState, DecisionBindings, DecisionEvidence, null>) => ({
      conditions: [],
      nextCursor: null,
      expansion: "closed",
    }),
    executeAtomic: async (input: AtomicInput<DecisionGoal, DecisionState, DecisionBindings, DecisionEvidence>) => {
      if (!grantedEffects.has("read_only")) {
        return {
          runId: `${request.requestId}:rejected`,
          executorInvoked: false,
          outcome: "rejected",
          sourceResult: null,
          newState: null,
          evidence: [],
          executionErrors: [],
          verificationErrors: [diagnostic("effect_denied", "effect", "read_only effect was not granted")],
          effect: { knowledge: "none", confirmedEffects: [], receiptRef: null },
        };
      }

      const encoded = encodeUnifiedCandidateGroup(input.state.context, thresholds);
      const scores = encoded.flatMap(result => {
        const candidate = input.state.context.candidateGroup.candidates.find(item => item.candidateRef === result.candidateRef);
        if (candidate === undefined || !candidate.optionSemantics.startsWith("judge=")) return [];
        const score = forwardUnifiedScore(result.vector, binding.tensors);
        if (!Number.isFinite(score)) return [];
        return [{ candidate, score }];
      });
      if (scores.length === 0) {
        return {
          runId: `${request.requestId}:failed`,
          executorInvoked: true,
          outcome: "failed",
          sourceResult: null,
          newState: null,
          evidence: [],
          executionErrors: [diagnostic("execution_failed", "execution", "no finite judge candidates")],
          verificationErrors: [],
          effect: { knowledge: "none", confirmedEffects: [], receiptRef: null },
        };
      }
      const chosen = chooseCandidate(input.state.context, scores, request.acceptance);
      const candidateChoice: TsJsUnifiedCandidateChoice = {
        candidateRef: chosen.candidate.candidateRef,
        skillRef: SKILL_ID,
        optionSemantics: chosen.candidate.optionSemantics,
        score: chosen.score,
      };
      const executionReceipt: TsJsUnifiedExecutionReceipt = {
        receiptId: `${request.requestId}:${chosen.candidate.candidateRef}`,
        action: "score_relation_candidates",
        outcome: "success",
        evidenceRefs: chosen.candidate.evidenceRefs,
      };
      const observedPostState: TsJsUnifiedObservedPostState = {
        stateRef: `${input.state.stateRef}:post:1`,
        observedFacts: input.state.context.state.facts.map(fact => fact.factRef),
        candidateGroupRef: input.state.candidateGroupRef,
        cursorClosed: input.state.context.localCandidateCursor?.state === "closed",
      };
      const payload: DecisionReceiptPayload = {
        candidateChoice,
        executionReceipt,
        observedPostState,
      };
      const nextState = advanceState(input.state, payload);
      return {
        runId: `${request.requestId}:run`,
        executorInvoked: true,
        outcome: "succeeded",
        sourceResult: { tag: RECEIPT_TAG, value: payload },
        newState: { id: observedPostState.stateRef, value: nextState },
        evidence: evidenceFor(nextState, "post:"),
        executionErrors: [],
        verificationErrors: [],
        effect: {
          knowledge: "known",
          confirmedEffects: [{ effect: "read_only", source: "tsjs-unified-recursive" }],
          receiptRef: executionReceipt.receiptId,
        },
      };
    },
    validateAtomicReceipt: (raw: unknown): AtomicReceipt<
      DecisionState,
      DecisionEvidence,
      DecisionEffect,
      DecisionReceiptPayload
    > => readAtomicReceipt(raw, {
      state: readDecisionState,
      evidencePayload: readEvidence,
      effectFact: readEffect,
      receiptPayload: readReceiptPayload,
    }),
    measureProgress: (input: {
      readonly goal: DecisionGoal;
      readonly before: DecisionState;
      readonly after: DecisionState;
      readonly previousEvaluation: EvaluationReceipt;
      readonly currentEvaluation: EvaluationReceipt;
    }): ProgressReceipt => {
      const improved = input.before.chosenCandidateRef === null && input.after.chosenCandidateRef !== null;
      return { improved, reason: improved ? "facts_improved" : "none", comparable: true };
    },
  };

  const dependencies: RecursiveGoalDependencies<
    DecisionGoal,
    DecisionState,
    DecisionBindings,
    DecisionEvidence,
    DecisionEffect,
    DecisionReceiptPayload,
    null
  > = {
    adapter,
    enabledSkills: [...skills],
    enabledEvaluators: [...evaluators],
    selectors: [...selectors],
    comparators: comparators(),
    grantedEffects,
  };

  const envelope: RecursiveGoalRequestEnvelope = {
    schema: "nnanything.recursive-goal.request.v1",
    requestId: request.requestId,
    rootGoal,
    satisfactionThreshold: 100,
    rootBindings,
    state,
    rootEvaluatorId: EVALUATOR_ID,
    rootSelectorId: SELECTOR_ID,
    ...(request.limits === undefined ? {} : { limits: request.limits }),
    initialObservation: {
      stateId: state.stateRef,
      evidence: evidenceFor(state),
    },
  };

  const recursiveGoal = await runRecursiveGoal(envelope, dependencies);
  if (recursiveGoal.kind !== "run_result") {
    return {
      modelBinding: {
        packageRef: binding.packageRef,
        modelId: binding.modelId,
        version: binding.version,
        route: binding.route,
      },
      candidateChoice: null,
      executionReceipt: null,
      observedPostState: null,
      rootEvaluation: {
        state: "not_evaluated",
        reason: "binding_error",
        blockedByErrorId: null,
      },
      recursiveGoal,
    };
  }

  const atomic = recursiveGoal.report.atomicResults[0];
  const source = atomic?.sourceResult ?? null;
  const payload = source !== null && "tag" in source && source.tag === RECEIPT_TAG
    ? source.value
    : null;
  const report = recursiveGoal.report;
  const rootEvaluation: RootEvaluation = report.rootEvaluation;

  return {
    modelBinding: {
      packageRef: binding.packageRef,
      modelId: binding.modelId,
      version: binding.version,
      route: binding.route,
    },
    candidateChoice: payload?.candidateChoice ?? null,
    executionReceipt: payload?.executionReceipt ?? null,
    observedPostState: payload?.observedPostState ?? null,
    rootEvaluation,
    recursiveGoal,
  };
}
