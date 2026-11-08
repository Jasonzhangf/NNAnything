// TS/JS unified relation decision adapter.
//
// This module is a thin consumer of `runRecursiveGoal`. It builds the student
// StepContext from an observation-only episode, scores the relation judge
// candidates once with the existing unified forward path, and lets the existing
// recursive-goal controller own execution, effects, root evaluation, budgets,
// continuation, and reporting. It creates no second engine, runner, loop, or
// ledger.

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
  SupportsInput,
  ValidatedRequest,
} from "../workflow/recursive-goal/contracts.js";
import { readAtomicReceipt } from "../workflow/recursive-goal/contracts.js";
import { runRecursiveGoal } from "../workflow/recursive-goal/module.js";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";
import type {
  Candidate,
  Observed,
  PreviousExecutionProjection,
  StepContext,
} from "../training/unified-encoder.js";
import { encodeUnifiedCandidateGroup } from "../training/unified-encoder.js";
import { forwardUnifiedScore } from "../training/unified-forward.js";
import type { UnifiedTensors } from "../training/unified-forward.js";
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
const SKILL_ID = "skill:relation.judge" as const;
const SKILL_VERSION = "relation.judge.v1" as const;
const RELATION_READ_SKILL_ID = "skill:relation.read" as const;
const RELATION_OBSERVE_SKILL_ID = "skill:relation.observe" as const;
const RELATION_CONTROL_SKILL_ID = "skill:relation.control" as const;
const RECEIPT_TAG = "tsjs.unified.decision.v1" as const;

interface DecisionGoal {
  readonly kind: "verify";
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
  readonly targetRef: string | null;
  readonly score: number;
}

export type TsJsUnifiedTerminalJudgement =
  | "judge=true"
  | "judge=false"
  | "judge=unknown"
  | "none";

export interface TsJsUnifiedExecutionReceipt {
  readonly receiptId: string;
  readonly action:
    | "submit_terminal_judgement"
    | "submit_read"
    | "submit_observe"
    | "submit_control";
  readonly actionRef: string;
  readonly candidateRef: string;
  readonly terminalJudgement: TsJsUnifiedTerminalJudgement;
  readonly postStateRef: string;
  readonly outcome: "success" | "failed";
  readonly evidenceRefs: readonly string[];
  /**
   * Real failure report for a failed advance/observe read. Present only when
   * `outcome` is `"failed"`; it carries the actual reader error, never a
   * synthetic success.
   */
  readonly failure?: Readonly<{
    readonly code: string;
    readonly message: string;
    readonly nativeCode: string | null;
  }> | null;
}

export interface TsJsUnifiedObservedPostState {
  readonly stateRef: string;
  readonly postStateRef: string;
  readonly candidateRef: string;
  readonly terminalJudgement: TsJsUnifiedTerminalJudgement;
  readonly observedFacts: readonly string[];
  readonly candidateGroupRef: string;
  readonly cursorClosed: boolean;
}

interface DecisionReceiptPayload {
  readonly stepId?: string;
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
  readonly candidateRef?: string;
  readonly postStateRef?: string;
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
  _context: StepContext,
  scores: readonly { readonly candidate: Candidate; readonly score: number }[],
): { readonly candidate: Candidate; readonly score: number } {
  const sorted = [...scores].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.candidate.candidateRef.localeCompare(right.candidate.candidateRef);
  });
  return sorted[0]!;
}

function encodedScores(
  context: StepContext,
  thresholds: Parameters<typeof encodeUnifiedCandidateGroup>[1],
  tensors: UnifiedTensors,
): readonly { readonly candidate: Candidate; readonly score: number }[] {
  return encodeUnifiedCandidateGroup(context, thresholds).flatMap(result => {
    const candidate = context.candidateGroup.candidates.find(
      item => item.candidateRef === result.candidateRef,
    );
    if (candidate === undefined) return [];
    const score = forwardUnifiedScore(result.vector, tensors);
    if (!Number.isFinite(score)) return [];
    return [{ candidate, score }];
  });
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
    payload: {
      evidenceRef: item.evidenceRef,
      ...(state.chosenCandidateRef === null
        ? {}
        : {
            candidateRef: state.chosenCandidateRef,
            postStateRef: state.stateRef,
          }),
    },
    validity: "valid",
  }));
}

interface StructuralRootEvaluation {
  readonly result: "satisfied" | "unsatisfied" | "unknown";
  readonly satisfaction: number | null;
  readonly necessaryConditionsMet: boolean;
  readonly evidenceRefs: readonly string[];
}

