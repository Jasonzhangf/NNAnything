import { expectRecord } from "../../core/schema.js";
import type {
  CliFilesystemSandbox,
  DirectoryRef,
  SemanticCallReceipt,
  SessionRef,
  SessionSnapshot,
} from "./filesystem-sandbox.js";
import {
  readObservedObjectRef,
  type ObservedObjectRef,
  type OsInteger,
} from "./entry-inspection.js";
import type {
  CliCommandFileFilter,
  CliCommandIgnorePolicy,
  CliCommandSearchLimits,
  CommandMatchedLineRecord,
  CommandSpawnLedgerEntry,
} from "./directory-command-search.js";
import type { L2Head, L2Prediction } from "../l2/contracts.js";
import type {
  HybridEInferRequest,
  HybridEInferResult,
} from "../../training/l2-hybrid-package.js";
import { validateCliHybridPackage } from "../../training/l2-hybrid-package.js";
import {
  readVersionedRef,
  sameVersionedRef,
  type VersionedRef,
} from "../../workflow/recursive-goal/planning-contracts.js";
import {
  readRecursiveGoalContinuation,
  type FactSnapshot,
  type RecursiveGoalContinuation,
  type RecursiveGoalContinuationGuards,
  type RecursiveGoalLimits,
} from "../../workflow/recursive-goal/contracts.js";

export const COMMAND_SEARCH_EVIDENCE_KIND = "cli.command-search.observation.v1" as const;
export const COMMAND_SEARCH_EFFECT_KIND = "cli.command-search.effect.v1" as const;

export const COMMAND_SEARCH_R_FEATURE_COUNT = 14;
export const COMMAND_SEARCH_E_FEATURE_COUNT = 19;
export const COMMAND_SEARCH_D_FEATURE_COUNT = 26;
export const COMMAND_SEARCH_A_FEATURE_COUNT = 6;

export const COMMAND_SEARCH_R_LABELS = ["insufficient", "holds", "refuted"] as const;
export const COMMAND_SEARCH_E_LABELS = ["unsatisfied", "satisfied", "unknown"] as const;
export const COMMAND_SEARCH_D_LABELS = [
  "SEARCH_TARGET_S0",
  "READ_TARGET_S0",
  "RETURN_RESULT",
  "REPORT_NO_MATCH",
  "SEARCH_TARGET_S1",
  "READ_TARGET_S1",
  "SEARCH_LITERAL_S0",
  "SEARCH_LITERAL_S1",
] as const;
export const COMMAND_SEARCH_A_LABELS = ["head", "tail", "RETURN", "SEARCH_LITERAL"] as const;

export type CommandSearchCardinality = "one" | "all";
export type CommandSearchGoalKind = "g3.literal-search" | "g2.read";
export type CommandSearchSlot = "s0" | "s1";

export type CommandSearchFollowUpRead =
  | Readonly<{ mode: "lines"; anchor: "head" | "tail"; count: number }>
  | Readonly<{ mode: "bytes"; offset: number; length: number }>;

export type CommandSearchScopeRefs =
  | readonly [DirectoryRef]
  | readonly [DirectoryRef, DirectoryRef];

export type CommandSearchTarget = Readonly<{
  kind: "cli.command-search-scope";
  scopeRefs: CommandSearchScopeRefs;
  fileFilter: CliCommandFileFilter | null;
  ignorePolicy: CliCommandIgnorePolicy;
}>;

export type CommandSearchLiteralGoal = Readonly<{
  kind: "file.property";
  property: "file.property.content.bytes";
  target: CommandSearchTarget;
  requirement: Readonly<{
    kind: "contains_literal";
    queryLiteral: string;
    cardinality: CommandSearchCardinality;
  }>;
}>;

export type CommandSearchTargetGoal = Readonly<{
  kind: "file.property";
  property: "file.property.directory.entries";
  target: Omit<CommandSearchTarget, "fileFilter"> & Readonly<{
    fileFilter: CliCommandFileFilter;
  }>;
  requirement: Readonly<{
    kind: "matches_target";
    cardinality: CommandSearchCardinality;
    followUpRead: CommandSearchFollowUpRead | null;
  }>;
}>;

export type CommandSearchGoal = CommandSearchLiteralGoal | CommandSearchTargetGoal;

export type CommandSearchRequest = Readonly<{
  requestId: string;
  goal: CommandSearchGoal;
}>;

export type CommandSearchGoalMeta = Readonly<{
  goalKind: CommandSearchGoalKind;
  cardinality: CommandSearchCardinality;
  scopeRefs: CommandSearchScopeRefs;
  fileFilter: CliCommandFileFilter | null;
  ignorePolicy: CliCommandIgnorePolicy;
  queryLiteral: string | null;
  followUpRead: CommandSearchFollowUpRead | null;
}>;

export type CommandSearchBindings = Readonly<{
  session: SessionRef;
  scopeRefs: CommandSearchScopeRefs;
  fileFilter: CliCommandFileFilter | null;
  ignorePolicy: CliCommandIgnorePolicy;
  goalKind: CommandSearchGoalKind;
  cardinality: CommandSearchCardinality;
  queryLiteral: string | null;
  followUpRead: CommandSearchFollowUpRead | null;
  modelRef: VersionedRef;
}>;

export type CommandSearchHeadEvaluation = Readonly<{
  features: readonly number[];
  namedFeatures: Readonly<Record<string, number>>;
  logits: readonly number[];
  logitsByLabel: Readonly<Record<string, number>>;
  predictedLabel: string;
}>;

export type CommandSearchEEvaluation = Readonly<{
  features: readonly number[];
  namedFeatures: Readonly<Record<string, number>>;
  readGate: 0 | 1;
  literalGate: 0 | 1;
  predictedLabel: string;
  rawPredictedLabel: string;
  rawLogits: readonly number[];
  routedLogits: readonly number[];
  rawPartialDiagnostic?: CommandSearchHeadEvaluation;
  rawUnmaskedPartialDiagnostic?: CommandSearchEEvaluation;
}>;

export type CommandSearchStepReceipt = Readonly<{
  slot: CommandSearchSlot;
  operation:
    | "directory.search.entries"
    | "directory.search.content"
    | "file.read"
    | "file.read.lines";
}>;

export type CommandSearchSlotREvaluation = CommandSearchHeadEvaluation & Readonly<{
  rawPartialDiagnostic?: CommandSearchHeadEvaluation | null;
}>;

export type CommandSearchRdeaStep = Readonly<{
  stepIndex: number;
  R: Readonly<{
    s0: CommandSearchSlotREvaluation;
    s1: CommandSearchSlotREvaluation | null;
  }>;
  E: CommandSearchEEvaluation;
  D: CommandSearchHeadEvaluation | null;
  A: CommandSearchHeadEvaluation | null;
  commandReceipt: CommandSearchStepReceipt | null;
}>;

export type CommandSearchSlotFact = Readonly<{
  slot: CommandSearchSlot;
  operation: "directory.search.entries" | "directory.search.content";
  directory: DirectoryRef;
  toolUsed: "rg" | "rg_files" | "grep_bsd" | "grep_gnu" | "find_P";
  exitCode: number | null;
  queryMatches: 1;
  normalCompleted: boolean;
  coverage: "complete" | "partial";
  reasons: readonly string[];
  matchedEntries: readonly string[];
  matchedLines: readonly CommandMatchedLineRecord[];
  stdoutBytesRead: number;
  stdoutChunkCount: number;
  crossChunkRecordSplits: number;
  unterminatedRemainderBytes: number;
  unterminatedFragmentDiscarded: boolean;
}>;

