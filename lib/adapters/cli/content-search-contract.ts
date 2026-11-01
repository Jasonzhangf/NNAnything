import { expectRecord } from "../../core/schema.js";
import type { DirectoryListObservation } from "./directory-listing.js";
import type {
  CliFilesystemSandbox,
  DirectoryRef,
  SemanticCallReceipt,
  SessionRef,
  SessionSnapshot,
} from "./filesystem-sandbox.js";
import {
  readObservedObjectRef,
  type EntryKind,
  type ObservedObjectRef,
  type OsInteger,
  type PathRef,
} from "./entry-inspection.js";
import type { ExplicitFileState } from "../../filters/cli-state.js";
import type {
  CliCommandSample,
  CliCommandTransition,
} from "../../nodes/cli-command.js";
import type { CliCommandProfile } from "../../filters/cli-command-policy.js";
import type { RecursiveGoalLimits } from "../../workflow/recursive-goal/contracts.js";
import type { DirectoryObjectRef } from "./entry-search-contract.js";

export type ContentSearchFileCondition = Readonly<{
  type: "regular";
  name?: string;
  suffix?: string;
}>;

export type ContentContainsPredicate = Readonly<{
  kind: "contains";
  needle: string;
  encoding: "utf8";
}>;

export type ContentSearchCardinality = "one" | "all";
export type ContentSearchRecursion = "flat" | "nested";

export type ContentSearchTarget = Readonly<{
  kind: "cli.content-search-scope";
  directory: DirectoryObjectRef;
  fileCondition: ContentSearchFileCondition | null;
  cardinality: ContentSearchCardinality;
  recursion: ContentSearchRecursion;
}>;

export type ContentSearchGoal = Readonly<{
  kind: "file.property";
  property: "file.property.content.bytes";
  target: ContentSearchTarget;
  requirement: Readonly<{
    kind: "contains";
    predicate: ContentContainsPredicate;
  }>;
}>;

export type ContentSearchRequest = Readonly<{
  requestId: string;
  goal: ContentSearchGoal;
  satisfactionThreshold: 100;
}>;

export type ContentSearchListGoal = Readonly<{
  kind: "file.property";
  property: "file.property.directory.entries";
  target: DirectoryRef;
  requirement: Readonly<{ kind: "observed"; freshness: "this_run" }>;
}>;

export type ContentSearchInspectGoal = Readonly<{
  kind: "file.property";
  property: "file.property.type";
  target: Readonly<{
    kind: "cli.entry-query";
    ref: PathRef;
    followSymlinks: false;
  }>;
  requirement: Readonly<{ kind: "observed"; freshness: "this_run" }>;
}>;

export type ContentSearchReadGoal = Readonly<{
  kind: "file.property";
  property: "file.property.content.bytes";
  target: Readonly<{
    kind: "cli.file";
    ref: ContentSearchFileRef;
    requiredType: "regular";
  }>;
  requirement: Readonly<{
    kind: "observed";
    range: Readonly<{ offset: number; length: number }>;
    attempt: number;
  }>;
}>;

export type ContentSearchRunGoal =
  | ContentSearchGoal
  | ContentSearchListGoal
  | ContentSearchInspectGoal
  | ContentSearchReadGoal;

export type ContentSearchBindings = Readonly<{
  session: SessionRef;
  directory: DirectoryObjectRef;
  fileCondition: ContentSearchFileCondition | null;
  cardinality: ContentSearchCardinality;
  recursion: ContentSearchRecursion;
  needle: string;
}>;

export type ContentSearchListingFact = Readonly<{
  sourceRun: string | null;
  physicalDirectory: string | null;
  coverage: "complete" | "partial" | null;
  errors: readonly string[];
  entries: readonly Readonly<{
    name: string;
    path: string;
    type: "file" | "directory" | "symlink" | "other" | "unknown";
  }>[];
}>;

export type ContentSearchInspectedFact = Readonly<{
  sourceRun: string | null;
  absolutePath: string;
  type: EntryKind | null;
  size: OsInteger;
  identity: Readonly<{ dev: OsInteger; ino: OsInteger }>;
  sessionRevision: number | null;
  errno: string | null;
}>;

export type ContentSearchFileRef = Readonly<{
  kind: "cli.file";
  scenarioId: string;
  sessionId: string;
  type: "regular";
  identity: Readonly<{ dev: OsInteger; ino: OsInteger }>;
  sourceRun: string;
  sessionRevision: number;
  absolutePath: string;
}>;

export type ContentSearchReadFact = Readonly<{
  ref: ContentSearchFileRef;
  sourceRun: string;
  refSourceRun: string;
  revision: number;
  offset: number;
  length: number;
  size: number;
  attempt: number;
  bytes: string;
  bytesRead: number;
  eof: boolean;
  identity: Readonly<{ dev: OsInteger; ino: OsInteger }>;
}>;

/**
 * Persisted state representation of an observed read.
 *
 * The recursive-goal engine snapshots and clones the candidate state after
 * every atomic step, so a raw file chunk must not live in the state. This type
 * carries the read metadata that consumers need and an explicit reference to
 * the atomic read receipt that holds the observed bytes. It is a reference,
 * not an empty read: `bytesRef.runId` names the receipt whose
 * `cli.file.read.receipt.v1` payload still contains the raw bytes.
 */
export type ContentSearchReadStateRef = Readonly<{
  kind: "cli.content-search.read-state-ref.v1";
  ref: ContentSearchFileRef;
  sourceRun: string;
  refSourceRun: string;
  revision: number;
  offset: number;
  length: number;
  size: number;
  attempt: number;
  bytesRead: number;
  eof: boolean;
  identity: Readonly<{ dev: OsInteger; ino: OsInteger }>;
  bytesRef: Readonly<{
    kind: "cli.file.read.receipt.v1";
    runId: string;
  }>;
}>;

export type ContentSearchCandidateOutcome =
  | "pending"
  | "matched"
  | "negative"
  | "type_mismatch"
  | "unknown"
  | "read_error"
  | "stale";

export type ContentSearchIdentityKey = Readonly<{
  scenarioId: string;
  sessionId: string;
  dev: OsInteger;
  ino: OsInteger;
  sessionRevision: number;
  sourceRun: string;
}>;

export type ContentSearchScanFact = Readonly<{
  nextOffset: number;
  carry: string;
  carryLineStartAbs: number;
  found: boolean;
  firstMatch: Readonly<{ start: number; end: number; line: number; column: number }> | null;
  complete: boolean;
  bytesRead: number;
  chunks: number;
  sizeAtStart: number;
  identityAtStart: ContentSearchIdentityKey;
  firstReadSourceRun: string | null;
  lastReadSourceRun: string | null;
  lastEndObserved: boolean;
  shortRead: boolean;
  prefixNewlines: number;
  lastNewlineAbs: number;
}>;

