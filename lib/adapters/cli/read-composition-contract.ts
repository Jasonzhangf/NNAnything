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
  type ObservedObjectRef,
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
import type { PlanningDecisionBinding } from "../../workflow/recursive-goal/decision-contracts.js";

export type ReadCompositionName = string;

export type ReadRange = Readonly<{ offset: number; length: number }>;

export type ReadCompositionSourceSpec = Readonly<{
  directory: DirectoryObjectRef;
  order: number | null;
}>;

export type ReadCompositionSingleTarget = Readonly<{
  kind: "cli.exact-child";
  directory: DirectoryObjectRef;
  name: ReadCompositionName;
  requiredType: "regular";
}>;

export type ReadCompositionMultiTarget = Readonly<{
  kind: "cli.exact-child-sources";
  sources: readonly [ReadCompositionSourceSpec, ReadCompositionSourceSpec];
  name: ReadCompositionName;
  requiredType: "regular";
}>;

export type ReadCompositionTarget =
  | ReadCompositionSingleTarget
  | ReadCompositionMultiTarget;

export type ReadCompositionRequirement = Readonly<{
  kind: "equals";
  range: ReadRange;
  expectedBase64: string;
}>;

export type ReadCompositionGoal = Readonly<{
  kind: "file.property";
  property: "file.property.content.bytes";
  target: ReadCompositionTarget;
  requirement: ReadCompositionRequirement;
}>;

export type ReadCompositionRequest = Readonly<{
  requestId: string;
  goal: ReadCompositionGoal;
  satisfactionThreshold: 100;
}>;

export type ReadCompositionListGoal = Readonly<{
  kind: "file.property";
  property: "file.property.directory.entries";
  target: DirectoryRef;
  requirement: Readonly<{ kind: "observed"; freshness: "this_run" }>;
}>;

export type ReadCompositionInspectGoal = Readonly<{
  kind: "file.property";
  property: "file.property.type";
  target: Readonly<{
    kind: "cli.entry-query";
    ref: PathRef;
    followSymlinks: false;
  }>;
  requirement: Readonly<{ kind: "observed"; freshness: "this_run" }>;
}>;

export type ReadCompositionReadGoal = Readonly<{
  kind: "file.property";
  property: "file.property.content.bytes";
  target: Readonly<{
    kind: "cli.file";
    ref: ObservedObjectRef;
    requiredType: "regular";
  }>;
  requirement: Readonly<{ kind: "observed"; range: ReadRange }>;
}>;

export type ReadCompositionRunGoal =
  | ReadCompositionGoal
  | ReadCompositionListGoal
  | ReadCompositionInspectGoal
  | ReadCompositionReadGoal;

export type ReadCompositionBindings = Readonly<{
  session: SessionRef;
  directory: DirectoryObjectRef;
  name: string;
  requiredType: "regular";
  range: ReadRange;
  expectedBase64: string;
}>;

export type ReadCompositionMultiBindings = Readonly<{
  session: SessionRef;
  sources: readonly [ReadCompositionSourceSpec, ReadCompositionSourceSpec];
  name: string;
  requiredType: "regular";
  range: ReadRange;
  expectedBase64: string;
}>;

export type ReadCompositionListingFact = Readonly<{
  sourceRun: string | null;
  coverage: "complete" | "partial" | null;
  directoryRef: DirectoryObjectRef | null;
  errors: readonly string[];
  candidateNames: readonly string[];
  entries: readonly Readonly<{
    name: string;
    path: string;
    type: "file" | "directory" | "symlink" | "other" | "unknown";
  }>[];
}>;

export type ReadCompositionCandidate = Readonly<{
  name: string;
  path: string;
  listedType: "file" | "directory" | "symlink" | "other" | "unknown";
  listingRun: string | null;
}>;

export type ReadCompositionInspectedFact = Readonly<{
  sourceRun: string | null;
  type: string | null;
  identity: Readonly<{ dev: number | string | null; ino: number | string | null }>;
  sessionRevision: number | null;
  absolutePath: string | null;
}>;

export type ReadCompositionFileRef = Readonly<{
  kind: "cli.file";
  scenarioId: string;
  sessionId: string;
  type: "regular";
  identity: Readonly<{ dev: number | string | null; ino: number | string | null }>;
  sourceRun: string;
  sessionRevision: number;
  absolutePath: string;
}>;

export type ReadCompositionReadFact = Readonly<{
  ref: ReadCompositionFileRef;
  sourceRun: string | null;
  refSourceRun: string | null;
  revision: number | null;
  offset: number | null;
  length: number | null;
  bytes: string | null;
  bytesRead: number | null;
  size: number | null;
  eof: boolean | null;
  identity: Readonly<{ dev: number | string | null; ino: number | string | null }>;
}>;