function evaluateStructuralRoot(
  state: DecisionState,
  evidence: readonly { readonly id: string; readonly stateRef: string; readonly validity: string }[],
): StructuralRootEvaluation {
  const chosen = state.chosenCandidateRef === null
    ? null
    : state.context.candidateGroup.candidates.find(
        candidate => candidate.candidateRef === state.chosenCandidateRef,
      ) ?? null;
  const currentEvidenceRefs = evidence
    .filter(item => item.stateRef === state.stateRef && item.validity === "valid")
    .map(item => item.id);

  if (
    chosen === null
    || !chosen.optionSemantics.startsWith("judge=")
    || state.executionReceipt === null
    || state.observedPostState === null
    || currentEvidenceRefs.length === 0
  ) {
    return {
      result: "unknown",
      satisfaction: null,
      necessaryConditionsMet: false,
      evidenceRefs: currentEvidenceRefs,
    };
  }

  const terminalJudgement = chosen.optionSemantics as TsJsUnifiedTerminalJudgement;
  const receipt = state.executionReceipt;
  const postState = state.observedPostState;
  const structurallyClosed =
    receipt.candidateRef === chosen.candidateRef
    && receipt.terminalJudgement === terminalJudgement
    && receipt.postStateRef === state.stateRef
    && postState.candidateRef === chosen.candidateRef
    && postState.terminalJudgement === terminalJudgement
    && postState.stateRef === state.stateRef
    && postState.postStateRef === state.stateRef
    && postState.candidateGroupRef === state.candidateGroupRef;

  return structurallyClosed
    ? {
        result: "satisfied",
        satisfaction: 100,
        necessaryConditionsMet: true,
        evidenceRefs: currentEvidenceRefs,
      }
    : {
        result: "unsatisfied",
        satisfaction: 0,
        necessaryConditionsMet: false,
        evidenceRefs: currentEvidenceRefs,
      };
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
    kind: "verify",
    targetRef: request.episode.sampleId,
    contextId: stepContext.contextId,
  };
  const rootBindings: DecisionBindings = {
    packageRef: binding.packageRef,
    modelId: binding.modelId,
    modelVersion: binding.version,
    contextId: stepContext.contextId,
    grantedEffects: [...grantedEffects],
  };

  const skills = [
    {
      id: SKILL_ID,
      version: SKILL_VERSION,
      mode: "atomic",
      capability: "relation.judge",
      evaluatorId: EVALUATOR_ID,
      requiredEffects: ["read_only"],
      allowedEffects: ["read_only"],
      retry: "never",
      effectClass: "read_only",
    },
    {
      id: RELATION_READ_SKILL_ID,
      version: "relation.read.v1",
      mode: "atomic",
      capability: "relation.read",
      evaluatorId: EVALUATOR_ID,
      requiredEffects: ["read_only"],
      allowedEffects: ["read_only"],
      retry: "never",
      effectClass: "read_only",
    },
    {
      id: RELATION_OBSERVE_SKILL_ID,
      version: "relation.observe.v1",
      mode: "atomic",
      capability: "relation.observe",
      evaluatorId: EVALUATOR_ID,
      requiredEffects: ["read_only"],
      allowedEffects: ["read_only"],
      retry: "never",
      effectClass: "read_only",
    },
    {
      id: RELATION_CONTROL_SKILL_ID,
      version: "relation.control.v1",
      mode: "atomic",
      capability: "relation.control",
      evaluatorId: EVALUATOR_ID,
      requiredEffects: ["read_only"],
      allowedEffects: ["read_only"],
      retry: "never",
      effectClass: "read_only",
    },
  ] as const;
  const evaluators = [{
    id: EVALUATOR_ID,
    goalType: "verify",
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
      input.goal.kind === "verify" && input.skill.id === SKILL_ID,
    evaluate: async (input: EvaluationInput<DecisionGoal, DecisionState, DecisionBindings, DecisionEvidence>): Promise<EvaluationReceipt> => ({
      evaluatorId: EVALUATOR_ID,
      ...evaluateStructuralRoot(input.state, input.evidence),
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
      const chosen = chooseCandidate(input.state.context, scores);
      const candidateChoice: TsJsUnifiedCandidateChoice = {
        candidateRef: chosen.candidate.candidateRef,
        skillRef: SKILL_ID,
        optionSemantics: chosen.candidate.optionSemantics,
        targetRef: chosen.candidate.targetRef,
        score: chosen.score,
      };
      const executionReceipt: TsJsUnifiedExecutionReceipt = {
        receiptId: `${request.requestId}:${chosen.candidate.candidateRef}`,
        action: "submit_terminal_judgement",
        actionRef: chosen.candidate.candidateRef,
        candidateRef: chosen.candidate.candidateRef,
        terminalJudgement: chosen.candidate.optionSemantics as TsJsUnifiedTerminalJudgement,
        postStateRef: `${input.state.stateRef}:post:1`,
        outcome: "success",
        evidenceRefs: chosen.candidate.evidenceRefs,
      };
      const observedPostState: TsJsUnifiedObservedPostState = {
        stateRef: `${input.state.stateRef}:post:1`,
        postStateRef: `${input.state.stateRef}:post:1`,
        candidateRef: chosen.candidate.candidateRef,
        terminalJudgement: chosen.candidate.optionSemantics as TsJsUnifiedTerminalJudgement,
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

const MULTI_STEP_ROOT_EVALUATOR_ID = "tsjs.unified.multistep.root.evaluator";
const MULTI_STEP_ROOT_SELECTOR_ID = "tsjs.unified.multistep.root.selector";
const MULTI_STEP_RELATION_JUDGE_SKILL_ID = "skill:relation.judge";
const MULTI_STEP_RELATION_READ_SKILL_ID = "skill:relation.read";
const MULTI_STEP_RELATION_OBSERVE_SKILL_ID = "skill:relation.observe";
const MULTI_STEP_RELATION_CONTROL_SKILL_ID = "skill:relation.control";
const MULTI_STEP_EXECUTOR_MISSING = "EXECUTOR_MISSING" as const;

export interface TsJsUnifiedStepReadInput {
  readonly requestId: string;
  readonly stepId: string;
  readonly action: "advance" | "observe";
  readonly candidateRef: string;
  readonly targetRef: string | null;
  readonly edgeRef: string | null;
  readonly pendingRelationRef: string;
  readonly moduleRef: string | null;
  readonly specifier: string | null;
  readonly fromFile: string | null;
  readonly fromStepId: string | null;
}

export interface TsJsUnifiedStepExecution {
  readonly outcome: "success" | "failed";
  readonly observedFacts: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly coverage: Readonly<{
    readonly modules: readonly string[];
    readonly targetModuleReached: boolean;
    readonly note: string | null;
  }> | null;
  readonly failure: Readonly<{
    readonly code: string;
    readonly message: string;
    readonly nativeCode: string | null;
  }> | null;
}

/**
 * Real step executor. `read` performs an actual module read and `observe`
 * performs an actual call-site/module observation. Both must return evidence
 * derived from the real read; a failure must be reported as a failed result.
 * No synthetic success is ever produced by this adapter.
 */
export interface TsJsUnifiedStepExecutor {
  read(input: TsJsUnifiedStepReadInput): Promise<TsJsUnifiedStepExecution>;
  observe(input: TsJsUnifiedStepReadInput): Promise<TsJsUnifiedStepExecution>;
}

/**
 * File-backed executor that reads the actual module source under `sourceRoot`
 * and parses it with the repository-pinned TypeScript AST. The returned facts
 * are derived from the parsed source, not from the request.
 */
export function createTsJsFileBackedStepExecutor(
  options: Readonly<{ readonly sourceRoot: string }>,
): TsJsUnifiedStepExecutor {
  const read = async (input: TsJsUnifiedStepReadInput): Promise<TsJsUnifiedStepExecution> => {
    const modulePath = resolveMultiStepModulePath(options.sourceRoot, input);
    if (modulePath === null) {
      return multiStepExecutorFailure(
        "MODULE_UNRESOLVED",
        `cannot resolve module for ${input.moduleRef ?? input.specifier ?? input.stepId}`,
        null,
      );
    }
    let text: string;
    try {
      text = await readFile(modulePath, "utf8");
    } catch (error) {
      const nativeCode = typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : null;
      return multiStepExecutorFailure(
        nativeCode ?? "READ_FAILED",
        error instanceof Error ? error.message : String(error),
        nativeCode,
      );
    }
    const sourceFile = ts.createSourceFile(
      modulePath,
      text,
      ts.ScriptTarget.Latest,
      false,
      scriptKindForPath(modulePath),
    );
    const engineRelative = relative(options.sourceRoot, modulePath).split("\\").join("/");
    const observedFacts = collectTsJsModuleFacts(sourceFile, engineRelative, text);
    return {
      outcome: "success",
      observedFacts,
      evidenceRefs: [`ev:${input.stepId}:${engineRelative}:read`],
      coverage: {
        modules: [engineRelative],
        targetModuleReached: true,
        note: null,
      },
      failure: null,
    };
  };
  return { read, observe: read };
}

function multiStepExecutorFailure(
  code: string,
  message: string,
  nativeCode: string | null,
): TsJsUnifiedStepExecution {
  return {
    outcome: "failed",
    observedFacts: [],
    evidenceRefs: [],
    coverage: null,
    failure: { code, message, nativeCode },
  };
}

function scriptKindForPath(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) return ts.ScriptKind.JS;
  if (path.endsWith(".json")) return ts.ScriptKind.JSON;
  return ts.ScriptKind.TS;
}

function resolveMultiStepModulePath(
  sourceRoot: string,
  input: TsJsUnifiedStepReadInput,
): string | null {
  const candidates: string[] = [];
  if (input.moduleRef !== null) {
    const stripped = input.moduleRef.startsWith("mod:") ? input.moduleRef.slice(4) : input.moduleRef;
    candidates.push(isAbsolute(stripped) ? stripped : join(sourceRoot, stripped));
  }
  if (input.specifier !== null && input.specifier.startsWith(".")) {
    const fromDirectory = input.fromFile === null
      ? sourceRoot
      : join(sourceRoot, dirname(input.fromFile));
    candidates.push(resolve(fromDirectory, input.specifier));
  }
  for (const candidate of candidates) {
    for (const variant of modulePathVariants(candidate)) {
      if (ts.sys.fileExists(variant) && !ts.sys.directoryExists(variant)) return variant;
    }
  }
  return null;
}

function modulePathVariants(path: string): readonly string[] {
  return [
    path,
    `${path}.ts`,
    `${path}.tsx`,
    `${path}.js`,
    `${path}.mjs`,
    `${path}.cjs`,
    join(path, "index.ts"),
    join(path, "index.tsx"),
    join(path, "index.js"),
  ];
}

function collectTsJsModuleFacts(
  sourceFile: ts.SourceFile,
  engineRelativePath: string,
  text: string,
): readonly string[] {
  const declarations: string[] = [];
  const exportsFound: string[] = [];
  const hasExportModifier = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node)
      && (ts.getModifiers(node) ?? []).some(
        modifier => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );
  for (const statement of sourceFile.statements) {
    if (
      (ts.isFunctionDeclaration(statement)
        || ts.isClassDeclaration(statement)
        || ts.isInterfaceDeclaration(statement)
        || ts.isTypeAliasDeclaration(statement))
      && statement.name !== undefined
    ) {
      declarations.push(`decl:${statement.name.text}`);
      if (hasExportModifier(statement)) exportsFound.push(`export:${statement.name.text}`);
    } else if (ts.isVariableStatement(statement)) {
      const exported = hasExportModifier(statement);
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          declarations.push(`decl:${declaration.name.text}`);
          if (exported) exportsFound.push(`export:${declaration.name.text}`);
        }
      }
    } else if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined) {
      if (ts.isNamedExports(statement.exportClause)) {
        const specifier = statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : null;
        for (const element of statement.exportClause.elements) {
          exportsFound.push(`export:${element.name.text}`);
          if (specifier !== null) exportsFound.push(`reexport:${element.name.text}<-${specifier}`);
        }
      }
    }
  }
  const lineCount = text.split("\n").length;
  return [
    `file:${engineRelativePath}`,
    `lines:${lineCount}`,
    ...declarations,
    ...exportsFound,
  ];
}

