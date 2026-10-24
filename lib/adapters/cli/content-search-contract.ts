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

export type ContentSearchTarget = Readonly<{
  kind: "cli.content-search-scope";
  directory: DirectoryObjectRef;
  fileCondition: ContentSearchFileCondition | null;
  cardinality: "one";
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
  cardinality: "one";
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

export type ContentSearchCandidateOutcome =
  | "pending"
  | "matched"
  | "negative"
  | "type_mismatch"
  | "unknown"
  | "read_error"
  | "stale";

export type ContentSearchCandidateFact = Readonly<{
  name: string;
  path: string;
  listedType: "file" | "directory" | "symlink" | "other" | "unknown";
  inspected: ContentSearchInspectedFact | null;
  fileRef: ContentSearchFileRef | null;
  read: ContentSearchReadFact | null;
  contains: boolean | null;
  outcome: ContentSearchCandidateOutcome;
  byteSpan: Readonly<{ start: number; end: number }> | null;
  line: number | null;
  column: number | null;
  reason: string | null;
  failureCode: string | null;
  duplicateRead: boolean;
}>;

export type ContentSearchState = Readonly<{
  stateId: string;
  session: SessionSnapshot;
  cli: ExplicitFileState;
  listing: ContentSearchListingFact | null;
  candidates: readonly ContentSearchCandidateFact[];
  duplicateReads: number;
}>;

export type ContentSearchPhase = "listed" | "choose" | "inspected" | "read" | "closed";

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
  fileRef: ContentSearchFileRef;
  path: string;
  needle: string;
  byteSpan: Readonly<{ start: number; end: number }>;
  line: number;
  column: number;
  size: number;
  bytesRead: number;
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
  reason: "complete_read_no_match";
}>;

export type ContentSearchRootFact =
  | Readonly<{
      kind: "matched";
      needle: string;
      listing: Readonly<{ sourceRun: string | null; coverage: "complete" }>;
      match: ContentSearchHitFact;
      candidateNames: readonly string[];
    }>
  | Readonly<{
      kind: "not_found";
      needle: string;
      listing: Readonly<{ sourceRun: string | null; coverage: "complete" }>;
      negativePaths: readonly string[];
      candidateNames: readonly string[];
    }>
  | Readonly<{
      kind: "insufficient_evidence";
      needle: string;
      listing: Readonly<{
        sourceRun: string | null;
        coverage: "complete" | "partial" | null;
        errors: readonly string[];
      }>;
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

export type ContentSearchDomainProjection = Readonly<{
  status: "achieved" | "unmet" | "unknown" | "rejected" | "failed";
  resolution:
    | "matched"
    | "not_found"
    | "insufficient_evidence"
    | "rejected"
    | "failed"
    | "interrupted";
  satisfaction: number | null;
  matches: readonly ContentSearchHitFact[];
  negatives: readonly ContentSearchNegativeFact[];
  coverage: "complete" | "partial" | null;
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
  }>;
}>;

export type ContentSearchScan = Readonly<{
  maxBytesPerFile: number;
  maxTotalBytes: number;
  chunkSize: number;
}>;

export type ContentSearchResources = Readonly<{
  sandbox: CliFilesystemSandbox;
  session: SessionRef;
  profile: CliCommandProfile;
  limits: RecursiveGoalLimits;
  scan?: ContentSearchScan;
  order?: ContentSearchOrder;
  duplicateReadProbe?: readonly string[];
  signal?: AbortSignal;
  onSample?: (sample: CliCommandSample) => void | Promise<void>;
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
  exactKeys(target, ["kind", "directory", "fileCondition", "cardinality"], "content search goal target");
  if (target.kind !== "cli.content-search-scope") {
    throw new TypeError("content search goal target.kind must be cli.content-search-scope");
  }
  if (target.cardinality !== "one") {
    throw new TypeError("content search goal target.cardinality must be one in P1");
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
      cardinality: "one",
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
    return Object.freeze({ maxBytesPerFile: 65536, maxTotalBytes: 262144, chunkSize: 65536 });
  }
  const input = record(value, "content search scan");
  if (!Object.hasOwn(input, "maxBytesPerFile") && !Object.hasOwn(input, "maxTotalBytes") && !Object.hasOwn(input, "chunkSize")) {
    throw new TypeError("content search scan must set at least one limit");
  }
  const keys = Object.keys(input).filter(key => ["maxBytesPerFile", "maxTotalBytes", "chunkSize"].includes(key));
  if (keys.length !== Object.keys(input).length) {
    throw new TypeError("content search scan contains unsupported fields");
  }
  const maxBytesPerFile = Object.hasOwn(input, "maxBytesPerFile")
    ? nonnegativeInteger(input.maxBytesPerFile, "content search scan.maxBytesPerFile")
    : 65536;
  const maxTotalBytes = Object.hasOwn(input, "maxTotalBytes")
    ? nonnegativeInteger(input.maxTotalBytes, "content search scan.maxTotalBytes")
    : 262144;
  const chunkSize = Object.hasOwn(input, "chunkSize")
    ? nonnegativeInteger(input.chunkSize, "content search scan.chunkSize")
    : maxBytesPerFile;
  return Object.freeze({
    maxBytesPerFile,
    maxTotalBytes,
    chunkSize,
  });
}

