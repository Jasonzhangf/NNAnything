import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { FeedbackInput, FeedbackProfile } from "./feedback-contract.js";
import type {
  BrowserSingleActionProfile,
  NativeClickInvocation,
  NativeClickReceipt,
  SingleActionControl,
  SingleActionEpisodeResult,
  SingleActionSnapshot,
} from "./single-action-contract.js";
import {
  readSingleActionSnapshot,
} from "./single-action-observation.js";
import type {
  BrowserExpansionStrategy,
  BrowserStrategyProfile,
  BrowserStrategyRequest,
  StrategyEffectProof,
  StrategyHistory,
  StrategyStepResources,
  StrategyStepResult,
} from "./strategy-contract.js";
import {
  predictBrowserStrategy,
  readBrowserStrategyRequest,
  validateBrowserStrategyProfile,
} from "../../filters/browser-strategy.js";
import {
  readFeedbackInput,
  validateFeedbackProfile,
} from "../../filters/browser-feedback.js";
import { validateBrowserSingleActionProfile } from "../../filters/browser-single-action-policy.js";
import type { NodeDefinition } from "../../core/contracts.js";
import { expectRecord } from "../../core/schema.js";
import {
  readBrowserSingleActionEpisodeResult,
} from "../../nodes/browser-single-action.js";
import {
  runBrowserStrategyStep,
} from "../../nodes/browser-strategy.js";
import {
  readAtomicReceipt,
  readRecursiveGoalInitialObservation,
  type AdapterDiagnostic,
  type AtomicEffectReceipt,
  type AtomicExecutionResult,
  type AtomicInput,
  type AtomicReceipt,
  type CollectionInput,
  type CleanupInput,
  type DerivationInput,
  type EnabledEvaluator,
  type EnabledSkill,
  type EvaluationInput,
  type EvaluationReceipt,
  type EvidenceRecord,
  type FactSnapshot,
  type ProgressReceipt,
  type ReceiptRef,
  type RecursiveGoalAdapter,
  type RecursiveGoalContinuation,
  type RecursiveGoalRequestEnvelope,
  type RecursiveGoalResponse,
  type RetryAssessment,
  type RetrySelectionView,
  type Selection,
  type SelectionInput,
  type StateRecord,
  type SupportsInput,
  type ValidatedRequest,
} from "../../workflow/recursive-goal/contracts.js";
import { runRecursiveGoal } from "../../workflow/recursive-goal/module.js";

export const BROWSER_STRATEGY_EVALUATOR_ID = "browser.strategy.set-expanded.v1";
export const BROWSER_STRATEGY_SELECTOR_ID = "browser.strategy.retry.selector.v1";
export const BROWSER_STRATEGY_NATIVE_SKILL_ID = "browser.expand.native";
export const BROWSER_STRATEGY_ROLE_SKILL_ID = "browser.expand.role";
export const BROWSER_STRATEGY_CAPABILITY = "browser.expand.selected";

export interface BrowserStrategyGoal {
  readonly kind: "SetExpanded";
  readonly regionRef: string;
  readonly desired: true;
}

export interface BrowserStrategyBindings {
  readonly documentRef: string;
  readonly scopeRef: string;
  readonly goalRegionRef: string;
  readonly equivalenceSetRef: string;
}

export interface BrowserStrategyState {
  readonly browser: SingleActionSnapshot;
  readonly history: readonly StrategyHistory[];
}

export interface BrowserStrategyEvidence {
  readonly kind: "browser.strategy.observed-fact.v1";
  readonly documentRef: string;
  readonly scopeRef: string;
  readonly observationId: string;
  readonly revision: number;
  readonly originalId: string;
  readonly source: string;
  readonly fact: unknown;
}

export type BrowserStrategyEffect =
  | {
      readonly kind: "browser.strategy.goal-region-expanded.v1";
      readonly strategyRef: string;
      readonly skillId: string;
      readonly targetRef: string;
      readonly regionRef: string;
      readonly observationId: string;
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly kind: "browser.strategy.native-effect-known.v1";
      readonly strategyRef: string;
      readonly skillId: string;
      readonly targetRef: string;
      readonly nativeSource: string;
      readonly evidenceRefs: readonly string[];
    };

export type BrowserStrategyCursor = null;
export type BrowserStrategyStepReceipt = StrategyStepResult;
export type BrowserStrategyGoalResponse = RecursiveGoalResponse<
  BrowserStrategyGoal,
  BrowserStrategyState,
  BrowserStrategyBindings,
  BrowserStrategyEvidence,
  BrowserStrategyEffect,
  BrowserStrategyStepReceipt,
  BrowserStrategyCursor
>;
export type BrowserStrategyCollectionInput = CollectionInput<
  BrowserStrategyGoal,
  BrowserStrategyState,
  BrowserStrategyBindings,
  BrowserStrategyEvidence,
  BrowserStrategyEffect,
  BrowserStrategyStepReceipt
>;
export type BrowserStrategyCleanupInput = CleanupInput<
  BrowserStrategyGoal,
  BrowserStrategyState,
  BrowserStrategyBindings,
  BrowserStrategyEvidence,
  BrowserStrategyEffect,
  BrowserStrategyStepReceipt
>;
export type BrowserStrategyRetryInput = Parameters<
  NonNullable<
    RecursiveGoalAdapter<
      BrowserStrategyGoal,
      BrowserStrategyState,
      BrowserStrategyBindings,
      BrowserStrategyEvidence,
      BrowserStrategyEffect,
      BrowserStrategyStepReceipt,
      BrowserStrategyCursor
    >["assessRetry"]
  >
>[0];

export interface BrowserStrategyGoalResources {
  readonly profile: BrowserStrategyProfile;
  readonly atomicProfile: BrowserSingleActionProfile;
  readonly feedbackProfile: FeedbackProfile;
  readonly registry: readonly BrowserExpansionStrategy[];
  readonly grantedEffects: ReadonlySet<string>;
  observe(): Promise<SingleActionSnapshot> | SingleActionSnapshot;
  currentControl():
    | Promise<SingleActionControl>
    | SingleActionControl;
  nativeClick(invocation: NativeClickInvocation): Promise<NativeClickReceipt>;
  collectAtomic(result: SingleActionEpisodeResult): Promise<void> | void;
  collectStep(result: StrategyStepResult): Promise<void> | void;
  proveNoEffect(
    input: FeedbackInput,
  ): Promise<StrategyEffectProof | null> | StrategyEffectProof | null;
  collectRoot(
    input: BrowserStrategyCollectionInput,
  ): Promise<ReceiptRef> | ReceiptRef;
  cleanupRoot?(
    input: BrowserStrategyCleanupInput,
  ): Promise<ReceiptRef> | ReceiptRef;
  readonly signal?: AbortSignal;
}