export type ReadCompositionSourceState = Readonly<{
  sourceId: "source:0" | "source:1";
  order: number | null;
  directory: DirectoryObjectRef;
  listing: ReadCompositionListingFact | null;
  candidate: ReadCompositionCandidate | null;
  inspected: ReadCompositionInspectedFact | null;
  fileRef: ReadCompositionFileRef | null;
  read: ReadCompositionReadFact | null;
}>;

export type ReadCompositionState = Readonly<{
  stateId: string;
  session: SessionSnapshot;
  cli: ExplicitFileState;
  listing: ReadCompositionListingFact | null;
  candidate: ReadCompositionCandidate | null;
  inspected: ReadCompositionInspectedFact | null;
  fileRef: ReadCompositionFileRef | null;
  read: ReadCompositionReadFact | null;
  sources: readonly [ReadCompositionSourceState, ReadCompositionSourceState] | null;
}>;

export type ReadCompositionPhase =
  | "listed"
  | "inspected"
  | "read"
  | "closed"
  | "rejected"
  | "fallback-basis"
  | "inspected-alt"
  | "read-alt";

export type ReadCompositionDecisionRecord = Readonly<{
  kind: "ranked" | "defer";
  chosen: "source:0" | "source:1" | null;
  missingKeys: readonly string[];
}>;

export type ReadCompositionCursor = Readonly<{
  phase: ReadCompositionPhase;
  chosen: 0 | 1 | null;
  decision: ReadCompositionDecisionRecord | null;
}>;

export type ReadCompositionEvidencePayload =
  | Readonly<{
      kind: "cli.read-composition.transition.v1";
      transitionId: string;
      stateId: string;
      transition: CliCommandTransition;
    }>
  | Readonly<{
      kind: "cli.read-composition.read.v1";
      transitionId: string;
      stateId: string;
      receipt: SemanticCallReceipt;
      ref: ReadCompositionFileRef;
    }>;

export type ReadCompositionEffectFact = Readonly<{
  kind: "cli.read-composition.observation";
  transitionId: string;
  runId: string | null;
  invoked: boolean;
}>;

export type ReadCompositionReadReceipt = Readonly<{
  kind: "cli.file.read.receipt.v1";
  receipt: SemanticCallReceipt;
  ref: ReadCompositionFileRef;
}>;

export type ReadCompositionReceiptPayload = CliCommandTransition | ReadCompositionReadReceipt;

export type ReadCompositionRootFact =
  | Readonly<{
      kind: "matched";
      listing: ReadCompositionListingFact;
      inspected: ReadCompositionInspectedFact;
      fileRef: ReadCompositionFileRef;
      read: ReadCompositionReadFact;
    }>
  | Readonly<{
      kind: "not_found";
      listing: ReadCompositionListingFact;
    }>
  | Readonly<{
      kind: "type_mismatch";
      listing: ReadCompositionListingFact;
      inspected: ReadCompositionInspectedFact;
      fileRef: ReadCompositionFileRef | null;
    }>
  | Readonly<{
      kind: "byte_mismatch";
      listing: ReadCompositionListingFact;
      inspected: ReadCompositionInspectedFact;
      fileRef: ReadCompositionFileRef;
      read: ReadCompositionReadFact;
    }>
  | Readonly<{
      kind: "insufficient_evidence";
      listing: ReadCompositionListingFact;
      inspected: ReadCompositionInspectedFact | null;
      fileRef: ReadCompositionFileRef | null;
      read: ReadCompositionReadFact | null;
    }>
  | Readonly<{
      kind: "stale_or_unverified";
      listing: ReadCompositionListingFact;
      inspected: ReadCompositionInspectedFact | null;
      fileRef: ReadCompositionFileRef | null;
      read: ReadCompositionReadFact | null;
    }>
  | Readonly<{ kind: "rejected" }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "interrupted" }>;

