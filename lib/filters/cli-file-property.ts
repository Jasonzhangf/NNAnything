import { expectRecord } from "../core/schema.js";
import type { DirectoryRef, SessionRef } from "../adapters/cli/filesystem-sandbox.js";
import type {
  EntryKind,
  OsInteger,
  ObservedObjectRef,
  PathRef,
} from "../adapters/cli/entry-inspection.js";
import { validateExplicitFileState, type ExplicitFileState, type EvidenceAuthority } from "./cli-state.js";

export type { ObservedObjectRef, OsInteger, PathRef } from "../adapters/cli/entry-inspection.js";

export const PATH_ABSOLUTE_PROPERTY = "file.property.path.absolute" as const;
export const PATH_RELATIVE_PROPERTY = "file.property.path.relative" as const;
export const PATH_PARENT_PROPERTY = "file.property.path.parent" as const;
export const PATH_NAME_PROPERTY = "file.property.path.name" as const;
export const PATH_PHYSICAL_PROPERTY = "file.property.path.physical" as const;
export const EXISTS_PROPERTY = "file.property.exists" as const;
export const TYPE_PROPERTY = "file.property.type" as const;
export const CWD_PROPERTY = "file.property.relation.sessionCwd" as const;
export const ENTRIES_PROPERTY = "file.property.directory.entries" as const;
export const SIZE_PROPERTY = "file.property.size" as const;
export const MODE_PROPERTY = "file.property.mode" as const;
export const OWNER_PROPERTY = "file.property.owner" as const;
export const TIMES_PROPERTY = "file.property.times" as const;
export const LINK_TARGET_PROPERTY = "file.property.link.target" as const;
export const ENTRY_IDENTITY_PROPERTY = "file.property.entry.identity" as const;
export const INSPECT_PROPERTIES = Object.freeze([
  EXISTS_PROPERTY,
  TYPE_PROPERTY,
  SIZE_PROPERTY,
  MODE_PROPERTY,
  OWNER_PROPERTY,
  TIMES_PROPERTY,
  LINK_TARGET_PROPERTY,
  ENTRY_IDENTITY_PROPERTY,
] as const);
export const REGISTERED_PROPERTIES = Object.freeze([
  PATH_ABSOLUTE_PROPERTY,
  PATH_RELATIVE_PROPERTY,
  PATH_PARENT_PROPERTY,
  PATH_NAME_PROPERTY,
  PATH_PHYSICAL_PROPERTY,
  EXISTS_PROPERTY,
  TYPE_PROPERTY,
  ENTRIES_PROPERTY,
  SIZE_PROPERTY,
  MODE_PROPERTY,
  OWNER_PROPERTY,
  TIMES_PROPERTY,
  LINK_TARGET_PROPERTY,
  ENTRY_IDENTITY_PROPERTY,
  CWD_PROPERTY,
] as const);
export const REGISTERED_PREDICATES = Object.freeze([
  "predicate.observe.absolute",
  "predicate.observe.relative",
  "predicate.observe.parts",
  "predicate.observe.physical",
  "predicate.observe.inspect",
  "predicate.observe.resolvedTarget",
  "predicate.observe.sessionCwd",
  "predicate.equals.sessionCwd",
  "predicate.observe.entries",
] as const);

export type RegisteredProperty = typeof REGISTERED_PROPERTIES[number];
export type RegisteredPredicate = typeof REGISTERED_PREDICATES[number];
export type EntryType = EntryKind;

export type ObjectIdentity = Readonly<{
  dev: OsInteger;
  ino: OsInteger;
}>;

export type EntryRef = ObservedObjectRef & Readonly<{ kind: "cli.entry" }>;
export type FileRef = ObservedObjectRef & Readonly<{ kind: "cli.file" }>;
export type ObservedDirectoryRef = ObservedObjectRef & Readonly<{ kind: "cli.directory" }>;
export type DirectoryObjectRef = DirectoryRef | ObservedDirectoryRef;
export type InspectRef = PathRef | EntryRef | FileRef | DirectoryObjectRef;

export type SessionCwdQuery = Readonly<{
  kind: "cli.file-query";
  relation: "sessionCwd";
  session: SessionRef;
}>;

export type DirectoryQuery = Readonly<{
  kind: "cli.file-query";
  relation: "entrySelector";
  scopes: readonly Readonly<Record<string, unknown>>[];
  selector: Readonly<{ type: "directory"; name?: string }>;
  cardinality: "one";
}>;

export type CwdGoal = Readonly<{
  kind: "file.property";
  property: typeof CWD_PROPERTY;
  target: SessionCwdQuery;
  requirement:
    | Readonly<{ kind: "observed"; freshness: "this_run" }>
    | Readonly<{ kind: "equals"; expected: DirectoryObjectRef | DirectoryQuery }>;
}>;