const EVIDENCE_PREFIX = "browser-strategy-evidence:";
const STATE_PREFIX = "browser-strategy-state:";
const GOAL_DESIRED = true;
const SATISFACTION_THRESHOLD = 100 as const;

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty string without NUL`);
  }
  return value;
}

function uniqueStrings(
  value: unknown,
  label: string,
  allowEmpty: boolean,
): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const values = value.map((entry, index) =>
    nonEmptyString(entry, `${label}[${index}]`));
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${label} contains duplicate values`);
  }
  if (!allowEmpty && values.length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
  return Object.freeze(values);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readBrowserStrategyGoal(value: unknown): BrowserStrategyGoal {
  const input = expectRecord(value, "browser strategy goal");
  exactKeys(input, ["kind", "regionRef", "desired"], "browser strategy goal");
  if (input.kind !== "SetExpanded" || input.desired !== GOAL_DESIRED) {
    throw new TypeError("browser strategy goal must be SetExpanded desired=true");
  }
  return Object.freeze({
    kind: "SetExpanded",
    regionRef: nonEmptyString(input.regionRef, "browser strategy goal.regionRef"),
    desired: true,
  });
}

function readBrowserStrategyBindings(value: unknown): BrowserStrategyBindings {
  const input = expectRecord(value, "browser strategy bindings");
  exactKeys(
    input,
    ["documentRef", "scopeRef", "goalRegionRef", "equivalenceSetRef"],
    "browser strategy bindings",
  );
  return Object.freeze({
    documentRef: nonEmptyString(
      input.documentRef,
      "browser strategy bindings.documentRef",
    ),
    scopeRef: nonEmptyString(input.scopeRef, "browser strategy bindings.scopeRef"),
    goalRegionRef: nonEmptyString(
      input.goalRegionRef,
      "browser strategy bindings.goalRegionRef",
    ),
    equivalenceSetRef: nonEmptyString(
      input.equivalenceSetRef,
      "browser strategy bindings.equivalenceSetRef",
    ),
  });
}

function readBrowserStrategyEvidence(value: unknown): BrowserStrategyEvidence {
  const input = expectRecord(value, "browser strategy evidence");
  exactKeys(
    input,
    [
      "kind",
      "documentRef",
      "scopeRef",
      "observationId",
      "revision",
      "originalId",
      "source",
      "fact",
    ],
    "browser strategy evidence",
  );
  if (input.kind !== "browser.strategy.observed-fact.v1") {
    throw new TypeError("browser strategy evidence.kind is invalid");
  }
  if (typeof input.revision !== "number"
    || !Number.isSafeInteger(input.revision)
    || input.revision < 0) {
    throw new TypeError("browser strategy evidence.revision must be a nonnegative integer");
  }
  return {
    kind: "browser.strategy.observed-fact.v1",
    documentRef: nonEmptyString(
      input.documentRef,
      "browser strategy evidence.documentRef",
    ),
    scopeRef: nonEmptyString(input.scopeRef, "browser strategy evidence.scopeRef"),
    observationId: nonEmptyString(
      input.observationId,
      "browser strategy evidence.observationId",
    ),
    revision: input.revision,
    originalId: nonEmptyString(input.originalId, "browser strategy evidence.originalId"),
    source: nonEmptyString(input.source, "browser strategy evidence.source"),
    fact: input.fact,
  };
}

function readBrowserStrategyEffect(value: unknown): BrowserStrategyEffect {
  const input = expectRecord(value, "browser strategy effect");
  const common = ["kind", "strategyRef", "skillId", "targetRef", "evidenceRefs"];
  const keys = input.kind === "browser.strategy.goal-region-expanded.v1"
    ? [...common, "regionRef", "observationId"]
    : input.kind === "browser.strategy.native-effect-known.v1"
      ? [...common, "nativeSource"]
      : null;
  if (keys === null) throw new TypeError("browser strategy effect.kind is invalid");
  exactKeys(input, keys, "browser strategy effect");
  if (!Array.isArray(input.evidenceRefs)) {
    throw new TypeError("browser strategy effect.evidenceRefs must be an array");
  }
  const evidenceRefs = input.evidenceRefs.map((entry, index) =>
    nonEmptyString(entry, `browser strategy effect.evidenceRefs[${index}]`));
  if (new Set(evidenceRefs).size !== evidenceRefs.length) {
    throw new TypeError("browser strategy effect.evidenceRefs contains duplicates");
  }
  const base = {
    strategyRef: nonEmptyString(
      input.strategyRef,
      "browser strategy effect.strategyRef",
    ),
    skillId: nonEmptyString(input.skillId, "browser strategy effect.skillId"),
    targetRef: nonEmptyString(input.targetRef, "browser strategy effect.targetRef"),
    evidenceRefs,
  };
  if (input.kind === "browser.strategy.goal-region-expanded.v1") {
    return {
      kind: "browser.strategy.goal-region-expanded.v1",
      ...base,
      regionRef: nonEmptyString(input.regionRef, "browser strategy effect.regionRef"),
      observationId: nonEmptyString(
        input.observationId,
        "browser strategy effect.observationId",
      ),
    };
  }
  return {
    kind: "browser.strategy.native-effect-known.v1",
    ...base,
    nativeSource: nonEmptyString(
      input.nativeSource,
      "browser strategy effect.nativeSource",
    ),
  };
}

function readBrowserStrategyState(
  value: unknown,
  goal: BrowserStrategyGoal,
): BrowserStrategyState {
  const input = expectRecord(value, "browser strategy state");
  exactKeys(input, ["browser", "history"], "browser strategy state");
  const browser = readSingleActionSnapshot(input.browser);
  const request = readBrowserStrategyRequest({
    request: {
      goal,
      satisfactionThreshold: SATISFACTION_THRESHOLD,
      state: browser,
    },
    history: input.history,
  });
  return Object.freeze({
    browser: request.request.state,
    history: request.history,
  });
}

function initialGoalRegionRef(
  value: unknown,
  explicitRegionRef: string | undefined,
): string {
  if (explicitRegionRef !== undefined) {
    return nonEmptyString(explicitRegionRef, "browser strategy initial goalRegionRef");
  }
  const input = expectRecord(value, "browser strategy initial state");
  exactKeys(input, ["browser", "history"], "browser strategy initial state");
  const browser = readSingleActionSnapshot(input.browser);
  if (!Array.isArray(input.history)) {
    throw new TypeError("browser strategy initial state.history must be an array");
  }
  const historyRegions = new Set(input.history.map((entry, index) => {
    const history = expectRecord(entry, `browser strategy initial state.history[${index}]`);
    return readFeedbackInput(history.input).request.goal.regionRef;
  }));
  if (historyRegions.size > 1) {
    throw new TypeError("browser strategy initial history must use one Goal region");
  }
  if (historyRegions.size === 1) {
    return [...historyRegions][0]!;
  }
  if (browser.regions.length === 1) {
    return browser.regions[0]!.ref;
  }
  throw new TypeError(
    "browser strategy initial goalRegionRef is required when the snapshot has multiple regions",
  );
}

function readBrowserStrategyStepReceipt(value: unknown): BrowserStrategyStepReceipt {
  const input = expectRecord(value, "browser strategy step receipt");
  for (const key of [
    "decision",
    "atomic",
    "feedback",
    "feedbackInput",
    "effectProof",
    "newState",
    "error",
    "collectionError",
  ]) {
    if (!Object.hasOwn(input, key)) {
      throw new TypeError(`browser strategy step receipt.${key} is required`);
    }
  }
  if (input.atomic !== null) readBrowserSingleActionEpisodeResult(input.atomic);
  if (input.feedbackInput !== null) readFeedbackInput(input.feedbackInput);
  if (input.newState !== null) readSingleActionSnapshot(input.newState);
  if (input.effectProof !== null) {
    const proof = expectRecord(input.effectProof, "browser strategy step receipt.effectProof");
    exactKeys(
      proof,
      [
        "kind",
        "targetRef",
        "documentRef",
        "beforeObservationId",
        "afterObservationId",
        "evidenceRefs",
      ],
      "browser strategy step receipt.effectProof",
    );
    if (proof.kind !== "controlled_fixture_no_effect") {
      throw new TypeError("browser strategy step receipt.effectProof.kind is invalid");
    }
    nonEmptyString(proof.targetRef, "browser strategy step receipt.effectProof.targetRef");
    nonEmptyString(proof.documentRef, "browser strategy step receipt.effectProof.documentRef");
    nonEmptyString(
      proof.beforeObservationId,
      "browser strategy step receipt.effectProof.beforeObservationId",
    );
    nonEmptyString(
      proof.afterObservationId,
      "browser strategy step receipt.effectProof.afterObservationId",
    );
    uniqueStrings(
      proof.evidenceRefs,
      "browser strategy step receipt.effectProof.evidenceRefs",
      false,
    );
  }
  return value as StrategyStepResult;
}

function snapshotEvidence(
  snapshot: SingleActionSnapshot,
  stateId: string,
): readonly EvidenceRecord<BrowserStrategyEvidence>[] {
  return Object.freeze(snapshot.evidence.map((item, index) => Object.freeze({
    id: `${EVIDENCE_PREFIX}${stateId}:${index}:${item.id}`,
    stateRef: stateId,
    payload: Object.freeze({
      kind: "browser.strategy.observed-fact.v1",
      documentRef: snapshot.documentRef,
      scopeRef: snapshot.scopeRef,
      observationId: snapshot.observationId,
      revision: snapshot.revision,
      originalId: item.id,
      source: item.source,
      fact: item.fact,
    } satisfies BrowserStrategyEvidence),
    validity: "valid" as const,
  })));
}

export function createBrowserStrategyInitialObservation(
  stateId: string,
  state: BrowserStrategyState,
  goalRegionRef?: string,
): { readonly stateId: string; readonly evidence: readonly EvidenceRecord<BrowserStrategyEvidence>[] } {
  const id = nonEmptyString(stateId, "browser strategy initial stateId");
  const regionRef = initialGoalRegionRef(state, goalRegionRef);
  const validated = readBrowserStrategyState(
    state,
    readBrowserStrategyGoal({
      kind: "SetExpanded",
      regionRef,
      desired: true,
    }),
  );
  if (validated.history.some(
    item => item.input.request.goal.regionRef !== regionRef,
  )) {
    throw new TypeError("browser strategy initial history Goal region differs");
  }
  return Object.freeze({
    stateId: id,
    evidence: snapshotEvidence(validated.browser, id),
  });
}

function readInitialObservation(
  value: unknown,
): ReturnType<typeof readRecursiveGoalInitialObservation<BrowserStrategyEvidence>> {
  return readRecursiveGoalInitialObservation(
    value,
    readBrowserStrategyEvidence,
    "request.initialObservation",
  );
}

function assertInitialObservationMatchesState(
  initialObservation: ReturnType<typeof readRecursiveGoalInitialObservation<BrowserStrategyEvidence>>,
  state: BrowserStrategyState,
): void {
  const rawEvidence = new Map(state.browser.evidence.map(item => [item.id, item]));
  const covered = new Set<string>();
  if (initialObservation.evidence.length !== rawEvidence.size) {
    throw new TypeError(
      "browser strategy initialObservation evidence must cover the current snapshot exactly",
    );
  }
  for (const item of initialObservation.evidence) {
    const raw = rawEvidence.get(item.payload.originalId);
    if (item.validity !== "valid"
      || raw === undefined
      || covered.has(item.payload.originalId)
      || item.payload.documentRef !== state.browser.documentRef
      || item.payload.scopeRef !== state.browser.scopeRef
      || item.payload.observationId !== state.browser.observationId
      || item.payload.revision !== state.browser.revision
      || item.payload.source !== raw.source
      || !isDeepStrictEqual(item.payload.fact, raw.fact)) {
      throw new TypeError(
        "browser strategy initialObservation evidence is not the current state snapshot",
      );
    }
    covered.add(item.payload.originalId);
  }
  if (covered.size !== rawEvidence.size) {
    throw new TypeError(
      "browser strategy initialObservation evidence must cover the current snapshot exactly",
    );
  }
}

function strategyForSkill(
  registry: readonly BrowserExpansionStrategy[],
  skillId: string,
): BrowserExpansionStrategy {
  const strategy = registry.find(item => item.skillId === skillId);
  if (strategy === undefined) {
    throw new TypeError(`browser strategy skill ${skillId} is absent from the registry`);
  }
  return strategy;
}

function validateRegistry(
  registry: readonly BrowserExpansionStrategy[],
): readonly BrowserExpansionStrategy[] {
  if (registry.length !== 2) {
    throw new TypeError("browser strategy registry must contain exactly two strategies");
  }
  const skillIds = new Set<string>();
  const strategyRefs = new Set<string>();
  const targetRefs = new Set<string>();
  const normalized: BrowserExpansionStrategy[] = [];
  let commonBinding: {
    readonly documentRef: string;
    readonly scopeRef: string;
    readonly goalRegionRef: string;
    readonly equivalenceSetRef: string;
  } | null = null;
  for (const [index, strategy] of registry.entries()) {
    const input = expectRecord(strategy, `browser strategy registry[${index}]`);
    exactKeys(
      input,
      [
        "strategyRef",
        "skillId",
        "targetRef",
        "goalRegionRef",
        "equivalenceSetRef",
        "documentRef",
        "scopeRef",
        "operation",
        "evidenceRefs",
      ],
      `browser strategy registry[${index}]`,
    );
    if (input.operation !== "CLICK") {
      throw new TypeError(`browser strategy registry[${index}].operation must be CLICK`);
    }
    const skillId = nonEmptyString(
      input.skillId,
      `browser strategy registry[${index}].skillId`,
    );
    const strategyRef = nonEmptyString(
      input.strategyRef,
      `browser strategy registry[${index}].strategyRef`,
    );
    const targetRef = nonEmptyString(
      input.targetRef,
      `browser strategy registry[${index}].targetRef`,
    );
    const goalRegionRef = nonEmptyString(
      input.goalRegionRef,
      `browser strategy registry[${index}].goalRegionRef`,
    );
    const equivalenceSetRef = nonEmptyString(
      input.equivalenceSetRef,
      `browser strategy registry[${index}].equivalenceSetRef`,
    );
    const documentRef = nonEmptyString(
      input.documentRef,
      `browser strategy registry[${index}].documentRef`,
    );
    const scopeRef = nonEmptyString(
      input.scopeRef,
      `browser strategy registry[${index}].scopeRef`,
    );
    const evidenceRefs = uniqueStrings(
      input.evidenceRefs,
      `browser strategy registry[${index}].evidenceRefs`,
      false,
    );
    if (skillIds.has(skillId)
      || strategyRefs.has(strategyRef)
      || targetRefs.has(targetRef)) {
      throw new TypeError("browser strategy registry contains duplicate strategy ids");
    }
    skillIds.add(skillId);
    strategyRefs.add(strategyRef);
    targetRefs.add(targetRef);
    if (commonBinding === null) {
      commonBinding = {
        documentRef,
        scopeRef,
        goalRegionRef,
        equivalenceSetRef,
      };
    } else if (commonBinding.documentRef !== documentRef
      || commonBinding.scopeRef !== scopeRef
      || commonBinding.goalRegionRef !== goalRegionRef
      || commonBinding.equivalenceSetRef !== equivalenceSetRef) {
      throw new TypeError("browser strategy registry must share one explicit Goal binding");
    }
    normalized.push(Object.freeze({
      strategyRef,
      skillId,
      targetRef,
      goalRegionRef,
      equivalenceSetRef,
      documentRef,
      scopeRef,
      operation: "CLICK",
      evidenceRefs,
    }));
  }
  const expectedSkills = [
    BROWSER_STRATEGY_NATIVE_SKILL_ID,
    BROWSER_STRATEGY_ROLE_SKILL_ID,
  ].sort();
  if (!isDeepStrictEqual([...skillIds].sort(), expectedSkills)) {
    throw new TypeError(
      "browser strategy registry must bind the native and explicit role skills",
    );
  }
  return Object.freeze(normalized);
}

function validateGoalResources(
  resources: BrowserStrategyGoalResources,
): void {
  validateBrowserStrategyProfile(resources.profile);
  validateBrowserSingleActionProfile(resources.atomicProfile);
  validateFeedbackProfile(resources.feedbackProfile);
  validateRegistry(resources.registry);
  if (!(resources.grantedEffects instanceof Set)) {
    throw new TypeError("browser strategy grantedEffects must be a Set");
  }
  for (const callback of [
    "observe",
    "currentControl",
    "nativeClick",
    "collectAtomic",
    "collectStep",
    "proveNoEffect",
    "collectRoot",
  ] as const) {
    if (typeof resources[callback] !== "function") {
      throw new TypeError(`browser strategy resources.${callback} must be a function`);
    }
  }
  if (resources.cleanupRoot !== undefined
    && typeof resources.cleanupRoot !== "function") {
    throw new TypeError("browser strategy resources.cleanupRoot must be a function");
  }
}

function assertBindings(
  bindings: BrowserStrategyBindings,
  goal: BrowserStrategyGoal,
  state: BrowserStrategyState,
  registry: readonly BrowserExpansionStrategy[],
): void {
  if (bindings.goalRegionRef !== goal.regionRef) {
    throw new TypeError("browser strategy bindings.goalRegionRef must equal the root Goal region");
  }
  if (state.browser.documentRef !== bindings.documentRef
    || state.browser.scopeRef !== bindings.scopeRef) {
    throw new TypeError("browser strategy state document/scope differs from the root bindings");
  }
  if (!state.browser.regions.some(region => region.ref === goal.regionRef)) {
    throw new TypeError("browser strategy state does not contain the root Goal region");
  }
  for (const strategy of registry) {
    if (strategy.documentRef !== bindings.documentRef
      || strategy.scopeRef !== bindings.scopeRef
      || strategy.goalRegionRef !== bindings.goalRegionRef
      || strategy.equivalenceSetRef !== bindings.equivalenceSetRef) {
      throw new TypeError(
        `browser strategy ${strategy.strategyRef} is outside the declared root binding`,
      );
    }
  }
  for (const item of state.history) {
    const strategy = registry.find(entry => entry.skillId === item.skillId);
    if (strategy === undefined) {
      throw new TypeError(`browser strategy history references unknown skill ${item.skillId}`);
    }
    if (item.strategyRef !== strategy.strategyRef
      || item.targetRef !== strategy.targetRef
      || item.equivalenceSetRef !== strategy.equivalenceSetRef
      || item.input.request.state.documentRef !== bindings.documentRef
      || item.input.request.state.scopeRef !== bindings.scopeRef
      || item.input.request.goal.regionRef !== goal.regionRef) {
      throw new TypeError("browser strategy history is outside the declared root binding");
    }
  }
}

function allSkillIds(
  registry: readonly BrowserExpansionStrategy[],
): readonly string[] {
  return Object.freeze(registry.map(strategy => strategy.skillId));
}

function enabledSkills(
  registry: readonly BrowserExpansionStrategy[],
): readonly EnabledSkill[] {
  return Object.freeze(registry.map(strategy => Object.freeze({
    id: strategy.skillId,
    version: "0.1.0",
    mode: "atomic" as const,
    capability: BROWSER_STRATEGY_CAPABILITY,
    evaluatorId: BROWSER_STRATEGY_EVALUATOR_ID,
    requiredEffects: Object.freeze(["browser.nativeClick"]),
    allowedEffects: Object.freeze(["browser.nativeClick"]),
    retry: "completed_no_effect" as const,
    effectClass: "mutating" as const,
  })));
}

function enabledEvaluators(): readonly EnabledEvaluator[] {
  return Object.freeze([Object.freeze({
    id: BROWSER_STRATEGY_EVALUATOR_ID,
    goalType: "browser.SetExpanded",
    thresholdContract: "0..100" as const,
    allowsPartialSatisfaction: false,
  })]);
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(canonicalFacts(left), canonicalFacts(right));
}

function canonicalFacts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalFacts);
  if (value === null || typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(input)
    .filter(([key]) =>
      key !== "id"
      && key !== "observationId"
      && key !== "originalId"
      && key !== "revision"
      && key !== "evidenceRefs"
      && key !== "stateRef")
    .map(([key, entry]) => [key, canonicalFacts(entry)]));
}