export type CommandSearchReadFact = Readonly<{
  slot: CommandSearchSlot;
  relPath: string;
  fileRef: ObservedObjectRef;
  operation: "file.read" | "file.read.lines";
  bytesRead: number;
  logicalLines: number | null;
  bytesBase64: string;
  identity: Readonly<{ dev: OsInteger; ino: OsInteger }>;
}>;

export type CommandSearchState = Readonly<{
  stateId: string;
  session: SessionSnapshot;
  goalKind: CommandSearchGoalKind;
  cardinality: CommandSearchCardinality;
  s1Enabled: boolean;
  lastSearchedSlot: CommandSearchSlot | null;
  slotReceipts: Readonly<{
    s0: CommandSearchSlotFact | null;
    s1: CommandSearchSlotFact | null;
  }>;
  readReceipt: CommandSearchReadFact | null;
  issuedRefs: readonly ObservedObjectRef[];
  spawnLedger: readonly CommandSpawnLedgerEntry[];
  stepTrace: readonly CommandSearchRdeaStep[];
}>;

export type CommandSearchEvidencePayload = Readonly<{
  kind: typeof COMMAND_SEARCH_EVIDENCE_KIND;
  transitionId: string;
  stateId: string;
  receipt: SemanticCallReceipt;
}>;

export type CommandSearchEffectFact = Readonly<{
  kind: typeof COMMAND_SEARCH_EFFECT_KIND;
  transitionId: string;
  runId: string | null;
  invoked: boolean;
}>;

export type CommandSearchCursor = Readonly<{
  phase: "evaluate" | "derive" | "execute" | "closed";
}>;

export type CommandSearchDomainProjection = Readonly<{
  status: "achieved" | "unmet" | "unknown" | "rejected" | "failed";
  resolution:
    | "matched"
    | "not_found"
    | "partial"
    | "insufficient_evidence"
    | "budget_exhausted"
    | "interrupted"
    | "rejected"
    | "failed";
  satisfaction: 100 | 0 | null;
  coverage: "complete" | "partial" | null;
  reasons: readonly string[];
  matchedEntries: readonly string[];
  matchedLines: readonly CommandMatchedLineRecord[];
  readReceipt: CommandSearchReadFact | null;
  issuedRefs: readonly ObservedObjectRef[];
  searchCommandSpawns: number;
  probeCommandSpawns: number;
  totalProcessSpawns: number;
  spawnLedger: readonly CommandSpawnLedgerEntry[];
  stepTrace: readonly CommandSearchRdeaStep[];
  modelMetadata: Readonly<{
    ref: VersionedRef;
    schema: "cli.hybrid-package.v1";
    calibration: "uncalibrated";
    adoption: "not_applied";
  }>;
  preserve: Readonly<{
    rootEvaluation: unknown;
    control: unknown;
    frames: unknown;
    atomicResults: unknown;
    effects: unknown;
    errors: unknown;
    primaryErrorId: string | null;
    budgetUsed: unknown;
    continuation: unknown;
  }>;
}>;

export type CliHybridSearchModelLike = Readonly<{
  kind: "cli.hybrid-search.model";
  ref: VersionedRef;
  schema: "cli.hybrid-package.v1";
  calibration: "uncalibrated";
  adoption: "not_applied";
  handwiredRoot: string;
  packagePath: string | null;
  package: Readonly<Record<string, unknown>>;
  profile: Readonly<Record<string, unknown>>;
  inferE: (request: HybridEInferRequest) => HybridEInferResult;
  inferHead: (head: L2Head, features: readonly number[]) => L2Prediction;
}>;

export type CommandSearchResources = Readonly<{
  sandbox: CliFilesystemSandbox;
  session: SessionRef;
  l2Model: CliHybridSearchModelLike;
  explicitLimits?: CliCommandSearchLimits;
  limits?: RecursiveGoalLimits;
  continuation?: unknown;
  signal?: AbortSignal;
}>;

export type CommandSearchRunResult = Readonly<{
  request: CommandSearchRequest;
  response: unknown;
  domain: CommandSearchDomainProjection;
}>;

export type CommandSearchContinuation = RecursiveGoalContinuation<
  CommandSearchGoal,
  CommandSearchState,
  CommandSearchBindings,
  CommandSearchEvidencePayload,
  CommandSearchEffectFact,
  SemanticCallReceipt,
  CommandSearchCursor
>;

export type CommandSearchDomainGuards = RecursiveGoalContinuationGuards<
  CommandSearchGoal,
  CommandSearchState,
  CommandSearchBindings,
  CommandSearchEvidencePayload,
  CommandSearchEffectFact,
  SemanticCallReceipt,
  CommandSearchCursor
> & Readonly<{
  sameFacts: (
    left: FactSnapshot<CommandSearchState, CommandSearchEvidencePayload>,
    right: FactSnapshot<CommandSearchState, CommandSearchEvidencePayload>,
  ) => boolean;
}>;

function record(value: unknown, label: string): Record<string, unknown> {
  return expectRecord(value, label);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty string without NUL`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function exactKeysWithOptional(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${label}.${key} is required`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} contains unsupported field ${key}`);
  }
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  const integer = nonnegativeInteger(value, label);
  if (integer === 0) throw new TypeError(`${label} must be a positive safe integer`);
  return integer;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function osInteger(value: unknown, label: string): OsInteger {
  if (value === null) return null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer`);
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
  throw new TypeError(`${label} must be a safe integer, decimal string, or null`);
}

