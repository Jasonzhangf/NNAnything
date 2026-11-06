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
  DeclarationIdentity,
  EvidenceProjection,
  SkillDescriptor,
  StepContext,
  MissingProjection,
} from "./unified-encoder.js";
import { UNIFIED_INPUT_SCHEMA } from "./unified-encoder.js";

export const RELATION_SKILL_REF = "skill:relation.judge";
export const RELATION_SKILL_KEY = "relation.judge";
export const RELATION_OBSERVE_SKILL_REF = "skill:relation.observe";
export const RELATION_READ_SKILL_REF = "skill:relation.read";
export const RELATION_CONTROL_SKILL_REF = "skill:relation.control";
export const DEFAULT_RELATION_STEP_ID = "step:0";

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
  readonly pendingRelationRef?: string | null;
  readonly callSiteRef?: string | null;
  readonly calleeName?: string | null;
  readonly requestedDeclaration?: DeclarationIdentity | null;
  readonly observedBindings?: readonly BindingEdge[];
  readonly observedDeclarations?: readonly DeclarationIdentity[];
  readonly remainingObligations?: readonly {
    readonly kind: "observe" | "advance";
    readonly ref: string;
    readonly informationGain: number;
  }[];
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

function resolveEnumeration(
  episode: RelationStepEpisode,
): "complete" | "truncated" | "enumeration_failed" {
  if (episode.enumerationFailure === true || episode.failureMode === "candidate_enumeration_failed") {
    return "enumeration_failed";
  }
  if (episode.cursorOpen === true || episode.failureMode === "candidate_truncated") {
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
  const firstDeclaration = observedDeclarations[0] ?? null;
  const firstProjection = firstDeclaration
    ? declarationProjection(firstDeclaration, callSiteRef)
    : null;
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
  const advanceTargetRefs = reachableEdges.map(edge => edge.edgeRef);
  const knownAdvanceTargetRefs = new Set(advanceTargetRefs);
  for (const obligation of obligations) {
    if (obligation.kind !== "advance" || obligation.informationGain <= 0) continue;
    if (knownAdvanceTargetRefs.has(obligation.ref)) continue;
    advanceTargetRefs.push(obligation.ref);
    knownAdvanceTargetRefs.add(obligation.ref);
  }
  if (advanceTargetRefs.length > 0) {
    skills.push(relationReadSkill());
  }
  for (const targetRef of advanceTargetRefs) {
    const matchingEdge = reachableEdges.find(edge => edge.edgeRef === targetRef) ?? null;
    candidates.push({
      candidateRef: `c:advance:${targetRef}`,
      goalRef: `goal:${episode.sampleId}`,
      skillRef: RELATION_READ_SKILL_REF,
      candidateKind: "action",
      optionSemantics: "advance",
      arguments: [{ name: "target", type: "binding_edge", valueRef: targetRef }],
      targetRef,
      bindingProjection: null,
      edgeRef: matchingEdge?.edgeRef ?? null,
      parameterProjection: [],
      evidenceRefs: episode.evidenceRefs,
    });
  }
  const observeObligations = obligations.filter(obligation =>
    obligation.kind === "observe" && obligation.informationGain > 0
  );
  if (observeObligations.length > 0) {
    skills.push(relationObserveSkill());
    for (const obligation of observeObligations) {
      candidates.push({
        candidateRef: `c:observe:${obligation.ref}`,
        goalRef: `goal:${episode.sampleId}`,
        skillRef: RELATION_OBSERVE_SKILL_REF,
        candidateKind: "action",
        optionSemantics: "observe",
        arguments: [{
          name: "target",
          type: "call_site",
          valueRef: callSiteRef ?? episode.entryFile,
        }],
        targetRef: obligation.ref,
        bindingProjection: null,
        edgeRef: null,
        parameterProjection: [],
        evidenceRefs: episode.evidenceRefs,
      });
    }
  }
  const hasLegalObservation =
    episode.cursorOpen === true || observeObligations.length > 0 || advanceTargetRefs.length > 0;
  skills.push(relationControlSkill());
  candidates.push({
    candidateRef: `c:control:${hasLegalObservation ? "DEFER" : "RETURN"}`,
    goalRef: `goal:${episode.sampleId}`,
    skillRef: RELATION_CONTROL_SKILL_REF,
    candidateKind: "control",
    optionSemantics: hasLegalObservation ? "DEFER" : "RETURN",
    arguments: [],
    targetRef: null,
    bindingProjection: null,
    edgeRef: null,
    parameterProjection: [],
    evidenceRefs: episode.evidenceRefs,
  });
  const missingProjections: MissingProjection[] = [];
  if (episode.requestedDeclaration == null) {
    missingProjections.push({
      targetRef: episode.targetRef,
      fieldRef: "goal.requestedDeclaration",
      state: "missing",
      reason: "observation_failed",
      evidenceRefs: episode.evidenceRefs,
    });
  }
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
    action: { previousActionRef: null, receiptRef: null, outcome: "none" },
    evaluation: { conditionStates: [], gaps: [] },
    skills,
    candidateGroup: {
      candidateGroupRef: relationCandidateGroupRef(episode.sampleId, episode.stepId),
      count: candidates.length,
      enumeration: resolveEnumeration(episode),
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
    inputSchema: UNIFIED_INPUT_SCHEMA,
  };
}
