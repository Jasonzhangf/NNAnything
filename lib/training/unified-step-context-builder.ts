// Typed StepContext builder for one corpus decision step.
//
// This is the student-side observation source: it consumes only the source-level
// episode record (typed local observations, entry file, requested declaration,
// route) and never reads gold, teacher resolution, or final call edges. The
// encoder consumes the returned StepContext, so every student feature stays
// derived from observation alone.

import type {
  BindingEdge,
  BindingProjection,
  Candidate,
  CurrentRelationProjection,
  DeclarationIdentity,
  EvidenceProjection,
  InformationGainValue,
  LocalCandidateCursorProjection,
  SkillDescriptor,
  StepContext,
  MissingProjection,
  Observed,
  PreviousExecutionProjection,
  RemainingObligationProjection,
  RelationshipProjection,
} from "./unified-encoder.js";
import type {
  TsJsCoverageRecord,
  TsJsParserRecord,
  TsJsRuntimeSelectorObservation,
  TsJsRuntimeSelectorRoleFact,
  TsJsSymbolTableRequest,
} from "../filters/tsjs-symbol-table-policy.js";
import { UNIFIED_INPUT_SCHEMA } from "./unified-encoder.js";

export const RELATION_SKILL_REF = "skill:relation.judge";
export const RELATION_SKILL_KEY = "relation.judge";
export const RELATION_OBSERVE_SKILL_REF = "skill:relation.observe";
export const RELATION_READ_SKILL_REF = "skill:relation.read";
export const RELATION_CONTROL_SKILL_REF = "skill:relation.control";
export const DEFAULT_RELATION_STEP_ID = "step:0";

export interface RelationStepSourceContent {
  readonly state: "not_requested" | "observed" | "failed" | "truncated" | "unsupported" | "conflicting";
  readonly resultRefs: readonly string[];
  readonly reason: string | null;
  readonly evidenceRefs: readonly string[];
}

export interface RelationStepLocalFact {
  readonly factRef: string;
  readonly role?: "selector_candidate_table" | "runtime_selector_dependency";
  readonly state: string;
  readonly value: string | null;
  readonly evidenceRefs: readonly string[];
}

export interface TsJsProducerSourceBinding {
  readonly kind: "nnanything.tsjs.producer-source.v1";
  readonly producerRequest: TsJsSymbolTableRequest;
  readonly parser: TsJsParserRecord;
  readonly coverage: TsJsCoverageRecord;
  readonly rawObservation: TsJsRuntimeSelectorObservation;
  readonly sampleId: string;
  readonly requestRef: string;
  readonly stepId: string;
  readonly fromStepId: string | null;
  readonly callSiteRef: string;
  readonly pendingRelationRef: string;
  readonly requestedDeclarationRef: string;
  readonly requestedModuleRef: string;
}

export interface RelationStepReceipt {
  readonly receiptId: string;
  readonly actionRef?: string;
  readonly action: string;
  readonly target?: string;
  readonly fromEdgeRef?: string;
  readonly origin?: "source_observation" | "model_execution";
  readonly fromStepId?: string | null;
  readonly pendingRelationRef?: string;
  readonly optionSemantics?: "observe" | "advance";
  readonly outcome?: "success" | "partial" | "failed" | "unknown";
  readonly result: unknown;
  readonly evidenceRefs: readonly string[];
  readonly producerSource?: TsJsProducerSourceBinding;
}

export interface RelationStepCoverage {
  readonly coveredModules?: readonly string[];
  readonly targetModuleReached?: boolean;
  readonly note?: string;
}

export function relationContextId(sampleId: string, stepId: string = DEFAULT_RELATION_STEP_ID): string {
  return `ctx:${sampleId}:${stepId}`;
}

export function relationCandidateGroupRef(sampleId: string, stepId: string = DEFAULT_RELATION_STEP_ID): string {
  return `cg:${sampleId}:${stepId}:0`;
}