export type ReadCompositionDomainProjection = Readonly<{
  status: "achieved" | "unmet" | "unknown" | "rejected" | "failed";
  resolution:
    | "matched"
    | "not_found"
    | "type_mismatch"
    | "byte_mismatch"
    | "insufficient_evidence"
    | "stale_or_unverified"
    | "rejected"
    | "failed"
    | "interrupted";
  satisfaction: number | null;
  match: ReadCompositionFileRef | null;
  coverage: "complete" | "partial" | null;
  sources: readonly Readonly<{
    sourceId: "source:0" | "source:1";
    attempt: "not_attempted" | "in_progress" | "matched" | "definitive_negative" | "unknown";
    negative: "not_found" | "type_mismatch" | "byte_mismatch" | null;
  }>[];
  decision: Readonly<{
    kind: "ranked" | "defer";
    chosen: "source:0" | "source:1" | null;
    missingKeys: readonly string[];
  }> | null;
  rootFact: ReadCompositionRootFact | null;
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

export type ReadCompositionResources = Readonly<{
  sandbox: CliFilesystemSandbox;
  session: SessionRef;
  profile: CliCommandProfile;
  limits: RecursiveGoalLimits;
  signal?: AbortSignal;
  onSample?: (sample: CliCommandSample) => void | Promise<void>;
  decision?: PlanningDecisionBinding;
}>;

export type ReadCompositionRunResult = Readonly<{
  request: ReadCompositionRequest;
  response: unknown;
  domain: ReadCompositionDomainProjection;
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

function base64Bytes(value: unknown, label: string): Uint8Array {
  if (typeof value !== "string") throw new TypeError(`${label} must be a base64 string`);
  let decoded: Uint8Array;
  try {
    decoded = Buffer.from(value, "base64");
  } catch {
    throw new TypeError(`${label} must be canonical base64`);
  }
  if (Buffer.from(decoded).toString("base64") !== value) {
    throw new TypeError(`${label} must be canonical base64`);
  }
  return decoded;
}

function sessionRef(value: unknown, label: string): SessionRef {
  const input = record(value, label);
  exactKeys(input, ["kind", "scenarioId", "sessionId"], label);
  if (input.kind !== "cli.session") {
    throw new TypeError(`${label} must be a cli.session reference`);
  }
  return Object.freeze({
    kind: "cli.session",
    scenarioId: nonEmpty(input.scenarioId, `${label}.scenarioId`),
    sessionId: nonEmpty(input.sessionId, `${label}.sessionId`),
  });
}

export function validateReadCompositionName(value: unknown, label: string): string {
  const name = nonEmpty(value, label);
  if (name === "." || name === ".." || name.includes("/")) {
    throw new TypeError(`${label} must be a single non-empty name segment without . or ..`);
  }
  return name;
}

function directoryObjectRef(value: unknown, label: string): DirectoryObjectRef {
  const input = record(value, label);
  if (input.kind !== "cli.directory") {
    throw new TypeError(`${label} must be a cli.directory reference`);
  }
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
  if (input.kind !== "cli.directory") {
    throw new TypeError(`${label} must be a cli.directory reference`);
  }
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
  if (input.kind !== "cli.path") {
    throw new TypeError(`${label} must be a cli.path reference`);
  }
  const path = nonEmpty(input.path, `${label}.path`);
  if (!path.startsWith("/")) {
    throw new TypeError(`${label}.path must be absolute`);
  }
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
  const allowed = new Set(["filesystem.read", "process.exec", "session.write"]);
  if (grantedEffects.some(effect => !allowed.has(effect))) {
    throw new TypeError(`${label}.grantedEffects contains an unsupported CLI effect`);
  }
  return Object.freeze({
    id: nonEmpty(input.id, `${label}.id`),
    cwd: nonEmpty(input.cwd, `${label}.cwd`),
    revision: nonnegativeInteger(input.revision, `${label}.revision`),
    grantedEffects: Object.freeze([...grantedEffects] as SessionSnapshot["grantedEffects"]),
  });
}

function osInteger(value: unknown, label: string): number | string | null {
  if (value === null) return null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer`);
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
  throw new TypeError(`${label} must be a safe integer, decimal string, or null`);
}

export function validateReadCompositionGoal(value: unknown): ReadCompositionGoal {
  const goal = record(value, "read composition goal");
  exactKeys(goal, ["kind", "property", "target", "requirement"], "read composition goal");
  if (goal.kind !== "file.property" || goal.property !== "file.property.content.bytes") {
    throw new TypeError("read composition goal must be a file.property.content.bytes goal");
  }
  const target = record(goal.target, "read composition goal target");
  if (target.requiredType !== "regular") {
    throw new TypeError("read composition goal target.requiredType must be regular");
  }
  const name = validateReadCompositionName(target.name, "read composition goal target.name");
  const requirement = record(goal.requirement, "read composition goal requirement");
  exactKeys(requirement, ["kind", "range", "expectedBase64"], "read composition goal requirement");
  if (requirement.kind !== "equals") {
    throw new TypeError("read composition goal requirement.kind must be equals");
  }
  const range = record(requirement.range, "read composition goal range");
  exactKeys(range, ["offset", "length"], "read composition goal range");
  const offset = nonnegativeInteger(range.offset, "read composition goal range.offset");
  const length = nonnegativeInteger(range.length, "read composition goal range.length");
  const expectedBase64 = String(requirement.expectedBase64);
  const expectedBytes = base64Bytes(expectedBase64, "read composition goal expectedBase64");
  if (expectedBytes.length !== length) {
    throw new TypeError("read composition goal expectedBase64 decoded length must equal range.length");
  }
  const requirementValue = Object.freeze({
    kind: "equals",
    range: Object.freeze({ offset, length }),
    expectedBase64,
  });

  if (target.kind === "cli.exact-child") {
    exactKeys(target, ["kind", "directory", "name", "requiredType"], "read composition goal target");
    return Object.freeze({
      kind: "file.property",
      property: "file.property.content.bytes",
      target: Object.freeze({
        kind: "cli.exact-child",
        directory: directoryObjectRef(target.directory, "read composition goal target.directory"),
        name,
        requiredType: "regular",
      }),
      requirement: requirementValue,
    });
  }

  if (target.kind === "cli.exact-child-sources") {
    exactKeys(target, ["kind", "sources", "name", "requiredType"], "read composition goal target");
    if (!Array.isArray(target.sources) || target.sources.length !== 2) {
      throw new TypeError("read composition goal target.sources must contain exactly two sources");
    }
    const parsedSources = target.sources.map((entry, index) => {
      const source = record(entry, `read composition goal target.sources[${index}]`);
      if (
        !Object.hasOwn(source, "directory") ||
        (Object.hasOwn(source, "order") && Object.keys(source).length !== 2) ||
        (!Object.hasOwn(source, "order") && Object.keys(source).length !== 1)
      ) {
        throw new TypeError(`read composition goal target.sources[${index}] must contain directory and optional order`);
      }
      const order = Object.hasOwn(source, "order") && source.order !== null
        ? nonnegativeInteger(source.order, `read composition goal target.sources[${index}].order`)
        : null;
      return Object.freeze({
        directory: directoryObjectRef(source.directory, `read composition goal target.sources[${index}].directory`),
        order,
      });
    });
    const sources = Object.freeze([
      parsedSources[0] as ReadCompositionSourceSpec,
      parsedSources[1] as ReadCompositionSourceSpec,
    ] as const);
    const presentOrders = sources.filter(source => source.order !== null);
    const firstOrder = presentOrders[0] === undefined ? null : presentOrders[0].order;
    const secondOrder = presentOrders[1] === undefined ? null : presentOrders[1].order;
    if (firstOrder !== null && secondOrder !== null && firstOrder === secondOrder) {
      throw new TypeError("read composition goal target.sources orders must differ when both are provided");
    }
    return Object.freeze({
      kind: "file.property",
      property: "file.property.content.bytes",
      target: Object.freeze({
        kind: "cli.exact-child-sources",
        sources,
        name,
        requiredType: "regular",
      }),
      requirement: requirementValue,
    });
  }

  throw new TypeError("read composition goal target.kind must be cli.exact-child or cli.exact-child-sources");
}

export function readCompositionDirectoryKey(ref: DirectoryObjectRef): string {
  if ("absolutePath" in ref) {
    return `${ref.scenarioId}\0${ref.sessionId}\0${ref.absolutePath}`;
  }
  return `${ref.scenarioId}\0${ref.sessionId}\0${ref.path}`;
}

export function validateReadCompositionRequest(
  value: unknown,
  _session: SessionRef,
): ReadCompositionRequest {
  const request = record(value, "read composition request");
  exactKeys(request, ["requestId", "goal", "satisfactionThreshold"], "read composition request");
  if (request.satisfactionThreshold !== 100) {
    throw new TypeError("read composition satisfactionThreshold must be exactly 100");
  }
  const goal = validateReadCompositionGoal(request.goal);
  return Object.freeze({
    requestId: nonEmpty(request.requestId, "requestId"),
    goal,
    satisfactionThreshold: 100,
  });
}

export function validateReadCompositionListGoal(value: unknown): ReadCompositionListGoal {
  const goal = record(value, "read composition list goal");
  exactKeys(goal, ["kind", "property", "target", "requirement"], "read composition list goal");
  if (goal.kind !== "file.property" || goal.property !== "file.property.directory.entries") {
    throw new TypeError("read composition list goal must use file.property.directory.entries");
  }
  const requirement = record(goal.requirement, "read composition list goal requirement");
  exactKeys(requirement, ["kind", "freshness"], "read composition list goal requirement");
  if (requirement.kind !== "observed" || requirement.freshness !== "this_run") {
    throw new TypeError("read composition list goal requirement must be observed this_run");
  }
  return Object.freeze({
    kind: "file.property",
    property: "file.property.directory.entries",
    target: directoryRef(goal.target, "read composition list goal target"),
    requirement: Object.freeze({ kind: "observed", freshness: "this_run" }),
  });
}

export function validateReadCompositionInspectGoal(value: unknown): ReadCompositionInspectGoal {
  const goal = record(value, "read composition inspect goal");
  exactKeys(goal, ["kind", "property", "target", "requirement"], "read composition inspect goal");
  if (goal.kind !== "file.property" || goal.property !== "file.property.type") {
    throw new TypeError("read composition inspect goal must use file.property.type");
  }
  const requirement = record(goal.requirement, "read composition inspect goal requirement");
  exactKeys(requirement, ["kind", "freshness"], "read composition inspect goal requirement");
  if (requirement.kind !== "observed" || requirement.freshness !== "this_run") {
    throw new TypeError("read composition inspect goal requirement must be observed this_run");
  }
  const target = record(goal.target, "read composition inspect goal target");
  exactKeys(target, ["kind", "ref", "followSymlinks"], "read composition inspect goal target");
  if (target.kind !== "cli.entry-query" || target.followSymlinks !== false) {
    throw new TypeError("read composition inspect goal target must be cli.entry-query with followSymlinks false");
  }
  return Object.freeze({
    kind: "file.property",
    property: "file.property.type",
    target: Object.freeze({
      kind: "cli.entry-query",
      ref: pathRef(target.ref, "read composition inspect goal target.ref"),
      followSymlinks: false,
    }),
    requirement: Object.freeze({ kind: "observed", freshness: "this_run" }),
  });
}

export function validateReadCompositionReadGoal(value: unknown): ReadCompositionReadGoal {
  const goal = record(value, "read composition read goal");
  exactKeys(goal, ["kind", "property", "target", "requirement"], "read composition read goal");
  if (goal.kind !== "file.property" || goal.property !== "file.property.content.bytes") {
    throw new TypeError("read composition read goal must use file.property.content.bytes");
  }
  const target = record(goal.target, "read composition read goal target");
  exactKeys(target, ["kind", "ref", "requiredType"], "read composition read goal target");
  if (target.kind !== "cli.file" || target.requiredType !== "regular") {
    throw new TypeError("read composition read goal target must be cli.file with requiredType regular");
  }
  const ref = readObservedObjectRef(target.ref);
  if (ref.kind !== "cli.file" || ref.type !== "regular") {
    throw new TypeError("read composition read goal target.ref must be a cli.file regular reference");
  }
  const requirement = record(goal.requirement, "read composition read goal requirement");
  exactKeys(requirement, ["kind", "range"], "read composition read goal requirement");
  if (requirement.kind !== "observed") {
    throw new TypeError("read composition read goal requirement.kind must be observed");
  }
  const range = record(requirement.range, "read composition read goal range");
  exactKeys(range, ["offset", "length"], "read composition read goal range");
  const offset = nonnegativeInteger(range.offset, "read composition read goal range.offset");
  const length = nonnegativeInteger(range.length, "read composition read goal range.length");
  return Object.freeze({
    kind: "file.property",
    property: "file.property.content.bytes",
    target: Object.freeze({
      kind: "cli.file",
      ref,
      requiredType: "regular",
    }),
    requirement: Object.freeze({
      kind: "observed",
      range: Object.freeze({ offset, length }),
    }),
  });
}

export function readReadCompositionGoal(value: unknown): ReadCompositionRunGoal {
  const goal = record(value, "read composition run goal");
  if (!Object.hasOwn(goal, "requirement") || !isRecord(goal.requirement)) {
    throw new TypeError("read composition run goal requirement must be an object");
  }
  const requirement = goal.requirement as Record<string, unknown>;
  if (goal.property === "file.property.content.bytes" && requirement.kind === "equals") {
    return validateReadCompositionGoal(goal);
  }
  if (goal.property === "file.property.directory.entries" && requirement.kind === "observed") {
    return validateReadCompositionListGoal(goal);
  }
  if (goal.property === "file.property.type" && requirement.kind === "observed") {
    return validateReadCompositionInspectGoal(goal);
  }
  if (goal.property === "file.property.content.bytes" && requirement.kind === "observed") {
    return validateReadCompositionReadGoal(goal);
  }
  throw new TypeError("unsupported read composition run goal");
}

export function readReadCompositionCursor(value: unknown): ReadCompositionCursor {
  const cursor = record(value, "read composition cursor");
  exactKeys(cursor, ["phase", "chosen", "decision"], "read composition cursor");
  if (!["listed", "inspected", "read", "closed", "rejected", "fallback-basis", "inspected-alt", "read-alt"].includes(String(cursor.phase))) {
    throw new TypeError("read composition cursor phase is invalid");
  }
  const chosen = cursor.chosen === null ? null : cursor.chosen;
  if (chosen !== null && chosen !== 0 && chosen !== 1) {
    throw new TypeError("read composition cursor chosen must be 0, 1, or null");
  }
  const decision = cursor.decision === null ? null : readDecisionRecord(cursor.decision);
  return Object.freeze({
    phase: cursor.phase as ReadCompositionPhase,
    chosen: chosen as 0 | 1 | null,
    decision,
  });
}

function readDecisionRecord(value: unknown): ReadCompositionDecisionRecord {
  const decision = record(value, "read composition cursor decision");
  exactKeys(decision, ["kind", "chosen", "missingKeys"], "read composition cursor decision");
  if (decision.kind !== "ranked" && decision.kind !== "defer") {
    throw new TypeError("read composition cursor decision.kind must be ranked or defer");
  }
  const chosen = decision.chosen;
  if (chosen !== null && chosen !== "source:0" && chosen !== "source:1") {
    throw new TypeError("read composition cursor decision.chosen must be source:0, source:1, or null");
  }
  if (!Array.isArray(decision.missingKeys) || decision.missingKeys.some(key => typeof key !== "string")) {
    throw new TypeError("read composition cursor decision.missingKeys must be a string array");
  }
  return Object.freeze({
    kind: decision.kind,
    chosen: chosen as "source:0" | "source:1" | null,
    missingKeys: Object.freeze([...(decision.missingKeys as string[])]),
  });
}

export function readReadCompositionEvidencePayload(value: unknown): ReadCompositionEvidencePayload {
  const payload = record(value, "read composition evidence payload");
  if (payload.kind === "cli.read-composition.transition.v1") {
    exactKeys(payload, ["kind", "transitionId", "stateId", "transition"], "read composition evidence payload");
    return Object.freeze({
      kind: "cli.read-composition.transition.v1",
      transitionId: nonEmpty(payload.transitionId, "read composition evidence transitionId"),
      stateId: nonEmpty(payload.stateId, "read composition evidence stateId"),
      transition: readCliCommandTransition(payload.transition, "read composition evidence transition"),
    });
  }
  if (payload.kind === "cli.read-composition.read.v1") {
    exactKeys(payload, ["kind", "transitionId", "stateId", "receipt", "ref"], "read composition evidence payload");
    return Object.freeze({
      kind: "cli.read-composition.read.v1",
      transitionId: nonEmpty(payload.transitionId, "read composition evidence transitionId"),
      stateId: nonEmpty(payload.stateId, "read composition evidence stateId"),
      receipt: readSemanticCallReceipt(payload.receipt, "read composition evidence receipt"),
      ref: readFileRef(payload.ref, "read composition evidence ref"),
    });
  }
  throw new TypeError("read composition evidence payload kind is invalid");
}

export function readReadCompositionEffectFact(value: unknown): ReadCompositionEffectFact {
  const effect = record(value, "read composition effect fact");
  exactKeys(effect, ["kind", "transitionId", "runId", "invoked"], "read composition effect fact");
  if (effect.kind !== "cli.read-composition.observation" || typeof effect.invoked !== "boolean") {
    throw new TypeError("read composition effect fact is invalid");
  }
  return Object.freeze({
    kind: "cli.read-composition.observation",
    transitionId: nonEmpty(effect.transitionId, "read composition effect transitionId"),
    runId: effect.runId === null ? null : nonEmpty(effect.runId, "read composition effect runId"),
    invoked: effect.invoked,
  });
}

export function readReadCompositionReceiptPayload(value: unknown): ReadCompositionReceiptPayload {
  const input = record(value, "read composition receipt payload");
  if (input.kind === "cli.file.read.receipt.v1") {
    exactKeys(input, ["kind", "receipt", "ref"], "read composition receipt payload");
    return Object.freeze({
      kind: "cli.file.read.receipt.v1",
      receipt: readSemanticCallReceipt(input.receipt, "read composition receipt receipt"),
      ref: readFileRef(input.ref, "read composition receipt ref"),
    });
  }
  return readCliCommandTransition(value, "read composition receipt transition");
}

export function readReadCompositionState(value: unknown): ReadCompositionState {
  const state = record(value, "read composition state");
  const requiredKeys = ["stateId", "session", "cli", "listing", "candidate", "inspected", "fileRef", "read"];
  const allowedKeys = new Set([...requiredKeys, "sources"]);
  if (
    requiredKeys.some(key => !Object.hasOwn(state, key)) ||
    Object.keys(state).some(key => !allowedKeys.has(key))
  ) {
    throw new TypeError("read composition state keys are invalid");
  }
  return Object.freeze({
    stateId: nonEmpty(state.stateId, "read composition state stateId"),
    session: sessionSnapshot(state.session, "read composition state session"),
    cli: readExplicitFileState(state.cli),
    listing: state.listing === null ? null : readListingFact(state.listing),
    candidate: state.candidate === null ? null : readCandidate(state.candidate),
    inspected: state.inspected === null ? null : readInspectedFact(state.inspected),
    fileRef: state.fileRef === null ? null : readFileRef(state.fileRef),
    read: state.read === null ? null : readReadFact(state.read),
    sources: state.sources === undefined || state.sources === null
      ? null
      : readSourceStates(state.sources),
  });
}

function readSourceStates(
  value: unknown,
): readonly [ReadCompositionSourceState, ReadCompositionSourceState] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError("read composition state.sources must contain exactly two sources");
  }
  return Object.freeze([
    readSourceState(value[0], "read composition state.sources[0]"),
    readSourceState(value[1], "read composition state.sources[1]"),
  ]);
}

function readSourceState(value: unknown, label: string): ReadCompositionSourceState {
  const source = record(value, label);
  exactKeys(source, ["sourceId", "order", "directory", "listing", "candidate", "inspected", "fileRef", "read"], label);
  if (source.sourceId !== "source:0" && source.sourceId !== "source:1") {
    throw new TypeError(`${label}.sourceId must be source:0 or source:1`);
  }
  return Object.freeze({
    sourceId: source.sourceId,
    order: source.order === null ? null : nonnegativeInteger(source.order, `${label}.order`),
    directory: directoryObjectRef(source.directory, `${label}.directory`),
    listing: source.listing === null ? null : readListingFact(source.listing),
    candidate: source.candidate === null ? null : readCandidate(source.candidate),
    inspected: source.inspected === null ? null : readInspectedFact(source.inspected),
    fileRef: source.fileRef === null ? null : readFileRef(source.fileRef, `${label}.fileRef`),
    read: source.read === null ? null : readReadFact(source.read),
  });
}

function readListingFact(value: unknown): ReadCompositionListingFact {
  const fact = record(value, "read composition state.listing");
  exactKeys(fact, ["sourceRun", "coverage", "directoryRef", "errors", "candidateNames", "entries"], "read composition state.listing");
  const coverage = fact.coverage;
  if (coverage !== null && coverage !== "complete" && coverage !== "partial") {
    throw new TypeError("read composition state.listing.coverage is invalid");
  }
  if (!Array.isArray(fact.errors) || fact.errors.some(error => typeof error !== "string")) {
    throw new TypeError("read composition state.listing.errors must be a string array");
  }
  if (!Array.isArray(fact.candidateNames) || fact.candidateNames.some(name => typeof name !== "string")) {
    throw new TypeError("read composition state.listing.candidateNames must be a string array");
  }
  if (!Array.isArray(fact.entries)) {
    throw new TypeError("read composition state.listing.entries must be an array");
  }
  const entries = fact.entries.map(entry => {
    const item = record(entry, "read composition state.listing.entries[]");
    exactKeys(item, ["name", "path", "type"], "read composition state.listing.entries[]");
    const type = item.type;
    if (!["file", "directory", "symlink", "other", "unknown"].includes(String(type))) {
      throw new TypeError("read composition state.listing.entries[].type is invalid");
    }
    return Object.freeze({
      name: nonEmpty(item.name, "read composition state.listing.entries[].name"),
      path: nonEmpty(item.path, "read composition state.listing.entries[].path"),
      type: type as "file" | "directory" | "symlink" | "other" | "unknown",
    });
  });
  return Object.freeze({
    sourceRun: fact.sourceRun === null ? null : nonEmpty(fact.sourceRun, "read composition state.listing.sourceRun"),
    coverage: coverage as "complete" | "partial" | null,
    directoryRef: fact.directoryRef === null ? null : directoryObjectRef(fact.directoryRef, "read composition state.listing.directoryRef"),
    errors: Object.freeze([...(fact.errors as string[])]),
    candidateNames: Object.freeze([...(fact.candidateNames as string[])]),
    entries: Object.freeze(entries),
  });
}

function readCandidate(value: unknown): ReadCompositionCandidate {
  const candidate = record(value, "read composition state.candidate");
  exactKeys(candidate, ["name", "path", "listedType", "listingRun"], "read composition state.candidate");
  const type = candidate.listedType;
  if (!["file", "directory", "symlink", "other", "unknown"].includes(String(type))) {
    throw new TypeError("read composition state.candidate.listedType is invalid");
  }
  return Object.freeze({
    name: nonEmpty(candidate.name, "read composition state.candidate.name"),
    path: nonEmpty(candidate.path, "read composition state.candidate.path"),
    listedType: type as ReadCompositionCandidate["listedType"],
    listingRun: candidate.listingRun === null ? null : nonEmpty(candidate.listingRun, "read composition state.candidate.listingRun"),
  });
}

function readInspectedFact(value: unknown): ReadCompositionInspectedFact {
  const fact = record(value, "read composition state.inspected");
  exactKeys(fact, ["sourceRun", "type", "identity", "sessionRevision", "absolutePath"], "read composition state.inspected");
  const identity = record(fact.identity, "read composition state.inspected.identity");
  exactKeys(identity, ["dev", "ino"], "read composition state.inspected.identity");
  return Object.freeze({
    sourceRun: fact.sourceRun === null ? null : nonEmpty(fact.sourceRun, "read composition state.inspected.sourceRun"),
    type: fact.type === null ? null : nonEmpty(fact.type, "read composition state.inspected.type"),
    identity: Object.freeze({
      dev: osInteger(identity.dev, "read composition state.inspected.identity.dev"),
      ino: osInteger(identity.ino, "read composition state.inspected.identity.ino"),
    }),
    sessionRevision: fact.sessionRevision === null ? null : nonnegativeInteger(fact.sessionRevision, "read composition state.inspected.sessionRevision"),
    absolutePath: fact.absolutePath === null ? null : nonEmpty(fact.absolutePath, "read composition state.inspected.absolutePath"),
  });
}

function readFileRef(value: unknown, label = "read composition state.fileRef"): ReadCompositionFileRef {
  const ref = record(value, label);
  exactKeys(ref, ["kind", "scenarioId", "sessionId", "type", "identity", "sourceRun", "sessionRevision", "absolutePath"], label);
  if (ref.kind !== "cli.file" || ref.type !== "regular") {
    throw new TypeError(`${label} must be a cli.file regular reference`);
  }
  const identity = record(ref.identity, `${label}.identity`);
  exactKeys(identity, ["dev", "ino"], `${label}.identity`);
  return Object.freeze({
    kind: "cli.file",
    scenarioId: nonEmpty(ref.scenarioId, `${label}.scenarioId`),
    sessionId: nonEmpty(ref.sessionId, `${label}.sessionId`),
    type: "regular",
    identity: Object.freeze({
      dev: osInteger(identity.dev, `${label}.identity.dev`),
      ino: osInteger(identity.ino, `${label}.identity.ino`),
    }),
    sourceRun: nonEmpty(ref.sourceRun, `${label}.sourceRun`),
    sessionRevision: nonnegativeInteger(ref.sessionRevision, `${label}.sessionRevision`),
    absolutePath: nonEmpty(ref.absolutePath, `${label}.absolutePath`),
  });
}

function readReadFact(value: unknown): ReadCompositionReadFact {
  const fact = record(value, "read composition state.read");
  exactKeys(fact, ["ref", "sourceRun", "refSourceRun", "revision", "offset", "length", "bytes", "bytesRead", "size", "eof", "identity"], "read composition state.read");
  const identity = record(fact.identity, "read composition state.read.identity");
  exactKeys(identity, ["dev", "ino"], "read composition state.read.identity");
  return Object.freeze({
    ref: readFileRef(fact.ref, "read composition state.read.ref"),
    sourceRun: fact.sourceRun === null ? null : nonEmpty(fact.sourceRun, "read composition state.read.sourceRun"),
    refSourceRun: fact.refSourceRun === null ? null : nonEmpty(fact.refSourceRun, "read composition state.read.refSourceRun"),
    revision: fact.revision === null ? null : nonnegativeInteger(fact.revision, "read composition state.read.revision"),
    offset: fact.offset === null ? null : nonnegativeInteger(fact.offset, "read composition state.read.offset"),
    length: fact.length === null ? null : nonnegativeInteger(fact.length, "read composition state.read.length"),
    bytes: fact.bytes === null
      ? null
      : typeof fact.bytes === "string" && !fact.bytes.includes("\0")
        ? fact.bytes
        : (() => { throw new TypeError("read composition state.read.bytes must be a base64 string"); })(),
    bytesRead: fact.bytesRead === null ? null : nonnegativeInteger(fact.bytesRead, "read composition state.read.bytesRead"),
    size: fact.size === null ? null : nonnegativeInteger(fact.size, "read composition state.read.size"),
    eof: fact.eof === null ? null : typeof fact.eof === "boolean" ? fact.eof : (() => { throw new TypeError("read composition state.read.eof must be boolean or null"); })(),
    identity: Object.freeze({
      dev: osInteger(identity.dev, "read composition state.read.identity.dev"),
      ino: osInteger(identity.ino, "read composition state.read.identity.ino"),
    }),
  });
}

function readSemanticCallReceipt(value: unknown, label: string): SemanticCallReceipt {
  const receipt = record(value, label);
  exactKeys(receipt, ["call", "status", "session_before", "session_after", "execution"], label);
  if (receipt.status !== "succeeded" && receipt.status !== "failed") {
    throw new TypeError(`${label}.status must be succeeded or failed`);
  }
  const execution = record(receipt.execution, `${label}.execution`);
  for (const key of ["status", "runId", "executorInvoked"]) {
    if (!Object.hasOwn(execution, key)) {
      throw new TypeError(`${label}.execution.${key} is required`);
    }
  }
  if (execution.status !== "succeeded" && execution.status !== "failed") {
    throw new TypeError(`${label}.execution.status must be succeeded or failed`);
  }
  if (execution.status === "succeeded" && !Object.hasOwn(execution, "observation")) {
    throw new TypeError(`${label}.execution.observation is required for a succeeded receipt`);
  }
  if (execution.status === "failed" && !Object.hasOwn(execution, "error")) {
    throw new TypeError(`${label}.execution.error is required for a failed receipt`);
  }
  return receipt as unknown as SemanticCallReceipt;
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
  const input = record(value, "read composition explicit file state");
  for (const key of ["session", "cwdObservation", "directoryListing"]) {
    if (!Object.hasOwn(input, key)) {
      throw new TypeError(`read composition explicit file state.${key} is required`);
    }
  }
  return input as unknown as ExplicitFileState;
}

export type { DirectoryListObservation, DirectoryObjectRef };