export type EntriesGoal = Readonly<{
  kind: "file.property";
  property: typeof ENTRIES_PROPERTY;
  target: DirectoryObjectRef | DirectoryQuery;
  requirement: Readonly<{ kind: "observed"; freshness: "this_run" }>;
}>;

export type PathResolveQuery = Readonly<{
  kind: "cli.path-query";
  base: PathRef;
  input: string;
}>;

export type PathRelativeQuery = Readonly<{
  kind: "cli.path-query";
  from: PathRef;
  to: PathRef;
}>;

export type PathAbsoluteGoal = Readonly<{
  kind: "file.property";
  property: typeof PATH_ABSOLUTE_PROPERTY;
  target: PathResolveQuery;
  requirement: Readonly<{ kind: "observed"; freshness: "this_run" }>;
}>;

export type PathRelativeGoal = Readonly<{
  kind: "file.property";
  property: typeof PATH_RELATIVE_PROPERTY;
  target: PathRelativeQuery;
  requirement: Readonly<{ kind: "observed"; freshness: "this_run" }>;
}>;

export type PathPartsGoal = Readonly<{
  kind: "file.property";
  property: typeof PATH_PARENT_PROPERTY | typeof PATH_NAME_PROPERTY;
  target: PathRef;
  requirement: Readonly<{ kind: "observed"; freshness: "this_run" }>;
}>;

export type PathPhysicalGoal = Readonly<{
  kind: "file.property";
  property: typeof PATH_PHYSICAL_PROPERTY;
  target: InspectRef;
  requirement: Readonly<{ kind: "observed"; freshness: "this_run" }>;
}>;

export type EntryInspectQuery = Readonly<{
  kind: "cli.entry-query";
  ref: InspectRef;
  followSymlinks: boolean;
}>;

export type InspectProperty = typeof EXISTS_PROPERTY | typeof TYPE_PROPERTY | typeof SIZE_PROPERTY
  | typeof MODE_PROPERTY | typeof OWNER_PROPERTY | typeof TIMES_PROPERTY
  | typeof LINK_TARGET_PROPERTY | typeof ENTRY_IDENTITY_PROPERTY;

export type InspectGoal = Readonly<{
  kind: "file.property";
  property: InspectProperty;
  target: EntryInspectQuery;
  requirement: Readonly<{ kind: "observed"; freshness: "this_run" }>;
}>;

export type ResolvedTargetGoal = Readonly<{
  kind: "file.property";
  property: typeof LINK_TARGET_PROPERTY;
  target: EntryInspectQuery;
  requirement: Readonly<{
    kind: "matches";
    predicate: Readonly<{ kind: "resolvedTarget" }>;
  }>;
}>;

export type GenericFilePropertyGoal = Readonly<{
  kind: "file.property";
  property: string;
  target: Readonly<Record<string, unknown>>;
  requirement: Readonly<Record<string, unknown>>;
}>;

export type RegisteredGoal = CwdGoal | EntriesGoal | PathAbsoluteGoal | PathRelativeGoal | PathPartsGoal
  | PathPhysicalGoal | InspectGoal | ResolvedTargetGoal;
export type FilePropertyGoal = RegisteredGoal | GenericFilePropertyGoal;

export function isResolvedTargetGoal(goal: FilePropertyGoal): goal is ResolvedTargetGoal {
  if (goal.property !== LINK_TARGET_PROPERTY) return false;
  const requirement = goal.requirement;
  if (requirement.kind !== "matches") return false;
  const predicate = requirement.predicate;
  return predicate !== null && typeof predicate === "object" && "kind" in predicate && predicate.kind === "resolvedTarget";
}

export type ValidatedGoal = Readonly<{
  goal: FilePropertyGoal;
  registered: boolean;
  predicate: RegisteredPredicate | null;
  unboundDirectory: boolean;
  bindingError: string | null;
}>;

export type PropertyRequest = Readonly<{
  goal: FilePropertyGoal;
  satisfactionThreshold: number;
  state: ExplicitFileState;
}>;

export type ValidatedPropertyRequest = PropertyRequest & Readonly<{
  registered: boolean;
  unboundDirectory: boolean;
  bindingError: string | null;
}>;

export type PropertyFacts = Readonly<{
  hasFreshEvidence: 0 | 1;
  knownValue: 0 | 1;
  requiredConditionHolds: 0 | 1;
  hasDestinationRef: 0 | 1;
}>;

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function absolutePath(value: unknown, label: string): string {
  const path = nonEmpty(value, label);
  if (path.includes("\0") || !path.startsWith("/")) throw new TypeError(`${label} must be an absolute path without NUL`);
  return path;
}

function pathText(value: unknown, label: string): string {
  const path = nonEmpty(value, label);
  if (path.includes("\0")) throw new TypeError(`${label} must not contain NUL`);
  return path;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new TypeError(`${label} must be a nonnegative integer`);
  return value as number;
}