export interface RelationStepEpisode {
  readonly sampleId: string;
  readonly stepId: string;
  readonly requestId: string;
  readonly sourceGroup: string;
  readonly language: string;
  readonly semanticStratum: string;
  readonly partition: string;
  readonly entryFile: string;
  readonly targetRef: string;
  readonly observedFacts: readonly string[];
  readonly observedLocalFacts?: readonly RelationStepLocalFact[];
  readonly pendingRelationRef?: string | null;
  readonly callSiteRef?: string | null;
  readonly calleeName?: string | null;
  readonly requestedDeclaration?: DeclarationIdentity | null;
  readonly observedBindings?: readonly BindingEdge[];
  readonly observedDeclarations?: readonly DeclarationIdentity[];
  readonly currentRelation?: CurrentRelationProjection | null;
  readonly relationshipProjection?: RelationshipProjection | null;
  readonly previousExecution?: Observed<PreviousExecutionProjection | null>;
  readonly localCandidateCursor?: LocalCandidateCursorProjection;
  readonly sourceContent?: RelationStepSourceContent | null;
  readonly shadowFacts?: readonly {
    readonly name: string;
    readonly declarationRef: string;
    readonly shadowScope: string;
  }[];
  readonly remainingObligations?: readonly {
    readonly kind: "observe" | "advance";
    readonly ref: string;
    readonly pendingRelationRef?: string;
    readonly targetRef?: string | null;
    readonly skillRef?: string;
    readonly arguments?: readonly {
      readonly name: string;
      readonly type: string;
      readonly valueRef: string | null;
    }[];
    readonly informationGain: number | string | Observed<InformationGainValue>;
    readonly informationGainExplanation?: string;
    readonly evidenceRefs?: readonly string[];
  }[];
  readonly receipts?: readonly RelationStepReceipt[];
  readonly coverage?: RelationStepCoverage | null;
  readonly notReady?: boolean;
  readonly sourceCandidateRefs?: readonly string[];
  readonly cursorOpen?: boolean;
  readonly enumerationFailure?: boolean;
  readonly correctedBindingFact?: {
    readonly origin: "adapter_observation" | "post_hoc_oracle";
    readonly text?: string;
  };
  readonly evidenceRefs: readonly string[];
  readonly failureMode: string | null;
  readonly derivationFamily: string;
  readonly adapterRef: string;
}

function evidence(ref: string): EvidenceProjection {
  return {
    evidenceRef: ref,
    typeStep: "binding",
    scopeRef: null,
    observedRevision: 1,
    resultRef: null,
  };
}

function relationJudgeSkill(): SkillDescriptor {
  return {
    skillRef: RELATION_SKILL_REF,
    skillKey: RELATION_SKILL_KEY,
    contractVersion: "relation.judge.v1",
    semanticClass: "verify",
    parameterSchema: {
      schemaVersion: "relation.judge.v1",
      parameters: [
        {
          name: "target",
          type: "declaration",
          required: true,
          allowedTargetKinds: ["function", "method", "variable", "class", "declaration"],
          cardinality: "one",
        },
      ],
    },
    capabilities: ["relation.judge"],
    effects: ["read_only"],
    executorRef: "engine:judge",
    ordering: "unordered",
  };
}

function relationObserveSkill(): SkillDescriptor {
  return {
    skillRef: RELATION_OBSERVE_SKILL_REF,
    skillKey: "relation.observe",
    contractVersion: "relation.observe.v1",
    semanticClass: "observe",
    parameterSchema: {
      schemaVersion: "relation.observe.v1",
      parameters: [
        {
          name: "target",
          type: "call_site",
          required: true,
          allowedTargetKinds: ["call_site", "source_module"],
          cardinality: "one",
        },
      ],
    },
    capabilities: ["relation.observe"],
    effects: ["read_only"],
    executorRef: "engine:observe",
    ordering: "unordered",
  };
}

function relationReadSkill(): SkillDescriptor {
  return {
    skillRef: RELATION_READ_SKILL_REF,
    skillKey: "relation.read",
    contractVersion: "relation.read.v1",
    semanticClass: "read",
    parameterSchema: {
      schemaVersion: "relation.read.v1",
      parameters: [
        {
          name: "target",
          type: "binding_edge",
          required: true,
          allowedTargetKinds: ["binding_edge"],
          cardinality: "one",
        },
      ],
    },
    capabilities: ["relation.read"],
    effects: ["read_only"],
    executorRef: "engine:read",
    ordering: "unordered",
  };
}

