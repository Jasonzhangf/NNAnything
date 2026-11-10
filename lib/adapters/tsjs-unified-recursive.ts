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
  EvidenceRecord,
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
  BindingEdge,
  Candidate,
  CurrentRelationProjection,
  DeclarationIdentity,
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
  readonly relation: RelationTargetCondition;
}

interface RelationTargetCondition {
  readonly relationRef: string;
  readonly declarationRef: string | null;
  readonly moduleRef: string | null;
  readonly name: string | null;
  readonly kind: string | null;
  readonly edges: readonly RelationEdgeCondition[];
}

interface RelationEdgeCondition {
  readonly edgeRef: string;
  readonly edgeKind: BindingEdge["edgeKind"];
  readonly sourceName: string;
  readonly targetName: string;
  readonly sourceModuleRef: string | null;
  readonly moduleSpecifierRaw: string | null;
  readonly expectedFacts: readonly string[];
  readonly expectedBinding: RelationBindingIdentity;
}

interface RelationBindingIdentity {
  readonly edgeKind: BindingEdge["edgeKind"];
  readonly containingModuleRef: string | null;
  readonly sourceModuleRef: string | null;
  readonly sourceName: string;
  readonly localName: string | null;
  readonly exportedAlias: string | null;
  readonly moduleSpecifierRaw: string | null;
  readonly sourceTargetRef: string | null;
}

export type TsJsModuleFactKind =
  | "declaration"
  | "export"
  | "import"
  | "re_export";

/**
 * A typed fact parsed from one module. It preserves the statement's module
 * location and the complete binding tuple instead of an unpaired name string.
 */
export interface TsJsModuleFact {
  readonly kind: TsJsModuleFactKind;
  readonly moduleRef: string;
  readonly name: string | null;
  readonly sourceName: string | null;
  readonly localName: string | null;
  readonly exportedAlias: string | null;
  readonly moduleSpecifierRaw: string | null;
  readonly resolvedModuleRef: string | null;
  readonly sourceTargetRef: string | null;
  readonly legacyFacts: readonly string[];
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

/**
 * B.6 minimal admitted initial-evidence payload union.
 *
 * Only the two observed-observation kinds are admitted. A declaration-audit
 * ref, a gold label, a model score, or a synthesized identifier is not a kind.
 * The records are built from the admitted row's own enclosing fields and are
 * bound to the adapter's real `initialStateValue.stateRef`, never to a derived
 * string.
 */
export type TsJsInitialEvidencePayload =
  | {
      readonly kind: "source_read_receipt";
      readonly receiptId: string;
      readonly actionRef: string;
      readonly origin: "source_observation";
      readonly outcome: "success";
      readonly targetRef: string;
      readonly fromStepId: string | null;
      readonly pendingRelationRef: string;
      readonly resultRefs: readonly string[];
      readonly evidenceRefs: readonly string[];
      readonly textLength?: number;
      readonly lineCount?: number;
    }
  | {
      readonly kind: "import_binding_observation";
      readonly edgeRef: string;
      readonly edgeKind: string;
      readonly fromNodeRef: string | null;
      readonly sourceName: string;
      readonly targetName: string;
      readonly sourceModuleRef: string;
      readonly targetModuleRef: string;
      readonly moduleSpecifierRaw: string | null;
      readonly evidenceRefs: readonly string[];
    };

export type TsJsInitialEvidenceRecord = EvidenceRecord<TsJsInitialEvidencePayload>;

export interface TsJsObservedLocalFact {
  readonly factRef: string;
  readonly role?: "selector_candidate_table" | "runtime_selector_dependency";
  readonly state: string;
  readonly value?: string | null;
  readonly evidenceRefs: readonly string[];
}

type AdmittedEpisode = RelationStepEpisode & {
  readonly observedLocalFacts?: readonly TsJsObservedLocalFact[];
};

export type TsJsQueryCompletion =
  | "complete_true"
  | "complete_false"
  | "complete_unknown"
  | "returned_unresolved"
  | "incomplete";

export type TsJsPredictedJudgement = "true" | "false" | "unknown" | null;

export type TsJsRootGapCode =
  | "POSITIVE_RELATION_NOT_ESTABLISHED"
  | "POSITIVE_RELATION_NOT_DECIDABLE"
  | "NO_POSITIVE_RELATION_ANSWER"
  | "ROOT_EVIDENCE_MISSING";

export interface TsJsRootGap {
  readonly code: TsJsRootGapCode;
  readonly refs: readonly string[];
}

/**
 * D.4 query-completion output. Relation truth (the terminal prediction) and
 * query completion stay separate. `positiveRootSatisfied` is true only for a
 * fully verified positive relation, so a correct negative or justified unknown
 * never flips the binary positive-relation field.
 */
export interface TsJsRootCompletion {
  readonly predictedJudgement: TsJsPredictedJudgement;
  readonly positiveRootSatisfied: boolean;
  readonly positiveRootGaps: readonly TsJsRootGap[];
  readonly queryCompletion: TsJsQueryCompletion;
  readonly evidenceRefs: readonly string[];
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

type MultiStepDecisionEvidence = DecisionEvidence | TsJsInitialEvidencePayload;

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

function readMultiStepEvidence(value: unknown): MultiStepDecisionEvidence {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("multi-step evidence payload must be an object");
  }
  const payload = value as Record<string, unknown>;
  if (typeof payload.evidenceRef === "string") {
    return value as DecisionEvidence;
  }
  if (
    payload.kind === "source_read_receipt"
    || payload.kind === "import_binding_observation"
  ) {
    return value as TsJsInitialEvidencePayload;
  }
  throw new TypeError("multi-step evidence payload has an unsupported kind");
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
  const relationCondition = relationTargetCondition(request.episode);
  const rootGoal: DecisionGoal = {
    kind: "verify",
    targetRef: relationTargetRef(relationCondition),
    contextId: stepContext.contextId,
    relation: relationCondition,
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
  /**
   * Optional typed module facts. The file-backed executor always supplies
   * them; compatibility executors may continue to return only legacy strings.
   */
  readonly moduleFacts?: readonly TsJsModuleFact[];
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
    const primaryModulePath = resolveMultiStepModulePath(options.sourceRoot, input);
    if (primaryModulePath === null) {
      return multiStepExecutorFailure(
        "MODULE_UNRESOLVED",
        `cannot resolve module for ${input.moduleRef ?? input.specifier ?? input.stepId}`,
        null,
      );
    }
    const containingModulePath = resolveMultiStepContainingModulePath(options.sourceRoot, input);
    if (input.fromFile !== null && containingModulePath === null) {
      return multiStepExecutorFailure(
        "MODULE_UNRESOLVED",
        `cannot resolve containing module for ${input.fromFile}`,
        null,
      );
    }
    const modulePaths = [...new Set(
      containingModulePath === null
        ? [primaryModulePath]
        : [primaryModulePath, containingModulePath],
    )];
    let moduleReads: readonly {
      readonly moduleRef: string;
      readonly facts: readonly TsJsModuleFact[];
      readonly lines: number;
    }[];
    try {
      moduleReads = await Promise.all(modulePaths.map(async modulePath => {
        const text = await readFile(modulePath, "utf8");
        return {
          moduleRef: relative(options.sourceRoot, modulePath).split("\\").join("/"),
          facts: collectTsJsModuleFactRecords(
            ts.createSourceFile(
              modulePath,
              text,
              ts.ScriptTarget.Latest,
              false,
              scriptKindForPath(modulePath),
            ),
            relative(options.sourceRoot, modulePath).split("\\").join("/"),
            modulePath,
            options.sourceRoot,
          ),
          lines: text.split("\n").length,
        };
      }));
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
    const moduleFacts = uniqueModuleFacts(moduleReads.flatMap(moduleRead => moduleRead.facts));
    const observedFacts = uniqueStrings([
      ...moduleReads.flatMap(moduleRead => [
        `file:${moduleRead.moduleRef}`,
        `lines:${moduleRead.lines}`,
      ]),
      ...moduleFacts.flatMap(fact => fact.legacyFacts),
    ]);
    return {
      outcome: "success",
      observedFacts,
      moduleFacts,
      evidenceRefs: moduleReads.map(moduleRead =>
        `ev:${input.stepId}:${moduleRead.moduleRef}:read`),
      coverage: {
        modules: moduleReads.map(moduleRead => moduleRead.moduleRef),
        targetModuleReached: true,
        note: null,
      },
      failure: null,
    };
  };
  return { read, observe: read };
}

function resolveMultiStepContainingModulePath(
  sourceRoot: string,
  input: TsJsUnifiedStepReadInput,
): string | null {
  if (input.fromFile === null) return null;
  return resolveMultiStepModulePath(sourceRoot, {
    ...input,
    moduleRef: input.fromFile,
    specifier: null,
  });
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

function resolveModuleSpecifierRef(
  sourceRoot: string,
  containingModulePath: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const candidate = resolve(dirname(containingModulePath), specifier);
  for (const variant of modulePathVariants(candidate)) {
    if (ts.sys.fileExists(variant) && !ts.sys.directoryExists(variant)) {
      return relative(sourceRoot, variant).split("\\").join("/");
    }
  }
  return null;
}

function collectTsJsModuleFactRecords(
  sourceFile: ts.SourceFile,
  engineRelativePath: string,
  absoluteModulePath: string,
  sourceRoot: string,
): readonly TsJsModuleFact[] {
  const facts: TsJsModuleFact[] = [];
  const hasExportModifier = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node)
      && (ts.getModifiers(node) ?? []).some(
        modifier => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );
  const pushDeclaration = (name: string, exported: boolean): void => {
    facts.push({
      kind: "declaration",
      moduleRef: engineRelativePath,
      name,
      sourceName: null,
      localName: null,
      exportedAlias: null,
      moduleSpecifierRaw: null,
      resolvedModuleRef: null,
      sourceTargetRef: `mod:${engineRelativePath}#top:${name}`,
      legacyFacts: [`decl:${name}`],
    });
    if (exported) {
      facts.push({
        kind: "export",
        moduleRef: engineRelativePath,
        name,
        sourceName: name,
        localName: name,
        exportedAlias: name,
        moduleSpecifierRaw: null,
        resolvedModuleRef: null,
        sourceTargetRef: `mod:${engineRelativePath}#top:${name}`,
        legacyFacts: [`export:${name}`],
      });
    }
  };
  for (const statement of sourceFile.statements) {
    if (
      (ts.isFunctionDeclaration(statement)
        || ts.isClassDeclaration(statement)
        || ts.isInterfaceDeclaration(statement)
        || ts.isTypeAliasDeclaration(statement)
        || ts.isEnumDeclaration(statement))
      && statement.name !== undefined
    ) {
      pushDeclaration(statement.name.text, hasExportModifier(statement));
    } else if (ts.isVariableStatement(statement)) {
      const exported = hasExportModifier(statement);
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          pushDeclaration(declaration.name.text, exported);
        }
      }
    } else if (ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const resolvedModuleRef = resolveModuleSpecifierRef(
        sourceRoot,
        absoluteModulePath,
        specifier,
      );
      const importClause = statement.importClause;
      if (importClause === undefined) {
        facts.push({
          kind: "import",
          moduleRef: engineRelativePath,
          name: null,
          sourceName: "*",
          localName: null,
          exportedAlias: null,
          moduleSpecifierRaw: specifier,
          resolvedModuleRef,
          sourceTargetRef: resolvedModuleRef === null ? null : `mod:${resolvedModuleRef}#top:*`,
          legacyFacts: [`import:*<-${specifier}`],
        });
      } else {
        if (importClause.name !== undefined) {
          facts.push({
            kind: "import",
            moduleRef: engineRelativePath,
            name: importClause.name.text,
            sourceName: "default",
            localName: importClause.name.text,
            exportedAlias: null,
            moduleSpecifierRaw: specifier,
            resolvedModuleRef,
            sourceTargetRef: resolvedModuleRef === null ? null : `mod:${resolvedModuleRef}#top:default`,
            legacyFacts: [`import:${importClause.name.text}<-${specifier}`],
          });
        }
        const namedBindings = importClause.namedBindings;
        if (namedBindings !== undefined && ts.isNamespaceImport(namedBindings)) {
          facts.push({
            kind: "import",
            moduleRef: engineRelativePath,
            name: namedBindings.name.text,
            sourceName: "*",
            localName: namedBindings.name.text,
            exportedAlias: null,
            moduleSpecifierRaw: specifier,
            resolvedModuleRef,
            sourceTargetRef: resolvedModuleRef === null ? null : `mod:${resolvedModuleRef}#top:*`,
            legacyFacts: [`import:${namedBindings.name.text}<-${specifier}`],
          });
        } else if (namedBindings !== undefined && ts.isNamedImports(namedBindings)) {
          for (const element of namedBindings.elements) {
            const sourceName = element.propertyName?.text ?? element.name.text;
            const localName = element.name.text;
            facts.push({
              kind: "import",
              moduleRef: engineRelativePath,
              name: localName,
              sourceName,
              localName,
              exportedAlias: null,
              moduleSpecifierRaw: specifier,
              resolvedModuleRef,
              sourceTargetRef: resolvedModuleRef === null
                ? null
                : `mod:${resolvedModuleRef}#top:${sourceName}`,
              legacyFacts: [`import:${sourceName} as ${localName}<-${specifier}`],
            });
          }
        }
      }
    } else if (ts.isExportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier !== undefined
        && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : null;
      const resolvedModuleRef = specifier === null
        ? null
        : resolveModuleSpecifierRef(sourceRoot, absoluteModulePath, specifier);
      if (specifier !== null && statement.exportClause !== undefined
        && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const sourceName = element.propertyName?.text ?? element.name.text;
          const exportedName = element.name.text;
          facts.push({
            kind: "re_export",
            moduleRef: engineRelativePath,
            name: exportedName,
            sourceName,
            localName: exportedName,
            exportedAlias: exportedName,
            moduleSpecifierRaw: specifier,
            resolvedModuleRef,
            sourceTargetRef: resolvedModuleRef === null
              ? null
              : `mod:${resolvedModuleRef}#top:${sourceName}`,
            legacyFacts: uniqueStrings([
              `export:${exportedName}`,
              `reexport:${sourceName}<-${specifier}`,
              ...(exportedName === sourceName
                ? []
                : [`reexport:${exportedName}<-${specifier}`]),
            ]),
          });
        }
      } else if (specifier !== null && statement.exportClause === undefined) {
        facts.push({
          kind: "re_export",
          moduleRef: engineRelativePath,
          name: "*",
          sourceName: "*",
          localName: "*",
          exportedAlias: "*",
          moduleSpecifierRaw: specifier,
          resolvedModuleRef,
          sourceTargetRef: resolvedModuleRef === null ? null : `mod:${resolvedModuleRef}#top:*`,
          legacyFacts: [`export:*`, `reexport:*<-${specifier}`],
        });
      } else if (specifier === null && statement.exportClause !== undefined
        && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const sourceName = element.propertyName?.text ?? element.name.text;
          const exportedName = element.name.text;
          facts.push({
            kind: "export",
            moduleRef: engineRelativePath,
            name: exportedName,
            sourceName,
            localName: exportedName,
            exportedAlias: exportedName,
            moduleSpecifierRaw: null,
            resolvedModuleRef: null,
            sourceTargetRef: `mod:${engineRelativePath}#top:${sourceName}`,
            legacyFacts: [`export:${exportedName}`],
          });
        }
      }
    }
  }
  return facts;
}