interface MultiStepLedgerEntry {
  readonly stepId: string;
  readonly requestRef: string;
  readonly pendingRelationRef: string;
  readonly fromStepId: string | null;
  readonly action: TsJsUnifiedExecutionReceipt["action"];
  readonly optionSemantics: string;
  readonly candidateRef: string;
  readonly targetRef: string | null;
  readonly edgeRef: string | null;
  readonly receiptId: string;
  readonly actionRef: string;
  readonly outcome: "success" | "failed";
  readonly evidenceRefs: readonly string[];
  readonly observedFacts: readonly string[];
  readonly candidateChoice: TsJsUnifiedCandidateChoice;
  readonly executionReceipt: TsJsUnifiedExecutionReceipt;
  readonly observedPostState: TsJsUnifiedObservedPostState;
  readonly nextStepId: string | null;
}

interface MultiStepPreviousExecution {
  readonly actionRef: string;
  readonly receiptRef: string;
  readonly origin: "model_execution";
  readonly fromStepId: string;
  readonly pendingRelationRef: string;
  readonly optionSemantics: "advance" | "observe";
  readonly targetRef: string;
  readonly outcome: "success";
  readonly evidenceRefs: readonly string[];
}

/**
 * Decision state for the single multi-step request. It carries the current
 * step plus the real execution ledger accumulated by the engine controller.
 */
interface MultiStepState {
  readonly stateRef: string;
  readonly requestId: string;
  readonly sampleId: string;
  /** Step ids already executed, in engine order; never sorted lexicographically. */
  readonly stepSequence: readonly string[];
  readonly context: StepContext;
  readonly ledger: readonly MultiStepLedgerEntry[];
  /** Real read evidence refs accumulated from executed advance/observe steps. */
  readonly readEvidenceRefs: readonly string[];
  readonly terminal: boolean;
  readonly terminalKind: "judge" | "control_return" | "control_defer" | "exhausted" | null;
  readonly terminalJudgement: TsJsUnifiedTerminalJudgement;
  readonly candidateGroupRef: string;
  readonly lastCandidateRef: string | null;
  readonly lastReceipt: TsJsUnifiedExecutionReceipt | null;
  readonly lastPostState: TsJsUnifiedObservedPostState | null;
  readonly nextStepId: string | null;
}

interface MultiStepReceiptPayload {
  readonly stepId: string;
  readonly candidateChoice: TsJsUnifiedCandidateChoice;
  readonly executionReceipt: TsJsUnifiedExecutionReceipt;
  readonly observedPostState: TsJsUnifiedObservedPostState;
  readonly nextStepId: string | null;
  /**
   * The previous-action reference the encoder actually consumed for this step
   * (`relationStepContext(...).action.previousActionRef`). It is the real
   * receipt actionRef of the previous executed step, or null for the start.
   */
  readonly previousActionRef: string | null;
}

type MultiStepAdapter = RecursiveGoalAdapter<
  DecisionGoal,
  MultiStepState,
  DecisionBindings,
  DecisionEvidence,
  DecisionEffect,
  MultiStepReceiptPayload,
  null
>;

export interface TsJsUnifiedMultiStepDecisionRequest {
  readonly requestId: string;
  readonly packagePath: string;
  readonly episodes: readonly RelationStepEpisode[];
  readonly grantedEffects: readonly string[] | ReadonlySet<string>;
  /** Optional real executor. Without it advance/observe fail with a typed error. */
  readonly executor?: TsJsUnifiedStepExecutor;
  readonly limits?: {
    readonly maxTransitions?: number;
    readonly maxDepth?: number;
    readonly maxDerivedGoals?: number;
  };
}