function sameBrowserFacts(
  left: SingleActionSnapshot,
  right: SingleActionSnapshot,
): boolean {
  return sameCanonical(
    {
      documentRef: left.documentRef,
      scopeRef: left.scopeRef,
      regions: left.regions,
      elements: left.elements,
      evidence: left.evidence.map(item => ({
        source: item.source,
        fact: item.fact,
      })),
    },
    {
      documentRef: right.documentRef,
      scopeRef: right.scopeRef,
      regions: right.regions,
      elements: right.elements,
      evidence: right.evidence.map(item => ({
        source: item.source,
        fact: item.fact,
      })),
    },
  );
}

function sameStateFacts(
  left: FactSnapshot<BrowserStrategyState, BrowserStrategyEvidence>,
  right: FactSnapshot<BrowserStrategyState, BrowserStrategyEvidence>,
): boolean {
  return sameBrowserFacts(left.state.browser, right.state.browser)
    && sameCanonical(left.state.history, right.state.history)
    && sameCanonical(
      left.evidence.map(item => ({
        validity: item.validity,
        payload: item.payload,
      })),
      right.evidence.map(item => ({
        validity: item.validity,
        payload: item.payload,
      })),
    )
    && sameCanonical(left.conditions, right.conditions);
}

export const browserStrategyComparators = Object.freeze({
  sameGoal: (left: BrowserStrategyGoal, right: BrowserStrategyGoal) =>
    isDeepStrictEqual(left, right),
  sameBindings: (
    left: BrowserStrategyBindings,
    right: BrowserStrategyBindings,
  ) => isDeepStrictEqual(left, right),
  sameFacts: sameStateFacts,
});