export type ContentSearchCandidateFact = Readonly<{
  name: string;
  path: string;
  listedType: "file" | "directory" | "symlink" | "other" | "unknown";
  inspected: ContentSearchInspectedFact | null;
  fileRef: ContentSearchFileRef | null;
  read: ContentSearchReadFact | ContentSearchReadStateRef | null;
  scan: ContentSearchScanFact | null;
  history: readonly ContentSearchHistoricalHitFact[];
  contains: boolean | null;
  outcome: ContentSearchCandidateOutcome;
  byteSpan: Readonly<{ start: number; end: number }> | null;
  line: number | null;
  column: number | null;
  reason: string | null;
  failureCode: string | null;
  duplicateRead: boolean;
  staleRetries: number;
}>;

export type ContentSearchDirectoryFact = Readonly<{
  path: string;
  depth: number;
  listing: ContentSearchListingFact | null;
  observedAtSourceRun: string | null;
  listed: boolean;
  descendable: boolean;
  uncoveredReason: "depth_limit" | "listing_partial" | "list_error" | null;
}>;

export type ContentSearchMismatchFact = Readonly<{
  name: string;
  path: string;
}>;

export type ContentSearchState = Readonly<{
  stateId: string;
  session: SessionSnapshot;
  cli: ExplicitFileState;
  listing: ContentSearchListingFact | null;
  cardinality: ContentSearchCardinality;
  recursion: ContentSearchRecursion;
  maxDirectoryDepth: number;
  maxStaleRetries: number;
  directories: readonly ContentSearchDirectoryFact[];
  pendingDirectories: readonly Readonly<{ path: string; depth: number }>[];
  candidates: readonly ContentSearchCandidateFact[];
  provenNegatives: readonly ContentSearchNegativeFact[];
  typeMismatches: readonly ContentSearchMismatchFact[];
  duplicateReads: number;
  bytesReadTotal: number;
}>;

export type ContentSearchPhase = "listed" | "descend" | "choose" | "inspected" | "read" | "reconcile" | "closed";

export type ContentSearchCursor = Readonly<{ phase: ContentSearchPhase }>;

export type ContentSearchEvidencePayload =
  | Readonly<{
      kind: "cli.content-search.transition.v1";
      transitionId: string;
      stateId: string;
      transition: CliCommandTransition;
    }>
  | Readonly<{
      kind: "cli.content-search.read.v1";
      transitionId: string;
      stateId: string;
      receipt: SemanticCallReceipt;
      ref: ContentSearchFileRef;
    }>;

export type ContentSearchEffectFact = Readonly<{
  kind: "cli.content-search.observation";
  transitionId: string;
  runId: string | null;
  invoked: boolean;
}>;

export type ContentSearchReadReceipt = Readonly<{
  kind: "cli.file.read.receipt.v1";
  receipt: SemanticCallReceipt;
  ref: ContentSearchFileRef;
}>;

export type ContentSearchReceiptPayload = CliCommandTransition | ContentSearchReadReceipt;

export type ContentSearchHitFact = Readonly<{
  kind: "current_hit";
  historical: false;
  identityKey: ContentSearchIdentityKey;
  fileRef: ContentSearchFileRef;
  path: string;
  needle: string;
  byteSpan: Readonly<{ start: number; end: number }>;
  line: number;
  column: number;
  size: number;
  bytesRead: number;
  scanComplete: boolean;
}>;

export type ContentSearchHistoricalHitFact = Readonly<{
  kind: "historical_stale_hit";
  historical: true;
  identityKey: ContentSearchIdentityKey;
  fileRef: ContentSearchFileRef;
  sourceRun: string;
  path: string;
  needle: string;
  byteSpan: Readonly<{ start: number; end: number }>;
  line: number;
  column: number;
  size: number;
  bytesRead: number;
  invalidation: Readonly<{
    kind: "identity_changed" | "size_changed" | "session_revision_changed" | "read_stale";
    observedAtSourceRun: string;
    code: string | null;
  }>;
}>;

export type ContentSearchNegativeFact = Readonly<{
  path: string;
  fileRef: ContentSearchFileRef;
  needle: string;
  offset: number;
  length: number;
  size: number;
  sessionRevision: number;
  observedAtSourceRun: string;
  completedAtSourceRun: string;
  reason: "complete_read_no_match";
}>;

export type ContentSearchCompleteListing = Readonly<{
  sourceRun: string | null;
  sourceRuns: readonly string[];
  coverage: "complete";
}>;

export type ContentSearchIncompleteListing = Readonly<{
  sourceRun: string | null;
  sourceRuns: readonly string[];
  coverage: "complete" | "partial" | null;
  errors: readonly string[];
}>;

export type ContentSearchRootFact =
  | Readonly<{
      kind: "matched";
      needle: string;
      listing: ContentSearchCompleteListing;
      match: ContentSearchHitFact;
      matches: readonly ContentSearchHitFact[];
      candidateNames: readonly string[];
    }>
  | Readonly<{
      kind: "not_found";
      needle: string;
      listing: ContentSearchCompleteListing;
      negativePaths: readonly string[];
      candidateNames: readonly string[];
    }>
  | Readonly<{
      kind: "partial";
      needle: string;
      listing: ContentSearchIncompleteListing;
      candidateNames: readonly string[];
      matchPaths: readonly string[];
      negativePaths: readonly string[];
      reasons: readonly string[];
    }>
  | Readonly<{
      kind: "insufficient_evidence";
      needle: string;
      listing: ContentSearchIncompleteListing;
      candidateNames: readonly string[];
      reasons: readonly string[];
      matchPaths: readonly string[];
      negativePaths: readonly string[];
    }>
  | Readonly<{ kind: "rejected" }>
  | Readonly<{ kind: "failed"; errors: readonly Readonly<{ path: string | null; code: string }>[] }>
  | Readonly<{ kind: "interrupted" }>;

export type ContentSearchOrder =
  | Readonly<{ kind: "lexicographic" }>
  | Readonly<{ kind: "injected-first"; name: string }>;

export type ContentSearchDenominators = Readonly<{
  listedDirectories: number;
  directoriesComplete: number;
  directoriesUncovered: number;
  candidatesTotal: number;
  candidatesScanned: number;
  candidatesMatched: number;
  candidatesNegative: number;
  candidatesUnresolved: number;
  typeMismatches: number;
}>;