export interface TsJsUnifiedStepSampleReceipt {
  readonly stepId: string;
  readonly optionSemantics: string;
  readonly targetRef: string | null;
  readonly postStepId: string | null;
  readonly actionRef: string | null;
  readonly receipt: {
    readonly receiptId: string;
    readonly receiptRef: string;
  } | null;
  readonly previousExecutionReceiptId: string | null;
  readonly outcome: "success" | "failed" | "unknown";
}

export interface TsJsUnifiedMultiStepStepResult {
  readonly stepId: string;
  readonly candidateChoice: TsJsUnifiedCandidateChoice;
  readonly executionReceipt: TsJsUnifiedExecutionReceipt;
  readonly observedPostState: TsJsUnifiedObservedPostState;
  readonly nextStepId: string | null;
  readonly previousActionRef: string | null;
}

export interface TsJsUnifiedMultiStepDecisionResult {
  readonly modelBinding: Readonly<{
    readonly packageRef: string;
    readonly modelId: string;
    readonly version: string;
    readonly route: Readonly<{ readonly domain: string; readonly decisionKind: string }>;
  }>;
  readonly recursiveGoal: RecursiveGoalResponse<
    DecisionGoal,
    MultiStepState,
    DecisionBindings,
    DecisionEvidence,
    DecisionEffect,
    MultiStepReceiptPayload,
    null
  >;
  readonly sampleReceipt: {
    readonly sampleId: string;
    readonly steps: readonly TsJsUnifiedStepSampleReceipt[];
  };
  readonly steps: readonly TsJsUnifiedMultiStepStepResult[];
  readonly rootEvaluation: RootEvaluation;
}

function multiStepDiagnostic(
  code: AdapterDiagnostic["code"],
  stage: AdapterDiagnostic["stage"],
  message: string,
  nativeCode: string | null = null,
): AdapterDiagnostic {
  return {
    diagnosticId: `${stage}:${code}:${nativeCode ?? ""}`,
    code,
    stage,
    sourceCategory: "tsjs_unified_recursive",
    message,
    nativeCode,
    refs: [],
  };
}

function multiStepAtomicFailure(
  runId: string,
  sourceResult: MultiStepReceiptPayload | null,
  diagnostic: AdapterDiagnostic,
): AtomicReceipt<MultiStepState, DecisionEvidence, DecisionEffect, MultiStepReceiptPayload> {
  return {
    runId,
    executorInvoked: true,
    outcome: "failed",
    sourceResult: sourceResult === null ? null : { tag: RECEIPT_TAG, value: sourceResult },
    newState: null,
    evidence: [],
    executionErrors: [diagnostic],
    verificationErrors: [],
    effect: { knowledge: "none", confirmedEffects: [], receiptRef: null },
  };
}

function multiStepReadInput(
  requestId: string,
  state: MultiStepState,
  candidate: Candidate,
  action: "advance" | "observe",
): TsJsUnifiedStepReadInput {
  const context = state.context;
  const binding = candidate.edgeRef !== null
    ? context.bindingEdges.find(edge => edge.edgeRef === candidate.edgeRef) ?? null
    : null;
  const moduleRef = binding !== null && binding.sourceModule.state === "known"
    ? binding.sourceModule.value ?? null
    : null;
  const fromFile = binding !== null && binding.targetModule.state === "known"
    ? binding.targetModule.value ?? null
    : context.state.objectRefs.length > 0
      ? context.state.objectRefs[0]!
      : null;
  return {
    requestId,
    stepId: context.stepId,
    action,
    candidateRef: candidate.candidateRef,
    targetRef: candidate.targetRef,
    edgeRef: candidate.edgeRef,
    pendingRelationRef: context.localCandidateCursor?.pendingRelationRef ?? context.goal.targetRef,
    moduleRef,
    specifier: binding?.moduleSpecifierRaw ?? null,
    fromFile,
    fromStepId: context.stepId,
  };
}

function multiStepStartStepId(episodes: readonly RelationStepEpisode[]): string {
  const all = new Set(episodes.map(episode => episode.stepId));
  for (const episode of episodes) {
    const previous = episode.previousExecution;
    const fromStepId = previous !== undefined
      && previous.state === "known"
      && previous.value !== null
      && previous.value !== undefined
      ? previous.value.fromStepId
      : null;
    if (fromStepId === null || fromStepId === undefined || !all.has(fromStepId)) {
      return episode.stepId;
    }
  }
  return episodes[0]!.stepId;
}

function multiStepPreviousValueRef(
  episode: RelationStepEpisode,
): PreviousExecutionProjection | null {
  const previous = episode.previousExecution;
  if (previous === undefined || previous.state !== "known") return null;
  return previous.value ?? null;
}

/**
 * Chooses the next episode from the real execution outcome. Matching uses the
 * executed action's fromStepId plus the executed edge/target module. It never
 * falls back to a lexicographic stepId sort.
 */
function multiStepResolveNextEpisode(
  currentStepId: string,
  optionSemantics: "advance" | "observe",
  executedEdgeRef: string | null,
  executedSourceModule: string | null,
  visited: ReadonlySet<string>,
  episodes: readonly RelationStepEpisode[],
): RelationStepEpisode | null {
  const explicitMatches = episodes.filter(episode => {
    if (episode.stepId === currentStepId || visited.has(episode.stepId)) return false;
    const previous = multiStepPreviousValueRef(episode);
    return previous !== null
      && previous.fromStepId === currentStepId
      && previous.optionSemantics === optionSemantics;
  });
  if (explicitMatches.length > 0) {
    const moduleMatch = explicitMatches.find(episode =>
      multiStepPreviousValueRef(episode)?.targetRef === executedSourceModule);
    if (moduleMatch !== undefined) return moduleMatch;
    const edgeMatch = explicitMatches.find(episode =>
      episode.observedBindings?.some(binding => binding.edgeRef === executedEdgeRef));
    if (edgeMatch !== undefined) return edgeMatch;
    if (explicitMatches.length === 1) return explicitMatches[0]!;
    throw new TypeError(
      `ambiguous next episode after step ${currentStepId}: ${explicitMatches.length} explicit candidates matched the executed edge/target`,
    );
  }
  const candidates = episodes.filter(episode => {
    if (episode.stepId === currentStepId || visited.has(episode.stepId)) return false;
    if (multiStepPreviousValueRef(episode) !== null) return false;
    // A next step without an explicit previousExecution is valid input: the
    // engine injects the actual receipt after this real execution.
    return nextStepCandidateMatches(episode, executedEdgeRef, executedSourceModule);
  });
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    throw new TypeError(
      `ambiguous next episode after step ${currentStepId}: ${candidates.length} implicit candidates matched the executed edge/target`,
    );
  }
  return null;
}