function evidenceRefsForSnapshot(
  snapshot: SingleActionSnapshot,
  evidence: readonly EvidenceRecord<BrowserStrategyEvidence>[],
): readonly string[] {
  const rawRefs = new Set(snapshot.evidence.map(item => item.id));
  return Object.freeze(evidence
    .filter(item =>
      item.validity === "valid"
      && item.payload.documentRef === snapshot.documentRef
      && item.payload.scopeRef === snapshot.scopeRef
      && item.payload.observationId === snapshot.observationId
      && rawRefs.has(item.payload.originalId))
    .map(item => item.id));
}

function regionFacts(
  snapshot: SingleActionSnapshot,
  regionRef: string,
): {
  readonly expanded: "observed" | "unknown";
  readonly expandedValue: boolean | null;
  readonly rendered: "observed" | "unknown";
  readonly renderedValue: boolean | null;
} {
  const region = snapshot.regions.find(item => item.ref === regionRef);
  return Object.freeze({
    expanded: region?.expanded.status ?? "unknown",
    expandedValue: region?.expanded.status === "observed"
      ? region.expanded.value
      : null,
    rendered: region?.rendered.status ?? "unknown",
    renderedValue: region?.rendered.status === "observed"
      ? region.rendered.value
      : null,
  });
}

function goalSatisfied(
  snapshot: SingleActionSnapshot,
  regionRef: string,
): boolean {
  const facts = regionFacts(snapshot, regionRef);
  return facts.expandedValue === true && facts.renderedValue === true;
}

