import { expectRecord } from "../../core/schema.js";
import type { DirectoryListObservation } from "./directory-listing.js";
import type {
  CliFilesystemSandbox,
  DirectoryRef,
  SessionRef,
  SessionSnapshot,
} from "./filesystem-sandbox.js";
import {
  readObservedObjectRef,
  type ObservedObjectRef,
  type PathRef,
} from "./entry-inspection.js";
import type {
  DirectoryKnowledge,
  ExplicitFileState,
} from "../../filters/cli-state.js";
import type {
  CliCommandSample,
  CliCommandTransition,
} from "../../nodes/cli-command.js";
import type { CliCommandProfile } from "../../filters/cli-command-policy.js";
import type { RecursiveGoalLimits } from "../../workflow/recursive-goal/contracts.js";

export type EntrySearchType = "regular" | "directory";

export type EntrySearchCardinality = "one" | "all";
export type EntrySearchRecursion = "flat" | "nested";

export type EntrySearchScan = Readonly<{
  maxDirectoryDepth?: number;
}>;

/** A bound directory reference. The trusted observed object shape is the
 * public contract; the legacy relative-path shape remains an accepted
 * compatibility form. DirectoryQuery is not accepted. */
export type DirectoryObjectRef =
  | DirectoryRef
  | (ObservedObjectRef & Readonly<{ kind: "cli.directory" }>);

export type EntrySearchPredicate = Readonly<{
  kind: "entrySelector";
  name: string;
  type: EntrySearchType;
  cardinality: EntrySearchCardinality;
  recursion?: EntrySearchRecursion;
}>;

export type EntrySearchGoal = Readonly<{
  kind: "file.property";
  property: "file.property.directory.entries";
  target: DirectoryObjectRef;
  requirement: Readonly<{
    kind: "matches";
    predicate: EntrySearchPredicate;
  }>;
}>;

export type EntrySearchRequest = Readonly<{
  requestId: string;
  goal: EntrySearchGoal;
  satisfactionThreshold: 100;
}>;

export type EntrySearchListGoal = Readonly<{
  kind: "file.property";
  property: "file.property.directory.entries";
  target: DirectoryRef;
  requirement: Readonly<{ kind: "observed"; freshness: "this_run" }>;
}>;

export type EntrySearchInspectGoal = Readonly<{
  kind: "file.property";
  property: "file.property.type";
  target: Readonly<{
    kind: "cli.entry-query";
    ref: PathRef;
    followSymlinks: false;
  }>;
  requirement: Readonly<{ kind: "observed"; freshness: "this_run" }>;
}>;

/** Goal kinds handled by one recursive root and two production atomic sub-goals. */
export type EntrySearchRunGoal = EntrySearchGoal | EntrySearchListGoal | EntrySearchInspectGoal;

export type EntrySearchBindings = Readonly<{
  session: SessionRef;
  directory: DirectoryObjectRef;
  predicate: EntrySearchPredicate;
}>;

export type EntrySearchListingRecord = Readonly<{
  physicalDirectory: string;
  entries: DirectoryKnowledge["entries"];
  coverage: "complete" | "partial";
  errors: DirectoryKnowledge["errors"];
  sourceRun: string;
  revision: number;
  observation: DirectoryListObservation;
}>;

export type EntrySearchDirectoryFact = Readonly<{
  path: string;
  depth: number;
  listing: EntrySearchListingRecord | null;
  observedAtSourceRun: string | null;
  listed: boolean;
  descendable: boolean;
  uncoveredReason: "depth_limit" | "listing_partial" | "list_error" | null;
}>;

export type EntrySearchCandidateOutcome =
  | "pending"
  | "matched"
  | "type_mismatch"
  | "stale_or_unverified";

export type EntrySearchCandidateFact = Readonly<{
  name: string;
  path: string;
  parentDirectoryPath: string;
  depth: number;
  listedType: "file" | "directory" | "symlink" | "other" | "unknown";
  listedAtSourceRun: string;
  inspected: EntrySearchInspectFact | null;
  issuedRef: ObservedObjectRef | null;
  outcome: EntrySearchCandidateOutcome;
  reason: "type_mismatch" | "disappeared" | "unverified_identity" | "stale_revision" | null;
}>;