function entryType(value: unknown, label: string): EntryType {
  if (!ENTRY_TYPES.includes(value as EntryType)) throw new TypeError(`${label} must be a supported entry type`);
  return value as EntryType;
}

function osInteger(value: unknown, label: string): OsInteger {
  if (value === null) return null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a safe nonnegative integer`);
    return value;
  }
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) return value;
  throw new TypeError(`${label} must be a safe integer, decimal string, or null`);
}

const ENTRY_TYPES = Object.freeze([
  "regular",
  "directory",
  "symlink",
  "character_device",
  "block_device",
  "fifo",
  "socket",
  "other",
] as const satisfies readonly EntryType[]);

export function validateSessionRef(value: unknown, label = "session reference"): SessionRef {
  const ref = expectRecord(value, label);
  exactKeys(ref, ["kind", "scenarioId", "sessionId"], label);
  if (ref.kind !== "cli.session") throw new TypeError(`${label} must be a cli.session reference`);
  return Object.freeze({
    kind: "cli.session",
    scenarioId: nonEmpty(ref.scenarioId, `${label}.scenarioId`),
    sessionId: nonEmpty(ref.sessionId, `${label}.sessionId`),
  });
}

export function validatePathRef(value: unknown, label = "path reference"): PathRef {
  const ref = expectRecord(value, label);
  exactKeys(ref, ["kind", "scenarioId", "sessionId", "path"], label);
  if (ref.kind !== "cli.path") throw new TypeError(`${label} must be a cli.path reference`);
  return Object.freeze({
    kind: "cli.path",
    scenarioId: nonEmpty(ref.scenarioId, `${label}.scenarioId`),
    sessionId: nonEmpty(ref.sessionId, `${label}.sessionId`),
    path: absolutePath(ref.path, `${label}.path`),
  });
}

export function validateObjectIdentity(value: unknown, label = "object identity"): ObjectIdentity {
  const identity = expectRecord(value, label);
  exactKeys(identity, ["dev", "ino"], label);
  return Object.freeze({
    dev: osInteger(identity.dev, `${label}.dev`),
    ino: osInteger(identity.ino, `${label}.ino`),
  });
}

export function validateObservedObjectRef(value: unknown, label = "observed object reference"): ObservedObjectRef {
  const ref = expectRecord(value, label);
  exactKeys(ref, ["absolutePath", "identity", "kind", "scenarioId", "sessionId", "sessionRevision", "sourceRun", "type"], label);
  if (ref.kind !== "cli.entry" && ref.kind !== "cli.file" && ref.kind !== "cli.directory") {
    throw new TypeError(`${label} must be a cli.entry, cli.file, or cli.directory reference`);
  }
  const type = entryType(ref.type, `${label}.type`);
  if (ref.kind === "cli.file" && type !== "regular") throw new TypeError(`${label} cli.file must be regular`);
  if (ref.kind === "cli.directory" && type !== "directory") throw new TypeError(`${label} cli.directory must be directory`);
  return Object.freeze({
    kind: ref.kind,
    scenarioId: nonEmpty(ref.scenarioId, `${label}.scenarioId`),
    sessionId: nonEmpty(ref.sessionId, `${label}.sessionId`),
    type,
    identity: validateObjectIdentity(ref.identity, `${label}.identity`),
    sourceRun: nonEmpty(ref.sourceRun, `${label}.sourceRun`),
    sessionRevision: nonnegativeInteger(ref.sessionRevision, `${label}.sessionRevision`),
    absolutePath: absolutePath(ref.absolutePath, `${label}.absolutePath`),
  });
}

export function validateDirectoryRef(value: unknown, label = "directory reference"): DirectoryRef {
  const ref = expectRecord(value, label);
  exactKeys(ref, ["kind", "scenarioId", "sessionId", "path"], label);
  if (ref.kind !== "cli.directory") throw new TypeError(`${label} must be a cli.directory reference`);
  const path = nonEmpty(ref.path, `${label}.path`);
  if (path.includes("\0")) throw new TypeError(`${label}.path must not contain NUL`);
  return Object.freeze({
    kind: "cli.directory",
    scenarioId: nonEmpty(ref.scenarioId, `${label}.scenarioId`),
    sessionId: nonEmpty(ref.sessionId, `${label}.sessionId`),
    path,
  });
}

export function validateDirectoryObjectRef(value: unknown, label = "directory reference"): DirectoryObjectRef {
  const ref = expectRecord(value, label);
  return ref.kind === "cli.directory" && Object.hasOwn(ref, "path")
    ? validateDirectoryRef(ref, label)
    : validateObservedObjectRef(ref, label) as ObservedDirectoryRef;
}

export function validateInspectRef(value: unknown, label = "inspect reference"): InspectRef {
  const ref = expectRecord(value, label);
  if (ref.kind === "cli.path") return validatePathRef(ref, label);
  if (ref.kind === "cli.entry") return validateObservedObjectRef(ref, label) as EntryRef;
  if (ref.kind === "cli.file") return validateObservedObjectRef(ref, label) as FileRef;
  if (ref.kind === "cli.directory") return validateDirectoryObjectRef(ref, label);
  throw new TypeError(`${label} must be a cli.path, cli.entry, cli.file, or cli.directory reference`);
}

function validateSessionCwdQuery(value: unknown): SessionCwdQuery {
  const query = expectRecord(value, "sessionCwd query");
  exactKeys(query, ["kind", "relation", "session"], "sessionCwd query");
  if (query.kind !== "cli.file-query" || query.relation !== "sessionCwd") throw new TypeError("sessionCwd query must be a cli.file-query with relation sessionCwd");
  return Object.freeze({ kind: "cli.file-query", relation: "sessionCwd", session: validateSessionRef(query.session, "sessionCwd query session") });
}

function validatePathResolveQuery(value: unknown): PathResolveQuery {
  const query = expectRecord(value, "path resolution query");
  exactKeys(query, ["base", "input", "kind"], "path resolution query");
  if (query.kind !== "cli.path-query") throw new TypeError("path resolution query must be a cli.path-query");
  return Object.freeze({
    kind: "cli.path-query",
    base: validatePathRef(query.base, "path resolution query base"),
    input: pathText(query.input, "path resolution query input"),
  });
}

function validatePathRelativeQuery(value: unknown): PathRelativeQuery {
  const query = expectRecord(value, "relative path query");
  exactKeys(query, ["from", "kind", "to"], "relative path query");
  if (query.kind !== "cli.path-query") throw new TypeError("relative path query must be a cli.path-query");
  return Object.freeze({
    kind: "cli.path-query",
    from: validatePathRef(query.from, "relative path query from"),
    to: validatePathRef(query.to, "relative path query to"),
  });
}

function validateEntryInspectQuery(value: unknown): EntryInspectQuery {
  const query = expectRecord(value, "entry inspection query");
  exactKeys(query, ["followSymlinks", "kind", "ref"], "entry inspection query");
  if (query.kind !== "cli.entry-query" || typeof query.followSymlinks !== "boolean") {
    throw new TypeError("entry inspection query must be a cli.entry-query with a boolean followSymlinks");
  }
  return Object.freeze({
    kind: "cli.entry-query",
    ref: validateInspectRef(query.ref, "entry inspection query ref"),
    followSymlinks: query.followSymlinks,
  });
}

function validateDirectoryQuery(value: unknown): DirectoryQuery {
  const query = expectRecord(value, "directory query");
  exactKeys(query, ["kind", "relation", "scopes", "selector", "cardinality"], "directory query");
  if (query.kind !== "cli.file-query" || query.relation !== "entrySelector" || query.cardinality !== "one") {
    throw new TypeError("directory query must be a cli.file-query entrySelector with cardinality one");
  }
  if (!Array.isArray(query.scopes)) throw new TypeError("directory query scopes must be an array");
  const scopes = query.scopes.map((scope, index) => {
    const item = expectRecord(scope, `directory query scopes[${index}]`);
    return Object.freeze({ ...item });
  });
  const selector = expectRecord(query.selector, "directory query selector");
  if (selector.type !== "directory" || Object.keys(selector).some(key => key !== "type" && key !== "name")) {
    throw new TypeError("directory query selector must declare type directory and an optional name");
  }
  if (Object.hasOwn(selector, "name")) nonEmpty(selector.name, "directory query selector.name");
  return Object.freeze({
    kind: "cli.file-query",
    relation: "entrySelector",
    scopes: Object.freeze(scopes),
    selector: Object.freeze({ type: "directory", ...(Object.hasOwn(selector, "name") ? { name: selector.name as string } : {}) }),
    cardinality: "one",
  });
}

function isDirectoryRef(value: unknown): value is DirectoryObjectRef {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (value as Record<string, unknown>).kind === "cli.directory";
}

function isLegacyDirectoryRef(value: unknown): value is DirectoryRef {
  return isDirectoryRef(value) && Object.hasOwn(value, "path");
}

function isDirectoryQuery(value: unknown): value is DirectoryQuery {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).kind === "cli.file-query"
    && (value as Record<string, unknown>).relation === "entrySelector";
}

function isSessionCwdQuery(value: unknown): value is SessionCwdQuery {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).kind === "cli.file-query"
    && (value as Record<string, unknown>).relation === "sessionCwd";
}

function observedRequirement(value: Record<string, unknown>, label: string): Readonly<{ kind: "observed"; freshness: "this_run" }> {
  exactKeys(value, ["freshness", "kind"], label);
  if (value.kind !== "observed" || value.freshness !== "this_run") throw new TypeError(`${label} must use observed freshness this_run`);
  return Object.freeze({ kind: "observed", freshness: "this_run" });
}

function genericTypedTarget(value: unknown): Readonly<Record<string, unknown>> {
  const target = expectRecord(value, "goal.target");
  if (target.kind === "cli.path") return validatePathRef(target, "goal.target");
  if (target.kind === "cli.entry") return validateObservedObjectRef(target, "goal.target");
  if (target.kind === "cli.file") return validateObservedObjectRef(target, "goal.target");
  if (target.kind === "cli.directory") return validateDirectoryObjectRef(target, "goal.target");
  if (target.kind === "cli.entry-query") return validateEntryInspectQuery(target);
  if (target.kind === "cli.path-query") {
    return Object.hasOwn(target, "from")
      ? validatePathRelativeQuery(target)
      : validatePathResolveQuery(target);
  }
  if (isDirectoryQuery(target)) return validateDirectoryQuery(target);
  if (isSessionCwdQuery(target)) return validateSessionCwdQuery(target);
  throw new TypeError("goal.target must be a typed reference or query");
}

export function validateGoal(value: unknown): ValidatedGoal {
  const input = expectRecord(value, "goal");
  exactKeys(input, ["kind", "property", "target", "requirement"], "goal");
  if (input.kind !== "file.property") throw new TypeError("Legacy Goal is not accepted; use kind file.property");
  const property = nonEmpty(input.property, "goal.property");
  if (!property.startsWith("file.property.")) throw new TypeError("goal.property must use the file.property namespace");
  const requirement = expectRecord(input.requirement, "goal.requirement");
  if (typeof requirement.kind !== "string" || requirement.kind.length === 0) throw new TypeError("goal.requirement.kind must be a non-empty string");

  if (property === CWD_PROPERTY) {
    if (!isSessionCwdQuery(input.target)) throw new TypeError("sessionCwd goal target must be a sessionCwd query");
    const target = validateSessionCwdQuery(input.target);
    if (requirement.kind === "observed") {
      exactKeys(requirement, ["kind", "freshness"], "sessionCwd observed requirement");
      if (requirement.freshness !== "this_run") throw new TypeError("observed requirement must use freshness this_run");
      return Object.freeze({
        goal: Object.freeze({ kind: "file.property", property: CWD_PROPERTY, target, requirement: Object.freeze({ kind: "observed", freshness: "this_run" }) }),
        registered: true,
        predicate: "predicate.observe.sessionCwd",
        unboundDirectory: false,
        bindingError: null,
      });
    }
    if (requirement.kind === "equals") {
      exactKeys(requirement, ["kind", "expected"], "sessionCwd equals requirement");
      const expected = isDirectoryRef(requirement.expected)
        ? validateDirectoryObjectRef(requirement.expected, "sessionCwd expected")
        : isDirectoryQuery(requirement.expected)
          ? validateDirectoryQuery(requirement.expected)
          : null;
      if (expected === null) throw new TypeError("sessionCwd equals expected must be a directory reference or directory query");
      return Object.freeze({
        goal: Object.freeze({ kind: "file.property", property: CWD_PROPERTY, target, requirement: Object.freeze({ kind: "equals", expected }) }),
        registered: true,
        predicate: "predicate.equals.sessionCwd",
        unboundDirectory: isDirectoryQuery(expected),
        bindingError: null,
      });
    }
    throw new TypeError("sessionCwd requirement must be observed or equals");
  }

  if (property === ENTRIES_PROPERTY) {
    if (requirement.kind !== "observed") throw new TypeError("directory.entries only supports observed requirement");
    const observed = observedRequirement(requirement, "directory.entries observed requirement");
    const target = isDirectoryRef(input.target)
      ? validateDirectoryObjectRef(input.target, "directory.entries target")
      : isDirectoryQuery(input.target)
        ? validateDirectoryQuery(input.target)
        : null;
    if (target === null) throw new TypeError("directory.entries target must be a directory reference or directory query");
    return Object.freeze({
      goal: Object.freeze({ kind: "file.property", property: ENTRIES_PROPERTY, target, requirement: observed }),
      registered: true,
      predicate: "predicate.observe.entries",
      unboundDirectory: isDirectoryQuery(target),
      bindingError: null,
    });
  }

  if (property === PATH_ABSOLUTE_PROPERTY && requirement.kind === "observed") {
    const target = validatePathResolveQuery(input.target);
    const observed = observedRequirement(requirement, "path.absolute observed requirement");
    return Object.freeze({
      goal: Object.freeze({ kind: "file.property", property: PATH_ABSOLUTE_PROPERTY, target, requirement: observed }),
      registered: true,
      predicate: "predicate.observe.absolute",
      unboundDirectory: false,
      bindingError: null,
    });
  }

  if (property === PATH_RELATIVE_PROPERTY && requirement.kind === "observed") {
    const target = validatePathRelativeQuery(input.target);
    const observed = observedRequirement(requirement, "path.relative observed requirement");
    return Object.freeze({
      goal: Object.freeze({ kind: "file.property", property: PATH_RELATIVE_PROPERTY, target, requirement: observed }),
      registered: true,
      predicate: "predicate.observe.relative",
      unboundDirectory: false,
      bindingError: null,
    });
  }

  if ((property === PATH_PARENT_PROPERTY || property === PATH_NAME_PROPERTY) && requirement.kind === "observed") {
    const target = validatePathRef(input.target, "path.parts target");
    const observed = observedRequirement(requirement, "path.parts observed requirement");
    return Object.freeze({
      goal: Object.freeze({ kind: "file.property", property, target, requirement: observed }),
      registered: true,
      predicate: "predicate.observe.parts",
      unboundDirectory: false,
      bindingError: null,
    });
  }

  if (property === PATH_PHYSICAL_PROPERTY && requirement.kind === "observed") {
    const target = validateInspectRef(input.target, "path.physical target");
    const observed = observedRequirement(requirement, "path.physical observed requirement");
    return Object.freeze({
      goal: Object.freeze({ kind: "file.property", property: PATH_PHYSICAL_PROPERTY, target, requirement: observed }),
      registered: true,
      predicate: "predicate.observe.physical",
      unboundDirectory: false,
      bindingError: null,
    });
  }

  if (property === LINK_TARGET_PROPERTY && requirement.kind === "matches") {
    exactKeys(requirement, ["kind", "predicate"], "resolvedTarget requirement");
    const predicate = expectRecord(requirement.predicate, "resolvedTarget predicate");
    exactKeys(predicate, ["kind"], "resolvedTarget predicate");
    if (predicate.kind !== "resolvedTarget") throw new TypeError("link.target matches predicate must be resolvedTarget");
    const target = validateEntryInspectQuery(input.target);
    return Object.freeze({
      goal: Object.freeze({
        kind: "file.property",
        property: LINK_TARGET_PROPERTY,
        target,
        requirement: Object.freeze({ kind: "matches", predicate: Object.freeze({ kind: "resolvedTarget" }) }),
      }),
      registered: true,
      predicate: "predicate.observe.resolvedTarget",
      unboundDirectory: false,
      bindingError: target.followSymlinks ? null : "resolved_target_requires_follow_symlinks",
    });
  }

  if (INSPECT_PROPERTIES.includes(property as InspectProperty) && requirement.kind === "observed") {
    const target = validateEntryInspectQuery(input.target);
    const observed = observedRequirement(requirement, "entry.inspect observed requirement");
    return Object.freeze({
      goal: Object.freeze({ kind: "file.property", property: property as InspectProperty, target, requirement: observed }),
      registered: true,
      predicate: "predicate.observe.inspect",
      unboundDirectory: false,
      bindingError: null,
    });
  }

  const target = genericTypedTarget(input.target);
  return Object.freeze({
    goal: Object.freeze({ kind: "file.property", property, target, requirement: Object.freeze({ ...requirement }) }),
    registered: false,
    predicate: null,
    unboundDirectory: false,
    bindingError: null,
  });
}

export function validatePropertyRequest(value: unknown, session: SessionRef): ValidatedPropertyRequest {
  const input = expectRecord(value, "file.property request");
  exactKeys(input, ["goal", "satisfactionThreshold", "state"], "file.property request");
  const threshold = input.satisfactionThreshold;
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new TypeError("satisfactionThreshold must be a finite number from 0 to 100");
  }
  const validated = validateGoal(input.goal);
  const state = validateExplicitFileState(input.state);
  if (state.session !== session.sessionId) throw new TypeError("State must belong to the bound session");
  const stateRefs: { scenarioId: string; sessionId: string }[] = [];
  const pathKnowledge = state.pathKnowledge ?? null;
  if (pathKnowledge?.kind === "path.resolve") stateRefs.push(pathKnowledge.base);
  if (pathKnowledge?.kind === "path.relative") stateRefs.push(pathKnowledge.from, pathKnowledge.to);
  if (pathKnowledge?.kind === "path.parts") stateRefs.push(pathKnowledge.path);
  if (pathKnowledge?.kind === "path.realpath") stateRefs.push(pathKnowledge.ref);
  if (state.entryKnowledge !== null && state.entryKnowledge !== undefined) stateRefs.push(state.entryKnowledge.query.ref);
  for (const ref of stateRefs) {
    if (ref.scenarioId !== session.scenarioId || ref.sessionId !== session.sessionId) {
      throw new TypeError("State typed reference must belong to the bound session and scenario");
    }
  }
  const goal = validated.goal;
  if (goal.property === CWD_PROPERTY) {
    const cwdGoal = goal as CwdGoal;
    if (cwdGoal.target.session.scenarioId !== session.scenarioId || cwdGoal.target.session.sessionId !== session.sessionId) {
      throw new TypeError("sessionCwd query must belong to the bound session");
    }
  }
  const refs: { scenarioId: string; sessionId: string }[] = [];
  const target = goal.target as Record<string, unknown>;
  if (target.kind === "cli.path" || target.kind === "cli.entry" || target.kind === "cli.file" || target.kind === "cli.directory") {
    refs.push(target as { scenarioId: string; sessionId: string });
  } else if (target.kind === "cli.path-query") {
    if (target.base !== undefined) refs.push(target.base as { scenarioId: string; sessionId: string });
    if (target.from !== undefined) refs.push(target.from as { scenarioId: string; sessionId: string });
    if (target.to !== undefined) refs.push(target.to as { scenarioId: string; sessionId: string });
  } else if (target.kind === "cli.entry-query") {
    refs.push(target.ref as { scenarioId: string; sessionId: string });
  } else if (target.kind === "cli.file-query" && target.relation === "sessionCwd") {
    refs.push(target.session as { scenarioId: string; sessionId: string });
  }
  const cwdRequirement = goal.property === CWD_PROPERTY ? (goal as CwdGoal).requirement : null;
  if (cwdRequirement !== null && cwdRequirement.kind === "equals" && isDirectoryRef(cwdRequirement.expected)) {
    refs.push(cwdRequirement.expected);
  }
  for (const ref of refs) {
    if (ref.scenarioId !== session.scenarioId || ref.sessionId !== session.sessionId) {
      throw new TypeError("Typed reference must belong to the bound session and scenario");
    }
  }
  return Object.freeze({
    goal,
    satisfactionThreshold: threshold,
    state,
    registered: validated.registered,
    unboundDirectory: validated.unboundDirectory,
    bindingError: validated.bindingError,
  });
}

export function predicateOf(goal: FilePropertyGoal): RegisteredPredicate | null {
  if (goal.property === CWD_PROPERTY) {
    const cwd = goal as CwdGoal;
    return cwd.requirement.kind === "observed" ? "predicate.observe.sessionCwd" : "predicate.equals.sessionCwd";
  }
  if (isResolvedTargetGoal(goal)) return "predicate.observe.resolvedTarget";
  if (goal.requirement.kind !== "observed") return null;
  if (goal.property === ENTRIES_PROPERTY) return "predicate.observe.entries";
  if (goal.property === PATH_ABSOLUTE_PROPERTY) return "predicate.observe.absolute";
  if (goal.property === PATH_RELATIVE_PROPERTY) return "predicate.observe.relative";
  if (goal.property === PATH_PARENT_PROPERTY || goal.property === PATH_NAME_PROPERTY) return "predicate.observe.parts";
  if (goal.property === PATH_PHYSICAL_PROPERTY) return "predicate.observe.physical";
  if (INSPECT_PROPERTIES.includes(goal.property as InspectProperty)) return "predicate.observe.inspect";
  return null;
}

export function propertyOf(goal: FilePropertyGoal): RegisteredProperty | null {
  return REGISTERED_PROPERTIES.includes(goal.property as RegisteredProperty) ? goal.property as RegisteredProperty : null;
}

export function isRegisteredGoal(goal: FilePropertyGoal): goal is RegisteredGoal {
  return REGISTERED_PROPERTIES.includes(goal.property as RegisteredProperty);
}

export function isUnboundDirectoryGoal(goal: FilePropertyGoal): boolean {
  if (goal.property === CWD_PROPERTY) {
    const cwd = goal as CwdGoal;
    return cwd.requirement.kind === "equals" && isDirectoryQuery(cwd.requirement.expected);
  }
  if (goal.property === ENTRIES_PROPERTY) return isDirectoryQuery((goal as EntriesGoal).target);
  return false;
}

export function expectedDirectoryOf(goal: FilePropertyGoal): DirectoryRef | null {
  if (goal.property === CWD_PROPERTY) {
    const cwd = goal as CwdGoal;
    return cwd.requirement.kind === "equals" && isLegacyDirectoryRef(cwd.requirement.expected) ? cwd.requirement.expected : null;
  }
  if (goal.property === ENTRIES_PROPERTY) {
    const target = (goal as EntriesGoal).target;
    return isLegacyDirectoryRef(target) ? target : null;
  }
  return null;
}

export function computePropertyFacts(input: Readonly<{
  goal: FilePropertyGoal;
  state: ExplicitFileState;
  session: SessionRef;
  revision: number;
  authority: EvidenceAuthority;
  expectedPhysical: string | null;
}>): PropertyFacts {
  const { goal, state, session, revision, authority, expectedPhysical } = input;
  const destination = expectedDirectoryOf(goal);
  const hasDestinationRef = destination !== null ? 1 : 0;
  const cwdKnowledge = state.cwdObservation;
  const directoryKnowledge = state.directoryListing;
  const cwdOrigin = cwdKnowledge !== null && authority.known({
    kind: "pwd",
    session: session.sessionId,
    revision: cwdKnowledge.revision,
    runId: cwdKnowledge.sourceRun,
    observation: cwdKnowledge.evidence,
  });
  const directoryOrigin = directoryKnowledge !== null && authority.known({
    kind: "directory.list",
    session: session.sessionId,
    revision: directoryKnowledge.revision,
    runId: directoryKnowledge.sourceRun,
    observation: directoryKnowledge.evidence,
  });

  if (goal.property === CWD_PROPERTY && (goal as CwdGoal).requirement.kind === "equals") {
    const known = cwdOrigin ? 1 : 0;
    const condition = known === 1 && expectedPhysical !== null && cwdKnowledge!.physicalCwd === expectedPhysical ? 1 : 0;
    const fresh = cwdOrigin && cwdKnowledge!.revision === revision
      && authority.trusted({
        kind: "pwd",
        session: session.sessionId,
        revision: cwdKnowledge!.revision,
        runId: cwdKnowledge!.sourceRun,
        observation: cwdKnowledge!.evidence,
      }) ? 1 : 0;
    return Object.freeze({ hasFreshEvidence: fresh as 0 | 1, knownValue: known as 0 | 1,
      requiredConditionHolds: condition as 0 | 1, hasDestinationRef: hasDestinationRef as 0 | 1 });
  }
  if (goal.property === ENTRIES_PROPERTY) {
    return Object.freeze({ hasFreshEvidence: 0, knownValue: directoryOrigin ? 1 : 0,
      requiredConditionHolds: 0, hasDestinationRef: hasDestinationRef as 0 | 1 });
  }
  return Object.freeze({ hasFreshEvidence: 0, knownValue: 0, requiredConditionHolds: 0,
    hasDestinationRef: hasDestinationRef as 0 | 1 });
}

export function legacyWires(goal: FilePropertyGoal): Readonly<{ goalObserveCwd: 0 | 1; goalSetCwd: 0 | 1; goalListDirectory: 0 | 1 }> {
  if (goal.property === CWD_PROPERTY) {
    const cwd = goal as CwdGoal;
    return cwd.requirement.kind === "observed"
      ? { goalObserveCwd: 1, goalSetCwd: 0, goalListDirectory: 0 }
      : { goalObserveCwd: 0, goalSetCwd: 1, goalListDirectory: 0 };
  }
  if (goal.property === ENTRIES_PROPERTY) return { goalObserveCwd: 0, goalSetCwd: 0, goalListDirectory: 1 };
  return { goalObserveCwd: 0, goalSetCwd: 0, goalListDirectory: 0 };
}

export function requiredHead(input: Readonly<{
  registered: boolean;
  unboundDirectory: boolean;
  goal: FilePropertyGoal;
  facts: PropertyFacts;
}>): "unsupported" | "DEFER" | "NOOP" | "pwd" | "cd" | "ls"
  | "path.resolve" | "path.relative" | "path.parts" | "path.realpath" | "entry.inspect" {
  if (!input.registered) return "unsupported";
  if (input.unboundDirectory) return "DEFER";
  if (input.goal.property === CWD_PROPERTY) {
    if ((input.goal as CwdGoal).requirement.kind === "observed") return "pwd";
    return input.facts.hasFreshEvidence === 1 && input.facts.requiredConditionHolds === 1 ? "NOOP" : "cd";
  }
  if (input.goal.property === ENTRIES_PROPERTY) return "ls";
  if (input.goal.property === PATH_ABSOLUTE_PROPERTY) return "path.resolve";
  if (input.goal.property === PATH_RELATIVE_PROPERTY) return "path.relative";
  if (input.goal.property === PATH_PARENT_PROPERTY || input.goal.property === PATH_NAME_PROPERTY) return "path.parts";
  if (input.goal.property === PATH_PHYSICAL_PROPERTY) return "path.realpath";
  return "entry.inspect";
}

export type OperationName = "entry.inspect" | "path.realpath";

/** Deterministic applicability by already-observed entry type. Read-only metadata observation applies to every supported type. */
export function evaluateOperationApplicability(entryType: EntryType | null, operation: OperationName): "appropriate" | "inappropriate" | "unknown" {
  if (!["entry.inspect", "path.realpath"].includes(operation)) return "unknown";
  if (entryType === null) return "unknown";
  return ENTRY_TYPES.includes(entryType) ? "appropriate" : "unknown";
}