function strategySelection(
  input: SelectionInput<
    BrowserStrategyGoal,
    BrowserStrategyState,
    BrowserStrategyBindings,
    BrowserStrategyEvidence
  >,
): RetrySelectionView | null {
  return input.retry ?? null;
}

function strategyRequest(
  goal: BrowserStrategyGoal,
  state: BrowserStrategyState,
): BrowserStrategyRequest {
  return Object.freeze({
    request: Object.freeze({
      goal,
      satisfactionThreshold: SATISFACTION_THRESHOLD,
      state: state.browser,
    }),
    history: state.history,
  });
}

function strategyInferenceResources(
  resources: BrowserStrategyGoalResources,
  selection: RetrySelectionView,
) {
  return Object.freeze({
    profile: resources.profile,
    atomicProfile: resources.atomicProfile,
    feedbackProfile: resources.feedbackProfile,
    registry: resources.registry,
    selection,
  });
}

function strategyStepResources(
  resources: BrowserStrategyGoalResources,
  selectedSkillId: string,
  selection: RetrySelectionView,
): StrategyStepResources {
  return Object.freeze({
    profile: resources.profile,
    atomicProfile: resources.atomicProfile,
    feedbackProfile: resources.feedbackProfile,
    registry: resources.registry,
    selection,
    selectedSkillId,
    grantedEffects: resources.grantedEffects,
    observe: async () => resources.observe(),
    currentControl: () => Promise.resolve(resources.currentControl()),
    nativeClick: async (invocation: NativeClickInvocation) =>
      resources.nativeClick(invocation),
    collectAtomic: async (result: SingleActionEpisodeResult) => {
      await resources.collectAtomic(result);
    },
    collectStep: async (result: StrategyStepResult) => {
      await resources.collectStep(result);
    },
    proveNoEffect: async (input: FeedbackInput) => resources.proveNoEffect(input),
  });
}

function selectedStrategyFor(
  resources: BrowserStrategyGoalResources,
  skillId: string,
): BrowserExpansionStrategy {
  return strategyForSkill(resources.registry, skillId);
}

function registryGoalRegionRef(
  registry: readonly BrowserExpansionStrategy[],
): string {
  const regions = new Set(registry.map(strategy => strategy.goalRegionRef));
  if (regions.size !== 1) {
    throw new TypeError("browser strategy registry must share one Goal region");
  }
  return [...regions][0]!;
}

function appendHistory(
  state: BrowserStrategyState,
  strategy: BrowserExpansionStrategy,
  result: StrategyStepResult,
): readonly StrategyHistory[] {
  if (result.feedbackInput === null) return state.history;
  return Object.freeze([
    ...state.history,
    Object.freeze({
      strategyRef: strategy.strategyRef,
      skillId: strategy.skillId,
      targetRef: strategy.targetRef,
      equivalenceSetRef: strategy.equivalenceSetRef,
      input: result.feedbackInput,
    }),
  ]);
}

function newStateFromStep(
  input: AtomicInput<
    BrowserStrategyGoal,
    BrowserStrategyState,
    BrowserStrategyBindings,
    BrowserStrategyEvidence
  >,
  result: StrategyStepResult,
  strategy: BrowserExpansionStrategy,
): StateRecord<BrowserStrategyState> {
  const browser = result.newState ?? input.state.browser;
  const stateId = `${STATE_PREFIX}${randomUUID()}`;
  return Object.freeze({
    id: stateId,
    value: Object.freeze({
      browser,
      history: appendHistory(input.state, strategy, result),
    }),
  });
}