/**
 * One recursive state record. The root and every atomic transition share this
 * shape. The embedded cli state is the production ExplicitFileState that is
 * already owned and validated by the existing property workflow.
 */
export type EntrySearchState = Readonly<{
  stateId: string;
  session: SessionSnapshot;
  cli: ExplicitFileState;
  cardinality?: EntrySearchCardinality;
  recursion?: EntrySearchRecursion;
  maxDirectoryDepth?: number | null;
  directories?: readonly EntrySearchDirectoryFact[];
  pendingDirectories?: readonly Readonly<{ path: string; depth: number }>[];
  candidates?: readonly EntrySearchCandidateFact[];
}>;

export type EntrySearchPhase = "initial" | "listed" | "descend" | "verified" | "closed";
export type EntrySearchCursor = Readonly<{ phase: EntrySearchPhase }>;

export type EntrySearchEvidencePayload = Readonly<{
  kind: "cli.entry-search.transition.v1";
  transitionId: string;
  stateId: string;
  transition: CliCommandTransition;
}>;

export type EntrySearchEffectFact = Readonly<{
  kind: "cli.entry-search.observation";
  transitionId: string;
  runId: string | null;
  invoked: boolean;
}>;

export type EntrySearchReceiptPayload = CliCommandTransition;

export type EntrySearchCandidate = Readonly<{
  name: string;
  path: string;
  listedType: "file" | "directory" | "symlink" | "other" | "unknown";
}>;

export type EntrySearchInspectFact = Readonly<{
  absolutePath: string;
  observedWith: "stat" | "lstat" | null;
  entryExists: boolean | null;
  resolvedTargetExists: boolean | null;
  type:
    | "regular"
    | "directory"
    | "symlink"
    | "character_device"
    | "block_device"
    | "fifo"
    | "socket"
    | "other"
    | null;
  identity: Readonly<{
    dev: number | string | null;
    ino: number | string | null;
    nlink: number | string | null;
    rdev: number | string | null;
  }>;
  errno: string | null;
  linkTarget: string | null;
  sourceRun: string;
  sessionRevision: number;
}>;

export type EntrySearchRootFact =
  | Readonly<{
      kind: "matched";
      predicate: EntrySearchPredicate;
      listing: Readonly<{ sourceRun: string; coverage: "complete" | "partial" }>;
      inspect: EntrySearchInspectFact;
      ref: ObservedObjectRef;
    }>
  | Readonly<{
      kind: "not_found";
      predicate: EntrySearchPredicate;
      listing: Readonly<{ sourceRun: string; coverage: "complete" }>;
    }>
  | Readonly<{
      kind: "type_mismatch";
      predicate: EntrySearchPredicate;
      listing: Readonly<{ sourceRun: string; coverage: "complete" }>;
      inspect: EntrySearchInspectFact;
      ref: ObservedObjectRef | null;
      typeMismatches: readonly ObservedObjectRef[];
    }>
  | Readonly<{
      kind: "stale_or_unverified";
      predicate: EntrySearchPredicate;
      listing: Readonly<{ sourceRun: string; coverage: "complete" }>;
      inspect: EntrySearchInspectFact | null;
      ref: ObservedObjectRef | null;
      reasons: readonly string[];
      typeMismatches: readonly ObservedObjectRef[];
    }>
  | Readonly<{
      kind: "partial";
      predicate: EntrySearchPredicate;
      listing: Readonly<{ sourceRun: string | null; coverage: "complete" | "partial" | null }>;
      matches: readonly ObservedObjectRef[];
      typeMismatches: readonly ObservedObjectRef[];
      reasons: readonly string[];
    }>
  | Readonly<{
      kind: "insufficient_evidence";
      predicate: EntrySearchPredicate;
      listing: Readonly<{
        sourceRun: string | null;
        coverage: "complete" | "partial" | null;
        errors: readonly string[];
        candidateNames: readonly string[];
        typeMismatchPaths?: readonly string[];
        reasons?: readonly string[];
      }>;
      reasons: readonly string[];
    }>
  | Readonly<{ kind: "rejected" }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "interrupted" }>;

