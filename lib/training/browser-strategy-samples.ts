import type {
  BrowserExpansionStrategy,
  BrowserStrategyProfile,
  BrowserStrategyRequest,
  StrategyEpisode,
  StrategyEvaluation,
  StrategyHistory,
} from "../adapters/browser/strategy-contract.js";
import type {
  ActionObservation,
  SingleActionElement,
  SingleActionSnapshot,
} from "../adapters/browser/single-action-contract.js";
import type { FeedbackInput, FeedbackProfile } from "../adapters/browser/feedback-contract.js";
import type { BrowserSingleActionProfile } from "../adapters/browser/single-action-contract.js";
import {
  readBrowserStrategyRequest,
  predictBrowserStrategy,
  readRemainingAtomicAttempts,
} from "../filters/browser-strategy.js";
import { expectRecord } from "../core/schema.js";

const EPISODE_KEYS = ["id", "family", "partition", "input", "registry", "selection", "teacher"] as const;
const TEACHER_KEYS = ["selectedSkillId", "source", "evidenceRefs", "note"] as const;
const REGISTRY_KEYS = [
  "strategyRef",
  "skillId",
  "targetRef",
  "goalRegionRef",
  "equivalenceSetRef",
  "documentRef",
  "scopeRef",
  "operation",
  "evidenceRefs",
] as const;

export interface StrategyEvaluationModels {
  readonly atomicProfile: BrowserSingleActionProfile;
  readonly feedbackProfile: FeedbackProfile;
}