function finiteArray(
  value: unknown,
  label: string,
  expectedLength: number | null = null,
): number[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (expectedLength !== null && value.length !== expectedLength) {
    throw new TypeError(`${label} must have length ${expectedLength}`);
  }
  return value.map((item, index) => finiteNumber(item, `${label}[${index}]`));
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map((item, index) => nonEmpty(item, `${label}[${index}]`));
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${label} must not contain duplicate entries`);
  }
}

function sessionRef(value: unknown, label: string): SessionRef {
  const input = record(value, label);
  exactKeys(input, ["kind", "scenarioId", "sessionId"], label);
  if (input.kind !== "cli.session") throw new TypeError(`${label} must be a cli.session reference`);
  return Object.freeze({
    kind: "cli.session",
    scenarioId: nonEmpty(input.scenarioId, `${label}.scenarioId`),
    sessionId: nonEmpty(input.sessionId, `${label}.sessionId`),
  });
}

function sessionSnapshot(value: unknown, label: string): SessionSnapshot {
  const input = record(value, label);
  exactKeys(input, ["id", "cwd", "revision", "grantedEffects"], label);
  if (!Array.isArray(input.grantedEffects) || input.grantedEffects.some(effect => typeof effect !== "string")) {
    throw new TypeError(`${label}.grantedEffects must be a string array`);
  }
  return Object.freeze({
    id: nonEmpty(input.id, `${label}.id`),
    cwd: nonEmpty(input.cwd, `${label}.cwd`),
    revision: nonnegativeInteger(input.revision, `${label}.revision`),
    grantedEffects: Object.freeze([...input.grantedEffects] as SessionSnapshot["grantedEffects"]),
  });
}

function directoryRef(value: unknown, label: string): DirectoryRef {
  const input = record(value, label);
  exactKeys(input, ["kind", "scenarioId", "sessionId", "path"], label);
  if (input.kind !== "cli.directory") throw new TypeError(`${label} must be a cli.directory reference`);
  return Object.freeze({
    kind: "cli.directory",
    scenarioId: nonEmpty(input.scenarioId, `${label}.scenarioId`),
    sessionId: nonEmpty(input.sessionId, `${label}.sessionId`),
    path: nonEmpty(input.path, `${label}.path`),
  });
}

function scopeRefs(value: unknown, label: string): CommandSearchScopeRefs {
  if (!Array.isArray(value) || (value.length !== 1 && value.length !== 2)) {
    throw new TypeError(`${label} must contain one or two directory references`);
  }
  const refs = value.map((item, index) => directoryRef(item, `${label}[${index}]`));
  const keys = refs.map(ref => `${ref.scenarioId}\0${ref.sessionId}\0${ref.path}`);
  assertUnique(keys, label);
  return Object.freeze(refs) as CommandSearchScopeRefs;
}

function commandSearchFileFilter(value: unknown, label: string): CliCommandFileFilter | null {
  if (value === null) return null;
  const input = record(value, label);
  const hasExact = Object.hasOwn(input, "exactBasename") && input.exactBasename !== undefined;
  const hasSuffix = Object.hasOwn(input, "suffix") && input.suffix !== undefined;
  if (hasExact && hasSuffix) throw new TypeError(`${label} must not set both exactBasename and suffix`);
  if (hasExact) {
    exactKeys(input, ["exactBasename"], label);
    const name = nonEmpty(input.exactBasename, `${label}.exactBasename`);
    if (name.includes("/")) throw new TypeError(`${label}.exactBasename must be a single name`);
    return Object.freeze({ exactBasename: name });
  }
  if (hasSuffix) {
    exactKeys(input, ["suffix"], label);
    const suffix = nonEmpty(input.suffix, `${label}.suffix`);
    if (suffix.includes("/")) throw new TypeError(`${label}.suffix must not contain a path separator`);
    return Object.freeze({ suffix });
  }
  exactKeys(input, [], label);
  return Object.freeze({});
}

function ignorePolicy(value: unknown, label: string): CliCommandIgnorePolicy {
  if (value !== "no_ignore" && value !== "respect_vcs_ignore") {
    throw new TypeError(`${label} must be no_ignore or respect_vcs_ignore`);
  }
  return value;
}

function cardinality(value: unknown, label: string): CommandSearchCardinality {
  if (value !== "one" && value !== "all") {
    throw new TypeError(`${label} must be one or all`);
  }
  return value;
}

function followUpRead(value: unknown, label: string): CommandSearchFollowUpRead | null {
  if (value === null) return null;
  const input = record(value, label);
  if (input.mode === "lines") {
    exactKeys(input, ["mode", "anchor", "count"], label);
    if (input.anchor !== "head" && input.anchor !== "tail") {
      throw new TypeError(`${label}.anchor must be head or tail`);
    }
    return Object.freeze({
      mode: "lines",
      anchor: input.anchor,
      count: positiveInteger(input.count, `${label}.count`),
    });
  }
  if (input.mode === "bytes") {
    exactKeys(input, ["mode", "offset", "length"], label);
    return Object.freeze({
      mode: "bytes",
      offset: nonnegativeInteger(input.offset, `${label}.offset`),
      length: positiveInteger(input.length, `${label}.length`),
    });
  }
  throw new TypeError(`${label}.mode must be lines or bytes`);
}

function searchLimits(value: unknown, label: string): CliCommandSearchLimits {
  const input = record(value, label);
  exactKeysWithOptional(input, [], ["maxStdoutBytes", "maxDepth", "timeoutMs"], label);
  const result: { maxStdoutBytes?: number; maxDepth?: number; timeoutMs?: number } = {};
  if (Object.hasOwn(input, "maxStdoutBytes") && input.maxStdoutBytes !== undefined) {
    result.maxStdoutBytes = nonnegativeInteger(input.maxStdoutBytes, `${label}.maxStdoutBytes`);
  }
  if (Object.hasOwn(input, "maxDepth") && input.maxDepth !== undefined) {
    result.maxDepth = nonnegativeInteger(input.maxDepth, `${label}.maxDepth`);
  }
  if (Object.hasOwn(input, "timeoutMs") && input.timeoutMs !== undefined) {
    result.timeoutMs = positiveInteger(input.timeoutMs, `${label}.timeoutMs`);
  }
  return Object.freeze(result);
}

function recursiveGoalLimits(value: unknown, label: string): RecursiveGoalLimits {
  const input = record(value, label);
  exactKeysWithOptional(input, [], ["maxTransitions", "maxDepth", "maxDerivedGoals"], label);
  const result: { maxTransitions?: number; maxDepth?: number; maxDerivedGoals?: number } = {};
  if (Object.hasOwn(input, "maxTransitions") && input.maxTransitions !== undefined) {
    result.maxTransitions = positiveInteger(input.maxTransitions, `${label}.maxTransitions`);
  }
  if (Object.hasOwn(input, "maxDepth") && input.maxDepth !== undefined) {
    result.maxDepth = positiveInteger(input.maxDepth, `${label}.maxDepth`);
  }
  if (Object.hasOwn(input, "maxDerivedGoals") && input.maxDerivedGoals !== undefined) {
    result.maxDerivedGoals = positiveInteger(input.maxDerivedGoals, `${label}.maxDerivedGoals`);
  }
  return Object.freeze(result);
}

export function validateCommandSearchRequest(value: unknown): CommandSearchRequest {
  const request = record(value, "command search request");
  exactKeys(request, ["requestId", "goal"], "command search request");
  const goal = record(request.goal, "command search goal");
  exactKeys(goal, ["kind", "property", "target", "requirement"], "command search goal");
  if (goal.kind !== "file.property") throw new TypeError("command search goal.kind must be file.property");
  const target = record(goal.target, "command search goal.target");
  exactKeys(target, ["kind", "scopeRefs", "fileFilter", "ignorePolicy"], "command search goal.target");
  if (target.kind !== "cli.command-search-scope") {
    throw new TypeError("command search goal.target.kind must be cli.command-search-scope");
  }
  const refs = scopeRefs(target.scopeRefs, "command search goal.target.scopeRefs");
  const filter = commandSearchFileFilter(target.fileFilter, "command search goal.target.fileFilter");
  const policy = ignorePolicy(target.ignorePolicy, "command search goal.target.ignorePolicy");
  const requirement = record(goal.requirement, "command search goal.requirement");

  if (goal.property === "file.property.content.bytes") {
    exactKeys(requirement, ["kind", "queryLiteral", "cardinality"], "command search goal.requirement");
    if (requirement.kind !== "contains_literal") {
      throw new TypeError("command search literal requirement.kind must be contains_literal");
    }
    const queryLiteral = nonEmpty(requirement.queryLiteral, "command search goal.requirement.queryLiteral");
    if (/[\r\n]/.test(queryLiteral)) {
      throw new TypeError("command search goal.requirement.queryLiteral must not contain CR or LF");
    }
    const requestedCardinality = cardinality(
      requirement.cardinality,
      "command search goal.requirement.cardinality",
    );
    if (refs.length > 1 && requestedCardinality === "all") {
      throw new TypeError("command search multi-scope cardinality all is not supported in this slice");
    }
    return Object.freeze({
      requestId: nonEmpty(request.requestId, "command search request.requestId"),
      goal: Object.freeze({
        kind: "file.property",
        property: "file.property.content.bytes",
        target: Object.freeze({
          kind: "cli.command-search-scope",
          scopeRefs: refs,
          fileFilter: filter,
          ignorePolicy: policy,
        }),
        requirement: Object.freeze({
          kind: "contains_literal",
          queryLiteral,
          cardinality: requestedCardinality,
        }),
      }),
    });
  }

  if (goal.property === "file.property.directory.entries") {
    exactKeys(requirement, ["kind", "cardinality", "followUpRead"], "command search goal.requirement");
    if (requirement.kind !== "matches_target") {
      throw new TypeError("command search target requirement.kind must be matches_target");
    }
    if (filter === null) {
      throw new TypeError("command search target goal.target.fileFilter must not be null");
    }
    const requestedCardinality = cardinality(
      requirement.cardinality,
      "command search goal.requirement.cardinality",
    );
    if (refs.length > 1 && requestedCardinality === "all") {
      throw new TypeError("command search multi-scope cardinality all is not supported in this slice");
    }
    return Object.freeze({
      requestId: nonEmpty(request.requestId, "command search request.requestId"),
      goal: Object.freeze({
        kind: "file.property",
        property: "file.property.directory.entries",
        target: Object.freeze({
          kind: "cli.command-search-scope",
          scopeRefs: refs,
          fileFilter: filter,
          ignorePolicy: policy,
        }),
        requirement: Object.freeze({
          kind: "matches_target",
          cardinality: requestedCardinality,
          followUpRead: followUpRead(requirement.followUpRead, "command search goal.requirement.followUpRead"),
        }),
      }),
    });
  }

  throw new TypeError("command search goal.property is not supported");
}

export function commandSearchGoalMeta(request: CommandSearchRequest): CommandSearchGoalMeta {
  const goal = request.goal;
  const target = goal.target;
  if (goal.property === "file.property.content.bytes") {
    return Object.freeze({
      goalKind: "g3.literal-search",
      cardinality: goal.requirement.cardinality,
      scopeRefs: target.scopeRefs,
      fileFilter: target.fileFilter,
      ignorePolicy: target.ignorePolicy,
      queryLiteral: goal.requirement.queryLiteral,
      followUpRead: null,
    });
  }
  return Object.freeze({
    goalKind: "g2.read",
    cardinality: goal.requirement.cardinality,
    scopeRefs: target.scopeRefs,
    fileFilter: target.fileFilter,
    ignorePolicy: target.ignorePolicy,
    queryLiteral: null,
    followUpRead: goal.requirement.followUpRead,
  });
}

export function validateCommandSearchBindings(
  value: unknown,
  session: SessionRef,
  expectedModelRef: VersionedRef,
): CommandSearchBindings {
  const input = record(value, "command search bindings");
  exactKeys(
    input,
    [
      "session",
      "scopeRefs",
      "fileFilter",
      "ignorePolicy",
      "goalKind",
      "cardinality",
      "queryLiteral",
      "followUpRead",
      "modelRef",
    ],
    "command search bindings",
  );
  const boundSession = sessionRef(input.session, "command search bindings.session");
  if (boundSession.scenarioId !== session.scenarioId || boundSession.sessionId !== session.sessionId) {
    throw new TypeError("command search bindings.session must match the bound session");
  }
  const refs = scopeRefs(input.scopeRefs, "command search bindings.scopeRefs");
  if (refs.some(ref => ref.scenarioId !== session.scenarioId || ref.sessionId !== session.sessionId)) {
    throw new TypeError("command search bindings.scopeRefs must belong to the bound session");
  }
  if (input.goalKind !== "g3.literal-search" && input.goalKind !== "g2.read") {
    throw new TypeError("command search bindings.goalKind is invalid");
  }
  const requestedCardinality = cardinality(input.cardinality, "command search bindings.cardinality");
  if (refs.length > 1 && requestedCardinality === "all") {
    throw new TypeError("command search multi-scope cardinality all is not supported in this slice");
  }
  const modelRef = readVersionedRef(input.modelRef, "command search bindings.modelRef");
  if (!sameVersionedRef(modelRef, expectedModelRef)) {
    throw new TypeError("command search bindings.modelRef does not match the injected model");
  }
  const queryLiteral =
    input.queryLiteral === null
      ? null
      : nonEmpty(input.queryLiteral, "command search bindings.queryLiteral");
  if (input.goalKind === "g3.literal-search" && queryLiteral === null) {
    throw new TypeError("literal command search bindings require queryLiteral");
  }
  if (input.goalKind === "g2.read" && queryLiteral !== null) {
    throw new TypeError("target command search bindings must not carry queryLiteral");
  }
  if (queryLiteral !== null && /[\r\n]/.test(queryLiteral)) {
    throw new TypeError("command search bindings.queryLiteral must not contain CR or LF");
  }
  const fileFilter = commandSearchFileFilter(input.fileFilter, "command search bindings.fileFilter");
  if (input.goalKind === "g2.read" && fileFilter === null) {
    throw new TypeError("target command search bindings.fileFilter must not be null");
  }
  return Object.freeze({
    session: boundSession,
    scopeRefs: refs,
    fileFilter,
    ignorePolicy: ignorePolicy(input.ignorePolicy, "command search bindings.ignorePolicy"),
    goalKind: input.goalKind,
    cardinality: requestedCardinality,
    queryLiteral,
    followUpRead: followUpRead(input.followUpRead, "command search bindings.followUpRead"),
    modelRef,
  });
}

function readMatchedLine(value: unknown, label: string): CommandMatchedLineRecord {
  const input = record(value, label);
  exactKeys(
    input,
    ["relPath", "lineNumber", "lineByteLength", "lineText", "matchedLineHasTrailingLF"],
    label,
  );
  const trailing = input.matchedLineHasTrailingLF;
  if (typeof trailing !== "boolean" && trailing !== "unobservable_in_grep_stream") {
    throw new TypeError(`${label}.matchedLineHasTrailingLF is invalid`);
  }
  return Object.freeze({
    relPath: nonEmpty(input.relPath, `${label}.relPath`),
    lineNumber: positiveInteger(input.lineNumber, `${label}.lineNumber`),
    lineByteLength: nonnegativeInteger(input.lineByteLength, `${label}.lineByteLength`),
    lineText: typeof input.lineText === "string" ? input.lineText : (() => {
      throw new TypeError(`${label}.lineText must be a string`);
    })(),
    matchedLineHasTrailingLF: trailing,
  });
}

export function readCommandSearchSlotFact(
  value: unknown,
  goalKind: CommandSearchGoalKind,
  label = "command search slot fact",
): CommandSearchSlotFact {
  const input = record(value, label);
  exactKeys(
    input,
    [
      "slot",
      "operation",
      "directory",
      "toolUsed",
      "exitCode",
      "queryMatches",
      "normalCompleted",
      "coverage",
      "reasons",
      "matchedEntries",
      "matchedLines",
      "stdoutBytesRead",
      "stdoutChunkCount",
      "crossChunkRecordSplits",
      "unterminatedRemainderBytes",
      "unterminatedFragmentDiscarded",
    ],
    label,
  );
  if (input.slot !== "s0" && input.slot !== "s1") throw new TypeError(`${label}.slot is invalid`);
  const expectedOperation =
    goalKind === "g3.literal-search" ? "directory.search.content" : "directory.search.entries";
  if (input.operation !== expectedOperation) {
    throw new TypeError(`${label}.operation must be ${expectedOperation} for ${goalKind}`);
  }
  const allowedTools =
    goalKind === "g3.literal-search"
      ? new Set(["rg", "grep_bsd", "grep_gnu"])
      : new Set(["rg_files", "find_P"]);
  if (!allowedTools.has(String(input.toolUsed))) {
    throw new TypeError(`${label}.toolUsed is invalid for ${goalKind}`);
  }
  if (input.queryMatches !== 1) throw new TypeError(`${label}.queryMatches must be 1`);
  if (typeof input.normalCompleted !== "boolean") {
    throw new TypeError(`${label}.normalCompleted must be a boolean`);
  }
  if (input.coverage !== "complete" && input.coverage !== "partial") {
    throw new TypeError(`${label}.coverage must be complete or partial`);
  }
  if (input.exitCode !== null) nonnegativeInteger(input.exitCode, `${label}.exitCode`);
  if (typeof input.unterminatedFragmentDiscarded !== "boolean") {
    throw new TypeError(`${label}.unterminatedFragmentDiscarded must be a boolean`);
  }
  const matchedEntries = stringArray(input.matchedEntries, `${label}.matchedEntries`);
  assertUnique(matchedEntries, `${label}.matchedEntries`);
  if (!Array.isArray(input.matchedLines)) throw new TypeError(`${label}.matchedLines must be an array`);
  return Object.freeze({
    slot: input.slot,
    operation: expectedOperation,
    directory: directoryRef(input.directory, `${label}.directory`),
    toolUsed: input.toolUsed as CommandSearchSlotFact["toolUsed"],
    exitCode: input.exitCode as number | null,
    queryMatches: 1,
    normalCompleted: input.normalCompleted,
    coverage: input.coverage,
    reasons: Object.freeze(stringArray(input.reasons, `${label}.reasons`)),
    matchedEntries: Object.freeze(matchedEntries),
    matchedLines: Object.freeze(
      input.matchedLines.map((item, index) => readMatchedLine(item, `${label}.matchedLines[${index}]`)),
    ),
    stdoutBytesRead: nonnegativeInteger(input.stdoutBytesRead, `${label}.stdoutBytesRead`),
    stdoutChunkCount: nonnegativeInteger(input.stdoutChunkCount, `${label}.stdoutChunkCount`),
    crossChunkRecordSplits: nonnegativeInteger(
      input.crossChunkRecordSplits,
      `${label}.crossChunkRecordSplits`,
    ),
    unterminatedRemainderBytes: nonnegativeInteger(
      input.unterminatedRemainderBytes,
      `${label}.unterminatedRemainderBytes`,
    ),
    unterminatedFragmentDiscarded: input.unterminatedFragmentDiscarded,
  });
}

export function readCommandSearchReadFact(
  value: unknown,
  label = "command search read fact",
): CommandSearchReadFact {
  const input = record(value, label);
  exactKeys(
    input,
    ["slot", "relPath", "fileRef", "operation", "bytesRead", "logicalLines", "bytesBase64", "identity"],
    label,
  );
  if (input.slot !== "s0" && input.slot !== "s1") throw new TypeError(`${label}.slot is invalid`);
  if (input.operation !== "file.read" && input.operation !== "file.read.lines") {
    throw new TypeError(`${label}.operation must be file.read or file.read.lines`);
  }
  const fileRef = readObservedObjectRef(input.fileRef);
  if (fileRef.kind !== "cli.file" || fileRef.type !== "regular") {
    throw new TypeError(`${label}.fileRef must be a bound regular cli.file reference`);
  }
  const identity = record(input.identity, `${label}.identity`);
  exactKeys(identity, ["dev", "ino"], `${label}.identity`);
  const dev = osInteger(identity.dev, `${label}.identity.dev`);
  const ino = osInteger(identity.ino, `${label}.identity.ino`);
  if (String(fileRef.identity.dev) !== String(dev) || String(fileRef.identity.ino) !== String(ino)) {
    throw new TypeError(`${label}.identity does not match fileRef.identity`);
  }
  if (typeof input.bytesBase64 !== "string") {
    throw new TypeError(`${label}.bytesBase64 must be a string`);
  }
  return Object.freeze({
    slot: input.slot,
    relPath: nonEmpty(input.relPath, `${label}.relPath`),
    fileRef,
    operation: input.operation,
    bytesRead: nonnegativeInteger(input.bytesRead, `${label}.bytesRead`),
    logicalLines:
      input.logicalLines === null
        ? null
        : nonnegativeInteger(input.logicalLines, `${label}.logicalLines`),
    bytesBase64: input.bytesBase64,
    identity: Object.freeze({ dev, ino }),
  });
}

function headEvaluation(
  value: unknown,
  label: string,
  featureCount: number,
  labelCount: number,
  allowedLabels: readonly string[],
): CommandSearchHeadEvaluation {
  const input = record(value, label);
  exactKeys(input, ["features", "namedFeatures", "logits", "logitsByLabel", "predictedLabel"], label);
  const features = finiteArray(input.features, `${label}.features`, featureCount);
  const namedFeatures = record(input.namedFeatures, `${label}.namedFeatures`);
  if (Object.keys(namedFeatures).length !== featureCount) {
    throw new TypeError(`${label}.namedFeatures must contain ${featureCount} entries`);
  }
  for (const [name, raw] of Object.entries(namedFeatures)) {
    finiteNumber(raw, `${label}.namedFeatures.${name}`);
  }
  const logits = finiteArray(input.logits, `${label}.logits`, labelCount);
  const logitsByLabel = record(input.logitsByLabel, `${label}.logitsByLabel`);
  if (Object.keys(logitsByLabel).length !== labelCount) {
    throw new TypeError(`${label}.logitsByLabel must contain ${labelCount} entries`);
  }
  for (const [name, raw] of Object.entries(logitsByLabel)) {
    finiteNumber(raw, `${label}.logitsByLabel.${name}`);
  }
  const predictedLabel = nonEmpty(input.predictedLabel, `${label}.predictedLabel`);
  if (!allowedLabels.includes(predictedLabel)) {
    throw new TypeError(`${label}.predictedLabel is not a valid head label`);
  }
  return Object.freeze({
    features: Object.freeze(features),
    namedFeatures: Object.freeze({ ...namedFeatures }) as Readonly<Record<string, number>>,
    logits: Object.freeze(logits),
    logitsByLabel: Object.freeze({ ...logitsByLabel }) as Readonly<Record<string, number>>,
    predictedLabel,
  });
}

function eEvaluation(value: unknown, label: string): CommandSearchEEvaluation {
  const input = record(value, label);
  exactKeysWithOptional(
    input,
    [
      "features",
      "namedFeatures",
      "readGate",
      "literalGate",
      "predictedLabel",
      "rawPredictedLabel",
      "rawLogits",
      "routedLogits",
    ],
    ["rawPartialDiagnostic", "rawUnmaskedPartialDiagnostic"],
    label,
  );
  const features = finiteArray(input.features, `${label}.features`, COMMAND_SEARCH_E_FEATURE_COUNT);
  const namedFeatures = record(input.namedFeatures, `${label}.namedFeatures`);
  if (Object.keys(namedFeatures).length !== COMMAND_SEARCH_E_FEATURE_COUNT) {
    throw new TypeError(`${label}.namedFeatures must contain ${COMMAND_SEARCH_E_FEATURE_COUNT} entries`);
  }
  for (const [name, raw] of Object.entries(namedFeatures)) {
    finiteNumber(raw, `${label}.namedFeatures.${name}`);
  }
  if (input.readGate !== 0 && input.readGate !== 1) {
    throw new TypeError(`${label}.readGate must be 0 or 1`);
  }
  if (input.literalGate !== 0 && input.literalGate !== 1) {
    throw new TypeError(`${label}.literalGate must be 0 or 1`);
  }
  if (input.readGate === 1 && input.literalGate === 1) {
    throw new TypeError(`${label} cannot activate both readGate and literalGate`);
  }
  const predictedLabel = nonEmpty(input.predictedLabel, `${label}.predictedLabel`);
  const rawPredictedLabel = nonEmpty(input.rawPredictedLabel, `${label}.rawPredictedLabel`);
  if (!COMMAND_SEARCH_E_LABELS.includes(predictedLabel as never)) {
    throw new TypeError(`${label}.predictedLabel is not a valid E label`);
  }
  if (!COMMAND_SEARCH_E_LABELS.includes(rawPredictedLabel as never)) {
    throw new TypeError(`${label}.rawPredictedLabel is not a valid E label`);
  }
  const rawPartialDiagnostic = Object.hasOwn(input, "rawPartialDiagnostic")
    ? headEvaluation(
        input.rawPartialDiagnostic,
        `${label}.rawPartialDiagnostic`,
        COMMAND_SEARCH_R_FEATURE_COUNT,
        COMMAND_SEARCH_R_LABELS.length,
        COMMAND_SEARCH_R_LABELS,
      )
    : undefined;
  const rawUnmaskedPartialDiagnostic = Object.hasOwn(input, "rawUnmaskedPartialDiagnostic")
    ? eEvaluation(input.rawUnmaskedPartialDiagnostic, `${label}.rawUnmaskedPartialDiagnostic`)
    : undefined;
  return Object.freeze({
    features: Object.freeze(features),
    namedFeatures: Object.freeze({ ...namedFeatures }) as Readonly<Record<string, number>>,
    readGate: input.readGate,
    literalGate: input.literalGate,
    predictedLabel,
    rawPredictedLabel,
    rawLogits: Object.freeze(finiteArray(input.rawLogits, `${label}.rawLogits`, COMMAND_SEARCH_E_LABELS.length)),
    routedLogits: Object.freeze(
      finiteArray(input.routedLogits, `${label}.routedLogits`, COMMAND_SEARCH_E_LABELS.length),
    ),
    ...(rawPartialDiagnostic === undefined ? {} : { rawPartialDiagnostic }),
    ...(rawUnmaskedPartialDiagnostic === undefined ? {} : { rawUnmaskedPartialDiagnostic }),
  });
}

function slotREvaluation(value: unknown, label: string): CommandSearchSlotREvaluation {
  const input = record(value, label);
  const headKeys = ["features", "namedFeatures", "logits", "logitsByLabel", "predictedLabel"] as const;
  exactKeysWithOptional(input, headKeys, ["rawPartialDiagnostic"], label);
  const head = headEvaluation(
    Object.fromEntries(headKeys.map(key => [key, input[key]])),
    label,
    COMMAND_SEARCH_R_FEATURE_COUNT,
    COMMAND_SEARCH_R_LABELS.length,
    COMMAND_SEARCH_R_LABELS,
  );
  if (!Object.hasOwn(input, "rawPartialDiagnostic") || input.rawPartialDiagnostic === null) {
    return head;
  }
  const rawPartialDiagnostic = headEvaluation(
    input.rawPartialDiagnostic,
    `${label}.rawPartialDiagnostic`,
    COMMAND_SEARCH_R_FEATURE_COUNT,
    COMMAND_SEARCH_R_LABELS.length,
    COMMAND_SEARCH_R_LABELS,
  );
  return Object.freeze({ ...head, rawPartialDiagnostic });
}

function stepReceipt(value: unknown, label: string): CommandSearchStepReceipt | null {
  if (value === null) return null;
  const input = record(value, label);
  exactKeys(input, ["slot", "operation"], label);
  if (input.slot !== "s0" && input.slot !== "s1") throw new TypeError(`${label}.slot is invalid`);
  if (
    input.operation !== "directory.search.entries" &&
    input.operation !== "directory.search.content" &&
    input.operation !== "file.read" &&
    input.operation !== "file.read.lines"
  ) {
    throw new TypeError(`${label}.operation is invalid`);
  }
  return Object.freeze({ slot: input.slot, operation: input.operation });
}

export function readCommandSearchRdeaStep(
  value: unknown,
  label = "command search step",
): CommandSearchRdeaStep {
  const input = record(value, label);
  exactKeys(input, ["stepIndex", "R", "E", "D", "A", "commandReceipt"], label);
  const r = record(input.R, `${label}.R`);
  exactKeys(r, ["s0", "s1"], `${label}.R`);
  const s0 = slotREvaluation(r.s0, `${label}.R.s0`);
  const s1 =
    r.s1 === null
      ? null
      : slotREvaluation(r.s1, `${label}.R.s1`);
  const d =
    input.D === null
      ? null
      : headEvaluation(
          input.D,
          `${label}.D`,
          COMMAND_SEARCH_D_FEATURE_COUNT,
          COMMAND_SEARCH_D_LABELS.length,
          COMMAND_SEARCH_D_LABELS,
        );
  const a =
    input.A === null
      ? null
      : headEvaluation(
          input.A,
          `${label}.A`,
          COMMAND_SEARCH_A_FEATURE_COUNT,
          COMMAND_SEARCH_A_LABELS.length,
          COMMAND_SEARCH_A_LABELS,
        );
  return Object.freeze({
    stepIndex: nonnegativeInteger(input.stepIndex, `${label}.stepIndex`),
    R: Object.freeze({ s0, s1 }),
    E: eEvaluation(input.E, `${label}.E`),
    D: d,
    A: a,
    commandReceipt: stepReceipt(input.commandReceipt, `${label}.commandReceipt`),
  });
}

function spawnLedgerEntry(value: unknown, label: string): CommandSpawnLedgerEntry {
  const input = record(value, label);
  exactKeysWithOptional(
    input,
    ["purpose", "cmd", "args", "exitCode"],
    ["toolUsed", "cwd", "stdoutBytesRead", "stdoutChunkCount", "crossChunkRecordSplits", "unterminatedRemainderBytes"],
    label,
  );
  if (input.purpose !== "search_command" && input.purpose !== "probe_grep_version") {
    throw new TypeError(`${label}.purpose is invalid`);
  }
  const args = stringArray(input.args, `${label}.args`);
  const exitCode = input.exitCode === null ? null : nonnegativeInteger(input.exitCode, `${label}.exitCode`);
  return Object.freeze({
    purpose: input.purpose,
    cmd: nonEmpty(input.cmd, `${label}.cmd`),
    args: Object.freeze(args),
    exitCode,
    ...(Object.hasOwn(input, "toolUsed") && input.toolUsed !== undefined
      ? { toolUsed: input.toolUsed as CommandSpawnLedgerEntry["toolUsed"] }
      : {}),
    ...(Object.hasOwn(input, "cwd") && input.cwd !== undefined
      ? { cwd: nonEmpty(input.cwd, `${label}.cwd`) }
      : {}),
    ...(Object.hasOwn(input, "stdoutBytesRead") && input.stdoutBytesRead !== undefined
      ? { stdoutBytesRead: nonnegativeInteger(input.stdoutBytesRead, `${label}.stdoutBytesRead`) }
      : {}),
    ...(Object.hasOwn(input, "stdoutChunkCount") && input.stdoutChunkCount !== undefined
      ? { stdoutChunkCount: nonnegativeInteger(input.stdoutChunkCount, `${label}.stdoutChunkCount`) }
      : {}),
    ...(Object.hasOwn(input, "crossChunkRecordSplits") && input.crossChunkRecordSplits !== undefined
      ? {
          crossChunkRecordSplits: nonnegativeInteger(
            input.crossChunkRecordSplits,
            `${label}.crossChunkRecordSplits`,
          ),
        }
      : {}),
    ...(Object.hasOwn(input, "unterminatedRemainderBytes") && input.unterminatedRemainderBytes !== undefined
      ? {
          unterminatedRemainderBytes: nonnegativeInteger(
            input.unterminatedRemainderBytes,
            `${label}.unterminatedRemainderBytes`,
          ),
        }
      : {}),
  }) as CommandSpawnLedgerEntry;
}

export function readCommandSearchState(value: unknown): CommandSearchState {
  const input = record(value, "command search state");
  exactKeys(
    input,
    [
      "stateId",
      "session",
      "goalKind",
      "cardinality",
      "s1Enabled",
      "lastSearchedSlot",
      "slotReceipts",
      "readReceipt",
      "issuedRefs",
      "spawnLedger",
      "stepTrace",
    ],
    "command search state",
  );
  if (input.goalKind !== "g3.literal-search" && input.goalKind !== "g2.read") {
    throw new TypeError("command search state.goalKind is invalid");
  }
  const requestedCardinality = cardinality(input.cardinality, "command search state.cardinality");
  if (typeof input.s1Enabled !== "boolean") {
    throw new TypeError("command search state.s1Enabled must be a boolean");
  }
  if (input.s1Enabled === true && requestedCardinality === "all") {
    throw new TypeError("command search state cannot enable s1 with cardinality all");
  }
  if (
    input.lastSearchedSlot !== null &&
    input.lastSearchedSlot !== "s0" &&
    input.lastSearchedSlot !== "s1"
  ) {
    throw new TypeError("command search state.lastSearchedSlot is invalid");
  }
  if (input.s1Enabled === false && input.lastSearchedSlot === "s1") {
    throw new TypeError("command search state cannot hold s1 lastSearchedSlot when s1Enabled is false");
  }
  const slots = record(input.slotReceipts, "command search state.slotReceipts");
  exactKeys(slots, ["s0", "s1"], "command search state.slotReceipts");
  const s0 =
    slots.s0 === null
      ? null
      : readCommandSearchSlotFact(slots.s0, input.goalKind, "command search state.slotReceipts.s0");
  const s1 =
    slots.s1 === null
      ? null
      : readCommandSearchSlotFact(slots.s1, input.goalKind, "command search state.slotReceipts.s1");
  if (s0 !== null && s0.slot !== "s0") throw new TypeError("command search state.slotReceipts.s0.slot must be s0");
  if (s1 !== null && s1.slot !== "s1") throw new TypeError("command search state.slotReceipts.s1.slot must be s1");
  if (input.s1Enabled === false && s1 !== null) {
    throw new TypeError("command search state cannot hold s1 when s1Enabled is false");
  }
  if (!Array.isArray(input.issuedRefs)) throw new TypeError("command search state.issuedRefs must be an array");
  const issuedRefs = input.issuedRefs.map((item, index) => readObservedObjectRef(item));
  assertUnique(
    issuedRefs.map(ref => `${ref.scenarioId}\0${ref.sessionId}\0${String(ref.identity.dev)}\0${String(ref.identity.ino)}\0${ref.absolutePath}`),
    "command search state.issuedRefs",
  );
  if (!Array.isArray(input.spawnLedger)) {
    throw new TypeError("command search state.spawnLedger must be an array");
  }
  const ledger = input.spawnLedger.map((item, index) =>
    spawnLedgerEntry(item, `command search state.spawnLedger[${index}]`),
  );
  if (!Array.isArray(input.stepTrace)) {
    throw new TypeError("command search state.stepTrace must be an array");
  }
  const stepTrace = input.stepTrace.map((item, index) =>
    readCommandSearchRdeaStep(item, `command search state.stepTrace[${index}]`),
  );
  for (let index = 0; index < stepTrace.length; index += 1) {
    if (stepTrace[index]!.stepIndex !== index) {
      throw new TypeError("command search state.stepTrace stepIndex must be contiguous from 0");
    }
  }
  const readReceipt =
    input.readReceipt === null
      ? null
      : readCommandSearchReadFact(input.readReceipt, "command search state.readReceipt");
  if (input.s1Enabled === false && readReceipt?.slot === "s1") {
    throw new TypeError("command search state cannot hold s1 readReceipt when s1Enabled is false");
  }
  return Object.freeze({
    stateId: nonEmpty(input.stateId, "command search state.stateId"),
    session: sessionSnapshot(input.session, "command search state.session"),
    goalKind: input.goalKind,
    cardinality: requestedCardinality,
    s1Enabled: input.s1Enabled,
    lastSearchedSlot: input.lastSearchedSlot as CommandSearchSlot | null,
    slotReceipts: Object.freeze({ s0, s1 }),
    readReceipt,
    issuedRefs: Object.freeze(issuedRefs),
    spawnLedger: Object.freeze(ledger),
    stepTrace: Object.freeze(stepTrace),
  });
}

export function readCommandSearchCursor(value: unknown): CommandSearchCursor {
  const input = record(value, "command search cursor");
  exactKeys(input, ["phase"], "command search cursor");
  if (
    input.phase !== "evaluate" &&
    input.phase !== "derive" &&
    input.phase !== "execute" &&
    input.phase !== "closed"
  ) {
    throw new TypeError("command search cursor.phase is invalid");
  }
  return Object.freeze({ phase: input.phase });
}

export function readCommandSearchEvidencePayload(value: unknown): CommandSearchEvidencePayload {
  const input = record(value, "command search evidence payload");
  exactKeys(input, ["kind", "transitionId", "stateId", "receipt"], "command search evidence payload");
  if (input.kind !== COMMAND_SEARCH_EVIDENCE_KIND) {
    throw new TypeError("command search evidence payload.kind is invalid");
  }
  const receipt = readCommandSearchSemanticReceipt(input.receipt, "command search evidence payload.receipt");
  return Object.freeze({
    kind: COMMAND_SEARCH_EVIDENCE_KIND,
    transitionId: nonEmpty(input.transitionId, "command search evidence payload.transitionId"),
    stateId: nonEmpty(input.stateId, "command search evidence payload.stateId"),
    receipt,
  });
}

function readCommandSearchSemanticReceipt(value: unknown, label: string): SemanticCallReceipt {
  const receipt = record(value, label);
  exactKeys(receipt, ["call", "status", "session_before", "session_after", "execution"], label);
  if (receipt.status !== "succeeded" && receipt.status !== "failed") {
    throw new TypeError(`${label}.status must be succeeded or failed`);
  }
  const call = record(receipt.call, `${label}.call`);
  if (call.operation !== "directory.search.entries" && call.operation !== "directory.search.content") {
    throw new TypeError(`${label}.call.operation is not a command search operation`);
  }
  const execution = record(receipt.execution, `${label}.execution`);
  for (const key of ["status", "runId", "executorInvoked"]) {
    if (!Object.hasOwn(execution, key)) throw new TypeError(`${label}.execution.${key} is required`);
  }
  if (execution.status !== "succeeded" && execution.status !== "failed") {
    throw new TypeError(`${label}.execution.status must be succeeded or failed`);
  }
  if (execution.status === "succeeded") {
    const observation = record(execution.observation, `${label}.execution.observation`);
    if (observation.kind !== call.operation) {
      throw new TypeError(`${label}.execution.observation.kind must match call.operation`);
    }
  }
  return receipt as unknown as SemanticCallReceipt;
}

export function readCommandSearchEffectFact(value: unknown): CommandSearchEffectFact {
  const input = record(value, "command search effect fact");
  exactKeys(input, ["kind", "transitionId", "runId", "invoked"], "command search effect fact");
  if (input.kind !== COMMAND_SEARCH_EFFECT_KIND) {
    throw new TypeError("command search effect fact.kind is invalid");
  }
  if (typeof input.invoked !== "boolean") {
    throw new TypeError("command search effect fact.invoked must be a boolean");
  }
  return Object.freeze({
    kind: COMMAND_SEARCH_EFFECT_KIND,
    transitionId: nonEmpty(input.transitionId, "command search effect fact.transitionId"),
    runId: input.runId === null ? null : nonEmpty(input.runId, "command search effect fact.runId"),
    invoked: input.invoked,
  });
}

export function validateCommandSearchResources(value: unknown): CommandSearchResources {
  const input = record(value, "command search resources");
  exactKeysWithOptional(
    input,
    ["sandbox", "session", "l2Model"],
    ["explicitLimits", "limits", "continuation", "signal"],
    "command search resources",
  );
  const sandbox = record(input.sandbox, "command search resources.sandbox");
  if (typeof sandbox.execute !== "function" || typeof sandbox.bindFile !== "function") {
    throw new TypeError("command search resources.sandbox must expose execute and bindFile");
  }
  const session = sessionRef(input.session, "command search resources.session");
  const model = record(input.l2Model, "command search resources.l2Model");
  if (model.kind !== "cli.hybrid-search.model") {
    throw new TypeError("command search resources.l2Model.kind must be cli.hybrid-search.model");
  }
  if (model.schema !== "cli.hybrid-package.v1") {
    throw new TypeError("command search resources.l2Model.schema must be cli.hybrid-package.v1");
  }
  if (model.calibration !== "uncalibrated" || model.adoption !== "not_applied") {
    throw new TypeError("command search resources.l2Model must stay uncalibrated and not_applied");
  }
  nonEmpty(model.handwiredRoot, "command search resources.l2Model.handwiredRoot");
  const modelRef = readVersionedRef(model.ref, "command search resources.l2Model.ref");
  if (typeof model.inferE !== "function" || typeof model.inferHead !== "function") {
    throw new TypeError("command search resources.l2Model must expose inferE and inferHead");
  }
  const pkg = record(model.package, "command search resources.l2Model.package");
  const heads = record(pkg.heads, "command search resources.l2Model.package.heads");
  for (const head of ["R", "D", "E", "A"] as const) {
    if (!isRecord(heads[head])) {
      throw new TypeError(`command search resources.l2Model.package.heads.${head} is required`);
    }
  }
  try {
    validateCliHybridPackage(pkg);
  } catch {
    throw new TypeError("command search resources.l2Model.package is not a valid cli.hybrid-package.v1");
  }
  const profile = record(model.profile, "command search resources.l2Model.profile");
  if (profile.schema !== "nnanything.l2.mlp.v1" || profile.calibration !== "uncalibrated" || profile.adoption !== "not_applied") {
    throw new TypeError("command search resources.l2Model.profile must stay uncalibrated and not_applied");
  }
  const explicitLimits =
    Object.hasOwn(input, "explicitLimits") && input.explicitLimits !== undefined
      ? searchLimits(input.explicitLimits, "command search resources.explicitLimits")
      : undefined;
  const limits =
    Object.hasOwn(input, "limits") && input.limits !== undefined
      ? recursiveGoalLimits(input.limits, "command search resources.limits")
      : undefined;
  if (Object.hasOwn(input, "continuation") && input.continuation !== undefined && !isRecord(input.continuation)) {
    throw new TypeError("command search resources.continuation must be an object");
  }
  if (Object.hasOwn(input, "signal") && input.signal !== undefined) {
    const signal = input.signal;
    if ((typeof signal !== "object" && typeof signal !== "function") || signal === null) {
      throw new TypeError("command search resources.signal must be an AbortSignal");
    }
  }
  return Object.freeze({
    sandbox: sandbox as unknown as CliFilesystemSandbox,
    session,
    l2Model: {
      ...model,
      ref: modelRef,
    } as unknown as CliHybridSearchModelLike,
    ...(explicitLimits === undefined ? {} : { explicitLimits }),
    ...(limits === undefined ? {} : { limits }),
    ...(Object.hasOwn(input, "continuation") && input.continuation !== undefined
      ? { continuation: input.continuation }
      : {}),
    ...(Object.hasOwn(input, "signal") && input.signal !== undefined
      ? { signal: input.signal as AbortSignal }
      : {}),
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createCommandSearchDomainGuards(options: Readonly<{
  session: SessionRef;
  modelRef: VersionedRef;
}>): CommandSearchDomainGuards {
  return Object.freeze({
    goal: (value: unknown) => validateCommandSearchRequest(value).goal,
    state: readCommandSearchState,
    bindings: (value: unknown) =>
      validateCommandSearchBindings(value, options.session, options.modelRef),
    evidencePayload: readCommandSearchEvidencePayload,
    effectFact: readCommandSearchEffectFact,
    receiptPayload: (value: unknown) =>
      readCommandSearchSemanticReceipt(value, "command search receipt payload"),
    cursor: readCommandSearchCursor,
    sameEffectFact: (left: CommandSearchEffectFact, right: CommandSearchEffectFact) =>
      sameJson(left, right),
    sameFacts: (
      left: FactSnapshot<CommandSearchState, CommandSearchEvidencePayload>,
      right: FactSnapshot<CommandSearchState, CommandSearchEvidencePayload>,
    ) => sameJson(left, right),
    sameGoal: (left: CommandSearchGoal, right: CommandSearchGoal) => sameJson(left, right),
    sameBindings: (left: CommandSearchBindings, right: CommandSearchBindings) =>
      sameJson(left, right),
    sameCursor: (left: CommandSearchCursor, right: CommandSearchCursor) => sameJson(left, right),
  });
}

export function readCommandSearchContinuation(
  value: unknown,
  guards: CommandSearchDomainGuards,
): CommandSearchContinuation {
  return readRecursiveGoalContinuation(value, guards);
}

export function restoredCommandSearchSequence(
  continuation: Readonly<{ states: readonly Readonly<{ id: string }>[] }> | null,
): number {
  if (continuation === null) return 0;
  let maximum = 0;
  for (const state of continuation.states) {
    const match = /:state-(\d+)$/.exec(state.id);
    if (match === null) continue;
    const value = Number(match[1]);
    if (Number.isSafeInteger(value) && value > maximum) maximum = value;
  }
  return maximum;
}
