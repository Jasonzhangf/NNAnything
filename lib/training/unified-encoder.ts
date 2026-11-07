export type Ref = string;
export type EvidenceRef = string;

export type MissingReason =
  | "not_requested"
  | "observation_failed"
  | "oracle_unavailable"
  | "contract_mismatch"
  | "candidate_enumeration_failed"
  | "candidate_truncated"
  | "unsupported_pattern"
  | "dynamic_undecidable";

export interface Observed<T> {
  readonly state: "known" | "missing" | "conflicting" | "not_observed" | "unsupported";
  readonly value?: T;
  readonly reason?: MissingReason;
  readonly valueRefs?: readonly Ref[];
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface EvidenceProjection {
  readonly evidenceRef: EvidenceRef;
  readonly typeStep: "syntax" | "scope" | "type" | "binding" | "receipt" | "model_judgment";
  readonly scopeRef: Ref | null;
  readonly observedRevision: number;
  readonly resultRef: Ref | null;
}

export interface SkillDescriptor {
  readonly skillRef: Ref;
  readonly skillKey: string;
  readonly contractVersion: string;
  readonly semanticClass: "observe" | "read" | "locate" | "change" | "verify" | "return_control";
  readonly parameterSchema: {
    readonly schemaVersion: string;
    readonly parameters: readonly {
      readonly name: string;
      readonly type: string;
      readonly required: boolean;
      readonly allowedTargetKinds: readonly string[];
      readonly cardinality: "one" | "many";
    }[];
  };
  readonly capabilities: readonly string[];
  readonly effects: readonly ("read_only" | "reversible" | "external" | "control")[];
  readonly executorRef: Ref;
  readonly ordering: "unordered" | "ordered";
}

export interface MissingProjection {
  readonly targetRef: Ref;
  readonly fieldRef: string;
  readonly state: "known" | "missing" | "conflicting" | "not_observed" | "unsupported";
  readonly reason: MissingReason | null;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface DeclarationIdentity {
  readonly declarationRef: Ref;
  readonly moduleRef: Ref | null;
  readonly name: string;
  readonly role: "import" | "export" | "local" | "shadow" | "member" | "unspecified";
  readonly kind: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface BindingProjection {
  readonly symbolRef: Ref;
  readonly callSiteRef: Ref | null;
  readonly role: "import" | "export" | "local" | "shadow" | "member" | "unspecified";
  readonly bindingMode: "bound" | "unbound" | "ambiguous" | "dynamic";
  readonly resolution:
    | { readonly status: "resolved"; readonly declarationRef: Ref; readonly moduleRef: Ref | null; readonly evidenceRefs: readonly EvidenceRef[] }
    | { readonly status: "ambiguous"; readonly declarationRefs: readonly Ref[]; readonly evidenceRefs: readonly EvidenceRef[] }
    | { readonly status: "unresolved"; readonly reason: MissingReason; readonly evidenceRefs: readonly EvidenceRef[] }
    | { readonly status: "dynamic"; readonly reason: MissingReason; readonly evidenceRefs: readonly EvidenceRef[] };
  readonly declarationRefs: readonly DeclarationIdentity[];
  readonly scopeRef: Ref | null;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export type InformationGainValue =
  | "advances_chain"
  | "resolves_target"
  | "none";

export interface CurrentRelationProjection {
  readonly pendingRelationRef: Ref;
  readonly callSiteRef: Ref;
  readonly binding: Observed<BindingProjection>;
}

// Shared value-flow relationship projection (Stage A accepted contract).
// Every field is a typed Observed over the adapter's raw local facts only;
// gold, analyzer truth, and future receipts never populate these values.
export type RelationKind =
  | "not_applicable"
  | "reaching_def"
  | "local_init"
  | "local_assign"
  | "destructure_extract"
  | "arg_to_param"
  | "return_from_fn"
  | "return_to_call_lhs";

export type BindingResolutionCode =
  | "not_applicable"
  | "unresolved"
  | "same_callee"
  | "different_callee"
  | "ambiguous_dynamic";

// Source/sink role classification indices for the shared value-flow projection.
// Source roles: 0=unknown, 1=definition/write, 2=argument, 3=return, 4=other.
// Sink roles: 0=unknown, 1=read, 2=parameter, 3=assignment_target, 4=other.
// The accepted double-argument slice only accepts ordinal 0/1.
export interface RoleAndOrdinalValue {
  readonly roleIndex: number;
  readonly ordinalIndex: number;
}

export interface OrderFlowAndCoverageValue {
  // 0=undetermined, 1..9 per the accepted order-flow table.
  readonly orderFlowIndex: number;
  // 0=missing, 1=partial, 2=complete, 3=not_applicable.
  readonly coverageIndex: number;
}

export interface RelationshipProjection {
  readonly relationKind: Observed<RelationKind>;
  readonly sourceSiteRef: Observed<Ref>;
  readonly sinkSiteRef: Observed<Ref>;
  readonly sourceRoleAndOrdinal: Observed<RoleAndOrdinalValue>;
  readonly sinkRoleAndOrdinal: Observed<RoleAndOrdinalValue>;
  readonly orderFlowAndCoverage: Observed<OrderFlowAndCoverageValue>;
  readonly bindingResolution: Observed<BindingResolutionCode>;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface RemainingObligationProjection {
  readonly kind: "observe" | "advance";
  readonly ref: Ref;
  readonly pendingRelationRef: Ref;
  readonly skillRef: Ref;
  readonly arguments: readonly {
    readonly name: string;
    readonly type: string;
    readonly valueRef: Ref | null;
  }[];
  readonly informationGain: Observed<InformationGainValue>;
  readonly informationGainExplanation?: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface PreviousExecutionProjection {
  readonly actionRef: Ref;
  readonly receiptRef: Ref | null;
  readonly origin: "source_observation" | "model_execution";
  readonly fromStepId: string | null;
  readonly pendingRelationRef: Ref;
  readonly optionSemantics: "observe" | "advance";
  readonly targetRef: Ref;
  readonly outcome: "success" | "partial" | "failed" | "unknown";
}

export interface LocalCandidateCursorProjection {
  readonly pendingRelationRef: Ref;
  readonly state: "closed" | "open" | "failed";
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface BindingEdge {
  readonly edgeRef: Ref;
  readonly callSiteRef: Ref | null;
  readonly fromNodeRef: Ref;
  readonly edgeKind: "import" | "re_export" | "local" | "member" | "shadow";
  readonly sourceName: string;
  readonly sourceModule: Observed<Ref>;
  readonly targetName: string;
  readonly targetModule: Observed<Ref>;
  readonly moduleSpecifierRaw: string | null;
  readonly sourceContent: {
    readonly state: "not_requested" | "observed" | "failed" | "truncated" | "unsupported" | "conflicting";
    readonly resultRefs: readonly Ref[];
    readonly reason: MissingReason | null;
    readonly evidenceRefs: readonly EvidenceRef[];
  };
  readonly visibility: Observed<"reachable" | "shadowed" | "unknown">;
  readonly hopDepth: number;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface Candidate {
  readonly candidateRef: Ref;
  readonly goalRef: Ref;
  readonly skillRef: Ref;
  readonly candidateKind: "relation" | "decomposition" | "condition" | "action" | "control";
  readonly optionSemantics: string;
  readonly arguments: readonly { readonly name: string; readonly type: string; readonly valueRef: Ref | null }[];
  readonly targetRef: Ref | null;
  readonly bindingProjection: BindingProjection | null;
  readonly edgeRef: Ref | null;
  readonly parameterProjection: readonly MissingProjection[];
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface CandidateGroup {
  readonly candidateGroupRef: Ref;
  readonly count: number;
  readonly enumeration: "complete" | "truncated" | "enumeration_failed";
  readonly candidates: readonly Candidate[];
}

export interface StepContext {
  readonly contextId: Ref;
  readonly requestRef: Ref;
  readonly stepId: string;
  readonly route: { readonly domain: string; readonly decisionKind: "R" | "D" | "E" | "A" };
  readonly goal: {
    readonly goalRef: Ref;
    readonly kind: "acquire" | "change" | "verify" | "complete";
    readonly targetRef: Ref;
    readonly requestedDeclaration?: DeclarationIdentity | null;
    readonly satisfactionThreshold: Observed<number>;
    readonly constraints: readonly Ref[];
  };
  readonly state: {
    readonly stateRef: Ref;
    readonly revision: number;
    readonly facts: readonly {
      readonly factRef: Ref;
      readonly predicateRef: Ref;
      readonly value: Observed<Ref>;
      readonly evidence: readonly EvidenceProjection[];
    }[];
    readonly objectRefs: readonly Ref[];
    readonly evidence: readonly EvidenceProjection[];
    readonly conflicts: readonly Ref[];
  };
  readonly action: {
    readonly previousActionRef: Ref | null;
    readonly receiptRef: Ref | null;
    readonly outcome: "none" | "success" | "partial" | "failed" | "unknown";
  };
  readonly evaluation: {
    readonly conditionStates: readonly {
      readonly conditionRef: Ref;
      readonly state: "satisfied" | "unsatisfied" | "unknown" | "not_applicable";
      readonly evidence: readonly EvidenceProjection[];
    }[];
    readonly gaps: readonly Ref[];
  };
  readonly skills: readonly SkillDescriptor[];
  readonly candidateGroup: CandidateGroup;
  readonly executionPolicy: {
    readonly remainingBudget: Observed<number>;
    readonly allowedEffects: readonly ("read_only" | "reversible" | "external" | "control")[];
    readonly authorizationRevision: number;
  };
  readonly missingProjections: readonly MissingProjection[];
  readonly bindingProjections: readonly BindingProjection[];
  readonly bindingEdges: readonly BindingEdge[];
  readonly currentRelation?: CurrentRelationProjection | null;
  readonly relationshipProjection?: RelationshipProjection | null;
  readonly remainingObligations?: readonly RemainingObligationProjection[];
  readonly previousExecution?: Observed<PreviousExecutionProjection | null>;
  readonly localCandidateCursor?: LocalCandidateCursorProjection;
  readonly inputSchema: "nnanything.unified-step.v1";
}

export interface FeatureThresholds {
  readonly schema: "nnanything.feature-thresholds.v1";
  readonly route: string;
  readonly encoderVersion: string;
  readonly buckets: Record<string, readonly number[]>;
}

export interface EncoderMissingMode {
  readonly block: "G0" | "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7";
  readonly fieldRef: string;
  readonly reason: MissingReason;
  readonly slotIndex: number;
  readonly fill: -1;
}

export interface EncoderResult {
  readonly candidateRef: Ref;
  readonly vector: readonly number[];
  readonly missingMode: readonly EncoderMissingMode[];
}

export const UNIFIED_ENCODER_VERSION = "nnanything.unified-step.encoder.v2";
export const UNIFIED_INPUT_SCHEMA = "nnanything.unified-step.v1";

const DEFAULT_THRESHOLDS: Record<string, readonly number[]> = Object.freeze({
  constraints: Object.freeze([0, 1, 2, 4]),
  knownFacts: Object.freeze([1, 2, 4, 8]),
  missingFacts: Object.freeze([0, 1, 2, 4]),
  objectRefs: Object.freeze([1, 2, 4, 8]),
  requiredArgsRatio: Object.freeze([0, 0.25, 0.5, 1]),
  requiredMissing: Object.freeze([0, 1, 2, 4]),
});

export function defaultThresholds(): FeatureThresholds {
  return {
    schema: "nnanything.feature-thresholds.v1",
    route: "r",
    encoderVersion: UNIFIED_ENCODER_VERSION,
    buckets: DEFAULT_THRESHOLDS,
  };
}

export function bucket(value: number, thresholds: readonly number[]): number {
  if (!Number.isFinite(value)) throw new TypeError("bucket value must be finite");
  if (thresholds.length !== 4) throw new TypeError("thresholds must have 4 entries");
  const t0 = thresholds[0];
  const t1 = thresholds[1];
  const t2 = thresholds[2];
  const t3 = thresholds[3];
  if (t0 === undefined || t1 === undefined || t2 === undefined || t3 === undefined) {
    throw new TypeError("thresholds entries must be defined");
  }
  if (value <= t0) return 0;
  if (value <= t1) return 0.25;
  if (value <= t2) return 0.5;
  if (value <= t3) return 0.75;
  return 1;
}

function missingClassValue(reason: MissingReason | null | undefined): number {
  if (!reason) return 0;
  switch (reason) {
    case "unsupported_pattern":
    case "dynamic_undecidable":
      return 1;
    case "candidate_enumeration_failed":
    case "contract_mismatch":
      return 0.75;
    case "oracle_unavailable":
      return 0.5;
    case "observation_failed":
    case "not_requested":
      return 0.25;
    case "candidate_truncated":
      return 0;
  }
}

function isKnown<T>(v: Observed<T>): boolean {
  return v.state === "known";
}

function findEdge(context: StepContext, candidate: Candidate): BindingEdge | null {
  if (!candidate.edgeRef) return null;
  return context.bindingEdges.find(e => e.edgeRef === candidate.edgeRef) ?? null;
}

function currentDeclaration(candidate: Candidate): DeclarationIdentity | null {
  const projection = candidate.bindingProjection;
  if (!projection || projection.resolution.status !== "resolved") return null;
  const resolution = projection.resolution;
  const matches = projection.declarationRefs.filter(
    declaration => declaration.declarationRef === resolution.declarationRef,
  );
  if (matches.length !== 1) {
    throw new Error(
      `DATA_INVALID: resolved declarationRef ${resolution.declarationRef} must match exactly one observed declaration`,
    );
  }
  const declaration = matches[0];
  if (declaration === undefined) {
    throw new Error(
      `DATA_INVALID: resolved declarationRef ${resolution.declarationRef} is missing from observed declarations`,
    );
  }
  if (
    resolution.moduleRef !== null
    && declaration.moduleRef !== null
    && resolution.moduleRef !== declaration.moduleRef
  ) {
    throw new Error(
      `DATA_INVALID: resolved declaration moduleRef ${resolution.moduleRef} conflicts with observed moduleRef ${declaration.moduleRef}`,
    );
  }
  return declaration;
}

function symbolPart(ref: Ref): string | null {
  const hash = ref.lastIndexOf("#");
  if (hash < 0) return null;
  const fragment = ref.slice(hash + 1);
  const colon = fragment.lastIndexOf(":");
  return colon >= 0 ? fragment.slice(colon + 1) : fragment;
}

const RELATION_KIND_CODE: Readonly<Record<RelationKind, number>> = Object.freeze({
  not_applicable: 0,
  reaching_def: 1 / 7,
  local_init: 2 / 7,
  local_assign: 3 / 7,
  destructure_extract: 4 / 7,
  arg_to_param: 5 / 7,
  return_from_fn: 6 / 7,
  return_to_call_lhs: 7 / 7,
});

const BINDING_RESOLUTION_CODE: Readonly<Record<BindingResolutionCode, number>> = Object.freeze({
  not_applicable: 0,
  unresolved: 0.25,
  same_callee: 0.5,
  different_callee: 0.75,
  ambiguous_dynamic: 1,
});

interface ProjectionEncode {
  readonly slot: number;
  readonly block: EncoderMissingMode["block"];
  readonly fieldRef: string;
  readonly value: number;
  readonly reason: MissingReason | null;
}

// Map a typed Observed projection field to either a real slot value or a
// missing-mode declaration per the accepted Stage A state table. Unsupported
// control flow keeps its legal value and does not generate a missingMode entry;
// the reject reason stays on the original Observed admissibility record.
function encodeProjectionSlot<T>(
  slot: number,
  block: EncoderMissingMode["block"],
  fieldRef: string,
  value: Observed<T>,
  code: (v: T) => number,
): ProjectionEncode {
  if (value.state === "known") {
    if (value.value === undefined) {
      throw new TypeError(`${fieldRef} must have a value when state is known`);
    }
    const v = code(value.value);
    if (v === -1) {
      return { slot, block, fieldRef, value: -1, reason: "unsupported_pattern" };
    }
    return { slot, block, fieldRef, value: v, reason: null };
  }
  // Unsupported control flow may retain a legal value (e.g. x[51] orderFlow 0);
  // a true whole-field unsupported falls through to the missing path.
  if (value.state === "unsupported" && value.value !== undefined) {
    const v = code(value.value);
    if (v === -1) {
      // Out-of-slice enum with no legal value: -1 plus declared unsupported reason.
      return { slot, block, fieldRef, value: -1, reason: value.reason ?? "unsupported_pattern" };
    }
    return { slot, block, fieldRef, value: code(value.value), reason: null };
  }
  const reason: MissingReason = value.reason
    ?? (value.state === "conflicting" ? "contract_mismatch" : "not_requested");
  return { slot, block, fieldRef, value: -1, reason };
}

interface RelationshipSlotResult {
  readonly relationKind: number;
  readonly sourceRole: number;
  readonly sinkRole: number;
  readonly orderFlow: number;
  readonly binding: number;
}

function encodeRelationshipProjection(
  projection: RelationshipProjection,
  missingMode: EncoderMissingMode[],
): RelationshipSlotResult {
  const relationKind = encodeProjectionSlot(15, "G1", "x[15].relationKind", projection.relationKind, k => RELATION_KIND_CODE[k]);
  const sourceRole = encodeProjectionSlot(23, "G2", "x[23].sourceRoleAndOrdinal", projection.sourceRoleAndOrdinal,
    ({ roleIndex, ordinalIndex }) => (ordinalIndex < 0 || ordinalIndex > 1 ? -1 : (roleIndex * 4 + ordinalIndex) / 19),
  );
  const sinkRole = encodeProjectionSlot(31, "G3", "x[31].sinkRoleAndOrdinal", projection.sinkRoleAndOrdinal,
    ({ roleIndex, ordinalIndex }) => (ordinalIndex < 0 || ordinalIndex > 1 ? -1 : (roleIndex * 4 + ordinalIndex) / 19),
  );
  const orderFlow = encodeProjectionSlot(
    51,
    "G6",
    "x[51].orderFlowAndCoverage",
    projection.orderFlowAndCoverage,
    ({ orderFlowIndex, coverageIndex }) =>
      (orderFlowIndex < 0 || orderFlowIndex > 9 || coverageIndex < 0 || coverageIndex > 3
        ? -1
        : (orderFlowIndex * 4 + coverageIndex) / 39),
  );
  const binding = encodeProjectionSlot(55, "G6", "x[55].bindingResolution", projection.bindingResolution, c => BINDING_RESOLUTION_CODE[c]);

  for (const e of [relationKind, sourceRole, sinkRole, orderFlow, binding]) {
    if (e.value === -1) {
      const reason: MissingReason = e.reason ?? "not_requested";
      missingMode.push({ block: e.block, fieldRef: e.fieldRef, reason, slotIndex: e.slot, fill: -1 });
    }
  }

  return {
    relationKind: relationKind.value,
    sourceRole: sourceRole.value,
    sinkRole: sinkRole.value,
    orderFlow: orderFlow.value,
    binding: binding.value,
  };
}

export function encodeUnifiedCandidate(
  context: StepContext,
  candidate: Candidate,
  thresholds: FeatureThresholds = defaultThresholds(),
): EncoderResult {
  if (context.inputSchema !== UNIFIED_INPUT_SCHEMA) {
    throw new TypeError("unified encoder requires nnanything.unified-step.v1 input");
  }
  if (context.candidateGroup.enumeration !== "complete") {
    throw new Error("candidate group must be complete before encoding");
  }

  const x = new Array<number>(64).fill(0);
  const missingMode: EncoderMissingMode[] = [];
  const relationshipSlots = context.relationshipProjection
    ? encodeRelationshipProjection(context.relationshipProjection, missingMode)
    : null;
  const isJudge = candidate.optionSemantics.startsWith("judge=");
  const requested = context.goal.requestedDeclaration ?? null;

  // G0 Goal
  x[0] = context.goal.kind === "acquire" ? 1 : 0;
  x[1] = context.goal.kind === "change" ? 1 : 0;
  x[2] = context.goal.kind === "verify" ? 1 : 0;
  x[3] = context.goal.kind === "complete" ? 1 : 0;
  x[4] = context.goal.targetRef.length > 0 ? 1 : 0;
  x[5] = isKnown(context.goal.satisfactionThreshold) ? 1 : 0;
  x[6] = bucket(context.goal.constraints.length, thresholds.buckets.constraints ?? [0, 1, 2, 4]);
  const goalMissing = context.goal.satisfactionThreshold.state !== "known"
    ? context.goal.satisfactionThreshold
    : null;
  x[7] = goalMissing ? missingClassValue(goalMissing.reason) : 0;

  // G1 State
  x[8] = bucket(context.state.facts.length, thresholds.buckets.knownFacts ?? [1, 2, 4, 8]);
  const missingFactCount = context.state.facts.filter(f => f.value.state !== "known").length;
  x[9] = bucket(missingFactCount, thresholds.buckets.missingFacts ?? [0, 1, 2, 4]);
  x[10] = context.state.conflicts.length > 0 ? 1 : 0;
  x[11] = context.state.evidence.length > 0 ? 1 : 0;
  x[12] = bucket(context.state.objectRefs.length, thresholds.buckets.objectRefs ?? [1, 2, 4, 8]);
  x[13] = 1;
  const skill = context.skills.find(s => s.skillRef === candidate.skillRef) ?? null;
  const edge = findEdge(context, candidate);
  const decl = currentDeclaration(candidate);
  const ambiguousDeclarationRefs = candidate.bindingProjection?.resolution.status === "ambiguous"
    ? candidate.bindingProjection.resolution.declarationRefs
    : [];
  const observedDeclarationCarrier = decl !== null || ambiguousDeclarationRefs.length !== 0;
  const targetSymbol = symbolPart(context.goal.targetRef) ?? "";
  const requestedKind = requested?.kind ?? null;
  const currentKind = decl?.kind ?? null;
  x[14] = skill !== null && requestedKind !== null
    ? (skill.parameterSchema.parameters.some(p => p.allowedTargetKinds.includes(requestedKind)) ? 1 : 0)
    : 0;
  x[15] = relationshipSlots?.relationKind ?? 0;

  // G2 Action/Evaluation
  x[16] = context.action.previousActionRef !== null ? 1 : 0;
  x[17] = context.action.receiptRef !== null ? 1 : 0;
  x[18] = context.action.outcome === "success" ? 1 : 0;
  x[19] = context.action.outcome === "partial" ? 1 : 0;
  x[20] = context.action.outcome === "failed" ? 1 : 0;
  x[21] = context.action.outcome === "unknown" ? 1 : 0;
  x[22] = context.evaluation.conditionStates.some(c => c.state === "satisfied") ? 1 : 0;
  x[23] = relationshipSlots?.sourceRole ?? 0;

  // G3 Skill
  // Terminal judge is an independent judgment family, not a skill (v0.9 §3.2):
  // its semanticClass slots stay 0, but executor/contract readiness (slot30) still
  // comes from the referenced SkillDescriptor.
  if (skill && !isJudge) {
    x[24] = skill.semanticClass === "observe" ? 1 : 0;
    x[25] = skill.semanticClass === "read" ? 1 : 0;
    x[26] = skill.semanticClass === "locate" ? 1 : 0;
    x[27] = skill.semanticClass === "change" ? 1 : 0;
    x[28] = skill.semanticClass === "verify" ? 1 : 0;
    x[29] = skill.semanticClass === "return_control" ? 1 : 0;
  }
  if (skill) {
    x[30] = skill.executorRef && skill.contractVersion ? 1 : 0;
  }
  x[31] = relationshipSlots?.sinkRole ?? 0;

  // G4 Binding/parameters
  const required = skill?.parameterSchema.parameters.filter(p => p.required) ?? [];
  const bound = required.filter(p => candidate.arguments.some(a => a.name === p.name && a.valueRef !== null));
  const ratio = required.length > 0 ? bound.length / required.length : 1;
  x[32] = bucket(ratio, thresholds.buckets.requiredArgsRatio ?? [0, 0.25, 0.5, 1]);
  const missingRequired = required.length - bound.length;
  x[33] = bucket(missingRequired, thresholds.buckets.requiredMissing ?? [0, 1, 2, 4]);
  x[34] = candidate.arguments.some(a => {
    const schema = skill?.parameterSchema.parameters.find(p => p.name === a.name);
    return schema !== undefined && a.type !== schema.type;
  }) ? 1 : 0;
  x[35] = required.length > 0 && missingRequired === 0 ? 1 : 0;
  x[36] = candidate.optionSemantics === "judge=true" ? 1 : 0;
  x[37] = candidate.optionSemantics === "judge=false" ? 1 : 0;
  x[38] = candidate.optionSemantics === "judge=unknown" ? 1 : 0;
  x[39] = missingRequired > 0 ? 0.75 : 0;

  // G5 Semantic
  x[40] = skill !== null && skill.effects.some(e => context.executionPolicy.allowedEffects.includes(e)) ? 1 : 0;
  x[41] = skill !== null && currentKind !== null
    ? (skill.parameterSchema.parameters.some(p => p.allowedTargetKinds.includes(currentKind)) ? 1 : 0)
    : 0;
  x[42] = skill !== null && candidate.arguments.every(a => {
    const p = skill.parameterSchema.parameters.find(sp => sp.name === a.name);
    return p === undefined || p.type === a.type;
  }) ? 1 : 0;
  x[43] = candidate.evidenceRefs.length > 0 ? 1 : 0;
  if (isJudge) {
    x[44] = observedDeclarationCarrier ? 1 : 0;
    x[45] = decl !== null && requested !== null ? (decl.name === requested.name ? 1 : 0) : -1;
    x[46] = decl !== null && requested !== null ? (decl.kind === requested.kind ? 1 : 0) : -1;
    x[47] = decl !== null && requested !== null ? 0 : 0.5;
  } else if (candidate.optionSemantics === "advance") {
    x[44] = edge !== null && edge.visibility.state === "known" && edge.visibility.value === "reachable" ? 1 : 0;
    x[45] = edge !== null
      ? (edge.sourceName === targetSymbol && edge.targetName === targetSymbol ? 1 : 0)
      : -1;
    x[46] = -1;
    x[47] = 0.5;
  } else {
    x[44] = -1;
    x[45] = -1;
    x[46] = -1;
    x[47] = 0.75;
  }

  // G6 Control
  x[48] = candidate.optionSemantics === "NOOP" ? 1 : 0;
  x[49] = candidate.optionSemantics === "RETURN" ? 1 : 0;
  x[50] = candidate.optionSemantics === "NO_CAPABILITY" ? 1 : 0;
  x[51] = relationshipSlots?.orderFlow ?? 3 / 39;
  x[52] = candidate.candidateKind === "control" ? 1 : 0;
  x[53] = candidate.candidateKind === "action" ? 1 : 0;
  x[54] = skill !== null && candidate.parameterProjection.length === 0 ? 1 : 0;
  x[55] = relationshipSlots?.binding ?? 0;

  // G7 Route/Terminal Identity
  const route = context.route.decisionKind;
  x[56] = route === "R" ? 1 : 0;
  x[57] = route === "D" ? 1 : 0;
  x[58] = route === "E" ? 1 : 0;
  x[59] = route === "A" ? 1 : 0;
  if (isJudge) {
    x[60] = decl !== null ? 1 : 0;
    if (decl === null || requested === null) {
      x[61] = -1;
      x[62] = -1;
      x[63] = 0.5;
    } else {
      x[61] = requested.moduleRef !== null && decl.moduleRef !== null
        ? (decl.moduleRef === requested.moduleRef ? 1 : 0)
        : -1;
      x[62] = requested.declarationRef !== null && decl.declarationRef !== null
        ? (decl.declarationRef === requested.declarationRef ? 1 : 0)
        : -1;
      x[63] = 0;
    }
  } else {
    x[60] = 0;
    x[61] = -1;
    x[62] = -1;
    x[63] = 0.5;
  }

  return {
    candidateRef: candidate.candidateRef,
    vector: Object.freeze(x),
    missingMode: Object.freeze(missingMode),
  };
}

export function encodeUnifiedCandidateGroup(
  context: StepContext,
  thresholds: FeatureThresholds = defaultThresholds(),
): readonly EncoderResult[] {
  if (context.candidateGroup.enumeration !== "complete") {
    throw new Error("candidate group must be complete before encoding");
  }
  return context.candidateGroup.candidates.map(c => encodeUnifiedCandidate(context, c, thresholds));
}