function diagnostic(
  result: StrategyStepResult,
  effect: AtomicEffectReceipt<BrowserStrategyEffect>,
): readonly AdapterDiagnostic[] {
  const error = result.error ?? result.atomic?.error ?? null;
  if (error === null) return Object.freeze([]);
  let code: AdapterDiagnostic["code"];
  let stage: AdapterDiagnostic["stage"];
  switch (error.code) {
    case "policy_deferred":
      code = "policy_deferred";
      stage = "selection";
      break;
    case "policy_error":
    case "invalid_click_proposal":
    case "missing_click_target":
    case "invalid_noop":
      code = "policy_error";
      stage = "execution";
      break;
    case "invalid_binding":
    case "stale_reference":
      code = "invalid_binding";
      stage = "binding";
      break;
    case "precondition_unsatisfied":
      code = "precondition_unsatisfied";
      stage = "execution";
      break;
    case "binding_ambiguous":
      code = "evidence_conflict";
      stage = "observation";
      break;
    case "observation_insufficient":
    case "observation_failed":
    case "post_observation_failed":
    case "control_unavailable":
      code = "evidence_unavailable";
      stage = "observation";
      break;
    case "effect_proof_invalid":
      code = "effect_outcome_unknown";
      stage = "effect";
      break;
    case "atomic_workflow_failed":
      code = "workflow_failure";
      stage = "execution";
      break;
    case "adapter_contract_invalid":
    case "feedback_contract_invalid":
    case "prediction_failed":
      code = "adapter_contract_invalid";
      stage = "execution";
      break;
    case "native_click_failed":
      code = result.atomic?.dispatchState === "unknown"
        ? "effect_outcome_unknown"
        : "execution_failed";
      stage = code === "effect_outcome_unknown" ? "effect" : "execution";
      break;
    default:
      code = "execution_failed";
      stage = "execution";
      break;
  }
  return Object.freeze([Object.freeze({
    diagnosticId: `browser-strategy-step:${error.code}`,
    code,
    stage,
    sourceCategory: result.error === null
      ? "browser_single_action_episode"
      : "browser_strategy_step",
    message: error.message,
    nativeCode: error.code,
    refs: Object.freeze(effect.receiptRef === null ? [] : [effect.receiptRef]),
  })]);
}

function verifiedEffect(
  input: AtomicInput<
    BrowserStrategyGoal,
    BrowserStrategyState,
    BrowserStrategyBindings,
    BrowserStrategyEvidence
  >,
  result: StrategyStepResult,
  strategy: BrowserExpansionStrategy,
): AtomicEffectReceipt<BrowserStrategyEffect> {
  const browser = result.newState ?? input.state.browser;
  const evidenceRefs = Object.freeze(browser.evidence.map(item => item.id));
  if (result.atomic?.dispatchState === "not_dispatched") {
    return Object.freeze({
      knowledge: "none",
      confirmedEffects: Object.freeze([]),
      receiptRef: `browser.strategy.not-dispatched:${browser.observationId}`,
    });
  }
  if (result.atomic?.effectKnowledge === "unknown"
    || result.atomic?.receipt?.effectKnowledge === "unknown") {
    return Object.freeze({
      knowledge: "unknown",
      confirmedEffects: Object.freeze([]),
      receiptRef: null,
    });
  }
  if (goalSatisfied(browser, input.goal.regionRef)) {
    return Object.freeze({
      knowledge: "known",
      confirmedEffects: Object.freeze([Object.freeze({
        kind: "browser.strategy.goal-region-expanded.v1",
        strategyRef: strategy.strategyRef,
        skillId: strategy.skillId,
        targetRef: strategy.targetRef,
        regionRef: input.goal.regionRef,
        observationId: browser.observationId,
        evidenceRefs,
      })]),
      receiptRef: `browser.strategy.goal-region:${browser.observationId}`,
    });
  }
  if (result.effectProof !== null) {
    return Object.freeze({
      knowledge: "none",
      confirmedEffects: Object.freeze([]),
      receiptRef: `browser.strategy.no-effect:${result.effectProof.beforeObservationId}:${result.effectProof.afterObservationId}`,
    });
  }
  if (result.atomic?.receipt?.effectKnowledge === "known") {
    return Object.freeze({
      knowledge: "known",
      confirmedEffects: Object.freeze([Object.freeze({
        kind: "browser.strategy.native-effect-known.v1",
        strategyRef: strategy.strategyRef,
        skillId: strategy.skillId,
        targetRef: strategy.targetRef,
        nativeSource: result.atomic.receipt.source,
        evidenceRefs,
      })]),
      receiptRef: `browser.strategy.native-effect:${browser.observationId}`,
    });
  }
  return Object.freeze({
    knowledge: "unknown",
    confirmedEffects: Object.freeze([]),
    receiptRef: null,
  });
}

function outcomeOf(result: StrategyStepResult): AtomicReceipt<
  BrowserStrategyState,
  BrowserStrategyEvidence,
  BrowserStrategyEffect,
  BrowserStrategyStepReceipt
>["outcome"] {
  if (result.atomic?.dispatchState === "unknown") return "unknown";
  const error = result.error ?? result.atomic?.error ?? null;
  if (error !== null) {
    return error.code === "policy_deferred"
      || error.code === "invalid_binding"
      || error.code === "stale_reference"
      || error.code === "precondition_unsatisfied"
      || error.code === "policy_error"
      || error.code === "observation_insufficient"
      || error.code === "binding_ambiguous"
      ? "rejected"
      : "failed";
  }
  if (result.atomic === null) return "rejected";
  return "succeeded";
}

function atomicReceipt(
  input: AtomicInput<
    BrowserStrategyGoal,
    BrowserStrategyState,
    BrowserStrategyBindings,
    BrowserStrategyEvidence
  >,
  result: StrategyStepResult,
  strategy: BrowserExpansionStrategy,
): AtomicReceipt<
  BrowserStrategyState,
  BrowserStrategyEvidence,
  BrowserStrategyEffect,
  BrowserStrategyStepReceipt
> {
  const feedback = result.atomic?.observationFeedback;
  // Invalid raw observations remain in sourceResult, never in trusted root State.
  // A not-dispatched attempt changed nothing, so the pre-dispatch observation is
  // still the current observation and needs no post-action freshness proof.
  const notDispatched = result.atomic?.dispatchState === "not_dispatched";
  const validPost = feedback === undefined || notDispatched || (feedback.status === "satisfied"
    && feedback.observationId === result.atomic?.newState?.observationId);
  const state = validPost ? newStateFromStep(input, result, strategy) : null;
  const effect = verifiedEffect(input, result, strategy);
  const verificationErrors: AdapterDiagnostic[] = feedback === undefined || validPost ? []
    : (feedback.errors.length > 0 ? feedback.errors : [{ code: "observation_insufficient", message: `Missing facts: ${feedback.unmetFacts.join(", ")}` }])
      .map(error => Object.freeze({
        diagnosticId: `browser-post:${error.code}`,
        code: "evidence_unavailable" as const, stage: "observation" as const,
        sourceCategory: "browser_single_action_observation", message: error.message,
        nativeCode: error.code, refs: Object.freeze(effect.receiptRef === null ? [] : [effect.receiptRef]),
      }));
  const executionErrors = result.atomic?.executionErrors?.length
    ? result.atomic.executionErrors.flatMap(error => diagnostic({ ...result, error }, effect))
    : diagnostic(result, effect).filter(error => !verificationErrors.some(observation =>
      observation.nativeCode === error.nativeCode));
  return Object.freeze({
    runId: randomUUID(),
    executorInvoked: true,
    outcome: outcomeOf(result),
    sourceResult: Object.freeze({
      tag: "browser.strategy-step.v1",
      value: result,
    }),
    newState: state,
    evidence: state === null ? Object.freeze([]) : snapshotEvidence(state.value.browser, state.id),
    executionErrors,
    verificationErrors: Object.freeze(verificationErrors),
    effect,
  });
}