function nextStepCandidateMatches(
  episode: RelationStepEpisode,
  executedEdgeRef: string | null,
  executedSourceModule: string | null,
): boolean {
  const bindings = episode.observedBindings ?? [];
  if (executedEdgeRef !== null
    && bindings.some(binding => binding.edgeRef === executedEdgeRef)) {
    return true;
  }
  if (executedSourceModule !== null) {
    if (relationStepContext(episode).state.objectRefs.includes(executedSourceModule)) {
      return true;
    }
    // The module read by the executed action becomes the current file of the
    // next step, so a binding that targets the executed module is a real match.
    if (bindings.some(binding =>
      binding.targetModule.state === "known"
      && binding.targetModule.value === executedSourceModule)) {
      return true;
    }
  }
  return false;
}

function multiStepPreviousExecutionIncompatibility(
  nextEpisode: RelationStepEpisode,
  expected: {
    readonly requestId: string;
    readonly stepId: string;
    readonly pendingRelationRef: string;
    readonly optionSemantics: "advance" | "observe";
    readonly targetRef: string | null;
  },
): string | null {
  if (nextEpisode.requestId !== expected.requestId) {
    return `next episode ${nextEpisode.stepId} belongs to request ${nextEpisode.requestId}, not ${expected.requestId}`;
  }
  const previous = multiStepPreviousValueRef(nextEpisode);
  if (previous !== null) {
    if (previous.fromStepId !== expected.stepId) {
      return `next episode ${nextEpisode.stepId} previousExecution.fromStepId ${previous.fromStepId} must be ${expected.stepId}`;
    }
    if (previous.optionSemantics !== expected.optionSemantics) {
      return `next episode ${nextEpisode.stepId} previousExecution.optionSemantics ${previous.optionSemantics} must be ${expected.optionSemantics}`;
    }
    if (previous.pendingRelationRef !== expected.pendingRelationRef) {
      return `next episode ${nextEpisode.stepId} previousExecution.pendingRelationRef does not match the executed step`;
    }
    if (previous.targetRef !== expected.targetRef) {
      return `next episode ${nextEpisode.stepId} previousExecution.targetRef ${previous.targetRef} must be ${expected.targetRef}`;
    }
  }
  return null;
}

function multiStepObservedPreviousExecution(
  previous: MultiStepPreviousExecution,
): Observed<PreviousExecutionProjection | null> {
  return {
    state: "known",
    value: {
      actionRef: previous.actionRef,
      receiptRef: previous.receiptRef,
      origin: previous.origin,
      fromStepId: previous.fromStepId,
      pendingRelationRef: previous.pendingRelationRef,
      optionSemantics: previous.optionSemantics,
      targetRef: previous.targetRef,
      outcome: previous.outcome,
    },
    evidenceRefs: previous.evidenceRefs,
  };
}

/**
 * Root evaluation for the multi-step request. The request root is satisfied
 * only when the accumulated real read evidence backs a terminal outcome. A
 * selected action alone never satisfies the root.
 */
function evaluateMultiStepRoot(
  state: MultiStepState,
  evidence: readonly { readonly id: string; readonly stateRef: string; readonly validity: string }[],
): StructuralRootEvaluation {
  const realReads = [...state.readEvidenceRefs];
  const validIds = new Set(
    evidence
      .filter(item => item.validity === "valid" && realReads.includes(item.id))
      .map(item => item.id),
  );
  const evidenceRefs = realReads.filter(id => validIds.size === 0 || validIds.has(id));
  if (!state.terminal) {
    return {
      result: "unsatisfied",
      satisfaction: 0,
      necessaryConditionsMet: false,
      evidenceRefs: [],
    };
  }
  const verified =
    (state.terminalKind === "judge" || state.terminalKind === "control_return")
    && evidenceRefs.length > 0;
  if (verified) {
    return {
      result: "satisfied",
      satisfaction: 100,
      necessaryConditionsMet: true,
      evidenceRefs,
    };
  }
  return {
    result: "unknown",
    satisfaction: null,
    necessaryConditionsMet: false,
    evidenceRefs,
  };
}

function multiStepPayloadOf(result: {
  readonly sourceResult: unknown;
}): MultiStepReceiptPayload | null {
  const source = result.sourceResult;
  if (source === null || typeof source !== "object" || !("tag" in source)) return null;
  const tagged = source as { tag: unknown; value: unknown };
  if (tagged.tag !== RECEIPT_TAG) return null;
  const value = tagged.value;
  if (typeof value !== "object" || value === null) return null;
  return value as MultiStepReceiptPayload;
}

/**
 * Drives every step with a single `runRecursiveGoal` invocation. The engine's
 * controller loop owns the progression: each atomic execution reads the real
 * module, returns the next step derived from that real outcome, and the loop
 * re-evaluates the root until it is satisfied or the request limits are spent.
 */