function relationControlSkill(): SkillDescriptor {
  return {
    skillRef: RELATION_CONTROL_SKILL_REF,
    skillKey: "relation.control",
    contractVersion: "relation.control.v1",
    semanticClass: "return_control",
    parameterSchema: {
      schemaVersion: "relation.control.v1",
      parameters: [],
    },
    capabilities: ["relation.control"],
    effects: ["control"],
    executorRef: "engine:control",
    ordering: "unordered",
  };
}

function declarationProjection(
  declaration: DeclarationIdentity,
  callSiteRef: string | null,
): BindingProjection {
  return {
    symbolRef: declaration.declarationRef,
    callSiteRef,
    role: declaration.role,
    bindingMode: "bound",
    resolution: {
      status: "resolved",
      declarationRef: declaration.declarationRef,
      moduleRef: declaration.moduleRef,
      evidenceRefs: declaration.evidenceRefs,
    },
    declarationRefs: [declaration],
    scopeRef: null,
    evidenceRefs: declaration.evidenceRefs,
  };
}

function observedGain(
  raw: number | string | Observed<InformationGainValue>,
  fallbackEvidence: readonly string[],
): Observed<InformationGainValue> {
  if (typeof raw === "number") {
    if (raw === 0) return { state: "known", value: "none", evidenceRefs: fallbackEvidence };
    if (raw > 0) return { state: "known", value: "advances_chain", evidenceRefs: fallbackEvidence };
    return { state: "unsupported", reason: "unsupported_pattern", evidenceRefs: fallbackEvidence };
  }
  if (typeof raw === "string") {
    return { state: "unsupported", reason: "unsupported_pattern", evidenceRefs: fallbackEvidence };
  }
  return raw;
}

function obligationProjection(
  raw: NonNullable<RelationStepEpisode["remainingObligations"]>[number],
  pendingRelationRef: string,
  fallbackEvidence: readonly string[],
): RemainingObligationProjection {
  const observed = observedGain(raw.informationGain, raw.evidenceRefs ?? fallbackEvidence);
  const valueRef = raw.arguments?.[0]?.valueRef ?? raw.ref;
  return {
    kind: raw.kind,
    ref: raw.ref,
    pendingRelationRef: raw.pendingRelationRef ?? "",
    skillRef: raw.skillRef ?? (
      raw.kind === "advance" ? RELATION_READ_SKILL_REF : RELATION_OBSERVE_SKILL_REF
    ),
    arguments: raw.arguments?.length
      ? raw.arguments
      : [{
          name: "target",
          type: raw.kind === "advance" ? "binding_edge" : "call_site",
          valueRef,
        }],
    informationGain: observed,
    ...(raw.informationGainExplanation !== undefined
      ? { informationGainExplanation: raw.informationGainExplanation }
      : {}),
    evidenceRefs: raw.evidenceRefs ?? fallbackEvidence,
  };
}

function previousAction(
  raw: Observed<PreviousExecutionProjection | null> | undefined,
): StepContext["action"] {
  if (raw === undefined || raw.state === "not_observed" || raw.state === "missing") {
    return { previousActionRef: null, receiptRef: null, outcome: "unknown" };
  }
  if (raw.state !== "known") {
    return { previousActionRef: null, receiptRef: null, outcome: "unknown" };
  }
  if (raw.value === null || raw.value === undefined) {
    return { previousActionRef: null, receiptRef: null, outcome: "none" };
  }
  return {
    previousActionRef: raw.value.actionRef,
    receiptRef: raw.value.receiptRef,
    outcome: raw.value.outcome,
  };
}

function gainValueOrUnknown(
  raw: number | string | Observed<InformationGainValue>,
  fallbackEvidence: readonly string[],
): Observed<InformationGainValue> {
  if (typeof raw === "number") {
    if (raw === 0) return { state: "known", value: "none", evidenceRefs: fallbackEvidence };
    if (raw > 0) return { state: "known", value: "advances_chain", evidenceRefs: fallbackEvidence };
    return { state: "unsupported", reason: "unsupported_pattern", evidenceRefs: fallbackEvidence };
  }
  if (typeof raw === "string") {
    if (raw === "advances_chain" || raw === "resolves_target" || raw === "none") {
      return { state: "known", value: raw, evidenceRefs: fallbackEvidence };
    }
    return { state: "unsupported", reason: "unsupported_pattern", evidenceRefs: fallbackEvidence };
  }
  return raw;
}