function failedAtomicReceipt(
  error: unknown,
): AtomicReceipt<
  BrowserStrategyState,
  BrowserStrategyEvidence,
  BrowserStrategyEffect,
  BrowserStrategyStepReceipt
> {
  const message = errorText(error);
  return Object.freeze({
    runId: null,
    executorInvoked: "unknown",
    outcome: "unknown",
    sourceResult: Object.freeze({
      category: "browser_strategy_atomic",
      message,
    }),
    newState: null,
    evidence: Object.freeze([]),
    executionErrors: Object.freeze([Object.freeze({
      diagnosticId: "browser-strategy-atomic:workflow_failure",
      code: "workflow_failure",
      stage: "execution",
      sourceCategory: "browser_strategy_atomic",
      message,
      nativeCode: null,
      refs: Object.freeze([]),
    })]),
    verificationErrors: Object.freeze([]),
    effect: Object.freeze({
      knowledge: "unknown",
      confirmedEffects: Object.freeze([]),
      receiptRef: null,
    }),
  });
}

function stableFailureKey(
  goal: BrowserStrategyGoal,
  bindings: BrowserStrategyBindings,
  strategy: BrowserExpansionStrategy,
): string {
  return [
    "completed_without_goal",
    goal.kind,
    bindings.equivalenceSetRef,
    bindings.goalRegionRef,
    strategy.targetRef,
  ].join(":");
}

function retryPreconditionsHold(
  before: SingleActionSnapshot,
  after: SingleActionSnapshot,
  goal: BrowserStrategyGoal,
  bindings: BrowserStrategyBindings,
  strategy: BrowserExpansionStrategy,
): boolean {
  if (before.documentRef !== bindings.documentRef
    || after.documentRef !== bindings.documentRef
    || before.scopeRef !== bindings.scopeRef
    || after.scopeRef !== bindings.scopeRef) {
    return false;
  }
  const target = after.elements.find(element => element.ref === strategy.targetRef);
  if (target === undefined
    || target.candidateStatus !== "ok"
    || target.controls.status !== "observed"
    || !target.controls.value.includes(goal.regionRef)
    || target.enabled.status !== "observed"
    || target.enabled.value !== true
    || target.hit.status !== "observed"
    || target.hit.value !== true) {
    return false;
  }
  return sameCanonical(
    {
      documentRef: before.documentRef,
      scopeRef: before.scopeRef,
      region: before.regions.find(region => region.ref === goal.regionRef),
      target: before.elements.find(element => element.ref === strategy.targetRef),
    },
    {
      documentRef: after.documentRef,
      scopeRef: after.scopeRef,
      region: after.regions.find(region => region.ref === goal.regionRef),
      target,
    },
  );
}

function evaluateGoal(
  input: EvaluationInput<
    BrowserStrategyGoal,
    BrowserStrategyState,
    BrowserStrategyBindings,
    BrowserStrategyEvidence
  >,
): EvaluationReceipt {
  const facts = regionFacts(input.state.browser, input.goal.regionRef);
  const evidenceRefs = evidenceRefsForSnapshot(input.state.browser, input.evidence);
  const known = facts.expanded === "observed" && facts.rendered === "observed";
  if (!known || evidenceRefs.length === 0) {
    return Object.freeze({
      evaluatorId: BROWSER_STRATEGY_EVALUATOR_ID,
      result: "unknown",
      satisfaction: null,
      necessaryConditionsMet: false,
      evidenceRefs: Object.freeze([]),
    });
  }
  const satisfied = facts.expandedValue === true && facts.renderedValue === true;
  return Object.freeze({
    evaluatorId: BROWSER_STRATEGY_EVALUATOR_ID,
    result: satisfied ? "satisfied" : "unsatisfied",
    satisfaction: satisfied ? 100 : 0,
    necessaryConditionsMet: true,
    evidenceRefs,
  });
}

function createAdapter(
  resources: BrowserStrategyGoalResources,
): RecursiveGoalAdapter<
  BrowserStrategyGoal,
  BrowserStrategyState,
  BrowserStrategyBindings,
  BrowserStrategyEvidence,
  BrowserStrategyEffect,
  BrowserStrategyStepReceipt,
  BrowserStrategyCursor