export async function runTsJsUnifiedMultiStepDecision(
  request: TsJsUnifiedMultiStepDecisionRequest,
): Promise<TsJsUnifiedMultiStepDecisionResult> {
  const grantedEffects = grantedSet(request.grantedEffects);
  if (!grantedEffects.has("read_only")) {
    throw new TypeError("tsjs unified multi-step decision requires the read_only effect");
  }
  if (!Array.isArray(request.episodes) || request.episodes.length === 0) {
    throw new TypeError("tsjs unified multi-step decision requires at least one episode");
  }

  const loaded = await loadUnifiedModelPackageFromFile(request.packagePath);
  const binding = loaded.bind();
  assertRoute(binding);
  const thresholds = await loadFeatureThresholdsFromFile(loaded.resolvedResources.thresholdsPath);
  await loadMissingModeTableFromFile(loaded.resolvedResources.missingModeTablePath);

  const episodes = request.episodes;
  const sampleId = episodes[0]!.sampleId;
  if (episodes.some(episode => episode.sampleId !== sampleId)) {
    throw new TypeError("multi-step episodes must belong to one sample");
  }
  const sampleRequestId = episodes[0]!.requestId;
  if (episodes.some(episode => episode.requestId !== sampleRequestId)) {
    throw new TypeError("multi-step episodes must belong to one request");
  }

  const startId = multiStepStartStepId(episodes);
  const startEpisode = episodes.find(episode => episode.stepId === startId)!;
  const startContext = relationStepContext(startEpisode);
  const initialStateValue: MultiStepState = {
    stateRef: `ms:${request.requestId}:${startContext.stepId}`,
    requestId: request.requestId,
    sampleId,
    stepSequence: [],
    context: startContext,
    ledger: [],
    readEvidenceRefs: [],
    terminal: false,
    terminalKind: null,
    terminalJudgement: "none",
    candidateGroupRef: startContext.candidateGroup.candidateGroupRef,
    lastCandidateRef: null,
    lastReceipt: null,
    lastPostState: null,
    nextStepId: null,
  };

  const rootGoal: DecisionGoal = {
    kind: "verify",
    targetRef: sampleId,
    contextId: startContext.contextId,
  };
  const rootBindings: DecisionBindings = {
    packageRef: binding.packageRef,
    modelId: binding.modelId,
    modelVersion: binding.version,
    contextId: startContext.contextId,
    grantedEffects: [...grantedEffects],
  };

  const skills = [
    {
      id: MULTI_STEP_RELATION_JUDGE_SKILL_ID,
      version: "relation.judge.v1",
      mode: "atomic",
      capability: "relation.judge",
      evaluatorId: MULTI_STEP_ROOT_EVALUATOR_ID,
      requiredEffects: ["read_only"],
      allowedEffects: ["read_only"],
      retry: "completed_no_effect",
      effectClass: "read_only",
    },
    {
      id: MULTI_STEP_RELATION_READ_SKILL_ID,
      version: "relation.read.v1",
      mode: "atomic",
      capability: "relation.read",
      evaluatorId: MULTI_STEP_ROOT_EVALUATOR_ID,
      requiredEffects: ["read_only"],
      allowedEffects: ["read_only"],
      retry: "completed_no_effect",
      effectClass: "read_only",
    },
    {
      id: MULTI_STEP_RELATION_OBSERVE_SKILL_ID,
      version: "relation.observe.v1",
      mode: "atomic",
      capability: "relation.observe",
      evaluatorId: MULTI_STEP_ROOT_EVALUATOR_ID,
      requiredEffects: ["read_only"],
      allowedEffects: ["read_only"],
      retry: "completed_no_effect",
      effectClass: "read_only",
    },
    {
      id: MULTI_STEP_RELATION_CONTROL_SKILL_ID,
      version: "relation.control.v1",
      mode: "atomic",
      capability: "relation.control",
      evaluatorId: MULTI_STEP_ROOT_EVALUATOR_ID,
      requiredEffects: ["read_only"],
      allowedEffects: ["read_only"],
      retry: "completed_no_effect",
      effectClass: "read_only",
    },
  ] as const;
  const evaluators = [{
    id: MULTI_STEP_ROOT_EVALUATOR_ID,
    goalType: "verify",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  }] as const;
  const selectors = [{
    id: MULTI_STEP_ROOT_SELECTOR_ID,
    skillIds: [
      MULTI_STEP_RELATION_JUDGE_SKILL_ID,
      MULTI_STEP_RELATION_READ_SKILL_ID,
      MULTI_STEP_RELATION_OBSERVE_SKILL_ID,
      MULTI_STEP_RELATION_CONTROL_SKILL_ID,
    ],
  }] as const;

  const adapter: MultiStepAdapter = {
    validateRequest: async (envelope: RecursiveGoalRequestEnvelope): Promise<
      ValidatedRequest<DecisionGoal, MultiStepState, DecisionBindings, DecisionEvidence, DecisionEffect, MultiStepReceiptPayload, null>
    > => ({
      requestId: envelope.requestId,
      rootGoal,
      satisfactionThreshold: 100,
      rootBindings,
      state: initialStateValue,
      rootEvaluatorId: MULTI_STEP_ROOT_EVALUATOR_ID,
      rootSelectorId: MULTI_STEP_ROOT_SELECTOR_ID,
      ...(envelope.limits !== undefined ? { limits: envelope.limits } : {}),
      initialObservation: { stateId: initialStateValue.stateRef, evidence: [] },
      continuation: null,
    }),
    supports: (input: SupportsInput<DecisionGoal, DecisionBindings>) =>
      input.goal.kind === "verify"
      && (input.skill.id === MULTI_STEP_RELATION_JUDGE_SKILL_ID
        || input.skill.id === MULTI_STEP_RELATION_READ_SKILL_ID
        || input.skill.id === MULTI_STEP_RELATION_OBSERVE_SKILL_ID
        || input.skill.id === MULTI_STEP_RELATION_CONTROL_SKILL_ID),
    evaluate: async (input: EvaluationInput<DecisionGoal, MultiStepState, DecisionBindings, DecisionEvidence>): Promise<EvaluationReceipt> => ({
      evaluatorId: MULTI_STEP_ROOT_EVALUATOR_ID,
      ...evaluateMultiStepRoot(input.state, input.evidence),
    }),
    select: async (input: SelectionInput<DecisionGoal, MultiStepState, DecisionBindings, DecisionEvidence>): Promise<Selection> => {
      if (input.state.terminal) {
        return {
          kind: "defer",
          reason: `rollout reached terminal state ${String(input.state.terminalKind)} without satisfying the request root`,
        };
      }
      const scores = encodedScores(input.state.context, thresholds, binding.tensors);
      if (scores.length === 0) {
        return { kind: "defer", reason: "no finite candidates in the current candidate group" };
      }
      const chosen = chooseCandidate(input.state.context, scores);
      const enabled = input.candidates.find(skill => skill.id === chosen.candidate.skillRef);
      if (enabled === undefined) {
        return {
          kind: "defer",
          reason: `candidate ${chosen.candidate.candidateRef} refers to a disabled skill`,
        };
      }
      return { kind: "selected", skillId: enabled.id };
    },
    derive: async (input: DerivationInput<DecisionGoal, MultiStepState, DecisionBindings, DecisionEvidence, null>) => ({
      conditions: [],
      nextCursor: null,
      expansion: "closed",
    }),
    executeAtomic: async (input: AtomicInput<DecisionGoal, MultiStepState, DecisionBindings, DecisionEvidence>) => {
      const state = input.state;
      const runId = `${request.requestId}:run:${state.context.stepId}`;
      const scores = encodedScores(state.context, thresholds, binding.tensors);
      if (scores.length === 0) {
        return multiStepAtomicFailure(
          runId,
          null,
          multiStepDiagnostic(
            "execution_failed",
            "execution",
            "no finite candidates in the current candidate group",
          ),
        );
      }
      const chosen = chooseCandidate(state.context, scores);
      if (chosen.candidate.skillRef !== input.skill.id) {
        return multiStepAtomicFailure(
          runId,
          null,
          multiStepDiagnostic(
            "invalid_binding",
            "selection",
            `selected skill ${input.skill.id} does not match scored candidate ${chosen.candidate.skillRef}`,
          ),
        );
      }

      const stepId = state.context.stepId;
      const candidateRef = chosen.candidate.candidateRef;
      const optionSemantics = chosen.candidate.optionSemantics;
      const actionKind = candidateSemanticsAction(optionSemantics);
      const actionRef = `${request.requestId}:action:${stepId}:${actionKind}`;
      const receiptId = `${request.requestId}:receipt:${stepId}:${candidateRef}`;
      const postStateRef = `${state.stateRef}:post:${stepId}`;
      const pendingRelationRef = state.context.localCandidateCursor?.pendingRelationRef
        ?? state.context.goal.targetRef;
      const candidateChoice: TsJsUnifiedCandidateChoice = {
        candidateRef,
        skillRef: chosen.candidate.skillRef,
        optionSemantics,
        targetRef: chosen.candidate.targetRef,
        score: chosen.score,
      };

      let execution: TsJsUnifiedStepExecution;
      let nextEpisode: RelationStepEpisode | null = null;
      let executedSourceModuleForNext: string | null = null;
      let terminalKind: MultiStepState["terminalKind"] = null;
      let terminalJudgement: TsJsUnifiedTerminalJudgement = "none";

      if (actionKind === "submit_read" || actionKind === "submit_observe") {
        const executor = request.executor;
        if (executor === null || executor === undefined) {
          return multiStepAtomicFailure(
            `${runId}:missing-executor`,
            null,
            multiStepDiagnostic(
              "execution_failed",
              "execution",
              `${MULTI_STEP_EXECUTOR_MISSING}: step ${stepId} selected ${optionSemantics} but no real executor was injected`,
              MULTI_STEP_EXECUTOR_MISSING,
            ),
          );
        }
        const readInput = multiStepReadInput(request.requestId, state, chosen.candidate, actionKind === "submit_read" ? "advance" : "observe");
        execution = actionKind === "submit_read"
          ? await executor.read(readInput)
          : await executor.observe(readInput);
        if (execution.outcome === "failed") {
          const failure = execution.failure;
          return multiStepAtomicFailure(
            `${runId}:failed`,
            {
              stepId,
              candidateChoice,
              executionReceipt: {
                receiptId,
                action: actionKind,
                actionRef,
                candidateRef,
                terminalJudgement: "none",
                postStateRef,
                outcome: "failed",
                evidenceRefs: [],
                failure,
              },
              observedPostState: {
                stateRef: postStateRef,
                postStateRef,
                candidateRef,
                terminalJudgement: "none",
                observedFacts: [],
                candidateGroupRef: state.candidateGroupRef,
                cursorClosed: state.context.localCandidateCursor?.state === "closed",
              },
              nextStepId: null,
              previousActionRef: state.context.action.previousActionRef,
            },
            multiStepDiagnostic(
              "execution_failed",
              "execution",
              failure === null
                ? `step ${stepId} ${optionSemantics} read failed`
                : `${failure.code}: ${failure.message}`,
              failure?.nativeCode ?? failure?.code ?? null,
            ),
          );
        }
        const binding = chosen.candidate.edgeRef !== null
          ? state.context.bindingEdges.find(edge => edge.edgeRef === chosen.candidate.edgeRef) ?? null
          : null;
        const executedSourceModule = binding !== null && binding.sourceModule.state === "known"
          ? binding.sourceModule.value ?? null
          : null;
        executedSourceModuleForNext = executedSourceModule;
        nextEpisode = multiStepResolveNextEpisode(
          stepId,
          actionKind === "submit_read" ? "advance" : "observe",
          chosen.candidate.edgeRef,
          executedSourceModule,
          new Set(state.stepSequence),
          episodes,
        );
        if (nextEpisode === null) terminalKind = "exhausted";
        if (nextEpisode !== null) {
          const incompatibility = multiStepPreviousExecutionIncompatibility(nextEpisode, {
            requestId: sampleRequestId,
            stepId,
            pendingRelationRef,
            optionSemantics: actionKind === "submit_read" ? "advance" : "observe",
            targetRef: executedSourceModule,
          });
          if (incompatibility !== null) {
            return multiStepAtomicFailure(
              `${runId}:previous-execution`,
              null,
              multiStepDiagnostic(
                "execution_failed",
                "execution",
                `incompatible previousExecution for ${nextEpisode.stepId}: ${incompatibility}`,
              ),
            );
          }
        }
      } else if (actionKind === "submit_control") {
        execution = {
          outcome: "success",
          observedFacts: [],
          evidenceRefs: chosen.candidate.evidenceRefs,
          coverage: null,
          failure: null,
        };
        terminalKind = optionSemantics === "RETURN" ? "control_return" : "control_defer";
      } else {
        execution = {
          outcome: "success",
          observedFacts: [],
          evidenceRefs: chosen.candidate.evidenceRefs,
          coverage: null,
          failure: null,
        };
        terminalKind = "judge";
        terminalJudgement = optionSemantics as TsJsUnifiedTerminalJudgement;
      }

      const executionReceipt: TsJsUnifiedExecutionReceipt = {
        receiptId,
        action: actionKind,
        actionRef,
        candidateRef,
        terminalJudgement: actionKind === "submit_terminal_judgement" ? terminalJudgement : "none",
        postStateRef,
        outcome: execution.outcome,
        evidenceRefs: execution.evidenceRefs,
        ...(execution.failure !== null ? { failure: execution.failure } : {}),
      };
      const observedPostState: TsJsUnifiedObservedPostState = {
        stateRef: postStateRef,
        postStateRef,
        candidateRef,
        terminalJudgement: executionReceipt.terminalJudgement,
        observedFacts: execution.observedFacts,
        candidateGroupRef: state.candidateGroupRef,
        cursorClosed: state.context.localCandidateCursor?.state === "closed",
      };

      const fromStepId = state.stepSequence.length === 0
        ? null
        : state.stepSequence[state.stepSequence.length - 1]!;
      const readEvidenceRefs = actionKind === "submit_read" || actionKind === "submit_observe"
        ? [...state.readEvidenceRefs, ...execution.evidenceRefs]
        : state.readEvidenceRefs;

      let nextStepId: string | null = null;
      let nextStateValue: MultiStepState;
      if (terminalKind !== null || nextEpisode === null) {
        nextStateValue = {
          stateRef: postStateRef,
          requestId: state.requestId,
          sampleId: state.sampleId,
          stepSequence: state.stepSequence,
          context: state.context,
          ledger: state.ledger,
          readEvidenceRefs,
          terminal: true,
          terminalKind: terminalKind ?? "exhausted",
          terminalJudgement,
          candidateGroupRef: state.candidateGroupRef,
          lastCandidateRef: candidateRef,
          lastReceipt: executionReceipt,
          lastPostState: observedPostState,
          nextStepId: null,
        };
      } else {
        const previousExecution: MultiStepPreviousExecution = {
          actionRef,
          receiptRef: receiptId,
          origin: "model_execution",
          fromStepId: stepId,
          pendingRelationRef,
          optionSemantics: actionKind === "submit_read" ? "advance" : "observe",
          targetRef: executedSourceModuleForNext ?? chosen.candidate.targetRef ?? pendingRelationRef,
          outcome: "success",
          evidenceRefs: execution.evidenceRefs,
        };
        const nextContext = relationStepContext({
          ...nextEpisode,
          previousExecution: multiStepObservedPreviousExecution(previousExecution),
        });
        nextStepId = nextEpisode.stepId;
        nextStateValue = {
          stateRef: `ms:${request.requestId}:${nextContext.stepId}`,
          requestId: state.requestId,
          sampleId: state.sampleId,
          stepSequence: [...state.stepSequence, stepId],
          context: nextContext,
          ledger: state.ledger,
          readEvidenceRefs,
          terminal: false,
          terminalKind: null,
          terminalJudgement: "none",
          candidateGroupRef: nextContext.candidateGroup.candidateGroupRef,
          lastCandidateRef: candidateRef,
          lastReceipt: executionReceipt,
          lastPostState: observedPostState,
          nextStepId,
        };
      }

      const ledgerEntry: MultiStepLedgerEntry = {
        stepId,
        requestRef: pendingRelationRef,
        pendingRelationRef,
        fromStepId,
        action: actionKind,
        optionSemantics,
        candidateRef,
        targetRef: chosen.candidate.targetRef,
        edgeRef: chosen.candidate.edgeRef,
        receiptId,
        actionRef,
        outcome: execution.outcome,
        evidenceRefs: execution.evidenceRefs,
        observedFacts: execution.observedFacts,
        candidateChoice,
        executionReceipt,
        observedPostState,
        nextStepId,
      };
      nextStateValue = { ...nextStateValue, ledger: [...state.ledger, ledgerEntry] };

      const payload: MultiStepReceiptPayload = {
        stepId,
        candidateChoice,
        executionReceipt,
        observedPostState,
        nextStepId,
        previousActionRef: state.context.action.previousActionRef,
      };
      return {
        runId,
        executorInvoked: true,
        outcome: "succeeded",
        sourceResult: { tag: RECEIPT_TAG, value: payload },
        newState: { id: nextStateValue.stateRef, value: nextStateValue },
        evidence: execution.evidenceRefs.map(ref => ({
          id: ref,
          stateRef: nextStateValue.stateRef,
          payload: { evidenceRef: ref, candidateRef, postStateRef: nextStateValue.stateRef },
          validity: "valid" as const,
        })),
        executionErrors: [],
        verificationErrors: [],
        effect: {
          knowledge: "known",
          confirmedEffects: [{ effect: "read_only", source: "tsjs-unified-recursive" }],
          receiptRef: receiptId,
        },
      };
    },
    validateAtomicReceipt: (raw: unknown): AtomicReceipt<
      MultiStepState,
      DecisionEvidence,
      DecisionEffect,
      MultiStepReceiptPayload
    > => readAtomicReceipt(raw, {
      state: value => value as MultiStepState,
      evidencePayload: readEvidence,
      effectFact: readEffect,
      receiptPayload: value => value as MultiStepReceiptPayload,
    }),
    measureProgress: (input: {
      readonly goal: DecisionGoal;
      readonly before: MultiStepState;
      readonly after: MultiStepState;
      readonly previousEvaluation: EvaluationReceipt;
      readonly currentEvaluation: EvaluationReceipt;
    }): ProgressReceipt => {
      const improved = input.after.ledger.length > input.before.ledger.length;
      return { improved, reason: improved ? "facts_improved" : "none", comparable: true };
    },
  };

  const dependencies: RecursiveGoalDependencies<
    DecisionGoal,
    MultiStepState,
    DecisionBindings,
    DecisionEvidence,
    DecisionEffect,
    MultiStepReceiptPayload,
    null
  > = {
    adapter,
    enabledSkills: [...skills],
    enabledEvaluators: [...evaluators],
    selectors: [...selectors],
    comparators: {
      sameGoal: (left, right) => jsonEqual(left, right),
      sameBindings: (left, right) => jsonEqual(left, right),
      sameFacts: (left, right) => jsonEqual(left.state.stepSequence, right.state.stepSequence),
    },
    grantedEffects,
  };

  const envelope: RecursiveGoalRequestEnvelope = {
    schema: "nnanything.recursive-goal.request.v1",
    requestId: request.requestId,
    rootGoal,
    satisfactionThreshold: 100,
    rootBindings,
    state: initialStateValue,
    rootEvaluatorId: MULTI_STEP_ROOT_EVALUATOR_ID,
    rootSelectorId: MULTI_STEP_ROOT_SELECTOR_ID,
    ...(request.limits === undefined ? {} : { limits: request.limits }),
    initialObservation: { stateId: initialStateValue.stateRef, evidence: [] },
  };

  const recursiveGoal = await runRecursiveGoal(envelope, dependencies);

  const modelBinding = {
    packageRef: binding.packageRef,
    modelId: binding.modelId,
    version: binding.version,
    route: binding.route,
  };
  if (recursiveGoal.kind !== "run_result") {
    return {
      modelBinding,
      recursiveGoal,
      sampleReceipt: { sampleId, steps: [] },
      steps: [],
      rootEvaluation: {
        state: "not_evaluated",
        reason: "binding_error",
        blockedByErrorId: null,
      },
    };
  }

  const atomicResults = recursiveGoal.report.atomicResults;
  const payloads = atomicResults.flatMap(result => {
    const payload = multiStepPayloadOf(result);
    return payload === null ? [] : [{ result, payload }];
  });
  const steps: TsJsUnifiedStepSampleReceipt[] = payloads.map((entry, index) => {
    const receipt = entry.payload?.executionReceipt ?? null;
    const previous = index === 0 ? null : payloads[index - 1]!.payload?.executionReceipt?.receiptId ?? null;
    const next = index + 1 < payloads.length ? payloads[index + 1]!.payload : null;
    return {
      stepId: entry.payload?.stepId ?? entry.result.dispatchId,
      optionSemantics: entry.payload?.candidateChoice.optionSemantics ?? "unknown",
      targetRef: entry.payload?.candidateChoice.targetRef ?? null,
      postStepId: next?.stepId ?? null,
      actionRef: receipt?.actionRef ?? null,
      receipt: receipt === null ? null : { receiptId: receipt.receiptId, receiptRef: receipt.receiptId },
      previousExecutionReceiptId: previous,
      outcome: receipt?.outcome ?? "unknown",
    };
  });
  const stepResults: TsJsUnifiedMultiStepStepResult[] = payloads.flatMap(entry =>
    entry.payload === null
      ? []
      : [{
          stepId: entry.payload.stepId,
          candidateChoice: entry.payload.candidateChoice,
          executionReceipt: entry.payload.executionReceipt,
          observedPostState: entry.payload.observedPostState,
          nextStepId: entry.payload.nextStepId,
          previousActionRef: entry.payload.previousActionRef,
        }],
  );

  return {
    modelBinding,
    recursiveGoal,
    sampleReceipt: { sampleId, steps },
    steps: stepResults,
    rootEvaluation: recursiveGoal.report.rootEvaluation,
  };
}

function candidateSemanticsAction(
  optionSemantics: string,
): TsJsUnifiedExecutionReceipt["action"] {
  if (optionSemantics === "advance") return "submit_read";
  if (optionSemantics === "observe") return "submit_observe";
  if (optionSemantics === "DEFER" || optionSemantics === "RETURN") return "submit_control";
  return "submit_terminal_judgement";
}
