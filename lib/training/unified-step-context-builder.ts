// Typed StepContext builder for one corpus decision step.
//
// This is the student-side observation source: it consumes only the source-level
// episode record (facts, entry file, goal target, route) and never reads gold,
// teacher resolution, or final call edges. The encoder consumes the returned
// StepContext, so every student feature stays derived from observation alone.

import type {
  Candidate,
  EvidenceProjection,
  StepContext,
  MissingProjection,
} from "./unified-encoder.js";
import { UNIFIED_INPUT_SCHEMA } from "./unified-encoder.js";

export const RELATION_SKILL_REF = "skill:relation.judge";
export const RELATION_SKILL_KEY = "relation.judge";
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
  const candidates: Candidate[] = ["judge=true", "judge=false", "judge=unknown"].map(judge => ({
    candidateRef: `c:${judge.replace("=", ":")}`,
    goalRef: `goal:${episode.sampleId}`,
    skillRef: RELATION_SKILL_REF,
    candidateKind: "relation" as const,
    optionSemantics: judge,
    arguments: [
      { name: "target", type: "declaration", valueRef: episode.targetRef as string | null },
    ],
    targetRef: episode.targetRef as string | null,
    bindingProjection: null,
    edgeRef: null,
    parameterProjection: [] as readonly MissingProjection[],
    evidenceRefs: episode.evidenceRefs,
  }));
  return {
    contextId: relationContextId(episode.sampleId, episode.stepId),
    requestRef: episode.requestId,
    stepId: episode.stepId,
    route: { domain: "tsjs", decisionKind: "R" },
    goal: {
      goalRef: `goal:${episode.sampleId}`,
      kind: "verify",
      targetRef: episode.targetRef as string,
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
    skills: [
      {
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
      },
    ],
    candidateGroup: {
      candidateGroupRef: relationCandidateGroupRef(episode.sampleId, episode.stepId),
      count: candidates.length,
      enumeration: "complete",
      candidates,
    },
    executionPolicy: {
      remainingBudget: { state: "not_observed", evidenceRefs: [] },
      allowedEffects: ["read_only"],
      authorizationRevision: 1,
    },
    missingProjections: [],
    bindingProjections: [],
    bindingEdges: [],
    inputSchema: UNIFIED_INPUT_SCHEMA,
  };
}