export interface StrategyEpisodePartitions {
  readonly train: readonly StrategyEpisode[];
  readonly development: readonly StrategyEpisode[];
  readonly verification: readonly StrategyEpisode[];
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const strings = value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`));
  if (new Set(strings).size !== strings.length) throw new TypeError(`${label} contains duplicate values`);
  return Object.freeze(strings);
}

function readRegistry(value: unknown): readonly BrowserExpansionStrategy[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError("strategy episode registry must be nonempty");
  return Object.freeze(value.map((raw, index) => {
    const row = expectRecord(raw, `strategy episode registry ${index}`);
    exactKeys(row, REGISTRY_KEYS, `strategy episode registry ${index}`);
    if (row.operation !== "CLICK") throw new TypeError(`strategy episode registry ${index}.operation must be CLICK`);
    return Object.freeze({
      strategyRef: nonEmptyString(row.strategyRef, `strategy episode registry ${index}.strategyRef`),
      skillId: nonEmptyString(row.skillId, `strategy episode registry ${index}.skillId`),
      targetRef: nonEmptyString(row.targetRef, `strategy episode registry ${index}.targetRef`),
      goalRegionRef: nonEmptyString(row.goalRegionRef, `strategy episode registry ${index}.goalRegionRef`),
      equivalenceSetRef: nonEmptyString(row.equivalenceSetRef, `strategy episode registry ${index}.equivalenceSetRef`),
      documentRef: nonEmptyString(row.documentRef, `strategy episode registry ${index}.documentRef`),
      scopeRef: nonEmptyString(row.scopeRef, `strategy episode registry ${index}.scopeRef`),
      operation: "CLICK" as const,
      evidenceRefs: stringArray(row.evidenceRefs, `strategy episode registry ${index}.evidenceRefs`),
    });
  }));
}

function readSelection(value: unknown): StrategyEpisode["selection"] {
  const selection = expectRecord(value, "strategy episode selection");
  exactKeys(selection, ["eligibleSkillIds", "lockedSkillId", "exhaustedSkillIds", "remainingAtomicAttempts"],
    "strategy episode selection");
  const eligibleSkillIds = stringArray(selection.eligibleSkillIds, "strategy episode selection.eligibleSkillIds");
  const exhaustedSkillIds = stringArray(selection.exhaustedSkillIds, "strategy episode selection.exhaustedSkillIds");
  const lockedSkillId = selection.lockedSkillId === null
    ? null
    : nonEmptyString(selection.lockedSkillId, "strategy episode selection.lockedSkillId");
  const remainingAtomicAttempts = readRemainingAtomicAttempts(
    selection.remainingAtomicAttempts,
    "strategy episode selection.remainingAtomicAttempts",
  );
  if (eligibleSkillIds.some(skillId => exhaustedSkillIds.includes(skillId))) {
    throw new TypeError("strategy episode selection contains an exhausted eligible strategy");
  }
  if (lockedSkillId !== null && (eligibleSkillIds.length !== 1 || eligibleSkillIds[0] !== lockedSkillId)) {
    throw new TypeError("strategy episode locked strategy must be the unique eligible strategy");
  }
  return Object.freeze({
    eligibleSkillIds,
    lockedSkillId,
    exhaustedSkillIds,
    remainingAtomicAttempts,
  });
}

function readEpisode(raw: unknown, index: number): StrategyEpisode {
  const row = expectRecord(raw, `strategy episode ${index}`);
  exactKeys(row, EPISODE_KEYS, `strategy episode ${index}`);
  if (!["train", "development", "verification"].includes(String(row.partition))) {
    throw new TypeError(`strategy episode ${index}.partition is invalid`);
  }
  const input = readBrowserStrategyRequest(row.input);
  const registry = readRegistry(row.registry);
  const selection = readSelection(row.selection);
  const skills = new Set(registry.map(strategy => strategy.skillId));
  if ([...selection.eligibleSkillIds, ...selection.exhaustedSkillIds].some(skillId => !skills.has(skillId))) {
    throw new TypeError(`strategy episode ${index} selection references an unregistered strategy`);
  }
  const teacher = expectRecord(row.teacher, `strategy episode ${index}.teacher`);
  exactKeys(teacher, TEACHER_KEYS, `strategy episode ${index}.teacher`);
  const selectedSkillId = teacher.selectedSkillId === null
    ? null
    : nonEmptyString(teacher.selectedSkillId, `strategy episode ${index}.teacher.selectedSkillId`);
  if (selectedSkillId !== null && !selection.eligibleSkillIds.includes(selectedSkillId)) {
    throw new TypeError(`strategy episode ${index} teacher selects a non-eligible strategy`);
  }
  if (teacher.source !== "synthetic_projection" && teacher.source !== "observed_episode") {
    throw new TypeError(`strategy episode ${index}.teacher.source is invalid`);
  }
  const evidenceRefs = stringArray(teacher.evidenceRefs, `strategy episode ${index}.teacher.evidenceRefs`);
  const availableEvidence = new Set([
    ...input.request.state.evidence.map(evidence => evidence.id),
    ...registry.flatMap(strategy => strategy.evidenceRefs),
  ]);
  if (evidenceRefs.length === 0 || evidenceRefs.some(ref => !availableEvidence.has(ref))) {
    throw new TypeError(`strategy episode ${index} teacher evidence is missing or unavailable`);
  }
  return Object.freeze({
    id: nonEmptyString(row.id, `strategy episode ${index}.id`),
    family: nonEmptyString(row.family, `strategy episode ${index}.family`),
    partition: row.partition as StrategyEpisode["partition"],
    input,
    registry,
    selection,
    teacher: Object.freeze({
      selectedSkillId,
      source: teacher.source,
      evidenceRefs,
      note: nonEmptyString(teacher.note, `strategy episode ${index}.teacher.note`),
    }),
  });
}

export function readStrategyEpisodes(value: unknown): readonly StrategyEpisode[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError("strategy episodes must be a nonempty array");
  const episodes = value.map(readEpisode);
  const ids = new Set<string>();
  const families = new Map<string, StrategyEpisode["partition"]>();
  for (const episode of episodes) {
    if (ids.has(episode.id)) throw new TypeError(`duplicate strategy episode id ${episode.id}`);
    ids.add(episode.id);
    const partition = families.get(episode.family);
    if (partition !== undefined && partition !== episode.partition) {
      throw new TypeError(`strategy family ${episode.family} crosses partitions`);
    }
    families.set(episode.family, episode.partition);
  }
  return Object.freeze(episodes);
}

export function partitionStrategyEpisodes(value: readonly StrategyEpisode[]): StrategyEpisodePartitions {
  const episodes = readStrategyEpisodes(value);
  return Object.freeze({
    train: Object.freeze(episodes.filter(episode => episode.partition === "train")),
    development: Object.freeze(episodes.filter(episode => episode.partition === "development")),
    verification: Object.freeze(episodes.filter(episode => episode.partition === "verification")),
  });
}

export function evaluateStrategyCases(
  profile: BrowserStrategyProfile,
  value: readonly StrategyEpisode[],
  models: StrategyEvaluationModels,
): StrategyEvaluation {
  const episodes = readStrategyEpisodes(value);
  const rows = episodes.map(episode => {
    const prediction = predictBrowserStrategy(episode.input, {
      profile,
      atomicProfile: models.atomicProfile,
      feedbackProfile: models.feedbackProfile,
      registry: episode.registry,
      selection: episode.selection,
    });
    const actualSkillId = prediction.kind === "SELECT" ? prediction.skillId : null;
    return {
      id: episode.id,
      expectedSkillId: episode.teacher.selectedSkillId,
      actualSkillId,
      passed: actualSkillId === episode.teacher.selectedSkillId,
      reason: prediction.reason,
    };
  });
  return {
    count: rows.length,
    passed: rows.filter(row => row.passed).length,
    failed: rows.filter(row => !row.passed).length,
    rows,
  };
}

function observed<T>(value: T, evidenceRef: string): ActionObservation<T> {
  return { status: "observed", value, evidenceRefs: [evidenceRef] };
}

function unknown<T>(reason: string): ActionObservation<T> {
  return { status: "unknown", reason };
}

interface StateOptions {
  readonly family: string;
  readonly variant: number;
  readonly observationId: string;
  readonly revision: number;
  readonly expanded?: boolean;
  readonly reverse?: boolean;
  readonly rename?: boolean;
}

interface BuiltState {
  readonly state: SingleActionSnapshot;
  readonly nativeRef: string;
  readonly roleRef: string;
  readonly regionRef: string;
}

function makeState(options: StateOptions): BuiltState {
  const { family, variant, observationId, revision } = options;
  const expanded = options.expanded ?? false;
  const nativeRef = options.rename ? "native-click-target" : "native-target";
  const roleRef = options.rename ? "role-click-target" : "role-target";
  const regionRef = options.rename ? "detail-region" : "region-main";
  const evidence: { readonly id: string; readonly observationId: string; readonly source: string; readonly fact: unknown }[] = [];
  const add = (suffix: string): string => {
    const id = `${observationId}:evidence:${suffix}`;
    evidence.push({
      id,
      observationId,
      source: "synthetic.strategy_projection",
      fact: { family, variant, suffix },
    });
    return id;
  };
  const scopeEvidence = add("scope");
  const nativeEvidence = add("native");
  const roleEvidence = add("role");
  const regionEvidence = add("region");
  const element = (
    ref: string,
    parentRef: string | null,
    tag: string,
    role: string | null,
    basicKind: SingleActionElement["basicKind"],
    controls: ActionObservation<readonly string[]>,
    enabled: ActionObservation<boolean>,
    hit: ActionObservation<boolean>,
    buttonSemantics: ActionObservation<boolean>,
    point: ActionObservation<{ readonly x: number; readonly y: number }>,
    evidenceRefs: readonly string[],
  ): SingleActionElement => ({
    ref,
    parentRef,
    tag,
    role,
    basicKind,
    judgmentStatus: "judged",
    candidateStatus: "ok",
    controls,
    enabled,
    hit,
    buttonSemantics,
    point,
    evidenceRefs,
  });
  const native = element(
    nativeRef,
    "scope",
    "button",
    null,
    "button",
    observed([regionRef], nativeEvidence),
    observed(true, nativeEvidence),
    observed(true, nativeEvidence),
    observed(true, nativeEvidence),
    observed({ x: 28 + variant, y: 36 }, nativeEvidence),
    [nativeEvidence],
  );
  const role = element(
    roleRef,
    "scope",
    "div",
    "button",
    "button",
    observed([regionRef], roleEvidence),
    observed(true, roleEvidence),
    observed(true, roleEvidence),
    observed(true, roleEvidence),
    observed({ x: 48 + variant, y: 36 }, roleEvidence),
    [roleEvidence],
  );
  const targets = [native, role];
  if (options.reverse) targets.reverse();
  return {
    state: {
      documentRef: `document:${family}`,
      observationId,
      revision,
      scopeRef: "scope",
      regions: [{
        ref: regionRef,
        expanded: observed(expanded, regionEvidence),
        rendered: observed(expanded, regionEvidence),
      }],
      elements: [
        element(
          "scope",
          null,
          "main",
          null,
          "container",
          observed([], scopeEvidence),
          unknown("scope is not actionable"),
          unknown("scope has no hit target"),
          observed(false, scopeEvidence),
          unknown("scope has no point"),
          [scopeEvidence],
        ),
        ...targets,
        element(
          regionRef,
          "scope",
          "section",
          "region",
          "container",
          observed([], regionEvidence),
          unknown("region is not actionable"),
          unknown("region has no hit target"),
          observed(false, regionEvidence),
          unknown("region has no point"),
          [regionEvidence],
        ),
      ],
      evidence,
    },
    nativeRef,
    roleRef,
    regionRef,
  };
}

function makeRegistry(built: BuiltState): readonly BrowserExpansionStrategy[] {
  return [
    {
      strategyRef: "strategy:native",
      skillId: "native-click",
      targetRef: built.nativeRef,
      goalRegionRef: built.regionRef,
      equivalenceSetRef: "equivalence:set-expanded",
      documentRef: built.state.documentRef,
      scopeRef: built.state.scopeRef,
      operation: "CLICK",
      evidenceRefs: ["registry-proof:synthetic-equivalence"],
    },
    {
      strategyRef: "strategy:role",
      skillId: "role-click",
      targetRef: built.roleRef,
      goalRegionRef: built.regionRef,
      equivalenceSetRef: "equivalence:set-expanded",
      documentRef: built.state.documentRef,
      scopeRef: built.state.scopeRef,
      operation: "CLICK",
      evidenceRefs: ["registry-proof:synthetic-equivalence"],
    },
  ];
}

type HistoryKind = "safe_failure" | "execution_rejected" | "indeterminate" | "verified_success";

function makeHistory(
  kind: HistoryKind,
  built: BuiltState,
  strategy: BrowserExpansionStrategy,
  family: string,
  variant: number,
): StrategyHistory {
  const preState = makeState({
    family,
    variant,
    observationId: `history:${kind}:pre:${variant}`,
    revision: Math.max(0, built.state.revision - 2),
    expanded: false,
    rename: strategy.targetRef.includes("click-target"),
  });
  const pre: BrowserStrategyRequest["request"] = {
    goal: { kind: "SetExpanded", regionRef: preState.regionRef, desired: true },
    satisfactionThreshold: 100,
    state: preState.state,
  };
  const point = { x: 30 + variant, y: 30 };
  const invocation = {
    kind: "click" as const,
    targetRef: strategy.targetRef,
    point,
    documentRef: pre.state.documentRef,
    observationId: pre.state.observationId,
    revision: pre.state.revision,
  };
  let input: FeedbackInput;
  if (kind === "execution_rejected") {
    input = {
      request: pre,
      result: {
        prediction: null,
        invocation: null,
        receipt: {
          dispatched: false,
          ok: false,
          effectKnowledge: "none",
          source: "synthetic.strategy_projection",
          error: { code: "native_input_rejected", message: "explicit synthetic rejection" },
        },
        dispatchState: "not_dispatched",
        effectKnowledge: "none",
        newState: null,
        satisfaction: null,
        achieved: false,
        error: null,
        collectionError: null,
      },
      controlAtCompletion: null,
    };
  } else if (kind === "indeterminate") {
    input = {
      request: pre,
      result: {
        prediction: null,
        invocation: null,
        receipt: null,
        dispatchState: "unknown",
        effectKnowledge: "unknown",
        newState: null,
        satisfaction: null,
        achieved: false,
        error: { code: "native_click_failed", message: "synthetic uncertain dispatch" },
        collectionError: null,
      },
      controlAtCompletion: null,
    };
  } else {
    const post = makeState({
      family,
      variant,
      observationId: `history:${kind}:post:${variant}`,
      revision: pre.state.revision + 1,
      expanded: kind === "verified_success",
      rename: strategy.targetRef.includes("click-target"),
    });
    input = {
      request: pre,
      result: {
        prediction: null,
        invocation,
        receipt: {
          dispatched: true,
          ok: true,
          effectKnowledge: "known",
          source: "synthetic.strategy_projection",
          error: null,
        },
        dispatchState: "dispatched",
        effectKnowledge: "known",
        newState: post.state,
        satisfaction: kind === "verified_success" ? 100 : 0,
        achieved: kind === "verified_success",
        error: null,
        collectionError: null,
      },
      controlAtCompletion: {
        documentRef: post.state.documentRef,
        observationId: post.state.observationId,
        revision: post.state.revision,
      },
    };
  }
  return {
    strategyRef: strategy.strategyRef,
    skillId: strategy.skillId,
    targetRef: strategy.targetRef,
    equivalenceSetRef: strategy.equivalenceSetRef,
    input,
  };
}

interface Mode {
  readonly id: string;
  readonly partition: "train" | "development";
  readonly eligible: readonly string[];
  readonly locked: string | null;
  readonly exhausted: readonly string[];
  readonly history: readonly { readonly skillId: string; readonly kind: HistoryKind }[];
  readonly selectedSkillId: string | null;
}

const MODES: readonly Mode[] = [
  { id: "native-preference", partition: "train", eligible: ["native-click", "role-click"], locked: null,
    exhausted: [], history: [], selectedSkillId: "native-click" },
  { id: "native-failure-rerank", partition: "train", eligible: ["native-click", "role-click"], locked: null,
    exhausted: [], history: [{ skillId: "native-click", kind: "safe_failure" }], selectedSkillId: "role-click" },
  { id: "locked-native-positive", partition: "train", eligible: ["native-click"], locked: "native-click",
    exhausted: ["role-click"], history: [{ skillId: "native-click", kind: "safe_failure" }], selectedSkillId: "native-click" },
  { id: "exhausted-native-role", partition: "train", eligible: ["role-click"], locked: null,
    exhausted: ["native-click"], history: [], selectedSkillId: "role-click" },
  { id: "locked-role-retry", partition: "train", eligible: ["role-click"], locked: "role-click",
    exhausted: ["native-click"], history: [{ skillId: "role-click", kind: "safe_failure" }], selectedSkillId: "role-click" },
  { id: "prior-role-success", partition: "train", eligible: ["native-click", "role-click"], locked: null,
    exhausted: [], history: [{ skillId: "role-click", kind: "verified_success" }], selectedSkillId: "role-click" },
  { id: "indeterminate-defer", partition: "train", eligible: ["native-click", "role-click"], locked: null,
    exhausted: [], history: [
      { skillId: "native-click", kind: "indeterminate" },
      { skillId: "role-click", kind: "indeterminate" },
    ], selectedSkillId: null },
  { id: "execution-rejected-defer", partition: "train", eligible: ["native-click", "role-click"], locked: null,
    exhausted: [], history: [
      { skillId: "native-click", kind: "execution_rejected" },
      { skillId: "role-click", kind: "execution_rejected" },
    ], selectedSkillId: null },
  { id: "order-reference-pair", partition: "train", eligible: ["native-click", "role-click"], locked: null,
    exhausted: [], history: [], selectedSkillId: "native-click" },
  { id: "development-native-preference", partition: "development", eligible: ["native-click", "role-click"],
    locked: null, exhausted: [], history: [], selectedSkillId: "native-click" },
  { id: "development-role-success", partition: "development", eligible: ["native-click", "role-click"],
    locked: null, exhausted: [], history: [{ skillId: "role-click", kind: "verified_success" }],
    selectedSkillId: "role-click" },
  { id: "development-locked-role-retry", partition: "development", eligible: ["role-click"],
    locked: "role-click", exhausted: ["native-click"],
    history: [{ skillId: "role-click", kind: "safe_failure" }], selectedSkillId: "role-click" },
] as const;

export function makeStrategySamples(): readonly StrategyEpisode[] {
  const episodes: StrategyEpisode[] = [];
  for (const mode of MODES) {
    for (let variant = 0; variant < 4; variant += 1) {
      const id = `strategy-${mode.id}-${String(variant).padStart(2, "0")}`;
      const built = makeState({
        family: `strategy.${mode.id}`,
        variant,
        observationId: `${id}:pre`,
        revision: 2 + variant,
        reverse: variant === 1 || variant === 3,
        rename: variant === 2 || variant === 3,
      });
      const registry = makeRegistry(built);
      const bySkill = new Map(registry.map(strategy => [strategy.skillId, strategy]));
      const history = mode.history.map(item =>
        makeHistory(item.kind, built, bySkill.get(item.skillId)!, `strategy.${mode.id}`, variant));
      const request: BrowserStrategyRequest["request"] = {
        goal: { kind: "SetExpanded", regionRef: built.regionRef, desired: true },
        satisfactionThreshold: 100,
        state: built.state,
      };
      episodes.push({
        id,
        family: `strategy.${mode.id}`,
        partition: mode.partition,
        input: { request, history },
        registry,
        selection: {
          eligibleSkillIds: mode.eligible,
          lockedSkillId: mode.locked,
          exhaustedSkillIds: mode.exhausted,
          remainingAtomicAttempts: 4,
        },
        teacher: {
          selectedSkillId: mode.selectedSkillId,
          source: "synthetic_projection",
          evidenceRefs: [request.state.evidence[0]!.id],
          note: "Explicit synthetic fixture teaching preference; not a real browser trajectory.",
        },
      });
    }
  }
  return readStrategyEpisodes(episodes);
}