export type ContentSearchDomainProjection = Readonly<{
  status: "achieved" | "unmet" | "unknown" | "rejected" | "failed";
  resolution:
    | "matched"
    | "not_found"
    | "partial"
    | "insufficient_evidence"
    | "rejected"
    | "failed"
    | "budget_exhausted"
    | "interrupted";
  satisfaction: number | null;
  cardinality: ContentSearchCardinality;
  recursion: ContentSearchRecursion;
  matches: readonly ContentSearchHitFact[];
  historicalMatches: readonly ContentSearchHistoricalHitFact[];
  negatives: readonly ContentSearchNegativeFact[];
  coverage: "complete" | "partial" | null;
  denominators: ContentSearchDenominators;
  observationBoundary: Readonly<{
    directoryListing: "per_list_dispatch";
    fileBytes: "per_read_range";
    atomicTreeSnapshot: false;
    atomicFileSnapshot: false;
  }>;
  ordering: ContentSearchOrder;
  deliberateSuboptimal: boolean;
  invocationCount: number;
  observationCount: number;
  bytesReadTotal: number;
  duplicateReads: number;
  budgetUsed: Readonly<{
    transitionsUsed: number;
    derivedGoalsUsed: number;
  }> | null;
  rootFact: ContentSearchRootFact | null;
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

export type ContentSearchScan = Readonly<{
  maxBytesPerFile: number;
  maxTotalBytes: number;
  chunkSize: number;
  maxDirectoryDepth: number;
  maxStaleRetries: number;
}>;

export type ContentSearchResources = Readonly<{
  sandbox: CliFilesystemSandbox;
  session: SessionRef;
  profile: CliCommandProfile;
  limits?: RecursiveGoalLimits;
  scan?: ContentSearchScan;
  order?: ContentSearchOrder;
  continuation?: unknown;
  duplicateReadProbe?: readonly string[];
  signal?: AbortSignal;
  onSample?: (sample: CliCommandSample) => void | Promise<void>;
  onDecision?: (decision: ContentSearchDecisionObservation) => void;
}>;

export type ContentSearchCandidateObservation = Readonly<{
  name: string;
  path: string;
  features: readonly number[];
}>;

export type ContentSearchDecisionObservation = Readonly<{
  ordinal: number;
  phase: "unstarted";
  forced: boolean;
  candidates: readonly ContentSearchCandidateObservation[];
  selected: ContentSearchCandidateObservation;
}>;

export type ContentSearchRunResult = Readonly<{
  request: ContentSearchRequest;
  response: unknown;
  domain: ContentSearchDomainProjection;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function osInteger(value: unknown, label: string): OsInteger {
  if (value === null) return null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer`);
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
  throw new TypeError(`${label} must be a safe integer, decimal string, or null`);
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

function directoryObjectRef(value: unknown, label: string): DirectoryObjectRef {
  const input = record(value, label);
  if (input.kind !== "cli.directory") throw new TypeError(`${label} must be a cli.directory reference`);
  if (Object.hasOwn(input, "path")) {
    exactKeys(input, ["kind", "scenarioId", "sessionId", "path"], label);
    return Object.freeze({
      kind: "cli.directory",
      scenarioId: nonEmpty(input.scenarioId, `${label}.scenarioId`),
      sessionId: nonEmpty(input.sessionId, `${label}.sessionId`),
      path: nonEmpty(input.path, `${label}.path`),
    }) as DirectoryRef as DirectoryObjectRef;
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
  if (input.kind !== "cli.directory") throw new TypeError(`${label} must be a cli.directory reference`);
  return Object.freeze({
    kind: "cli.directory",
    scenarioId: nonEmpty(input.scenarioId, `${label}.scenarioId`),
    sessionId: nonEmpty(input.sessionId, `${label}.sessionId`),
    path: nonEmpty(input.path, `${label}.path`),
  });
}

function pathRef(value: unknown, label: string): PathRef {
  const input = record(value, label);
  exactKeys(input, ["kind", "scenarioId", "sessionId", "path"], label);
  if (input.kind !== "cli.path") throw new TypeError(`${label} must be a cli.path reference`);
  const path = nonEmpty(input.path, `${label}.path`);
  if (!path.startsWith("/")) throw new TypeError(`${label}.path must be absolute`);
  return Object.freeze({
    kind: "cli.path",
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
  return Object.freeze({
    id: nonEmpty(input.id, `${label}.id`),
    cwd: nonEmpty(input.cwd, `${label}.cwd`),
    revision: nonnegativeInteger(input.revision, `${label}.revision`),
    grantedEffects: Object.freeze([...grantedEffects] as SessionSnapshot["grantedEffects"]),
  });
}

function fileCondition(value: unknown, label: string): ContentSearchFileCondition | null {
  if (value === null) return null;
  const input = record(value, label);
  if (input.type !== "regular") throw new TypeError(`${label}.type must be regular`);
  const hasName = Object.hasOwn(input, "name") && input.name !== undefined;
  const hasSuffix = Object.hasOwn(input, "suffix") && input.suffix !== undefined;
  if (hasName && hasSuffix) throw new TypeError(`${label} must not set both name and suffix`);
  if (hasName) {
    exactKeys(input, ["type", "name"], label);
    const name = nonEmpty(input.name, `${label}.name`);
    if (name === "." || name === ".." || name.includes("/")) {
      throw new TypeError(`${label}.name must be a single name segment without . or ..`);
    }
    return Object.freeze({ type: "regular", name });
  }
  if (hasSuffix) {
    exactKeys(input, ["type", "suffix"], label);
    const suffix = nonEmpty(input.suffix, `${label}.suffix`);
    if (suffix.includes("/")) throw new TypeError(`${label}.suffix must not contain a path separator`);
    return Object.freeze({ type: "regular", suffix });
  }
  exactKeys(input, ["type"], label);
  return Object.freeze({ type: "regular" });
}

function predicate(value: unknown, label: string): ContentContainsPredicate {
  const input = record(value, label);
  exactKeys(input, ["kind", "needle", "encoding"], label);
  if (input.kind !== "contains" || input.encoding !== "utf8") {
    throw new TypeError(`${label} must be a utf8 contains predicate`);
  }
  return Object.freeze({
    kind: "contains",
    needle: nonEmpty(input.needle, `${label}.needle`),
    encoding: "utf8",
  });
}

export function validateContentSearchGoal(value: unknown): ContentSearchGoal {
  const goal = record(value, "content search goal");
  exactKeys(goal, ["kind", "property", "target", "requirement"], "content search goal");
  if (goal.kind !== "file.property" || goal.property !== "file.property.content.bytes") {
    throw new TypeError("content search goal must be a file.property.content.bytes goal");
  }
  const target = record(goal.target, "content search goal target");
  if (target.kind !== "cli.content-search-scope") {
    throw new TypeError("content search goal target.kind must be cli.content-search-scope");
  }
  for (const key of ["directory", "fileCondition", "cardinality"]) {
    if (!Object.hasOwn(target, key)) {
      throw new TypeError(`content search goal target.${key} is required`);
    }
  }
  const targetKeys = Object.keys(target);
  if (targetKeys.some(key => !["kind", "directory", "fileCondition", "cardinality", "recursion"].includes(key))) {
    throw new TypeError("content search goal target contains unsupported fields");
  }
  if (target.cardinality !== "one" && target.cardinality !== "all") {
    throw new TypeError("content search goal target.cardinality must be one or all");
  }
  const recursion = Object.hasOwn(target, "recursion") ? target.recursion : "flat";
  if (recursion !== "flat" && recursion !== "nested") {
    throw new TypeError("content search goal target.recursion must be flat or nested");
  }
  if (target.cardinality === "one" && recursion === "nested") {
    throw new TypeError("content search P2 supports only one+flat and all+flat|nested");
  }
  const requirement = record(goal.requirement, "content search goal requirement");
  exactKeys(requirement, ["kind", "predicate"], "content search goal requirement");
  if (requirement.kind !== "contains") {
    throw new TypeError("content search goal requirement.kind must be contains");
  }
  return Object.freeze({
    kind: "file.property",
    property: "file.property.content.bytes",
    target: Object.freeze({
      kind: "cli.content-search-scope",
      directory: directoryObjectRef(target.directory, "content search goal target.directory"),
      fileCondition: fileCondition(target.fileCondition, "content search goal target.fileCondition"),
      cardinality: target.cardinality,
      recursion,
    }),
    requirement: Object.freeze({
      kind: "contains",
      predicate: predicate(requirement.predicate, "content search goal requirement.predicate"),
    }),
  });
}

export function validateContentSearchRequest(value: unknown, session: SessionRef): ContentSearchRequest {
  const request = record(value, "content search request");
  exactKeys(request, ["requestId", "goal", "satisfactionThreshold"], "content search request");
  if (request.satisfactionThreshold !== 100) {
    throw new TypeError("content search satisfactionThreshold must be exactly 100");
  }
  const goal = validateContentSearchGoal(request.goal);
  if (goal.target.directory.scenarioId !== session.scenarioId || goal.target.directory.sessionId !== session.sessionId) {
    throw new TypeError("content search goal target must belong to the bound session and scenario");
  }
  return Object.freeze({
    requestId: nonEmpty(request.requestId, "requestId"),
    goal,
    satisfactionThreshold: 100,
  });
}

export function validateContentSearchOrder(value: unknown): ContentSearchOrder {
  const input = record(value, "content search order");
  if (input.kind === "lexicographic") {
    exactKeys(input, ["kind"], "content search order");
    return Object.freeze({ kind: "lexicographic" });
  }
  if (input.kind === "injected-first") {
    exactKeys(input, ["kind", "name"], "content search order");
    const name = nonEmpty(input.name, "content search order.name");
    if (name === "." || name === ".." || name.includes("/")) {
      throw new TypeError("content search order.name must be a single name segment");
    }
    return Object.freeze({ kind: "injected-first", name });
  }
  throw new TypeError("content search order.kind must be lexicographic or injected-first");
}

export function validateContentSearchScan(value: unknown): ContentSearchScan {
  if (value === undefined) {
    return Object.freeze({ maxBytesPerFile: 65536, maxTotalBytes: 262144, chunkSize: 65536, maxDirectoryDepth: 8, maxStaleRetries: 1 });
  }
  const input = record(value, "content search scan");
  if (!Object.hasOwn(input, "maxBytesPerFile") && !Object.hasOwn(input, "maxTotalBytes") &&
      !Object.hasOwn(input, "chunkSize") && !Object.hasOwn(input, "maxDirectoryDepth") &&
      !Object.hasOwn(input, "maxStaleRetries")) {
    throw new TypeError("content search scan must set at least one limit");
  }
  if (Object.keys(input).some(key =>
    !["maxBytesPerFile", "maxTotalBytes", "chunkSize", "maxDirectoryDepth", "maxStaleRetries"].includes(key))) {
    throw new TypeError("content search scan contains unsupported fields");
  }
  const maxBytesPerFile = Object.hasOwn(input, "maxBytesPerFile")
    ? nonnegativeInteger(input.maxBytesPerFile, "content search scan.maxBytesPerFile")
    : 65536;
  const maxTotalBytes = Object.hasOwn(input, "maxTotalBytes")
    ? nonnegativeInteger(input.maxTotalBytes, "content search scan.maxTotalBytes")
    : 262144;
  const chunkSize = Object.hasOwn(input, "chunkSize")
    ? positiveInteger(input.chunkSize, "content search scan.chunkSize")
    : maxBytesPerFile;
  const maxDirectoryDepth = Object.hasOwn(input, "maxDirectoryDepth")
    ? nonnegativeInteger(input.maxDirectoryDepth, "content search scan.maxDirectoryDepth")
    : 8;
  const maxStaleRetries = Object.hasOwn(input, "maxStaleRetries")
    ? nonnegativeInteger(input.maxStaleRetries, "content search scan.maxStaleRetries")
    : 1;
  return Object.freeze({
    maxBytesPerFile,
    maxTotalBytes,
    chunkSize,
    maxDirectoryDepth,
    maxStaleRetries,
  });
}

export function validateContentSearchBindings(value: unknown, session: SessionRef): ContentSearchBindings {
  const bindings = record(value, "content search bindings");
  for (const key of ["session", "directory", "fileCondition", "cardinality", "needle"]) {
    if (!Object.hasOwn(bindings, key)) {
      throw new TypeError(`content search bindings.${key} is required`);
    }
  }
  if (Object.keys(bindings).some(key => !["session", "directory", "fileCondition", "cardinality", "needle", "recursion"].includes(key))) {
    throw new TypeError("content search bindings contains unsupported fields");
  }
  const boundSession = sessionRef(bindings.session, "bindings.session");
  const directory = directoryObjectRef(bindings.directory, "bindings.directory");
  if (
    boundSession.scenarioId !== session.scenarioId ||
    boundSession.sessionId !== session.sessionId ||
    directory.scenarioId !== session.scenarioId ||
    directory.sessionId !== session.sessionId
  ) {
    throw new TypeError("content search bindings must belong to the bound session and scenario");
  }
  if (bindings.cardinality !== "one" && bindings.cardinality !== "all") {
    throw new TypeError("content search bindings.cardinality must be one or all");
  }
  const recursion = Object.hasOwn(bindings, "recursion") ? bindings.recursion : "flat";
  if (recursion !== "flat" && recursion !== "nested") {
    throw new TypeError("content search bindings.recursion must be flat or nested");
  }
  if (bindings.cardinality === "one" && recursion === "nested") {
    throw new TypeError("content search P2 supports only one+flat and all+flat|nested");
  }
  return Object.freeze({
    session: boundSession,
    directory,
    fileCondition: fileCondition(bindings.fileCondition, "bindings.fileCondition"),
    cardinality: bindings.cardinality,
    recursion,
    needle: nonEmpty(bindings.needle, "bindings.needle"),
  });
}

export function validateContentSearchListGoal(value: unknown): ContentSearchListGoal {
  const goal = record(value, "content search list goal");
  exactKeys(goal, ["kind", "property", "target", "requirement"], "content search list goal");
  if (goal.kind !== "file.property" || goal.property !== "file.property.directory.entries") {
    throw new TypeError("content search list goal must use file.property.directory.entries");
  }
  const requirement = record(goal.requirement, "content search list goal requirement");
  exactKeys(requirement, ["kind", "freshness"], "content search list goal requirement");
  if (requirement.kind !== "observed" || requirement.freshness !== "this_run") {
    throw new TypeError("content search list goal requirement must be observed this_run");
  }
  return Object.freeze({
    kind: "file.property",
    property: "file.property.directory.entries",
    target: directoryRef(goal.target, "content search list goal target"),
    requirement: Object.freeze({ kind: "observed", freshness: "this_run" }),
  });
}

export function validateContentSearchInspectGoal(value: unknown): ContentSearchInspectGoal {
  const goal = record(value, "content search inspect goal");
  exactKeys(goal, ["kind", "property", "target", "requirement"], "content search inspect goal");
  if (goal.kind !== "file.property" || goal.property !== "file.property.type") {
    throw new TypeError("content search inspect goal must use file.property.type");
  }
  const requirement = record(goal.requirement, "content search inspect goal requirement");
  exactKeys(requirement, ["kind", "freshness"], "content search inspect goal requirement");
  if (requirement.kind !== "observed" || requirement.freshness !== "this_run") {
    throw new TypeError("content search inspect goal requirement must be observed this_run");
  }
  const target = record(goal.target, "content search inspect goal target");
  exactKeys(target, ["kind", "ref", "followSymlinks"], "content search inspect goal target");
  if (target.kind !== "cli.entry-query" || target.followSymlinks !== false) {
    throw new TypeError("content search inspect goal target must be cli.entry-query with followSymlinks false");
  }
  return Object.freeze({
    kind: "file.property",
    property: "file.property.type",
    target: Object.freeze({
      kind: "cli.entry-query",
      ref: pathRef(target.ref, "content search inspect goal target.ref"),
      followSymlinks: false,
    }),
    requirement: Object.freeze({ kind: "observed", freshness: "this_run" }),
  });
}

export function validateContentSearchReadGoal(value: unknown): ContentSearchReadGoal {
  const goal = record(value, "content search read goal");
  exactKeys(goal, ["kind", "property", "target", "requirement"], "content search read goal");
  if (goal.kind !== "file.property" || goal.property !== "file.property.content.bytes") {
    throw new TypeError("content search read goal must use file.property.content.bytes");
  }
  const target = record(goal.target, "content search read goal target");
  exactKeys(target, ["kind", "ref", "requiredType"], "content search read goal target");
  if (target.kind !== "cli.file" || target.requiredType !== "regular") {
    throw new TypeError("content search read goal target must be cli.file with requiredType regular");
  }
  const ref = readObservedObjectRef(target.ref);
  if (ref.kind !== "cli.file" || ref.type !== "regular") {
    throw new TypeError("content search read goal target.ref must be a cli.file regular reference");
  }
  const requirement = record(goal.requirement, "content search read goal requirement");
  exactKeys(requirement, ["kind", "range", "attempt"], "content search read goal requirement");
  if (requirement.kind !== "observed") {
    throw new TypeError("content search read goal requirement.kind must be observed");
  }
  const range = record(requirement.range, "content search read goal range");
  exactKeys(range, ["offset", "length"], "content search read goal range");
  return Object.freeze({
    kind: "file.property",
    property: "file.property.content.bytes",
    target: Object.freeze({
      kind: "cli.file",
      ref: ref as ContentSearchFileRef,
      requiredType: "regular",
    }),
    requirement: Object.freeze({
      kind: "observed",
      range: Object.freeze({
        offset: nonnegativeInteger(range.offset, "content search read goal range.offset"),
        length: nonnegativeInteger(range.length, "content search read goal range.length"),
      }),
      attempt: positiveInteger(requirement.attempt, "content search read goal attempt"),
    }),
  });
}

export function readContentSearchGoal(value: unknown): ContentSearchRunGoal {
  const goal = record(value, "content search run goal");
  if (!Object.hasOwn(goal, "requirement") || !isRecord(goal.requirement)) {
    throw new TypeError("content search run goal requirement must be an object");
  }
  const requirement = goal.requirement as Record<string, unknown>;
  if (goal.property === "file.property.content.bytes" && requirement.kind === "contains") {
    return validateContentSearchGoal(goal);
  }
  if (goal.property === "file.property.directory.entries" && requirement.kind === "observed") {
    return validateContentSearchListGoal(goal);
  }
  if (goal.property === "file.property.type" && requirement.kind === "observed") {
    return validateContentSearchInspectGoal(goal);
  }
  if (goal.property === "file.property.content.bytes" && requirement.kind === "observed") {
    return validateContentSearchReadGoal(goal);
  }
  throw new TypeError("unsupported content search run goal");
}

export function readContentSearchCursor(value: unknown): ContentSearchCursor {
  const cursor = record(value, "content search cursor");
  exactKeys(cursor, ["phase"], "content search cursor");
  if (!["listed", "descend", "choose", "inspected", "read", "reconcile", "closed"].includes(String(cursor.phase))) {
    throw new TypeError("content search cursor phase is invalid");
  }
  return Object.freeze({ phase: cursor.phase as ContentSearchPhase });
}

export function readContentSearchEvidencePayload(value: unknown): ContentSearchEvidencePayload {
  const payload = record(value, "content search evidence payload");
  if (payload.kind === "cli.content-search.transition.v1") {
    exactKeys(payload, ["kind", "transitionId", "stateId", "transition"], "content search evidence payload");
    return Object.freeze({
      kind: "cli.content-search.transition.v1",
      transitionId: nonEmpty(payload.transitionId, "content search evidence transitionId"),
      stateId: nonEmpty(payload.stateId, "content search evidence stateId"),
      transition: readCliCommandTransition(payload.transition, "content search evidence transition"),
    });
  }
  if (payload.kind === "cli.content-search.read.v1") {
    exactKeys(payload, ["kind", "transitionId", "stateId", "receipt", "ref"], "content search evidence payload");
    return Object.freeze({
      kind: "cli.content-search.read.v1",
      transitionId: nonEmpty(payload.transitionId, "content search evidence transitionId"),
      stateId: nonEmpty(payload.stateId, "content search evidence stateId"),
      receipt: readSemanticCallReceipt(payload.receipt, "content search evidence receipt"),
      ref: readFileRef(payload.ref, "content search evidence ref"),
    });
  }
  throw new TypeError("content search evidence payload kind is invalid");
}

export function readContentSearchEffectFact(value: unknown): ContentSearchEffectFact {
  const effect = record(value, "content search effect fact");
  exactKeys(effect, ["kind", "transitionId", "runId", "invoked"], "content search effect fact");
  if (effect.kind !== "cli.content-search.observation" || typeof effect.invoked !== "boolean") {
    throw new TypeError("content search effect fact is invalid");
  }
  return Object.freeze({
    kind: "cli.content-search.observation",
    transitionId: nonEmpty(effect.transitionId, "content search effect transitionId"),
    runId: effect.runId === null ? null : nonEmpty(effect.runId, "content search effect runId"),
    invoked: effect.invoked,
  });
}

export function readContentSearchReceiptPayload(value: unknown): ContentSearchReceiptPayload {
  const input = record(value, "content search receipt payload");
  if (input.kind === "cli.file.read.receipt.v1") {
    exactKeys(input, ["kind", "receipt", "ref"], "content search receipt payload");
    return Object.freeze({
      kind: "cli.file.read.receipt.v1",
      receipt: readSemanticCallReceipt(input.receipt, "content search receipt receipt"),
      ref: readFileRef(input.ref, "content search receipt ref"),
    });
  }
  return readCliCommandTransition(value, "content search receipt transition");
}

function readSemanticCallReceipt(value: unknown, label: string): SemanticCallReceipt {
  const receipt = record(value, label);
  exactKeys(receipt, ["call", "status", "session_before", "session_after", "execution"], label);
  if (receipt.status !== "succeeded" && receipt.status !== "failed") {
    throw new TypeError(`${label}.status must be succeeded or failed`);
  }
  const execution = record(receipt.execution, `${label}.execution`);
  for (const key of ["status", "runId", "executorInvoked"]) {
    if (!Object.hasOwn(execution, key)) throw new TypeError(`${label}.execution.${key} is required`);
  }
  if (execution.status !== "succeeded" && execution.status !== "failed") {
    throw new TypeError(`${label}.execution.status must be succeeded or failed`);
  }
  return receipt as unknown as SemanticCallReceipt;
}

function readCliCommandTransition(value: unknown, label: string): CliCommandTransition {
  const transition = record(value, label);
  for (const key of ["goal", "satisfactionThreshold", "state_before", "action", "invocation", "policy", "policy_error", "execution_result", "session_before", "session_after", "observed_state_after", "postcondition", "satisfaction", "status", "reason", "changed", "evidence", "collection_result", "defer"]) {
    if (!Object.hasOwn(transition, key)) throw new TypeError(`${label}.${key} is required`);
  }
  return transition as unknown as CliCommandTransition;
}

function readExplicitFileState(value: unknown): ExplicitFileState {
  const input = record(value, "content search explicit file state");
  for (const key of ["session", "cwdObservation", "directoryListing"]) {
    if (!Object.hasOwn(input, key)) throw new TypeError(`content search explicit file state.${key} is required`);
  }
  return input as unknown as ExplicitFileState;
}

function readFileRef(value: unknown, label: string): ContentSearchFileRef {
  const input = record(value, label);
  exactKeys(input, ["kind", "scenarioId", "sessionId", "type", "identity", "sourceRun", "sessionRevision", "absolutePath"], label);
  if (input.kind !== "cli.file" || input.type !== "regular") {
    throw new TypeError(`${label} must be a cli.file regular reference`);
  }
  const identity = record(input.identity, `${label}.identity`);
  exactKeys(identity, ["dev", "ino"], `${label}.identity`);
  return Object.freeze({
    kind: "cli.file",
    scenarioId: nonEmpty(input.scenarioId, `${label}.scenarioId`),
    sessionId: nonEmpty(input.sessionId, `${label}.sessionId`),
    type: "regular",
    identity: Object.freeze({
      dev: osInteger(identity.dev, `${label}.identity.dev`),
      ino: osInteger(identity.ino, `${label}.identity.ino`),
    }),
    sourceRun: nonEmpty(input.sourceRun, `${label}.sourceRun`),
    sessionRevision: nonnegativeInteger(input.sessionRevision, `${label}.sessionRevision`),
    absolutePath: nonEmpty(input.absolutePath, `${label}.absolutePath`),
  });
}

function readIdentity(value: unknown, label: string): Readonly<{ dev: OsInteger; ino: OsInteger }> {
  const input = record(value, label);
  exactKeys(input, ["dev", "ino"], label);
  return Object.freeze({
    dev: osInteger(input.dev, `${label}.dev`),
    ino: osInteger(input.ino, `${label}.ino`),
  });
}

function readInspected(value: unknown, label: string): ContentSearchInspectedFact {
  const input = record(value, label);
  exactKeys(input, ["sourceRun", "absolutePath", "type", "size", "identity", "sessionRevision", "errno"], label);
  return Object.freeze({
    sourceRun: input.sourceRun === null ? null : nonEmpty(input.sourceRun, `${label}.sourceRun`),
    absolutePath: nonEmpty(input.absolutePath, `${label}.absolutePath`),
    type: input.type === null ? null : input.type as EntryKind,
    size: osInteger(input.size, `${label}.size`),
    identity: readIdentity(input.identity, `${label}.identity`),
    sessionRevision: input.sessionRevision === null ? null : nonnegativeInteger(input.sessionRevision, `${label}.sessionRevision`),
    errno: input.errno === null ? null : nonEmpty(input.errno, `${label}.errno`),
  });
}

function readReadStateRef(value: unknown, label: string): ContentSearchReadStateRef {
  const input = record(value, label);
  exactKeys(input, ["kind", "ref", "sourceRun", "refSourceRun", "revision", "offset", "length", "size", "attempt", "bytesRead", "eof", "identity", "bytesRef"], label);
  if (input.kind !== "cli.content-search.read-state-ref.v1") {
    throw new TypeError(`${label}.kind must be cli.content-search.read-state-ref.v1`);
  }
  if (typeof input.eof !== "boolean") throw new TypeError(`${label}.eof must be a boolean`);
  const bytesRef = record(input.bytesRef, `${label}.bytesRef`);
  exactKeys(bytesRef, ["kind", "runId"], `${label}.bytesRef`);
  if (bytesRef.kind !== "cli.file.read.receipt.v1") {
    throw new TypeError(`${label}.bytesRef.kind must be cli.file.read.receipt.v1`);
  }
  return Object.freeze({
    kind: "cli.content-search.read-state-ref.v1",
    ref: readFileRef(input.ref, `${label}.ref`),
    sourceRun: nonEmpty(input.sourceRun, `${label}.sourceRun`),
    refSourceRun: nonEmpty(input.refSourceRun, `${label}.refSourceRun`),
    revision: nonnegativeInteger(input.revision, `${label}.revision`),
    offset: nonnegativeInteger(input.offset, `${label}.offset`),
    length: nonnegativeInteger(input.length, `${label}.length`),
    size: nonnegativeInteger(input.size, `${label}.size`),
    attempt: positiveInteger(input.attempt, `${label}.attempt`),
    bytesRead: nonnegativeInteger(input.bytesRead, `${label}.bytesRead`),
    eof: input.eof,
    identity: readIdentity(input.identity, `${label}.identity`),
    bytesRef: Object.freeze({
      kind: "cli.file.read.receipt.v1",
      runId: nonEmpty(bytesRef.runId, `${label}.bytesRef.runId`),
    }),
  });
}

function readCandidateRead(value: unknown, label: string): ContentSearchReadStateRef {
  const input = record(value, label);
  if (input.kind !== "cli.content-search.read-state-ref.v1") {
    throw new TypeError(`${label} must be a cli.content-search.read-state-ref.v1 reference`);
  }
  return readReadStateRef(input, label);
}

function readIdentityKey(value: unknown, label: string): ContentSearchIdentityKey {
  const input = record(value, label);
  exactKeys(input, ["scenarioId", "sessionId", "dev", "ino", "sessionRevision", "sourceRun"], label);
  return Object.freeze({
    scenarioId: nonEmpty(input.scenarioId, `${label}.scenarioId`),
    sessionId: nonEmpty(input.sessionId, `${label}.sessionId`),
    dev: osInteger(input.dev, `${label}.dev`),
    ino: osInteger(input.ino, `${label}.ino`),
    sessionRevision: nonnegativeInteger(input.sessionRevision, `${label}.sessionRevision`),
    sourceRun: nonEmpty(input.sourceRun, `${label}.sourceRun`),
  });
}

function readScanFact(value: unknown, label: string): ContentSearchScanFact {
  const input = record(value, label);
  exactKeys(input, ["nextOffset", "carry", "carryLineStartAbs", "found", "firstMatch", "complete", "bytesRead", "chunks", "sizeAtStart", "identityAtStart", "firstReadSourceRun", "lastReadSourceRun", "lastEndObserved", "shortRead", "prefixNewlines", "lastNewlineAbs"], label);
  if (typeof input.found !== "boolean" || typeof input.complete !== "boolean" ||
      typeof input.lastEndObserved !== "boolean" || typeof input.shortRead !== "boolean") {
    throw new TypeError(`${label} boolean fields are invalid`);
  }
  const firstMatch = input.firstMatch === null ? null : (() => {
    const span = record(input.firstMatch, `${label}.firstMatch`);
    exactKeys(span, ["start", "end", "line", "column"], `${label}.firstMatch`);
    return Object.freeze({
      start: nonnegativeInteger(span.start, `${label}.firstMatch.start`),
      end: nonnegativeInteger(span.end, `${label}.firstMatch.end`),
      line: positiveInteger(span.line, `${label}.firstMatch.line`),
      column: positiveInteger(span.column, `${label}.firstMatch.column`),
    });
  })();
  return Object.freeze({
    nextOffset: nonnegativeInteger(input.nextOffset, `${label}.nextOffset`),
    carry: typeof input.carry === "string" ? input.carry : (() => { throw new TypeError(`${label}.carry must be a string`); })(),
    carryLineStartAbs: nonnegativeInteger(input.carryLineStartAbs, `${label}.carryLineStartAbs`),
    found: input.found,
    firstMatch,
    complete: input.complete,
    bytesRead: nonnegativeInteger(input.bytesRead, `${label}.bytesRead`),
    chunks: nonnegativeInteger(input.chunks, `${label}.chunks`),
    sizeAtStart: nonnegativeInteger(input.sizeAtStart, `${label}.sizeAtStart`),
    identityAtStart: readIdentityKey(input.identityAtStart, `${label}.identityAtStart`),
    firstReadSourceRun: input.firstReadSourceRun === null ? null : nonEmpty(input.firstReadSourceRun, `${label}.firstReadSourceRun`),
    lastReadSourceRun: input.lastReadSourceRun === null ? null : nonEmpty(input.lastReadSourceRun, `${label}.lastReadSourceRun`),
    lastEndObserved: input.lastEndObserved,
    shortRead: input.shortRead,
    prefixNewlines: nonnegativeInteger(input.prefixNewlines, `${label}.prefixNewlines`),
    lastNewlineAbs: input.lastNewlineAbs === -1 ? -1 : nonnegativeInteger(input.lastNewlineAbs, `${label}.lastNewlineAbs`),
  });
}

function readHistoricalHit(value: unknown, label: string): ContentSearchHistoricalHitFact {
  const input = record(value, label);
  exactKeys(input, ["kind", "historical", "identityKey", "fileRef", "sourceRun", "path", "needle", "byteSpan", "line", "column", "size", "bytesRead", "invalidation"], label);
  const invalidation = record(input.invalidation, `${label}.invalidation`);
  exactKeys(invalidation, ["kind", "observedAtSourceRun", "code"], `${label}.invalidation`);
  const byteSpan = record(input.byteSpan, `${label}.byteSpan`);
  exactKeys(byteSpan, ["start", "end"], `${label}.byteSpan`);
  return Object.freeze({
    kind: "historical_stale_hit",
    historical: true,
    identityKey: readIdentityKey(input.identityKey, `${label}.identityKey`),
    fileRef: readFileRef(input.fileRef, `${label}.fileRef`),
    sourceRun: nonEmpty(input.sourceRun, `${label}.sourceRun`),
    path: nonEmpty(input.path, `${label}.path`),
    needle: nonEmpty(input.needle, `${label}.needle`),
    byteSpan: Object.freeze({ start: nonnegativeInteger(byteSpan.start, `${label}.byteSpan.start`), end: nonnegativeInteger(byteSpan.end, `${label}.byteSpan.end`) }),
    line: nonnegativeInteger(input.line, `${label}.line`),
    column: nonnegativeInteger(input.column, `${label}.column`),
    size: nonnegativeInteger(input.size, `${label}.size`),
    bytesRead: nonnegativeInteger(input.bytesRead, `${label}.bytesRead`),
    invalidation: Object.freeze({
      kind: invalidation.kind as ContentSearchHistoricalHitFact["invalidation"]["kind"],
      observedAtSourceRun: nonEmpty(invalidation.observedAtSourceRun, `${label}.invalidation.observedAtSourceRun`),
      code: invalidation.code === null ? null : nonEmpty(invalidation.code, `${label}.invalidation.code`),
    }),
  });
}

function readCandidate(value: unknown, label: string): ContentSearchCandidateFact {
  const input = record(value, label);
  exactKeys(input, ["name", "path", "listedType", "inspected", "fileRef", "read", "scan", "history", "contains", "outcome", "byteSpan", "line", "column", "reason", "failureCode", "duplicateRead", "staleRetries"], label);
  const outcomes = new Set(["pending", "matched", "negative", "type_mismatch", "unknown", "read_error", "stale"]);
  if (!outcomes.has(String(input.outcome))) throw new TypeError(`${label}.outcome is invalid`);
  if (typeof input.contains !== "boolean" && input.contains !== null) throw new TypeError(`${label}.contains must be boolean or null`);
  if (typeof input.duplicateRead !== "boolean") throw new TypeError(`${label}.duplicateRead must be a boolean`);
  const byteSpan = input.byteSpan === null ? null : (() => {
    const span = record(input.byteSpan, `${label}.byteSpan`);
    exactKeys(span, ["start", "end"], `${label}.byteSpan`);
    return Object.freeze({
      start: nonnegativeInteger(span.start, `${label}.byteSpan.start`),
      end: nonnegativeInteger(span.end, `${label}.byteSpan.end`),
    });
  })();
  return Object.freeze({
    name: nonEmpty(input.name, `${label}.name`),
    path: nonEmpty(input.path, `${label}.path`),
    listedType: input.listedType as ContentSearchCandidateFact["listedType"],
    inspected: input.inspected === null ? null : readInspected(input.inspected, `${label}.inspected`),
    fileRef: input.fileRef === null ? null : readFileRef(input.fileRef, `${label}.fileRef`),
    read: input.read === null ? null : readCandidateRead(input.read, `${label}.read`),
    scan: input.scan === null ? null : readScanFact(input.scan, `${label}.scan`),
    history: Object.freeze((input.history as unknown[]).map((item, index) => readHistoricalHit(item, `${label}.history[${index}]`))),
    contains: input.contains as boolean | null,
    outcome: input.outcome as ContentSearchCandidateOutcome,
    byteSpan,
    line: input.line === null ? null : nonnegativeInteger(input.line, `${label}.line`),
    column: input.column === null ? null : nonnegativeInteger(input.column, `${label}.column`),
    reason: input.reason === null ? null : nonEmpty(input.reason, `${label}.reason`),
    failureCode: input.failureCode === null ? null : nonEmpty(input.failureCode, `${label}.failureCode`),
    duplicateRead: input.duplicateRead,
    staleRetries: nonnegativeInteger(input.staleRetries, `${label}.staleRetries`),
  });
}

function readListing(value: unknown, label: string): ContentSearchListingFact {
  const input = record(value, label);
  exactKeys(input, ["sourceRun", "physicalDirectory", "coverage", "errors", "entries"], label);
  if (!Array.isArray(input.errors) || !Array.isArray(input.entries)) throw new TypeError(`${label} errors and entries must be arrays`);
  const coverage = input.coverage;
  if (coverage !== null && coverage !== "complete" && coverage !== "partial") {
    throw new TypeError(`${label}.coverage is invalid`);
  }
  return Object.freeze({
    sourceRun: input.sourceRun === null ? null : nonEmpty(input.sourceRun, `${label}.sourceRun`),
    physicalDirectory: input.physicalDirectory === null ? null : nonEmpty(input.physicalDirectory, `${label}.physicalDirectory`),
    coverage: coverage as "complete" | "partial" | null,
    errors: Object.freeze((input.errors as unknown[]).map(item => String(item))),
    entries: Object.freeze((input.entries as unknown[]).map((item, index) => {
      const entry = record(item, `${label}.entries[${index}]`);
      return Object.freeze({
        name: nonEmpty(entry.name, `${label}.entries[${index}].name`),
        path: nonEmpty(entry.path, `${label}.entries[${index}].path`),
        type: entry.type as ContentSearchListingFact["entries"][number]["type"],
      });
    })),
  });
}

function readNegative(value: unknown, label: string): ContentSearchNegativeFact {
  const input = record(value, label);
  exactKeys(input, ["path", "fileRef", "needle", "offset", "length", "size", "sessionRevision", "observedAtSourceRun", "completedAtSourceRun", "reason"], label);
  if (input.reason !== "complete_read_no_match") throw new TypeError(`${label}.reason must be complete_read_no_match`);
  return Object.freeze({
    path: nonEmpty(input.path, `${label}.path`),
    fileRef: readFileRef(input.fileRef, `${label}.fileRef`),
    needle: nonEmpty(input.needle, `${label}.needle`),
    offset: nonnegativeInteger(input.offset, `${label}.offset`),
    length: nonnegativeInteger(input.length, `${label}.length`),
    size: nonnegativeInteger(input.size, `${label}.size`),
    sessionRevision: nonnegativeInteger(input.sessionRevision, `${label}.sessionRevision`),
    observedAtSourceRun: nonEmpty(input.observedAtSourceRun, `${label}.observedAtSourceRun`),
    completedAtSourceRun: nonEmpty(input.completedAtSourceRun, `${label}.completedAtSourceRun`),
    reason: "complete_read_no_match",
  });
}

export function readContentSearchState(value: unknown): ContentSearchState {
  const state = record(value, "content search state");
  exactKeys(state, ["stateId", "session", "cli", "listing", "cardinality", "recursion", "maxDirectoryDepth", "maxStaleRetries", "directories", "pendingDirectories", "candidates", "provenNegatives", "typeMismatches", "duplicateReads", "bytesReadTotal"], "content search state");
  if (!Array.isArray(state.candidates)) throw new TypeError("content search state.candidates must be an array");
  if (!Array.isArray(state.directories)) throw new TypeError("content search state.directories must be an array");
  if (!Array.isArray(state.pendingDirectories)) throw new TypeError("content search state.pendingDirectories must be an array");
  if (!Array.isArray(state.provenNegatives)) throw new TypeError("content search state.provenNegatives must be an array");
  if (!Array.isArray(state.typeMismatches)) throw new TypeError("content search state.typeMismatches must be an array");
  if (state.cardinality !== "one" && state.cardinality !== "all") throw new TypeError("content search state.cardinality is invalid");
  if (state.recursion !== "flat" && state.recursion !== "nested") throw new TypeError("content search state.recursion is invalid");
  const directories = (state.directories as unknown[]).map((item, index) => {
    const input = record(item, `content search state.directories[${index}]`);
    exactKeys(input, ["path", "depth", "listing", "observedAtSourceRun", "listed", "descendable", "uncoveredReason"], `content search state.directories[${index}]`);
    if (typeof input.listed !== "boolean" || typeof input.descendable !== "boolean") {
      throw new TypeError(`content search state.directories[${index}] boolean fields are invalid`);
    }
    return Object.freeze({
      path: nonEmpty(input.path, `directories[${index}].path`),
      depth: nonnegativeInteger(input.depth, `directories[${index}].depth`),
      listing: input.listing === null ? null : readListing(input.listing, `directories[${index}].listing`),
      observedAtSourceRun: input.observedAtSourceRun === null ? null : nonEmpty(input.observedAtSourceRun, `directories[${index}].observedAtSourceRun`),
      listed: input.listed,
      descendable: input.descendable,
      uncoveredReason: input.uncoveredReason === null ? null : input.uncoveredReason as ContentSearchDirectoryFact["uncoveredReason"],
    });
  });
  const pendingDirectories = (state.pendingDirectories as unknown[]).map((item, index) => {
    const input = record(item, `content search state.pendingDirectories[${index}]`);
    exactKeys(input, ["path", "depth"], `content search state.pendingDirectories[${index}]`);
    return Object.freeze({ path: nonEmpty(input.path, `pendingDirectories[${index}].path`), depth: nonnegativeInteger(input.depth, `pendingDirectories[${index}].depth`) });
  });
  const typeMismatches = (state.typeMismatches as unknown[]).map((item, index) => {
    const input = record(item, `content search state.typeMismatches[${index}]`);
    exactKeys(input, ["name", "path"], `content search state.typeMismatches[${index}]`);
    return Object.freeze({ name: nonEmpty(input.name, `typeMismatches[${index}].name`), path: nonEmpty(input.path, `typeMismatches[${index}].path`) });
  });
  return Object.freeze({
    stateId: nonEmpty(state.stateId, "content search state stateId"),
    session: sessionSnapshot(state.session, "content search state session"),
    cli: readExplicitFileState(state.cli),
    listing: state.listing === null ? null : readListing(state.listing, "content search state listing"),
    cardinality: state.cardinality,
    recursion: state.recursion,
    maxDirectoryDepth: nonnegativeInteger(state.maxDirectoryDepth, "content search state maxDirectoryDepth"),
    maxStaleRetries: nonnegativeInteger(state.maxStaleRetries, "content search state maxStaleRetries"),
    directories: Object.freeze(directories),
    pendingDirectories: Object.freeze(pendingDirectories),
    candidates: Object.freeze((state.candidates as unknown[]).map((item, index) => readCandidate(item, `content search state.candidates[${index}]`))),
    provenNegatives: Object.freeze((state.provenNegatives as unknown[]).map((item, index) => {
      const input = record(item, `content search state.provenNegatives[${index}]`);
      return readNegative(input, `content search state.provenNegatives[${index}]`);
    })),
    typeMismatches: Object.freeze(typeMismatches),
    duplicateReads: nonnegativeInteger(state.duplicateReads, "content search state duplicateReads"),
    bytesReadTotal: nonnegativeInteger(state.bytesReadTotal, "content search state bytesReadTotal"),
  });
}

export type { DirectoryListObservation, DirectoryObjectRef };