export function validateContentSearchBindings(value: unknown, session: SessionRef): ContentSearchBindings {
  const bindings = record(value, "content search bindings");
  exactKeys(bindings, ["session", "directory", "fileCondition", "cardinality", "needle"], "content search bindings");
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
  if (bindings.cardinality !== "one") {
    throw new TypeError("content search bindings.cardinality must be one in P1");
  }
  return Object.freeze({
    session: boundSession,
    directory,
    fileCondition: fileCondition(bindings.fileCondition, "bindings.fileCondition"),
    cardinality: "one",
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
  if (!["listed", "choose", "inspected", "read", "closed"].includes(String(cursor.phase))) {
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

function readReadFact(value: unknown, label: string): ContentSearchReadFact {
  const input = record(value, label);
  exactKeys(input, ["ref", "sourceRun", "refSourceRun", "revision", "offset", "length", "size", "attempt", "bytes", "bytesRead", "eof", "identity"], label);
  if (typeof input.eof !== "boolean") throw new TypeError(`${label}.eof must be a boolean`);
  return Object.freeze({
    ref: readFileRef(input.ref, `${label}.ref`),
    sourceRun: nonEmpty(input.sourceRun, `${label}.sourceRun`),
    refSourceRun: nonEmpty(input.refSourceRun, `${label}.refSourceRun`),
    revision: nonnegativeInteger(input.revision, `${label}.revision`),
    offset: nonnegativeInteger(input.offset, `${label}.offset`),
    length: nonnegativeInteger(input.length, `${label}.length`),
    size: nonnegativeInteger(input.size, `${label}.size`),
    attempt: positiveInteger(input.attempt, `${label}.attempt`),
    bytes: typeof input.bytes === "string" ? input.bytes : (() => { throw new TypeError(`${label}.bytes must be a string`); })(),
    bytesRead: nonnegativeInteger(input.bytesRead, `${label}.bytesRead`),
    eof: input.eof,
    identity: readIdentity(input.identity, `${label}.identity`),
  });
}

function readCandidate(value: unknown, label: string): ContentSearchCandidateFact {
  const input = record(value, label);
  exactKeys(input, ["name", "path", "listedType", "inspected", "fileRef", "read", "contains", "outcome", "byteSpan", "line", "column", "reason", "failureCode", "duplicateRead"], label);
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
    read: input.read === null ? null : readReadFact(input.read, `${label}.read`),
    contains: input.contains as boolean | null,
    outcome: input.outcome as ContentSearchCandidateOutcome,
    byteSpan,
    line: input.line === null ? null : nonnegativeInteger(input.line, `${label}.line`),
    column: input.column === null ? null : nonnegativeInteger(input.column, `${label}.column`),
    reason: input.reason === null ? null : nonEmpty(input.reason, `${label}.reason`),
    failureCode: input.failureCode === null ? null : nonEmpty(input.failureCode, `${label}.failureCode`),
    duplicateRead: input.duplicateRead,
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

export function readContentSearchState(value: unknown): ContentSearchState {
  const state = record(value, "content search state");
  exactKeys(state, ["stateId", "session", "cli", "listing", "candidates", "duplicateReads"], "content search state");
  if (!Array.isArray(state.candidates)) throw new TypeError("content search state.candidates must be an array");
  return Object.freeze({
    stateId: nonEmpty(state.stateId, "content search state stateId"),
    session: sessionSnapshot(state.session, "content search state session"),
    cli: readExplicitFileState(state.cli),
    listing: state.listing === null ? null : readListing(state.listing, "content search state listing"),
    candidates: Object.freeze((state.candidates as unknown[]).map((item, index) => readCandidate(item, `content search state.candidates[${index}]`))),
    duplicateReads: nonnegativeInteger(state.duplicateReads, "content search state duplicateReads"),
  });
}

export type { DirectoryListObservation, DirectoryObjectRef };