> {
  return {
    async validateRequest(request) {
      const goal = readBrowserStrategyGoal(request.rootGoal);
      const bindings = readBrowserStrategyBindings(request.rootBindings);
      if (request.satisfactionThreshold !== SATISFACTION_THRESHOLD) {
        throw new TypeError("browser strategy satisfactionThreshold must be 100");
      }
      if (request.rootEvaluatorId !== BROWSER_STRATEGY_EVALUATOR_ID
        || request.rootSelectorId !== BROWSER_STRATEGY_SELECTOR_ID) {
        throw new TypeError("browser strategy evaluator/selector ids are not enabled");
      }
      if (request.retryPolicy === undefined) {
        throw new TypeError("browser strategy requires bounded retryPolicy");
      }
      if (request.invocation?.maxAtomicDispatches !== 1) {
        throw new TypeError("browser strategy requires maxAtomicDispatches=1");
      }
      if (request.retryPolicy.selectorId !== BROWSER_STRATEGY_SELECTOR_ID) {
        throw new TypeError("browser strategy retryPolicy selector is not enabled");
      }
      const expectedSkills = [...allSkillIds(resources.registry)].sort();
      const policySkills = [...request.retryPolicy.strategySkillIds].sort();
      if (!isDeepStrictEqual(expectedSkills, policySkills)) {
        throw new TypeError(
          "browser strategy retryPolicy strategySkillIds must equal the registry",
        );
      }
      const state = readBrowserStrategyState(request.state, goal);
      assertBindings(bindings, goal, state, resources.registry);
      const initialObservation = request.initialObservation === undefined
        ? undefined
        : readInitialObservation(request.initialObservation);
      if (request.continuation === undefined && initialObservation === undefined) {
        throw new TypeError(
          "browser strategy new runs require initialObservation evidence",
        );
      }
      if (initialObservation !== undefined) {
        if (initialObservation.stateId.length === 0) {
          throw new TypeError("browser strategy initialObservation.stateId is required");
        }
        assertInitialObservationMatchesState(initialObservation, state);
      }
      return {
        requestId: request.requestId,
        rootGoal: goal,
        satisfactionThreshold: SATISFACTION_THRESHOLD,
        rootBindings: bindings,
        state,
        rootEvaluatorId: BROWSER_STRATEGY_EVALUATOR_ID,
        rootSelectorId: BROWSER_STRATEGY_SELECTOR_ID,
        limits: request.limits,
        ...(initialObservation === undefined ? {} : { initialObservation }),
        continuation: request.continuation === undefined
          ? null
          : request.continuation as RecursiveGoalContinuation<
              BrowserStrategyGoal,
              BrowserStrategyState,
              BrowserStrategyBindings,
              BrowserStrategyEvidence,
              BrowserStrategyEffect,
              BrowserStrategyStepReceipt,
              BrowserStrategyCursor
            >,
        retryPolicy: request.retryPolicy,
      };
    },

    supports(input: SupportsInput<BrowserStrategyGoal, BrowserStrategyBindings>) {
      return input.goal.kind === "SetExpanded"
        && resources.registry.some(strategy => strategy.skillId === input.skill.id);
    },

    async evaluate(input) {
      return evaluateGoal(input);
    },

    async select(
      input: SelectionInput<
        BrowserStrategyGoal,
        BrowserStrategyState,
        BrowserStrategyBindings,
        BrowserStrategyEvidence
      >,
    ): Promise<Selection> {
      const selection = strategySelection(input);
      if (selection === null) {
        return { kind: "defer", reason: "core did not provide a retry selection view" };
      }
      const candidates = new Set(input.candidates.map(skill => skill.id));
      const eligible = new Set(selection.eligibleSkillIds);
      if (candidates.size !== eligible.size
        || [...candidates].some(skillId => !eligible.has(skillId))) {
        throw new TypeError("retry selection view differs from the selector candidate set");
      }
      const prediction = predictBrowserStrategy(
        strategyRequest(input.goal, input.state),
        strategyInferenceResources(resources, selection),
      );
      if (prediction.kind === "DEFER") {
        return {
          kind: "defer",
          reason: prediction.reason ?? "browser strategy policy deferred",
        };
      }
      if (prediction.skillId === null || !candidates.has(prediction.skillId)) {
        throw new TypeError("browser strategy prediction selected outside the candidate set");
      }
      return { kind: "selected", skillId: prediction.skillId };
    },

    async derive(
      _input: DerivationInput<
        BrowserStrategyGoal,
        BrowserStrategyState,
        BrowserStrategyBindings,
        BrowserStrategyEvidence,
        BrowserStrategyCursor
      >,
    ) {
      return {
        conditions: Object.freeze([]),
        nextCursor: null,
        expansion: "closed" as const,
      };
    },

    async executeAtomic(input) {
      const strategy = selectedStrategyFor(resources, input.skill.id);
      if (input.retry === undefined) {
        return failedAtomicReceipt(
          new TypeError("core did not provide a retry selection view"),
        );
      }
      if (!input.retry.eligibleSkillIds.includes(input.skill.id)) {
        return failedAtomicReceipt(
          new TypeError(`strategy skill ${input.skill.id} is not eligible in the core view`),
        );
      }
      try {
        const result = await runBrowserStrategyStep(
          strategyRequest(input.goal, input.state),
          strategyStepResources(resources, input.skill.id, input.retry),
        );
        return atomicReceipt(input, result, strategy);
      } catch (error) {
        return failedAtomicReceipt(error);
      }
    },

    validateAtomicReceipt(raw) {
      const goalRegionRef = registryGoalRegionRef(resources.registry);
      return readAtomicReceipt(raw, {
        state: value => readBrowserStrategyState(value, {
          kind: "SetExpanded",
          regionRef: goalRegionRef,
          desired: true,
        }),
        evidencePayload: readBrowserStrategyEvidence,
        effectFact: readBrowserStrategyEffect,
        receiptPayload: readBrowserStrategyStepReceipt,
      });
    },

    assessRetry(input): RetryAssessment {
      if (input.atomicResult.outcome !== "succeeded"
        || input.atomicResult.executionErrorIds.length !== 0
        || input.atomicResult.verificationErrorIds.length !== 0
        || input.evaluation.result !== "unsatisfied"
        || input.atomicResult.effect.knowledge !== "none") {
        return { kind: "stop", reason: "evidence_insufficient" };
      }
      const source = input.atomicResult.sourceResult;
      if (source === null || !("tag" in source) || source.tag !== "browser.strategy-step.v1") {
        return { kind: "stop", reason: "evidence_insufficient" };
      }
      const result = source.value;
      if (result.feedbackInput === null
        || result.feedback?.status !== "predicted"
        || result.feedback.head !== "completed_without_goal") {
        return { kind: "stop", reason: "unsupported_retry" };
      }
      const strategy = selectedStrategyFor(resources, input.skill.id);
      const current = input.state.browser;
      if (!retryPreconditionsHold(
        result.feedbackInput.request.state,
        current,
        input.goal,
        input.bindings,
        strategy,
      )) {
        return { kind: "stop", reason: "precondition_changed" };
      }
      return {
        kind: "safe_same_failure",
        failureKey: stableFailureKey(input.goal, input.bindings, strategy),
        evidenceRefs: Object.freeze([...input.evaluation.evidenceRefs]),
      };
    },

    measureProgress({
      before,
      after,
      previousEvaluation,
      currentEvaluation,
    }): ProgressReceipt {
      const comparable = before.browser.documentRef === after.browser.documentRef
        && before.browser.scopeRef === after.browser.scopeRef
        && previousEvaluation.satisfaction !== null
        && currentEvaluation.satisfaction !== null;
      const improved = comparable
        && currentEvaluation.satisfaction! > previousEvaluation.satisfaction!;
      return {
        improved,
        reason: improved ? "facts_improved" : "none",
        comparable,
      };
    },

    async collect(input) {
      return resources.collectRoot(input);
    },

    ...(resources.cleanupRoot === undefined
      ? {}
      : {
          async cleanup(input: BrowserStrategyCleanupInput) {
            return resources.cleanupRoot!(input);
          },
        }),
  };
}

export async function runBrowserStrategyGoal(
  rawRequest: unknown,
  resources: BrowserStrategyGoalResources,
): Promise<BrowserStrategyGoalResponse> {
  validateGoalResources(resources);
  const registry = validateRegistry(resources.registry);
  const adapter = createAdapter({ ...resources, registry });
  return runRecursiveGoal<
    BrowserStrategyGoal,
    BrowserStrategyState,
    BrowserStrategyBindings,
    BrowserStrategyEvidence,
    BrowserStrategyEffect,
    BrowserStrategyStepReceipt,
    BrowserStrategyCursor
  >(rawRequest, {
    adapter,
    enabledSkills: enabledSkills(registry),
    enabledEvaluators: enabledEvaluators(),
    selectors: Object.freeze([Object.freeze({
      id: BROWSER_STRATEGY_SELECTOR_ID,
      skillIds: allSkillIds(registry),
    })]),
    comparators: browserStrategyComparators,
    grantedEffects: resources.grantedEffects,
    ...(resources.signal === undefined ? {} : { signal: resources.signal }),
  });
}

export const browserStrategyStepNodeOperators = [
  "browser.strategy.prepare",
  "browser.strategy.feedback",
  "browser.strategy.select",
  "browser.strategy.apply",
  "browser.strategy.report",
] as const satisfies readonly NodeDefinition["operator"][];