function observesOnlyCurrentObligationTarget(
  raw: NonNullable<RelationStepEpisode["remainingObligations"]>[number],
  pendingRelationRef: string,
): boolean {
  return raw.pendingRelationRef === pendingRelationRef;
}

function obligationArguments(
  raw: NonNullable<RelationStepEpisode["remainingObligations"]>[number],
  pendingRelationRef: string,
): readonly { readonly name: string; readonly type: string; readonly valueRef: string | null }[] {
  if (raw.arguments !== undefined && raw.arguments.length > 0) return raw.arguments;
  if (raw.kind === "advance") {
    return [{ name: "target", type: "binding_edge", valueRef: raw.ref }];
  }
  return [{
    name: "target",
    type: "call_site",
    valueRef: raw.targetRef ?? null,
  }];
}

function currentRelationProjection(episode: RelationStepEpisode): CurrentRelationProjection | null {
  if (episode.currentRelation === undefined || episode.currentRelation === null) return null;
  return episode.currentRelation;
}

function relationProjection(episode: RelationStepEpisode): BindingProjection | null {
  return episode.currentRelation?.binding.state === "known"
    ? (episode.currentRelation.binding.value ?? null)
    : null;
}

function localCursor(
  episode: RelationStepEpisode,
  pendingRelationRef: string,
): LocalCandidateCursorProjection {
  if (episode.localCandidateCursor !== undefined) return episode.localCandidateCursor;
  if (episode.cursorOpen === true) {
    return { pendingRelationRef, state: "open", evidenceRefs: episode.evidenceRefs };
  }
  if (episode.enumerationFailure === true || episode.failureMode === "candidate_enumeration_failed") {
    return { pendingRelationRef, state: "failed", evidenceRefs: episode.evidenceRefs };
  }
  return { pendingRelationRef, state: "closed", evidenceRefs: episode.evidenceRefs };
}

function resolveEnumeration(
  episode: RelationStepEpisode,
  cursorState: LocalCandidateCursorProjection["state"],
): "complete" | "truncated" | "enumeration_failed" {
  if (episode.enumerationFailure === true || episode.failureMode === "candidate_enumeration_failed") {
    return "enumeration_failed";
  }
  if (cursorState !== "closed" || episode.failureMode === "candidate_truncated") {
    return "truncated";
  }
  return "complete";
}