export type EntrySearchDomainProjection = Readonly<{
  status: "achieved" | "unmet" | "unknown" | "rejected" | "failed";
  resolution:
    | "matched"
    | "not_found"
    | "type_mismatch"
    | "insufficient_evidence"
    | "stale_or_unverified"
    | "partial"
    | "rejected"
    | "failed"
    | "budget_exhausted"
    | "interrupted";
  satisfaction: number | null;
  match: ObservedObjectRef | null;
  matches: readonly ObservedObjectRef[];
  typeMismatches: readonly ObservedObjectRef[];
  denominators: Readonly<{
    listedDirectories: number;
    directoriesComplete: number;
    directoriesUncovered: number;
    nameMatchedCandidates: number;
    candidatesInspected: number;
    candidatesMatched: number;
    candidatesStaleOrUnverified: number;
    typeMismatches: number;
  }>;
  coverage: "complete" | "partial" | null;
  rootFact: EntrySearchRootFact | null;
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

export type EntrySearchResources = Readonly<{
  sandbox: CliFilesystemSandbox;
  session: SessionRef;
  profile: CliCommandProfile;
  scan?: EntrySearchScan;
  limits?: RecursiveGoalLimits;
  signal?: AbortSignal;
  continuation?: unknown;
  onSample?: (sample: CliCommandSample) => void | Promise<void>;
}>;

export type EntrySearchRunResult = Readonly<{
  request: EntrySearchRequest;
  response: unknown;
  domain: EntrySearchDomainProjection;
}>;

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

function record(value: unknown, label: string): Record<string, unknown> {
  return expectRecord(value, label);
}

function sessionRef(value: unknown, label: string): SessionRef {
  const input = record(value, label);
  exactKeys(input, ["kind", "scenarioId", "sessionId"], label);
  if (input.kind !== "cli.session") {
    throw new TypeError(`${label} must be a cli.session reference`);
  }
  return Object.freeze({
    kind: "cli.session" as const,
    scenarioId: nonEmpty(input.scenarioId, `${label}.scenarioId`),
    sessionId: nonEmpty(input.sessionId, `${label}.sessionId`),
  });
}

function directoryObjectRef(value: unknown, label: string): DirectoryObjectRef {
  const input = record(value, label);
  if (input.kind !== "cli.directory") {
    throw new TypeError(`${label} must be a cli.directory reference`);
  }
  if (Object.hasOwn(input, "path")) {
    return directoryRef(input, label);
  }
  const observed = readObservedObjectRef(input);
  if (observed.kind !== "cli.directory" || observed.type !== "directory") {
    throw new TypeError(`${label} must be a bound cli.directory object reference`);
  }
  return observed as DirectoryObjectRef;
}

function directoryRef(value: unknown, label: string): DirectoryRef {
  const input = record(value, label);
  exactKeys(input, ["kind", "scenarioId", "sessionId", "path"], label);
  if (input.kind !== "cli.directory") {
    throw new TypeError(`${label} must be a cli.directory reference`);
  }
  return Object.freeze({
    kind: "cli.directory" as const,
    scenarioId: nonEmpty(input.scenarioId, `${label}.scenarioId`),
    sessionId: nonEmpty(input.sessionId, `${label}.sessionId`),
    path: nonEmpty(input.path, `${label}.path`),
  });
}

function pathRef(value: unknown, label: string): PathRef {
  const input = record(value, label);
  exactKeys(input, ["kind", "scenarioId", "sessionId", "path"], label);
  if (input.kind !== "cli.path") {
    throw new TypeError(`${label} must be a cli.path reference`);
  }
  const path = nonEmpty(input.path, `${label}.path`);
  if (!path.startsWith("/")) {
    throw new TypeError(`${label}.path must be absolute`);
  }
  return Object.freeze({
    kind: "cli.path" as const,
    scenarioId: nonEmpty(input.scenarioId, `${label}.scenarioId`),
    sessionId: nonEmpty(input.sessionId, `${label}.sessionId`),
    path,
  });
}

function sessionSnapshot(value: unknown, label: string): SessionSnapshot {
  const input = record(value, label);
  exactKeys(input, ["id", "cwd", "revision", "grantedEffects"], label);
  const grantedEffects = input.grantedEffects;
  if (!Array.isArray(grantedEffects) || grantedEffects.some(effect => typeof effect !== "string")) {
    throw new TypeError(`${label}.grantedEffects must be a string array`);
  }
  const allowed = new Set(["filesystem.read", "process.exec", "session.write"]);
  if (grantedEffects.some(effect => !allowed.has(effect))) {
    throw new TypeError(`${label}.grantedEffects contains an unsupported CLI effect`);
  }
  return Object.freeze({
    id: nonEmpty(input.id, `${label}.id`),
    cwd: nonEmpty(input.cwd, `${label}.cwd`),
    revision: nonnegativeInteger(input.revision, `${label}.revision`),
    grantedEffects: Object.freeze(
      [...grantedEffects] as SessionSnapshot["grantedEffects"],
    ),
  });
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a nonnegative integer`);
  }
  return value as number;
}

export function validateEntrySearchPredicate(value: unknown): EntrySearchPredicate {
  const predicate = record(value, "goal.requirement.predicate");
  const keys = Object.keys(predicate);
  const required = ["kind", "name", "type", "cardinality"];
  if (
    keys.length !== required.length + (Object.hasOwn(predicate, "recursion") ? 1 : 0) ||
    required.some(key => !Object.hasOwn(predicate, key)) ||
    keys.some(key => key !== "recursion" && !required.includes(key))
  ) {
    throw new TypeError(
      "goal.requirement.predicate must contain exactly kind, name, type, cardinality and optional recursion",
    );
  }
  if (predicate.kind !== "entrySelector") {
    throw new TypeError("goal.requirement.predicate.kind must be entrySelector");
  }
  if (predicate.cardinality !== "one" && predicate.cardinality !== "all") {
    throw new TypeError("goal.requirement.predicate.cardinality must be one or all");
  }
  const recursion = Object.hasOwn(predicate, "recursion")
    ? predicate.recursion
    : "flat";
  if (recursion !== "flat" && recursion !== "nested") {
    throw new TypeError("goal.requirement.predicate.recursion must be flat or nested");
  }
  if (predicate.type !== "regular" && predicate.type !== "directory") {
    throw new TypeError("goal.requirement.predicate.type must be regular or directory");
  }
  const name = nonEmpty(predicate.name, "goal.requirement.predicate.name");
  if (name === "." || name === "..") {
    throw new TypeError("goal.requirement.predicate.name must not be . or ..");
  }
  if (name.includes("/")) {
    throw new TypeError("goal.requirement.predicate.name must be a single name without a path separator");
  }
  return Object.freeze({
    kind: "entrySelector",
    name,
    type: predicate.type as EntrySearchType,
    cardinality: predicate.cardinality as EntrySearchCardinality,
    ...(recursion === "flat" ? {} : { recursion: "nested" as const }),
  });
}

export function validateEntrySearchGoal(value: unknown): EntrySearchGoal {
  const goal = record(value, "entry search goal");
  exactKeys(goal, ["kind", "property", "target", "requirement"], "entry search goal");
  if (goal.kind !== "file.property" || goal.property !== "file.property.directory.entries") {
    throw new TypeError("entry search goal must be a file.property directory.entries goal");
  }
  const requirement = record(goal.requirement, "entry search goal requirement");
  exactKeys(requirement, ["kind", "predicate"], "entry search goal requirement");
  if (requirement.kind !== "matches") {
    throw new TypeError("entry search goal requirement.kind must be matches");
  }
  return Object.freeze({
    kind: "file.property",
    property: "file.property.directory.entries",
    target: directoryObjectRef(goal.target, "entry search goal target"),
    requirement: Object.freeze({
      kind: "matches",
      predicate: validateEntrySearchPredicate(requirement.predicate),
    }),
  });
}

export function validateEntrySearchRequest(value: unknown, session: SessionRef): EntrySearchRequest {
  const request = record(value, "entry search request");
  exactKeys(request, ["requestId", "goal", "satisfactionThreshold"], "entry search request");
  if (request.satisfactionThreshold !== 100) {
    throw new TypeError("entry search satisfactionThreshold must be exactly 100");
  }
  const goal = validateEntrySearchGoal(request.goal);
  if (goal.target.scenarioId !== session.scenarioId || goal.target.sessionId !== session.sessionId) {
    throw new TypeError("entry search goal target must belong to the bound session and scenario");
  }
  return Object.freeze({
    requestId: nonEmpty(request.requestId, "requestId"),
    goal,
    satisfactionThreshold: 100,
  });
}

export function validateEntrySearchBindings(value: unknown, session: SessionRef): EntrySearchBindings {
  const bindings = record(value, "entry search bindings");
  exactKeys(bindings, ["session", "directory", "predicate"], "entry search bindings");
  const boundSession = sessionRef(bindings.session, "bindings.session");
  const directory = directoryObjectRef(bindings.directory, "bindings.directory");
  const predicate = validateEntrySearchPredicate(bindings.predicate);
  if (
    boundSession.scenarioId !== session.scenarioId ||
    boundSession.sessionId !== session.sessionId ||
    directory.scenarioId !== session.scenarioId ||
    directory.sessionId !== session.sessionId
  ) {
    throw new TypeError("entry search bindings must belong to the bound session and scenario");
  }
  return Object.freeze({
    session: boundSession,
    directory,
    predicate,
  });
}

export function readEntrySearchState(value: unknown): EntrySearchState {
  const state = record(value, "entry search state");
  const legacy = !Object.hasOwn(state, "recursion");
  if (legacy) {
    exactKeys(state, ["stateId", "session", "cli"], "entry search state");
  } else {
    const keys = Object.keys(state);
    for (const key of ["stateId", "session", "cli", "cardinality", "recursion", "maxDirectoryDepth", "directories", "pendingDirectories", "candidates"]) {
      if (!Object.hasOwn(state, key)) {
        throw new TypeError(`entry search state.${key} is required`);
      }
    }
    if (keys.length !== 9) {
      throw new TypeError("entry search state must contain exactly stateId, session, cli, cardinality, recursion, maxDirectoryDepth, directories, pendingDirectories, candidates");
    }
  }
  if (legacy) {
    return Object.freeze({
      stateId: nonEmpty(state.stateId, "entry search state stateId"),
      session: sessionSnapshot(state.session, "entry search state session"),
      cli: readExplicitFileState(state.cli),
    });
  }
  if (state.cardinality !== "one" && state.cardinality !== "all") {
    throw new TypeError("entry search state.cardinality must be one or all");
  }
  if (state.recursion !== "flat" && state.recursion !== "nested") {
    throw new TypeError("entry search state.recursion must be flat or nested");
  }
  const maxDirectoryDepth = state.maxDirectoryDepth === null
    ? null
    : nonnegativeInteger(state.maxDirectoryDepth, "entry search state.maxDirectoryDepth");
  if (!Array.isArray(state.directories) || !Array.isArray(state.pendingDirectories) || !Array.isArray(state.candidates)) {
    throw new TypeError("entry search state directories, pendingDirectories and candidates must be arrays");
  }
  const directories = (state.directories as unknown[]).map((item, index) =>
    readEntrySearchDirectoryFact(item, `entry search state.directories[${index}]`));
  const pendingDirectories = (state.pendingDirectories as unknown[]).map((item, index) => {
    const pending = record(item, `entry search state.pendingDirectories[${index}]`);
    exactKeys(pending, ["path", "depth"], `entry search state.pendingDirectories[${index}]`);
    return Object.freeze({
      path: nonEmpty(pending.path, `entry search state.pendingDirectories[${index}].path`),
      depth: nonnegativeInteger(pending.depth, `entry search state.pendingDirectories[${index}].depth`),
    });
  });
  const candidates = (state.candidates as unknown[]).map((item, index) =>
    readEntrySearchCandidateFact(item, `entry search state.candidates[${index}]`));
  return Object.freeze({
    stateId: nonEmpty(state.stateId, "entry search state stateId"),
    session: sessionSnapshot(state.session, "entry search state session"),
    cli: readExplicitFileState(state.cli),
    cardinality: state.cardinality,
    recursion: state.recursion,
    maxDirectoryDepth,
    directories: Object.freeze(directories),
    pendingDirectories: Object.freeze(pendingDirectories),
    candidates: Object.freeze(candidates),
  });
}

function readEntrySearchDirectoryFact(value: unknown, label: string): EntrySearchDirectoryFact {
  const input = record(value, label);
  const keys = ["path", "depth", "listing", "observedAtSourceRun", "listed", "descendable", "uncoveredReason"];
  if (keys.some(key => !Object.hasOwn(input, key)) || Object.keys(input).length !== keys.length) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
  if (typeof input.listed !== "boolean" || typeof input.descendable !== "boolean") {
    throw new TypeError(`${label}.listed and .descendable must be booleans`);
  }
  if (
    input.uncoveredReason !== null &&
    input.uncoveredReason !== "depth_limit" &&
    input.uncoveredReason !== "listing_partial" &&
    input.uncoveredReason !== "list_error"
  ) {
    throw new TypeError(`${label}.uncoveredReason is invalid`);
  }
  return Object.freeze({
    path: nonEmpty(input.path, `${label}.path`),
    depth: nonnegativeInteger(input.depth, `${label}.depth`),
    listing: input.listing === null ? null : (input.listing as EntrySearchListingRecord),
    observedAtSourceRun: input.observedAtSourceRun === null ? null : nonEmpty(input.observedAtSourceRun, `${label}.observedAtSourceRun`),
    listed: input.listed,
    descendable: input.descendable,
    uncoveredReason: input.uncoveredReason,
  });
}

function readEntrySearchCandidateFact(value: unknown, label: string): EntrySearchCandidateFact {
  const input = record(value, label);
  const keys = ["name", "path", "parentDirectoryPath", "depth", "listedType", "listedAtSourceRun", "inspected", "issuedRef", "outcome", "reason"];
  if (keys.some(key => !Object.hasOwn(input, key)) || Object.keys(input).length !== keys.length) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
  if (
    input.listedType !== "file" && input.listedType !== "directory" &&
    input.listedType !== "symlink" && input.listedType !== "other" && input.listedType !== "unknown"
  ) {
    throw new TypeError(`${label}.listedType is invalid`);
  }
  if (
    input.outcome !== "pending" && input.outcome !== "matched" &&
    input.outcome !== "type_mismatch" && input.outcome !== "stale_or_unverified"
  ) {
    throw new TypeError(`${label}.outcome is invalid`);
  }
  if (
    input.reason !== null && input.reason !== "type_mismatch" &&
    input.reason !== "disappeared" && input.reason !== "unverified_identity" && input.reason !== "stale_revision"
  ) {
    throw new TypeError(`${label}.reason is invalid`);
  }
  return Object.freeze({
    name: nonEmpty(input.name, `${label}.name`),
    path: nonEmpty(input.path, `${label}.path`),
    parentDirectoryPath: nonEmpty(input.parentDirectoryPath, `${label}.parentDirectoryPath`),
    depth: nonnegativeInteger(input.depth, `${label}.depth`),
    listedType: input.listedType,
    listedAtSourceRun: nonEmpty(input.listedAtSourceRun, `${label}.listedAtSourceRun`),
    inspected: input.inspected === null ? null : (input.inspected as EntrySearchInspectFact),
    issuedRef: input.issuedRef === null ? null : readObservedObjectRef(input.issuedRef),
    outcome: input.outcome,
    reason: input.reason,
  });
}

export function validateEntrySearchListGoal(value: unknown): EntrySearchListGoal {
  const goal = record(value, "entry search list goal");
  exactKeys(goal, ["kind", "property", "target", "requirement"], "entry search list goal");
  if (goal.kind !== "file.property" || goal.property !== "file.property.directory.entries") {
    throw new TypeError("entry search list goal must use file.property.directory.entries");
  }
  const requirement = record(goal.requirement, "entry search list goal requirement");
  exactKeys(requirement, ["kind", "freshness"], "entry search list goal requirement");
  if (requirement.kind !== "observed" || requirement.freshness !== "this_run") {
    throw new TypeError("entry search list goal requirement must be observed this_run");
  }
  return Object.freeze({
    kind: "file.property",
    property: "file.property.directory.entries",
    target: directoryRef(goal.target, "entry search list goal target"),
    requirement: Object.freeze({ kind: "observed", freshness: "this_run" }),
  });
}

export function validateEntrySearchInspectGoal(value: unknown): EntrySearchInspectGoal {
  const goal = record(value, "entry search inspect goal");
  exactKeys(goal, ["kind", "property", "target", "requirement"], "entry search inspect goal");
  if (goal.kind !== "file.property" || goal.property !== "file.property.type") {
    throw new TypeError("entry search inspect goal must use file.property.type");
  }
  const requirement = record(goal.requirement, "entry search inspect goal requirement");
  exactKeys(requirement, ["kind", "freshness"], "entry search inspect goal requirement");
  if (requirement.kind !== "observed" || requirement.freshness !== "this_run") {
    throw new TypeError("entry search inspect goal requirement must be observed this_run");
  }
  const target = record(goal.target, "entry search inspect goal target");
  exactKeys(target, ["kind", "ref", "followSymlinks"], "entry search inspect goal target");
  if (target.kind !== "cli.entry-query" || target.followSymlinks !== false) {
    throw new TypeError("entry search inspect goal target must be cli.entry-query with followSymlinks false");
  }
  return Object.freeze({
    kind: "file.property",
    property: "file.property.type",
    target: Object.freeze({
      kind: "cli.entry-query" as const,
      ref: pathRef(target.ref, "entry search inspect goal target.ref"),
      followSymlinks: false,
    }),
    requirement: Object.freeze({ kind: "observed", freshness: "this_run" }),
  });
}

export function readEntrySearchGoal(value: unknown): EntrySearchRunGoal {
  const goal = record(value, "entry search run goal");
  if (!Object.hasOwn(goal, "requirement") || !isRecord(goal.requirement)) {
    throw new TypeError("entry search run goal requirement must be an object");
  }
  const requirement = goal.requirement as Record<string, unknown>;
  if (requirement.kind === "matches") {
    return validateEntrySearchGoal(goal);
  }
  if (requirement.kind === "observed" && goal.property === "file.property.directory.entries") {
    return validateEntrySearchListGoal(goal);
  }
  if (requirement.kind === "observed" && goal.property === "file.property.type") {
    return validateEntrySearchInspectGoal(goal);
  }
  throw new TypeError("unsupported entry search run goal");
}

export function readEntrySearchCursor(value: unknown): EntrySearchCursor {
  const cursor = record(value, "entry search cursor");
  exactKeys(cursor, ["phase"], "entry search cursor");
  if (
    cursor.phase !== "initial" &&
    cursor.phase !== "listed" &&
    cursor.phase !== "descend" &&
    cursor.phase !== "verified" &&
    cursor.phase !== "closed"
  ) {
    throw new TypeError("entry search cursor phase is invalid");
  }
  return Object.freeze({ phase: cursor.phase as EntrySearchPhase });
}

/**
 * Resolve the caller's optional scan scope into the concrete recursion mode and
 * directory depth bound. Flat recursion never descends, so its bound is 0.
 * Nested recursion without an explicit bound records `null`, meaning the tree
 * is enumerated until it is naturally exhausted.
 */
export function resolveEntrySearchScan(
  predicate: EntrySearchPredicate,
  scan: unknown,
): Readonly<{ recursion: EntrySearchRecursion; maxDirectoryDepth: number | null }> {
  const recursion = predicate.recursion ?? "flat";
  if (scan === undefined) {
    return Object.freeze({ recursion, maxDirectoryDepth: recursion === "flat" ? 0 : null });
  }
  const input = record(scan, "entry search scan");
  const keys = Object.keys(input);
  if (keys.length > 1 || (keys.length === 1 && !Object.hasOwn(input, "maxDirectoryDepth"))) {
    throw new TypeError("entry search scan must contain only optional maxDirectoryDepth");
  }
  const provided = Object.hasOwn(input, "maxDirectoryDepth") && input.maxDirectoryDepth !== undefined;
  const maxDirectoryDepth = provided
    ? nonnegativeInteger(input.maxDirectoryDepth, "entry search scan.maxDirectoryDepth")
    : (recursion === "flat" ? 0 : null);
  if (recursion === "flat") {
    if (maxDirectoryDepth !== 0) {
      throw new TypeError("entry search flat recursion requires scan.maxDirectoryDepth to be 0");
    }
    return Object.freeze({ recursion, maxDirectoryDepth: 0 });
  }
  return Object.freeze({ recursion, maxDirectoryDepth });
}

export function readEntrySearchEvidencePayload(value: unknown): EntrySearchEvidencePayload {
  const payload = record(value, "entry search evidence payload");
  exactKeys(payload, ["kind", "transitionId", "stateId", "transition"], "entry search evidence payload");
  if (payload.kind !== "cli.entry-search.transition.v1") {
    throw new TypeError("entry search evidence payload kind is invalid");
  }
  return Object.freeze({
    kind: "cli.entry-search.transition.v1",
    transitionId: nonEmpty(payload.transitionId, "entry search evidence transitionId"),
    stateId: nonEmpty(payload.stateId, "entry search evidence stateId"),
    transition: readCliCommandTransition(payload.transition, "entry search evidence transition"),
  });
}

export function readEntrySearchEffectFact(value: unknown): EntrySearchEffectFact {
  const effect = record(value, "entry search effect fact");
  exactKeys(effect, ["kind", "transitionId", "runId", "invoked"], "entry search effect fact");
  if (effect.kind !== "cli.entry-search.observation" || typeof effect.invoked !== "boolean") {
    throw new TypeError("entry search effect fact is invalid");
  }
  return Object.freeze({
    kind: "cli.entry-search.observation",
    transitionId: nonEmpty(effect.transitionId, "entry search effect transitionId"),
    runId: effect.runId === null ? null : nonEmpty(effect.runId, "entry search effect runId"),
    invoked: effect.invoked,
  });
}

export function readEntrySearchReceiptPayload(value: unknown): EntrySearchReceiptPayload {
  return readCliCommandTransition(value, "entry search receipt transition");
}

function readCliCommandTransition(value: unknown, label: string): CliCommandTransition {
  const transition = record(value, label);
  for (const key of ["goal", "satisfactionThreshold", "state_before", "action", "invocation", "policy", "policy_error", "execution_result", "session_before", "session_after", "observed_state_after", "postcondition", "satisfaction", "status", "reason", "changed", "evidence", "collection_result", "defer"]) {
    if (!Object.hasOwn(transition, key)) {
      throw new TypeError(`${label}.${key} is required`);
    }
  }
  return transition as unknown as CliCommandTransition;
}

function readExplicitFileState(value: unknown): ExplicitFileState {
  // The production validator already owns the full shape. Importing it here
  // keeps this bridge from duplicating that contract.
  const input = record(value, "entry search explicit file state");
  for (const key of ["session", "cwdObservation", "directoryListing"]) {
    if (!Object.hasOwn(input, key)) {
      throw new TypeError(`entry search explicit file state.${key} is required`);
    }
  }
  return input as unknown as ExplicitFileState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type { DirectoryListObservation };