/**
 * Compatibility executors may return only legacy string facts. Derive weak
 * declaration/export facts from them, never import/re-export pairings: a
 * relation edge still requires its full tuple from the executor.
 */
function moduleFactsFromLegacyObservations(
  observedFacts: readonly string[],
  moduleRef: string | null,
): readonly TsJsModuleFact[] {
  const normalizedModuleRef = moduleRef ?? "observed-module";
  const facts: TsJsModuleFact[] = [];
  for (const observedFact of observedFacts) {
    const declaration = /^decl:(.+)$/.exec(observedFact);
    if (declaration !== null) {
      const name = declaration[1]!;
      facts.push({
        kind: "declaration",
        moduleRef: normalizedModuleRef,
        name,
        sourceName: null,
        localName: null,
        exportedAlias: null,
        moduleSpecifierRaw: null,
        resolvedModuleRef: null,
        sourceTargetRef: `mod:${normalizedModuleRef}#top:${name}`,
        legacyFacts: [observedFact],
      });
    }
    const exportFact = /^export:(.+)$/.exec(observedFact);
    if (exportFact !== null) {
      const name = exportFact[1]!;
      facts.push({
        kind: "export",
        moduleRef: normalizedModuleRef,
        name,
        sourceName: name,
        localName: name,
        exportedAlias: name,
        moduleSpecifierRaw: null,
        resolvedModuleRef: null,
        sourceTargetRef: `mod:${normalizedModuleRef}#top:${name}`,
        legacyFacts: [observedFact],
      });
    }
  }
  return facts;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function relationTargetCondition(
  episode: RelationStepEpisode,
  episodes: readonly RelationStepEpisode[] = [episode],
): RelationTargetCondition {
  const declaration = episode.requestedDeclaration ?? null;
  const edgesByRef = new Map<string, RelationEdgeCondition>();
  const requiredEdgeRefs = new Set<string>();
  for (const candidateEpisode of episodes) {
    for (const obligation of candidateEpisode.remainingObligations ?? []) {
      requiredEdgeRefs.add(obligation.ref);
    }
  }
  for (const candidateEpisode of episodes) {
    for (const edge of candidateEpisode.observedBindings ?? []) {
      if (!requiredEdgeRefs.has(edge.edgeRef)) continue;
      if (edgesByRef.has(edge.edgeRef)) continue;
      const sourceModuleRef = edge.sourceModule.state === "known"
        ? edge.sourceModule.value ?? null
        : null;
      edgesByRef.set(edge.edgeRef, {
        edgeRef: edge.edgeRef,
        edgeKind: edge.edgeKind,
        sourceName: edge.sourceName,
        targetName: edge.targetName,
        sourceModuleRef,
        moduleSpecifierRaw: edge.moduleSpecifierRaw,
        expectedFacts: expectedBindingFacts(edge),
        expectedBinding: relationBindingIdentity(edge),
      });
    }
  }
  return {
    relationRef: episode.pendingRelationRef ?? episode.targetRef,
    declarationRef: declaration?.declarationRef ?? null,
    moduleRef: declaration?.moduleRef ?? null,
    name: declaration?.name ?? null,
    kind: declaration?.kind ?? null,
    edges: [...edgesByRef.values()],
  };
}

function relationTargetRef(condition: RelationTargetCondition): string {
  return condition.declarationRef ?? condition.relationRef;
}

function symbolPart(ref: string | null): string | null {
  if (ref === null) return null;
  const hash = ref.lastIndexOf("#");
  if (hash < 0) return null;
  const fragment = ref.slice(hash + 1);
  const colon = fragment.lastIndexOf(":");
  return colon >= 0 ? fragment.slice(colon + 1) : fragment;
}

function targetDeclarationName(condition: RelationTargetCondition): string | null {
  return condition.name ?? symbolPart(condition.declarationRef);
}

function normalizeModulePath(ref: string | null): string | null {
  if (ref === null) return null;
  const withoutScheme = ref.startsWith("mod:") ? ref.slice(4) : ref;
  const declarationModule = withoutScheme.split("#", 1)[0]!;
  return declarationModule.replace(/^\.\//, "");
}

function targetDeclarationModule(condition: RelationTargetCondition): string | null {
  return normalizeModulePath(condition.moduleRef)
    ?? normalizeModulePath(condition.declarationRef)
    ?? null;
}

function sameModulePath(left: string | null, right: string | null): boolean {
  const normalizedLeft = normalizeModulePath(left);
  const normalizedRight = normalizeModulePath(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

function normalizeSourceTargetRef(ref: string | null): string | null {
  if (ref === null) return null;
  const normalizedModule = normalizeModulePath(ref);
  if (normalizedModule === null) return null;
  const hash = ref.indexOf("#");
  return hash < 0 ? normalizedModule : `${normalizedModule}${ref.slice(hash)}`;
}

function normalizeBindingIdentity(identity: RelationBindingIdentity): RelationBindingIdentity {
  return {
    ...identity,
    containingModuleRef: normalizeModulePath(identity.containingModuleRef),
    sourceModuleRef: normalizeModulePath(identity.sourceModuleRef),
    sourceTargetRef: normalizeSourceTargetRef(identity.sourceTargetRef),
  };
}

function sameBindingIdentity(
  left: RelationBindingIdentity,
  right: RelationBindingIdentity,
): boolean {
  const normalizedLeft = normalizeBindingIdentity(left);
  const normalizedRight = normalizeBindingIdentity(right);
  return normalizedLeft.edgeKind === normalizedRight.edgeKind
    && normalizedLeft.containingModuleRef === normalizedRight.containingModuleRef
    && normalizedLeft.sourceModuleRef === normalizedRight.sourceModuleRef
    && normalizedLeft.sourceName === normalizedRight.sourceName
    && normalizedLeft.localName === normalizedRight.localName
    && normalizedLeft.exportedAlias === normalizedRight.exportedAlias
    && normalizedLeft.moduleSpecifierRaw === normalizedRight.moduleSpecifierRaw
    && normalizedLeft.sourceTargetRef === normalizedRight.sourceTargetRef;
}

function relationBindingIdentity(edge: BindingEdge): RelationBindingIdentity {
  const containingModuleRef = edge.targetModule.state === "known"
    ? edge.targetModule.value ?? null
    : null;
  const sourceModuleRef = edge.sourceModule.state === "known"
    ? edge.sourceModule.value ?? null
    : null;
  return {
    edgeKind: edge.edgeKind,
    containingModuleRef,
    sourceModuleRef,
    sourceName: edge.sourceName,
    localName: edge.targetName,
    exportedAlias: edge.edgeKind === "re_export" ? edge.targetName : null,
    moduleSpecifierRaw: edge.moduleSpecifierRaw,
    sourceTargetRef: sourceModuleRef === null
      ? null
      : `mod:${normalizeModulePath(sourceModuleRef)}#top:${edge.sourceName}`,
  };
}

function expectedBindingFacts(edge: BindingEdge): readonly string[] {
  const binding = relationBindingIdentity(edge);
  const containing = normalizeModulePath(binding.containingModuleRef) ?? "?";
  const source = normalizeModulePath(binding.sourceModuleRef) ?? "?";
  if (edge.edgeKind === "re_export") {
    return [
      `binding:re_export:${containing}<-${binding.moduleSpecifierRaw ?? "?"}`
      + `<-${source}#${binding.sourceName}`
      + ` as ${binding.localName ?? "?"}`
      + ` -> ${binding.exportedAlias ?? "?"}`,
    ];
  }
  if (edge.edgeKind === "import") {
    return [
      `binding:import:${containing}<-${binding.moduleSpecifierRaw ?? "?"}`
      + `<-${source}#${binding.sourceName}`
      + ` as ${binding.localName ?? "?"}`,
    ];
  }
  return [`binding:${edge.edgeKind}:${containing}#${edge.targetName}`];
}

function moduleFactsForModule(
  moduleFacts: readonly TsJsModuleFact[],
  moduleRef: string | null,
): readonly TsJsModuleFact[] {
  const normalized = normalizeModulePath(moduleRef);
  if (normalized === null) return [];
  return moduleFacts.filter(fact => normalizeModulePath(fact.moduleRef) === normalized);
}

function moduleFactExportsName(fact: TsJsModuleFact, name: string): boolean {
  return (fact.kind === "export" && fact.name === name)
    || (fact.kind === "re_export"
      && (fact.exportedAlias === name || fact.localName === name));
}

function moduleFactDeclaresOrExportsName(fact: TsJsModuleFact, name: string): boolean {
  return (fact.kind === "declaration" && fact.name === name)
    || moduleFactExportsName(fact, name);
}

function sameImportBinding(fact: TsJsModuleFact, edge: BindingEdge): boolean {
  return fact.kind === "import"
    && sameModulePath(fact.moduleRef, edge.targetModule.value ?? null)
    && fact.sourceName === edge.sourceName
    && fact.localName === edge.targetName
    && fact.moduleSpecifierRaw === edge.moduleSpecifierRaw
    && sameModulePath(fact.resolvedModuleRef, edge.sourceModule.value ?? null);
}

function sameReexportBinding(fact: TsJsModuleFact, edge: BindingEdge): boolean {
  return fact.kind === "re_export"
    && sameModulePath(fact.moduleRef, edge.targetModule.value ?? null)
    && fact.sourceName === edge.sourceName
    && fact.localName === edge.targetName
    && fact.exportedAlias === edge.targetName
    && fact.moduleSpecifierRaw === edge.moduleSpecifierRaw
    && sameModulePath(fact.resolvedModuleRef, edge.sourceModule.value ?? null);
}

function uniqueModuleFacts(
  facts: readonly TsJsModuleFact[],
): readonly TsJsModuleFact[] {
  const seen = new Set<string>();
  return facts.filter(fact => {
    const key = JSON.stringify(fact);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function verifyBindingAgainstModuleFacts(
  stepId: string,
  edge: BindingEdge,
  moduleFacts: readonly TsJsModuleFact[],
  observedModuleRef: string | null,
  evidenceRefs: readonly string[],
  phase: MultiStepBindingVerification["phase"],
): MultiStepBindingVerification {
  const expectedBinding = relationBindingIdentity(edge);
  const matchedModuleFacts: TsJsModuleFact[] = [];
  let failureReason: string | null = null;
  const observedEdgeModuleRef = edge.edgeKind === "import"
    ? normalizeModulePath(expectedBinding.containingModuleRef)
    : edge.edgeKind === "re_export"
      ? normalizeModulePath(expectedBinding.sourceModuleRef)
      : observedModuleRef;

  if (edge.edgeKind === "import") {
    const containingFacts = moduleFactsForModule(moduleFacts, expectedBinding.containingModuleRef);
    if (containingFacts.length === 0) {
      failureReason = "containing_module_not_observed";
    }
    const importFacts = containingFacts.filter(fact => fact.kind === "import");
    const exactImport = importFacts.find(fact => sameImportBinding(fact, edge));
    if (exactImport !== undefined) {
      matchedModuleFacts.push(exactImport);
    } else if (failureReason === null) {
      failureReason = "import_tuple_mismatch";
    }
    // An import edge's read proves the exact source-module export named by
    // the observed binding. The containing module is part of the same current
    // read; an unread containing module can never be treated as a passing
    // absence of an import.
    const sourceExports = moduleFactsForModule(moduleFacts, expectedBinding.sourceModuleRef)
      .filter(fact => moduleFactExportsName(fact, edge.sourceName));
    if (sourceExports.length > 0) {
      matchedModuleFacts.push(sourceExports[0]!);
    } else if (failureReason === null) {
      failureReason = "source_module_does_not_export_source_name";
    }
  } else if (edge.edgeKind === "re_export") {
    const containingFacts = moduleFactsForModule(moduleFacts, expectedBinding.containingModuleRef);
    if (containingFacts.length === 0) {
      failureReason = "containing_module_not_observed";
    }
    const exactReexport = containingFacts
      .filter(fact => fact.kind === "re_export")
      .find(fact => sameReexportBinding(fact, edge));
    if (exactReexport !== undefined) {
      matchedModuleFacts.push(exactReexport);
    } else if (failureReason === null) {
      failureReason = "reexport_tuple_mismatch";
    }
    const sourceFacts = moduleFactsForModule(moduleFacts, expectedBinding.sourceModuleRef);
    const sourceExports = sourceFacts.filter(fact =>
      moduleFactExportsName(fact, edge.sourceName));
    if (sourceExports.length > 0) {
      matchedModuleFacts.push(sourceExports[0]!);
    } else if (failureReason === null) {
      failureReason = sourceFacts.length === 0
        ? "source_module_not_observed"
        : "source_module_declaration_missing";
    }
  } else {
    const moduleRef = expectedBinding.sourceModuleRef ?? expectedBinding.containingModuleRef;
    const declarationFacts = moduleFactsForModule(moduleFacts, moduleRef)
      .filter(fact => moduleFactDeclaresOrExportsName(fact, edge.targetName));
    if (declarationFacts.length > 0) {
      matchedModuleFacts.push(declarationFacts[0]!);
    } else {
      failureReason = "declaration_missing";
    }
  }

  const uniqueMatched = uniqueModuleFacts(matchedModuleFacts);
  return {
    stepId,
    edgeRef: edge.edgeRef,
    edgeKind: edge.edgeKind,
    sourceName: edge.sourceName,
    targetName: edge.targetName,
    sourceModuleRef: expectedBinding.sourceModuleRef,
    moduleSpecifierRaw: edge.moduleSpecifierRaw,
    observedModuleRef: observedEdgeModuleRef,
    expectedBinding,
    expectedFacts: expectedBindingFacts(edge),
    matchedModuleFacts: uniqueMatched,
    matchedFacts: uniqueStrings(uniqueMatched.flatMap(fact => fact.legacyFacts)),
    verified: failureReason === null && uniqueMatched.length > 0,
    failureReason: failureReason
      ?? (uniqueMatched.length > 0 ? null : "binding_not_observed"),
    phase,
    evidenceRefs,
  };
}

function bindingVerificationForExecution(
  stepId: string,
  edge: BindingEdge,
  execution: TsJsUnifiedStepExecution,
  observedModuleRef: string | null,
  moduleFacts: readonly TsJsModuleFact[],
): MultiStepBindingVerification {
  return verifyBindingAgainstModuleFacts(
    stepId,
    edge,
    moduleFacts,
    observedModuleRef,
    execution.evidenceRefs,
    "executed",
  );
}

function targetDeclarationReached(
  condition: RelationTargetCondition,
  observations: readonly MultiStepReadObservation[],
  moduleFacts: readonly TsJsModuleFact[],
  verifications: readonly MultiStepBindingVerification[],
): boolean {
  const name = targetDeclarationName(condition);
  const modulePath = targetDeclarationModule(condition);
  if (name === null || modulePath === null) return false;
  const targetRead = observations.find(observation =>
    observation.moduleRefs.some(moduleRef => sameModulePath(moduleRef, modulePath))
    && moduleFactsForModule(observation.moduleFacts ?? [], modulePath)
      .some(fact => moduleFactExportsName(fact, name)),
  );
  if (targetRead === undefined) return false;
  if (!moduleFactsForModule(moduleFacts, modulePath)
    .some(fact => moduleFactExportsName(fact, name))) {
    return false;
  }
  return verifications.some(verification =>
    verification.phase === "executed"
    && verification.verified
    && verification.sourceName === name
    && sameModulePath(verification.sourceModuleRef, modulePath),
  );
}

function currentRelationFromRealFacts(
  episode: RelationStepEpisode,
  condition: RelationTargetCondition,
  facts: readonly string[],
  observations: readonly MultiStepReadObservation[],
  moduleFacts: readonly TsJsModuleFact[],
  verifications: readonly MultiStepBindingVerification[],
  evidenceRefs: readonly string[],
): CurrentRelationProjection {
  const reached = targetDeclarationReached(condition, observations, moduleFacts, verifications);
  const failed = verifications.find(verification => !verification.verified) ?? null;
  const callSiteRef = episode.callSiteRef ?? episode.currentRelation?.callSiteRef ?? "";
  if (reached && condition.declarationRef !== null) {
    const declaration: DeclarationIdentity = {
      declarationRef: condition.declarationRef,
      moduleRef: condition.moduleRef,
      name: targetDeclarationName(condition) ?? "",
      role: "export",
      kind: condition.kind ?? "unknown",
      evidenceRefs,
    };
    return {
      pendingRelationRef: condition.relationRef,
      callSiteRef,
      binding: {
        state: "known",
        value: {
          symbolRef: `symbol:${condition.declarationRef}`,
          callSiteRef,
          role: "export",
          bindingMode: "bound",
          resolution: {
            status: "resolved",
            declarationRef: condition.declarationRef,
            moduleRef: condition.moduleRef,
            evidenceRefs,
          },
          declarationRefs: [declaration],
          scopeRef: null,
          evidenceRefs,
        },
        evidenceRefs,
      },
    };
  }
  return {
    pendingRelationRef: condition.relationRef,
    callSiteRef,
    binding: {
      state: failed === null ? "not_observed" : "unsupported",
      ...(failed === null
        ? { reason: "not_requested" as const }
        : { reason: "observation_failed" as const }),
      evidenceRefs: failed?.evidenceRefs ?? evidenceRefs,
    },
  };
}

function updatedBindingEdge(
  edge: BindingEdge,
  verification: MultiStepBindingVerification,
): BindingEdge {
  return {
    ...edge,
    sourceContent: verification.verified
      ? {
          state: "observed" as const,
          resultRefs: verification.matchedFacts,
          reason: null,
          evidenceRefs: verification.evidenceRefs,
        }
      : {
          state: "failed" as const,
          resultRefs: [],
          reason: "observation_failed" as const,
          evidenceRefs: verification.evidenceRefs,
        },
    visibility: verification.verified
      ? {
          state: "known" as const,
          value: "reachable" as const,
          evidenceRefs: verification.evidenceRefs,
        }
      : {
          state: "unsupported" as const,
          reason: "observation_failed" as const,
          evidenceRefs: verification.evidenceRefs,
        },
    evidenceRefs: uniqueStrings([...edge.evidenceRefs, ...verification.evidenceRefs]),
  };
}

function deriveEpisodeFromRealFacts(
  nextEpisode: RelationStepEpisode,
  condition: RelationTargetCondition,
  verification: MultiStepBindingVerification | null,
  facts: readonly string[],
  moduleFacts: readonly TsJsModuleFact[],
  observations: readonly MultiStepReadObservation[],
  verifications: readonly MultiStepBindingVerification[],
  readEvidenceRefs: readonly string[],
): {
  readonly episode: RelationStepEpisode;
  readonly followUpFailure: MultiStepBindingVerification | null;
} {
  const observedBindings: BindingEdge[] = [];
  let followUpFailure: MultiStepBindingVerification | null = null;
  for (const edge of nextEpisode.observedBindings ?? []) {
    if (verification !== null && edge.edgeRef === verification.edgeRef) {
      observedBindings.push(updatedBindingEdge(edge, verification));
      continue;
    }
    const bindingIdentity = relationBindingIdentity(edge);
    const requiredModuleRefs = [
      bindingIdentity.containingModuleRef,
      bindingIdentity.sourceModuleRef,
    ].filter((moduleRef): moduleRef is string => moduleRef !== null);
    const everyRequiredModuleObserved = requiredModuleRefs.every(moduleRef =>
      observations.some(observation =>
        observation.moduleRefs.some(observationRef =>
          sameModulePath(observationRef, moduleRef))));
    if (!everyRequiredModuleObserved) {
      observedBindings.push(edge);
      continue;
    }
    const readObservation = observations.find(observation =>
      bindingIdentity.sourceModuleRef !== null
      && observation.moduleRefs.some(observationRef =>
        sameModulePath(observationRef, bindingIdentity.sourceModuleRef)))
      ?? observations.at(-1);
    if (readObservation === undefined) {
      observedBindings.push(edge);
      continue;
    }
    const followUpVerification = verifyBindingAgainstModuleFacts(
      nextEpisode.stepId,
      edge,
      moduleFacts,
      readObservation.moduleRef,
      readObservation.evidenceRefs,
      "follow_up",
    );
    if (!followUpVerification.verified && followUpFailure === null) {
      followUpFailure = followUpVerification;
    }
    observedBindings.push(
      followUpVerification.verified
        ? {
            ...edge,
            evidenceRefs: uniqueStrings([
              ...edge.evidenceRefs,
              ...followUpVerification.evidenceRefs,
            ]),
          }
        : updatedBindingEdge(edge, followUpVerification),
    );
  }
  const verificationFailed = (verification !== null && !verification.verified)
    || followUpFailure !== null;
  const targetReached = targetDeclarationReached(
    condition,
    observations,
    moduleFacts,
    verifications,
  );
  return {
    episode: {
      ...nextEpisode,
      observedFacts: facts,
      observedBindings,
      // A real read replaces preset source-content truth, but still-unexecuted
      // obligations remain the legal advance candidates for later steps. A
      // failed follow-up stops the old chain by closing that obligation set.
      remainingObligations: verificationFailed
        ? []
        : nextEpisode.remainingObligations ?? [],
      localCandidateCursor: verificationFailed
        ? {
            pendingRelationRef: condition.relationRef,
            state: "closed" as const,
            evidenceRefs: readEvidenceRefs,
          }
        : nextEpisode.localCandidateCursor ?? {
            pendingRelationRef: condition.relationRef,
            state: "closed" as const,
            evidenceRefs: readEvidenceRefs,
          },
      currentRelation: currentRelationFromRealFacts(
        nextEpisode,
        condition,
        facts,
        observations,
        moduleFacts,
        verifications,
        readEvidenceRefs,
      ),
      coverage: {
        coveredModules: uniqueStrings(observations.flatMap(observation =>
          observation.moduleRef === null ? [] : [observation.moduleRef]
        )),
        targetModuleReached: targetReached,
        ...(verificationFailed ? { note: "binding_verification_failed" } : {}),
      },
      evidenceRefs: readEvidenceRefs,
    },
    followUpFailure,
  };
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
  readonly observedModuleRef: string | null;
  readonly bindingVerification: MultiStepBindingVerification | null;
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

interface MultiStepReadObservation {
  readonly stepId: string;
  readonly moduleRef: string | null;
  readonly moduleRefs: readonly string[];
  readonly facts: readonly string[];
  readonly moduleFacts: readonly TsJsModuleFact[];
  readonly evidenceRefs: readonly string[];
}

interface MultiStepBindingVerification {
  readonly stepId: string;
  readonly edgeRef: string;
  readonly edgeKind: BindingEdge["edgeKind"];
  readonly sourceName: string;
  readonly targetName: string;
  readonly sourceModuleRef: string | null;
  readonly moduleSpecifierRaw: string | null;
  readonly observedModuleRef: string | null;
  readonly expectedBinding: RelationBindingIdentity;
  readonly expectedFacts: readonly string[];
  readonly matchedModuleFacts: readonly TsJsModuleFact[];
  readonly matchedFacts: readonly string[];
  readonly verified: boolean;
  readonly failureReason: string | null;
  readonly phase: "executed" | "follow_up";
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
  /** Facts parsed from modules actually read by the executor. */
  readonly realFacts: readonly string[];
  /** Typed module facts parsed from modules actually read by the executor. */
  readonly realModuleFacts: readonly TsJsModuleFact[];
  readonly readObservations: readonly MultiStepReadObservation[];
  readonly bindingVerifications: readonly MultiStepBindingVerification[];
  readonly followUpFailures: readonly MultiStepBindingVerification[];
  readonly terminal: boolean;
  readonly terminalKind:
    | "judge"
    | "control_return"
    | "control_defer"
    | "exhausted"
    | "binding_failed"
    | null;
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
  MultiStepDecisionEvidence,
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
    MultiStepDecisionEvidence,
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
  /** D.4 typed completion output, computed without gold access. */
  readonly rootCompletion: TsJsRootCompletion;
  /** B.6 admitted initial-evidence records; invalid candidates are dropped. */
  readonly admittedInitialEvidence: readonly TsJsInitialEvidenceRecord[];
  /** Explicit reasons a candidate initial-evidence record was not admitted. */
  readonly initialEvidenceInvalidReasons: readonly string[];
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
): AtomicReceipt<MultiStepState, MultiStepDecisionEvidence, DecisionEffect, MultiStepReceiptPayload> {
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

function uniqueRefs(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((ref): ref is string => typeof ref === "string" && ref.length > 0))];
}

function receiptNumber(
  receipt: NonNullable<RelationStepEpisode["receipts"]>[number],
  field: "textLength" | "lineCount",
): number | undefined {
  const value = (receipt as unknown as Record<string, unknown>)[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function intersectRefs(...groups: readonly (readonly string[])[]): readonly string[] {
  if (groups.length === 0) return [];
  const first = groups[0] ?? [];
  const rest = groups.slice(1);
  const restSets = rest.map(group => new Set(group));
  return uniqueRefs(
    first.filter(ref => ref.length > 0 && restSets.every(set => set.has(ref))),
  );
}

/**
 * Admits the B.6 read record for one admitted source read receipt. The read
 * ref must resolve through the typed read identities (receipt, previous
 * execution, binding/resolution, and observed source content where present).
 * A receipt-shaped assertion that only carries an `ev:` string is rejected.
 */
function admittedReadRecords(
  episode: RelationStepEpisode,
  stateRef: string,
  receipt: NonNullable<RelationStepEpisode["receipts"]>[number],
): { readonly records: readonly TsJsInitialEvidenceRecord[]; readonly reasons: readonly string[] } {
  const reject = (reason: string) => ({ records: [] as const, reasons: [reason] });
  if (receipt.action !== "read_source") return reject("source read receipt action mismatch");
  if (receipt.outcome !== "success") return reject("source read receipt outcome not success");
  if (receipt.origin !== "source_observation") {
    return reject("source read receipt origin not source_observation");
  }
  const receiptId = nonEmptyString(receipt.receiptId);
  const actionRef = nonEmptyString(receipt.actionRef);
  const targetRef = nonEmptyString(receipt.target);
  if (receiptId === null) return reject("source read receipt missing receiptId");
  if (actionRef === null) return reject("source read receipt missing actionRef");
  if (targetRef === null) return reject("source read receipt missing targetRef");

  const reasons: string[] = [];
  const receiptPendingRelationRef = nonEmptyString(receipt.pendingRelationRef);
  const episodePendingRelationRef = nonEmptyString(episode.pendingRelationRef);
  if (receiptPendingRelationRef === null) {
    reasons.push("source read receipt missing pendingRelationRef");
  } else if (
    episodePendingRelationRef !== null
    && receiptPendingRelationRef !== episodePendingRelationRef
  ) {
    reasons.push("source read receipt pendingRelationRef mismatch");
  }
  const fromStepId = receipt.fromStepId === undefined ? null : receipt.fromStepId;
  const previous = episode.previousExecution?.state === "known"
    ? episode.previousExecution.value ?? null
    : null;
  if (previous === null) {
    return reject("source read receipt requires typed previous execution identity");
  }
  if (nonEmptyString(previous.receiptRef) !== receiptId) {
    reasons.push("source read receiptId does not match previous execution");
  }
  if (nonEmptyString(previous.actionRef) !== actionRef) {
    reasons.push("source read actionRef does not match previous execution");
  }
  if (nonEmptyString(previous.targetRef) !== targetRef) {
    reasons.push("source read targetRef does not match previous execution");
  }
  if ((previous.fromStepId ?? null) !== fromStepId) {
    reasons.push("source read fromStepId does not match previous execution");
  }
  if (
    receiptPendingRelationRef !== null
    && previous.pendingRelationRef !== null
    && previous.pendingRelationRef !== receiptPendingRelationRef
  ) {
    reasons.push("source read pendingRelationRef does not match previous execution");
  }
  if (previous.outcome !== "success") {
    reasons.push("source read previous execution outcome not success");
  }

  const receiptResultRefs = Array.isArray(receipt.result)
    ? receipt.result.filter((ref): ref is string => typeof ref === "string" && ref.startsWith("ev:"))
    : [];
  const binding = episode.currentRelation?.binding.state === "known"
    ? episode.currentRelation.binding.value ?? null
    : null;
  const bindingRefs = [
    ...(binding?.evidenceRefs ?? []),
    ...(binding !== null && binding.resolution.status !== "unresolved"
      ? binding.resolution.evidenceRefs
      : []),
  ];
  const membershipGroups: readonly (readonly string[])[] = [
    receipt.evidenceRefs,
    receiptResultRefs,
    bindingRefs,
    ...(episode.previousExecution?.evidenceRefs === undefined
      ? []
      : [episode.previousExecution.evidenceRefs]),
    ...(episode.sourceContent?.state === "observed"
      ? [episode.sourceContent.evidenceRefs]
      : []),
  ];
  const readRefs = intersectRefs(...membershipGroups);
  if (readRefs.length === 0) reasons.push("source read evidence membership missing");
  if (reasons.length > 0 || receiptPendingRelationRef === null) {
    return { records: [], reasons: uniqueRefs(reasons) };
  }

  const textLength = receiptNumber(receipt, "textLength");
  const lineCount = receiptNumber(receipt, "lineCount");
  const records = readRefs.map(ref => ({
    id: ref,
    stateRef,
    validity: "valid" as const,
    payload: {
      kind: "source_read_receipt" as const,
      receiptId,
      actionRef,
      origin: "source_observation" as const,
      outcome: "success" as const,
      targetRef,
      fromStepId,
      pendingRelationRef: receiptPendingRelationRef,
      resultRefs: uniqueRefs(receiptResultRefs),
      evidenceRefs: uniqueRefs(receipt.evidenceRefs),
      ...(textLength === undefined ? {} : { textLength }),
      ...(lineCount === undefined ? {} : { lineCount }),
    },
  }));
  return { records, reasons: [] };
}

function admittedImportRecord(
  episode: RelationStepEpisode,
  stateRef: string,
  binding: NonNullable<RelationStepEpisode["observedBindings"]>[number],
): { readonly record: TsJsInitialEvidenceRecord | null; readonly reason: string | null } {
  if (binding.edgeKind !== "import") return { record: null, reason: "not an import edge" };
  if (binding.sourceModule.state !== "known" || binding.targetModule.state !== "known") {
    return { record: null, reason: "import module is not known" };
  }
  const sourceModuleRef = binding.sourceModule.value;
  const targetModuleRef = binding.targetModule.value;
  if (
    typeof sourceModuleRef !== "string"
    || typeof targetModuleRef !== "string"
  ) return { record: null, reason: "import module ref is missing" };
  if (
    binding.edgeRef.length === 0
    || binding.sourceName.length === 0
    || binding.targetName.length === 0
  ) {
    return { record: null, reason: "import binding identity is incomplete" };
  }
  if (binding.evidenceRefs.length === 0) {
    return { record: null, reason: "import binding has no evidence refs" };
  }
  const importRef = binding.evidenceRefs.find(ref => ref.startsWith("ev:")) ?? null;
  if (importRef === null) {
    return { record: null, reason: "import binding evidence ref is not observed" };
  }
  return {
    record: {
      id: importRef,
      stateRef,
      validity: "valid",
      payload: {
        kind: "import_binding_observation",
        edgeRef: binding.edgeRef,
        edgeKind: binding.edgeKind,
        fromNodeRef: binding.fromNodeRef,
        sourceName: binding.sourceName,
        targetName: binding.targetName,
        sourceModuleRef,
        targetModuleRef,
        moduleSpecifierRaw: binding.moduleSpecifierRaw ?? null,
        evidenceRefs: binding.evidenceRefs,
      },
    },
    reason: null,
  };
}

/**
 * B.6 bounded initial-evidence admission. Reads only the admitted episode
 * data and returns valid `TsJsInitialEvidenceRecord[]` plus explicit reasons
 * for dropped candidates. It never imports a registry, checksum, gold, oracle,
 * or teacher source and never synthesizes an identity.
 */
export function admitInitialEvidence(
  requestId: string,
  episodes: readonly RelationStepEpisode[],
): {
  readonly initialObservation: {
    readonly stateId: string;
    readonly evidence: readonly TsJsInitialEvidenceRecord[];
  } | null;
  readonly invalidReasons: readonly string[];
  readonly initialStateRef: string;
} {
  if (episodes.length === 0) {
    return { initialObservation: null, invalidReasons: ["no admitted episode"], initialStateRef: "" };
  }
  const startEpisode = episodes.find(episode => episode.stepId === multiStepStartStepId(episodes))
    ?? episodes[0]!;
  const stateRef = `ms:${requestId}:${startEpisode.stepId}`;
  const reasons: string[] = [];
  const records = new Map<string, TsJsInitialEvidenceRecord>();
  const duplicateIds = new Set<string>();
  const addRecord = (record: TsJsInitialEvidenceRecord): void => {
    if (records.has(record.id)) {
      reasons.push(`duplicate initial evidence id ${record.id}`);
      duplicateIds.add(record.id);
      return;
    }
    records.set(record.id, record);
  };
  const receipts = startEpisode.receipts ?? [];
  const previous = startEpisode.previousExecution?.state === "known"
    ? startEpisode.previousExecution.value
    : null;
  const previousReceiptRef = nonEmptyString(previous?.receiptRef);
  const expectedPendingRelationRef = nonEmptyString(startEpisode.pendingRelationRef);
  const readReceipt = previousReceiptRef === null
    ? receipts.find(receipt =>
        receipt.action === "read_source"
        && receipt.outcome === "success"
        && receipt.origin === "source_observation"
        && expectedPendingRelationRef !== null
        && receipt.pendingRelationRef === expectedPendingRelationRef)
    : receipts.find(receipt => receipt.receiptId === previousReceiptRef);
  if (readReceipt === undefined) {
    reasons.push("missing source read receipt");
  } else {
    const readAdmission = admittedReadRecords(startEpisode, stateRef, readReceipt);
    if (readAdmission.records.length === 0) {
      reasons.push(...readAdmission.reasons);
      if (readAdmission.reasons.length === 0) reasons.push("source read receipt not admitted");
    }
    for (const record of readAdmission.records) addRecord(record);
  }
  for (const binding of startEpisode.observedBindings ?? []) {
    if (binding.edgeKind !== "import") continue;
    const importAdmission = admittedImportRecord(startEpisode, stateRef, binding);
    if (importAdmission.record === null) {
      reasons.push(
        `import binding ${binding.edgeRef} not admitted: ${importAdmission.reason ?? "unknown"}`,
      );
      continue;
    }
    addRecord(importAdmission.record);
  }
  for (const duplicateId of duplicateIds) {
    records.delete(duplicateId);
  }
  const evidence = [...records.values()];
  if (evidence.length === 0 && reasons.length === 0) {
    reasons.push("no admitted initial evidence");
  }
  return {
    initialObservation: { stateId: stateRef, evidence },
    invalidReasons: uniqueRefs(reasons),
    initialStateRef: stateRef,
  };
}

function rootTerminalPrediction(state: MultiStepState): TsJsPredictedJudgement {
  if (state.terminalKind !== "judge") return null;
  if (state.terminalJudgement === "judge=true") return "true";
  if (state.terminalJudgement === "judge=false") return "false";
  if (state.terminalJudgement === "judge=unknown") return "unknown";
  return null;
}

function enumerationClosed(state: MultiStepState): boolean {
  if (state.context.candidateGroup.enumeration !== "complete") return false;
  if (state.context.localCandidateCursor?.state !== "closed") return false;
  if ((state.context.remainingObligations ?? []).length > 0) return false;
  return !state.context.candidateGroup.candidates.some(candidate =>
    candidate.optionSemantics === "advance" || candidate.optionSemantics === "observe");
}

function executedEpisodesOf(
  state: MultiStepState,
  episodes: readonly RelationStepEpisode[],
): readonly RelationStepEpisode[] {
  const executed = new Set([...state.stepSequence, state.context.stepId]);
  return episodes.filter(episode => executed.has(episode.stepId));
}

function observedLocalFactsOf(
  episode: RelationStepEpisode,
): readonly TsJsObservedLocalFact[] {
  return (episode as AdmittedEpisode).observedLocalFacts ?? [];
}

function negativeShadowWitness(
  episodes: readonly RelationStepEpisode[],
  state: MultiStepState,
  initialEvidence: readonly TsJsInitialEvidenceRecord[],
): readonly string[] {
  if (!enumerationClosed(state)) return [];
  for (const episode of executedEpisodesOf(state, episodes)) {
    const currentRelation = episode.currentRelation;
    const binding = currentRelation?.binding.state === "known"
      ? currentRelation.binding.value
      : null;
    if (binding === null || binding === undefined || binding.role !== "shadow" || binding.bindingMode !== "bound") continue;
    if (binding.resolution.status !== "resolved" || binding.resolution.declarationRef.length === 0) continue;
    const declarationRef = binding.resolution.declarationRef;
    const shadowDeclaration = (episode.observedDeclarations ?? []).find(
      declaration => declaration.role === "shadow" && declaration.declarationRef === declarationRef);
    if (shadowDeclaration === undefined) continue;
    const shadowFact = (episode.shadowFacts ?? []).find(
      fact => fact.declarationRef === declarationRef);
    if (shadowFact === undefined) continue;
    const requestModuleRef = episode.requestedDeclaration?.moduleRef ?? null;
    const shadowModuleRef = shadowDeclaration.moduleRef;
    if (
      requestModuleRef === null
      || shadowModuleRef === null
      || sameModulePath(requestModuleRef, shadowModuleRef)
    ) continue;
    const importBinding = (episode.observedBindings ?? []).find(edge =>
      edge.edgeKind === "import"
      && edge.targetModule.state === "known"
      && sameModulePath(edge.targetModule.value ?? null, shadowModuleRef));
    if (importBinding === undefined) continue;
    const bindingRefs = new Set<string>([
      ...binding.evidenceRefs,
      ...binding.resolution.evidenceRefs,
    ]);
    const readRecord = initialEvidence.find(record =>
      record.validity === "valid"
      && record.payload.kind === "source_read_receipt"
      && bindingRefs.has(record.id));
    const importRecord = initialEvidence.find(record =>
      record.validity === "valid"
      && record.payload.kind === "import_binding_observation"
      && record.payload.edgeRef === importBinding.edgeRef);
    if (readRecord === undefined || importRecord === undefined) continue;
    return uniqueRefs([readRecord.id, importRecord.id]);
  }
  return [];
}

function dynamicUndecidableWitness(
  episodes: readonly RelationStepEpisode[],
  state: MultiStepState,
  initialEvidence: readonly TsJsInitialEvidenceRecord[],
): readonly string[] {
  if (!enumerationClosed(state)) return [];
  for (const episode of executedEpisodesOf(state, episodes)) {
    const currentRelation = episode.currentRelation;
    const binding = currentRelation?.binding.state === "known"
      ? currentRelation.binding.value
      : null;
    if (binding === null || binding === undefined || binding.bindingMode !== "dynamic") continue;
    if (
      binding.resolution.status !== "dynamic"
      || binding.resolution.reason !== "dynamic_undecidable"
    ) continue;
    if (episode.sourceContent?.state !== "not_requested") continue;
    if (episode.coverage?.note !== "runtime_dynamic_selector") continue;
    if (episode.coverage.targetModuleReached !== false) continue;
    const bindingRefs = new Set<string>([
      ...binding.evidenceRefs,
      ...binding.resolution.evidenceRefs,
    ]);
    const readRecord = initialEvidence.find(record =>
      record.validity === "valid"
      && record.payload.kind === "source_read_receipt"
      && bindingRefs.has(record.id));
    if (readRecord === undefined) continue;
    if (!binding.resolution.evidenceRefs.includes(readRecord.id)) continue;
    const localFacts = observedLocalFactsOf(episode);
    const admittedReadRefs = new Set(initialEvidence
      .filter(record => record.validity === "valid" && record.payload.kind === "source_read_receipt")
      .map(record => record.id));
    const roleReadRef = (role: TsJsObservedLocalFact["role"]): string | null => {
      const facts = localFacts.filter(fact => fact.role === role && fact.state === "known");
      if (facts.length !== 1) return null;
      const fact = facts[0]!;
      const refs = uniqueRefs(fact.evidenceRefs.filter(ref =>
        admittedReadRefs.has(ref)
        && bindingRefs.has(ref)
        && binding.resolution.evidenceRefs.includes(ref)
      ));
      return refs.length === 1 ? refs[0]! : null;
    };
    const tableRef = roleReadRef("selector_candidate_table");
    const runtimeRef = roleReadRef("runtime_selector_dependency");
    if (tableRef === null || runtimeRef === null || tableRef !== runtimeRef) continue;
    return [tableRef];
  }
  return [];
}

function rootCompletionOf(
  episodes: readonly RelationStepEpisode[],
  state: MultiStepState,
  evidence: readonly { readonly id: string; readonly stateRef: string; readonly validity: string }[],
  goal: DecisionGoal,
  initialEvidence: readonly TsJsInitialEvidenceRecord[],
): TsJsRootCompletion {
  const predicted = rootTerminalPrediction(state);
  const structural = evaluateMultiStepRoot(state, evidence, goal);
  const availableRefs = [...structural.evidenceRefs];
  const missingGap: TsJsRootGap = { code: "ROOT_EVIDENCE_MISSING", refs: availableRefs };
  if (!state.terminal) {
    return {
      predictedJudgement: predicted,
      positiveRootSatisfied: false,
      positiveRootGaps: [missingGap],
      queryCompletion: "incomplete",
      evidenceRefs: availableRefs,
    };
  }
  if (state.terminalKind === "control_return") {
    return {
      predictedJudgement: null,
      positiveRootSatisfied: false,
      positiveRootGaps: [{ code: "NO_POSITIVE_RELATION_ANSWER", refs: [] }],
      queryCompletion: "returned_unresolved",
      evidenceRefs: availableRefs,
    };
  }
  if (state.terminalKind === "judge" && state.terminalJudgement === "judge=true") {
    return structural.result === "satisfied"
      ? {
          predictedJudgement: "true",
          positiveRootSatisfied: true,
          positiveRootGaps: [],
          queryCompletion: "complete_true",
          evidenceRefs: availableRefs,
        }
      : {
          predictedJudgement: "true",
          positiveRootSatisfied: false,
          positiveRootGaps: [missingGap],
          queryCompletion: "incomplete",
          evidenceRefs: availableRefs,
        };
  }
  if (state.terminalKind === "judge" && state.terminalJudgement === "judge=false") {
    const shadow = negativeShadowWitness(episodes, state, initialEvidence);
    if (shadow.length === 0) {
      return {
        predictedJudgement: "false",
        positiveRootSatisfied: false,
        positiveRootGaps: [missingGap],
        queryCompletion: "incomplete",
        evidenceRefs: availableRefs,
      };
    }
    return {
      predictedJudgement: "false",
      positiveRootSatisfied: false,
      positiveRootGaps: [{ code: "POSITIVE_RELATION_NOT_ESTABLISHED", refs: shadow }],
      queryCompletion: "complete_false",
      evidenceRefs: shadow,
    };
  }
  if (state.terminalKind === "judge" && state.terminalJudgement === "judge=unknown") {
    const dynamic = dynamicUndecidableWitness(episodes, state, initialEvidence);
    if (dynamic.length === 0) {
      return {
        predictedJudgement: "unknown",
        positiveRootSatisfied: false,
        positiveRootGaps: [missingGap],
        queryCompletion: "incomplete",
        evidenceRefs: availableRefs,
      };
    }
    return {
      predictedJudgement: "unknown",
      positiveRootSatisfied: false,
      positiveRootGaps: [{ code: "POSITIVE_RELATION_NOT_DECIDABLE", refs: dynamic }],
      queryCompletion: "complete_unknown",
      evidenceRefs: dynamic,
    };
  }
  return {
    predictedJudgement: predicted,
    positiveRootSatisfied: false,
    positiveRootGaps: [missingGap],
    queryCompletion: "incomplete",
    evidenceRefs: availableRefs,
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
  goal: DecisionGoal,
): StructuralRootEvaluation {
  const realReads = [...state.readEvidenceRefs];
  const validIds = new Set(
    evidence
      .filter(item => item.validity === "valid" && realReads.includes(item.id))
      .map(item => item.id),
  );
  const evidenceRefs = realReads.filter(id => validIds.has(id));
  if (!state.terminal) {
    return {
      result: "unsatisfied",
      satisfaction: 0,
      necessaryConditionsMet: false,
      evidenceRefs: [],
    };
  }
  const terminalAccepts = state.terminalKind === "control_return"
    || (state.terminalKind === "judge" && state.terminalJudgement === "judge=true");
  const everyReadHasValidEvidence = state.readObservations.length > 0
    && state.readObservations.every(observation =>
      observation.evidenceRefs.some(ref => validIds.has(ref))
    );
  const everyBindingVerified = state.bindingVerifications.length > 0
    && state.bindingVerifications.every(verification => verification.verified);
  const everyRequiredEdgeVerified = goal.relation.edges.length > 0
    && goal.relation.edges.every(edgeCondition =>
      state.bindingVerifications.some(verification =>
        verification.phase === "executed"
        && verification.edgeRef === edgeCondition.edgeRef
        && verification.verified
        && sameBindingIdentity(verification.expectedBinding, edgeCondition.expectedBinding)));
  const targetReached = targetDeclarationReached(
    goal.relation,
    state.readObservations,
    state.realModuleFacts,
    state.bindingVerifications,
  );
  const expansionComplete =
    state.context.candidateGroup.enumeration === "complete"
    && state.context.localCandidateCursor?.state === "closed";
  const verified =
    terminalAccepts
    && evidenceRefs.length > 0
    && everyReadHasValidEvidence
    && everyBindingVerified
    && everyRequiredEdgeVerified
    && targetReached
    && expansionComplete;
  if (verified) {
    return {
      result: "satisfied",
      satisfaction: 100,
      necessaryConditionsMet: true,
      evidenceRefs,
    };
  }
  return {
    result: "unsatisfied",
    satisfaction: 0,
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
    realFacts: [],
    realModuleFacts: [],
    readObservations: [],
    bindingVerifications: [],
    followUpFailures: [],
    terminal: false,
    terminalKind: null,
    terminalJudgement: "none",
    candidateGroupRef: startContext.candidateGroup.candidateGroupRef,
    lastCandidateRef: null,
    lastReceipt: null,
    lastPostState: null,
    nextStepId: null,
  };

  const admission = admitInitialEvidence(request.requestId, episodes);
  const admittedInitialEvidence = admission.initialObservation?.evidence ?? [];
  const initialEvidenceInvalidReasons = admission.invalidReasons;
  const admittedInitialObservation = {
    stateId: initialStateValue.stateRef,
    evidence: [...admittedInitialEvidence],
  };

  const relationCondition = relationTargetCondition(startEpisode, episodes);
  const rootGoal: DecisionGoal = {
    kind: "verify",
    targetRef: relationTargetRef(relationCondition),
    contextId: startContext.contextId,
    relation: relationCondition,
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
      ValidatedRequest<DecisionGoal, MultiStepState, DecisionBindings, MultiStepDecisionEvidence, DecisionEffect, MultiStepReceiptPayload, null>
    > => ({
      requestId: envelope.requestId,
      rootGoal,
      satisfactionThreshold: 100,
      rootBindings,
      state: initialStateValue,
      rootEvaluatorId: MULTI_STEP_ROOT_EVALUATOR_ID,
      rootSelectorId: MULTI_STEP_ROOT_SELECTOR_ID,
      ...(envelope.limits !== undefined ? { limits: envelope.limits } : {}),
      initialObservation: {
        stateId: admittedInitialObservation.stateId,
        evidence: [...admittedInitialObservation.evidence],
      },
      continuation: null,
    }),
    supports: (input: SupportsInput<DecisionGoal, DecisionBindings>) =>
      input.goal.kind === "verify"
      && (input.skill.id === MULTI_STEP_RELATION_JUDGE_SKILL_ID
        || input.skill.id === MULTI_STEP_RELATION_READ_SKILL_ID
        || input.skill.id === MULTI_STEP_RELATION_OBSERVE_SKILL_ID
        || input.skill.id === MULTI_STEP_RELATION_CONTROL_SKILL_ID),
    evaluate: async (input: EvaluationInput<DecisionGoal, MultiStepState, DecisionBindings, MultiStepDecisionEvidence>): Promise<EvaluationReceipt> => ({
      evaluatorId: MULTI_STEP_ROOT_EVALUATOR_ID,
      ...evaluateMultiStepRoot(input.state, input.evidence, input.goal),
    }),
    select: async (input: SelectionInput<DecisionGoal, MultiStepState, DecisionBindings, MultiStepDecisionEvidence>): Promise<Selection> => {
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
    derive: async (input: DerivationInput<DecisionGoal, MultiStepState, DecisionBindings, MultiStepDecisionEvidence, null>) => ({
      conditions: [],
      nextCursor: null,
      expansion: "closed",
    }),
    executeAtomic: async (input: AtomicInput<DecisionGoal, MultiStepState, DecisionBindings, MultiStepDecisionEvidence>) => {
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
      let bindingVerification: MultiStepBindingVerification | null = null;
      let readObservation: MultiStepReadObservation | null = null;
      let nextRealFacts = state.realFacts;
      let nextRealModuleFacts = state.realModuleFacts;
      let nextReadObservations = state.readObservations;
      let nextBindingVerifications = state.bindingVerifications;
      let nextFollowUpFailures = state.followUpFailures;
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
        const executionModuleFacts = execution.moduleFacts
          ?? moduleFactsFromLegacyObservations(execution.observedFacts, readInput.moduleRef);
        const executionModuleRefs = uniqueStrings([
          ...(execution.coverage?.modules ?? []),
          ...executionModuleFacts.map(fact => fact.moduleRef),
          ...(readInput.moduleRef === null ? [] : [readInput.moduleRef]),
        ].flatMap(moduleRef => {
          const normalized = normalizeModulePath(moduleRef);
          return normalized === null ? [] : [normalized];
        }));
        const executedSourceModule = binding !== null && binding.sourceModule.state === "known"
          ? binding.sourceModule.value ?? null
          : null;
        executedSourceModuleForNext = executedSourceModule;
        nextRealFacts = uniqueStrings([...state.realFacts, ...execution.observedFacts]);
        nextRealModuleFacts = uniqueModuleFacts([
          ...state.realModuleFacts,
          ...executionModuleFacts,
        ]);
        readObservation = {
          stepId,
          moduleRef: readInput.moduleRef,
          moduleRefs: executionModuleRefs,
          facts: execution.observedFacts,
          moduleFacts: executionModuleFacts,
          evidenceRefs: execution.evidenceRefs,
        };
        nextReadObservations = [...state.readObservations, readObservation];
        if (binding !== null) {
          bindingVerification = bindingVerificationForExecution(
            stepId,
            binding,
            execution,
            readInput.moduleRef,
            executionModuleFacts,
          );
          nextBindingVerifications = [...state.bindingVerifications, bindingVerification];
          if (!bindingVerification.verified) {
            terminalKind = "binding_failed";
          }
        }
        if (terminalKind === null) {
          nextEpisode = multiStepResolveNextEpisode(
            stepId,
            actionKind === "submit_read" ? "advance" : "observe",
            chosen.candidate.edgeRef,
            executedSourceModule,
            new Set(state.stepSequence),
            episodes,
          );
          if (nextEpisode === null) terminalKind = "exhausted";
        }
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
          const derived = deriveEpisodeFromRealFacts(
            nextEpisode,
            relationCondition,
            bindingVerification,
            nextRealFacts,
            nextRealModuleFacts,
            nextReadObservations,
            nextBindingVerifications,
            uniqueStrings([...state.readEvidenceRefs, ...execution.evidenceRefs]),
          );
          nextEpisode = derived.episode;
          if (derived.followUpFailure !== null) {
            nextFollowUpFailures = [...state.followUpFailures, derived.followUpFailure];
            nextBindingVerifications = [
              ...nextBindingVerifications,
              derived.followUpFailure,
            ];
          }
          if (nextFollowUpFailures.length > 0) {
            terminalKind = "binding_failed";
          }
        }
      } else if (actionKind === "submit_control") {
        execution = {
          outcome: "success",
          observedFacts: [],
          evidenceRefs: [],
          coverage: null,
          failure: null,
        };
        terminalKind = optionSemantics === "RETURN" ? "control_return" : "control_defer";
      } else {
        execution = {
          outcome: "success",
          observedFacts: [],
          evidenceRefs: [],
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
      const realFacts = actionKind === "submit_read" || actionKind === "submit_observe"
        ? nextRealFacts
        : state.realFacts;
      const realModuleFacts = actionKind === "submit_read" || actionKind === "submit_observe"
        ? nextRealModuleFacts
        : state.realModuleFacts;
      const readObservations = actionKind === "submit_read" || actionKind === "submit_observe"
        ? nextReadObservations
        : state.readObservations;
      const bindingVerifications = actionKind === "submit_read" || actionKind === "submit_observe"
        ? nextBindingVerifications
        : state.bindingVerifications;
      const followUpFailures = actionKind === "submit_read" || actionKind === "submit_observe"
        ? nextFollowUpFailures
        : state.followUpFailures;

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
          realFacts,
          realModuleFacts,
          readObservations,
          bindingVerifications,
          followUpFailures,
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
          realFacts,
          realModuleFacts,
          readObservations,
          bindingVerifications,
          followUpFailures,
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
        observedModuleRef: readObservation?.moduleRef ?? null,
        bindingVerification,
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
      MultiStepDecisionEvidence,
      DecisionEffect,
      MultiStepReceiptPayload
    > => readAtomicReceipt(raw, {
      state: value => value as MultiStepState,
      evidencePayload: readMultiStepEvidence,
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
    MultiStepDecisionEvidence,
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
    initialObservation: {
      stateId: admittedInitialObservation.stateId,
      evidence: [...admittedInitialObservation.evidence],
    },
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
      rootCompletion: rootCompletionOf(episodes, initialStateValue, [], rootGoal, admittedInitialEvidence),
      admittedInitialEvidence,
      initialEvidenceInvalidReasons,
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
  const finalState = recursiveGoal.report.states.at(-1)?.value ?? initialStateValue;
  const finalEvidence = recursiveGoal.report.evidence;

  return {
    modelBinding,
    recursiveGoal,
    sampleReceipt: { sampleId, steps },
    steps: stepResults,
    rootEvaluation: recursiveGoal.report.rootEvaluation,
    rootCompletion: rootCompletionOf(episodes, finalState, finalEvidence, rootGoal, admittedInitialEvidence),
    admittedInitialEvidence,
    initialEvidenceInvalidReasons,
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