export function relationStepContext(episode: RelationStepEpisode): StepContext {
  const facts = episode.observedFacts.map((fact, index) => ({
    factRef: `fact:${episode.sampleId}:${index}`,
    predicateRef: "observed_source_fact",
    value: {
      state: "known" as const,
      value: fact,
      evidenceRefs: episode.evidenceRefs,
    },
    evidence: episode.evidenceRefs.map(ref => evidence(ref)),
  }));
  const observedBindings = episode.observedBindings ?? [];
  const observedDeclarations = episode.observedDeclarations ?? [];
  const callSiteRef = episode.callSiteRef ?? null;
  const pendingRelationRef = episode.pendingRelationRef ?? episode.targetRef;
  const firstProjection = relationProjection(episode);
  const candidates: Candidate[] = ["judge=true", "judge=false", "judge=unknown"].map(judge => ({
    candidateRef: `c:${judge.replace("=", ":")}`,
    goalRef: `goal:${episode.sampleId}`,
    skillRef: RELATION_SKILL_REF,
    candidateKind: "relation" as const,
    optionSemantics: judge,
    arguments: [
      { name: "target", type: "declaration", valueRef: pendingRelationRef },
    ],
    targetRef: pendingRelationRef,
    bindingProjection: firstProjection,
    edgeRef: null,
    parameterProjection: [] as readonly MissingProjection[],
    evidenceRefs: episode.evidenceRefs,
  }));
  const skills: SkillDescriptor[] = [relationJudgeSkill()];
  const obligations = episode.remainingObligations ?? [];
  const reachableEdges = observedBindings.filter(edge =>
    edge.visibility.state === "known" && edge.visibility.value === "reachable"
  );
  const missingProjections: MissingProjection[] = [];
  const legalAdvanceTargetRefs = new Set<string>();
  const legalObserveObligationRefs = new Set<string>();
  const unknownGainObligationRefs = new Set<string>();
  const missingObligationRefs = new Set<string>();
  for (const obligation of obligations) {
    const projected = obligationProjection(obligation, pendingRelationRef, episode.evidenceRefs);
    if (obligation.pendingRelationRef === undefined || obligation.pendingRelationRef === null) {
      missingObligationRefs.add(obligation.ref);
      missingProjections.push({
        targetRef: obligation.ref,
        fieldRef: "remainingObligations.pendingRelationRef",
        state: "missing",
        reason: "not_requested",
        evidenceRefs: episode.evidenceRefs,
      });
      continue;
    }
    if (!observesOnlyCurrentObligationTarget(obligation, pendingRelationRef)) {
      continue;
    }
    const gain = projected.informationGain;
    if (gain.state !== "known") {
      unknownGainObligationRefs.add(obligation.ref);
      missingProjections.push({
        targetRef: obligation.ref,
        fieldRef: "remainingObligations.informationGain",
        state: gain.state,
        reason: gain.reason ?? "not_requested",
        evidenceRefs: episode.evidenceRefs,
      });
      continue;
    }
    if (gain.value === "none" || gain.value === undefined) {
      continue;
    }
    if (obligation.kind === "advance") {
      const matchingEdge = reachableEdges.find(edge => edge.edgeRef === obligation.ref);
      const executable =
        matchingEdge !== undefined
        && matchingEdge.sourceContent.state === "not_requested"
        && projected.arguments.some(argument => argument.valueRef === obligation.ref);
      if (executable) {
        legalAdvanceTargetRefs.add(obligation.ref);
      } else {
        missingObligationRefs.add(obligation.ref);
        missingProjections.push({
          targetRef: obligation.ref,
          fieldRef: "obligations.advance",
          state: "missing",
          reason: "not_requested",
          evidenceRefs: episode.evidenceRefs,
        });
      }
    } else {
      const hasTargetArgument = projected.arguments.some(argument =>
        argument.name === "target" && argument.valueRef !== null
      );
      if (hasTargetArgument) {
        legalObserveObligationRefs.add(obligation.ref);
      } else {
        missingObligationRefs.add(obligation.ref);
        missingProjections.push({
          targetRef: obligation.ref,
          fieldRef: "remainingObligations.arguments",
          state: "missing",
          reason: "not_requested",
          evidenceRefs: episode.evidenceRefs,
        });
      }
    }
  }
  const advanceTargetRefs = [...legalAdvanceTargetRefs].sort();
  const hasUnknownQualificationGap =
    unknownGainObligationRefs.size > 0
    || missingObligationRefs.size > 0;
  const cursor =
    hasUnknownQualificationGap
      ? ({ pendingRelationRef, state: "open" as const, evidenceRefs: episode.evidenceRefs })
      : localCursor(episode, pendingRelationRef);
  if (advanceTargetRefs.length > 0) {
    skills.push(relationReadSkill());
  }
  for (const targetRef of advanceTargetRefs) {
    const matchingEdge = reachableEdges.find(edge => edge.edgeRef === targetRef);
    if (matchingEdge === undefined) {
      missingProjections.push({
        targetRef,
        fieldRef: "obligations.advance",
        state: "unsupported",
        reason: "unsupported_pattern",
        evidenceRefs: episode.evidenceRefs,
      });
      continue;
    }
    candidates.push({
      candidateRef: `c:advance:${targetRef}`,
      goalRef: `goal:${episode.sampleId}`,
      skillRef: RELATION_READ_SKILL_REF,
      candidateKind: "action",
      optionSemantics: "advance",
      arguments: [{ name: "target", type: "binding_edge", valueRef: targetRef }],
      targetRef,
      bindingProjection: null,
      edgeRef: matchingEdge.edgeRef,
      parameterProjection: [],
      evidenceRefs: episode.evidenceRefs,
    });
  }
  const observeObligations = obligations.filter(obligation =>
    legalObserveObligationRefs.has(obligation.ref)
  );
  if (observeObligations.length > 0) {
    skills.push(relationObserveSkill());
    for (const obligation of observeObligations) {
      const projected = obligationProjection(obligation, pendingRelationRef, episode.evidenceRefs);
      candidates.push({
        candidateRef: `c:observe:${obligation.ref}`,
        goalRef: `goal:${episode.sampleId}`,
        skillRef: RELATION_OBSERVE_SKILL_REF,
        candidateKind: "action",
        optionSemantics: "observe",
        arguments: projected.arguments,
        targetRef: obligation.ref,
        bindingProjection: null,
        edgeRef: null,
        parameterProjection: [],
        evidenceRefs: episode.evidenceRefs,
      });
    }
  }
  const hasLegalObservation =
    cursor.state !== "closed"
    || observeObligations.length > 0
    || advanceTargetRefs.length > 0;
  skills.push(relationControlSkill());
  const controlOption = hasLegalObservation || hasUnknownQualificationGap ? "DEFER" : "RETURN";
  const controlCandidateRef = `c:${controlOption.toLowerCase()}`;
  candidates.push({
    candidateRef: controlCandidateRef,
    goalRef: `goal:${episode.sampleId}`,
    skillRef: RELATION_CONTROL_SKILL_REF,
    candidateKind: "control",
    optionSemantics: controlOption,
    arguments: [],
    targetRef: null,
    bindingProjection: null,
    edgeRef: null,
    parameterProjection: [],
    evidenceRefs: episode.evidenceRefs,
  });
  if (episode.requestedDeclaration == null) {
    missingProjections.push({
      targetRef: episode.targetRef,
      fieldRef: "goal.requestedDeclaration",
      state: "missing",
      reason: "observation_failed",
      evidenceRefs: episode.evidenceRefs,
    });
  }
  const previous = episode.previousExecution;
  const action = previousAction(previous);
  if (previous !== undefined && previous.state === "not_observed") {
    missingProjections.push({
      targetRef: pendingRelationRef,
      fieldRef: "previousExecution",
      state: "not_observed",
      reason: "not_requested",
      evidenceRefs: episode.evidenceRefs,
    });
  }
  if (
    episode.currentRelation !== undefined
    && episode.currentRelation !== null
    && (episode.currentRelation.binding.state === "missing"
      || episode.currentRelation.binding.state === "not_observed")
  ) {
    missingProjections.push({
      targetRef: pendingRelationRef,
      fieldRef: "currentRelation.binding",
      state: episode.currentRelation.binding.state,
      reason: episode.currentRelation.binding.reason ?? "not_requested",
      evidenceRefs: episode.currentRelation.binding.evidenceRefs,
    });
  }
  const obligationProjections = obligations.map(obligation =>
    obligationProjection(obligation, pendingRelationRef, episode.evidenceRefs)
  );
  return {
    contextId: relationContextId(episode.sampleId, episode.stepId),
    requestRef: episode.requestId,
    stepId: episode.stepId,
    route: { domain: "tsjs", decisionKind: "R" },
    goal: {
      goalRef: `goal:${episode.sampleId}`,
      kind: "verify",
      targetRef: episode.targetRef as string,
      requestedDeclaration: episode.requestedDeclaration ?? null,
      satisfactionThreshold: { state: "not_observed", evidenceRefs: [] },
      constraints: [],
    },
    state: {
      stateRef: `state:${episode.sampleId}`,
      revision: 1,
      facts,
      objectRefs: [episode.entryFile],
      evidence: episode.evidenceRefs.map(ref => evidence(ref)),
      conflicts: [],
    },
    action,
    evaluation: { conditionStates: [], gaps: [] },
    skills,
    candidateGroup: {
      candidateGroupRef: relationCandidateGroupRef(episode.sampleId, episode.stepId),
      count: candidates.length,
      enumeration: resolveEnumeration(episode, cursor.state),
      candidates,
    },
    executionPolicy: {
      remainingBudget: { state: "not_observed", evidenceRefs: [] },
      allowedEffects: ["read_only"],
      authorizationRevision: 1,
    },
    missingProjections,
    bindingProjections: observedDeclarations.map(declaration =>
      declarationProjection(declaration, callSiteRef)
    ),
    bindingEdges: observedBindings,
    currentRelation: currentRelationProjection(episode),
    ...(episode.relationshipProjection === undefined ? {} : { relationshipProjection: episode.relationshipProjection }),
    remainingObligations: obligationProjections,
    ...(previous === undefined ? {} : { previousExecution: previous }),
    localCandidateCursor: cursor,
    inputSchema: UNIFIED_INPUT_SCHEMA,
  };
}
