import { expectRecord } from "../core/schema.js";
import type { DirectoryRef, SessionRef } from "../adapters/cli/filesystem-sandbox.js";
import { validateExplicitFileState, type ExplicitFileState, type EvidenceAuthority } from "./cli-state.js";

export const CWD_PROPERTY = "file.property.relation.sessionCwd" as const;
export const ENTRIES_PROPERTY = "file.property.directory.entries" as const;
export const REGISTERED_PROPERTIES = Object.freeze([ENTRIES_PROPERTY, CWD_PROPERTY] as const);
export const REGISTERED_PREDICATES = Object.freeze([
  "predicate.observe.sessionCwd",
  "predicate.equals.sessionCwd",
  "predicate.observe.entries",
] as const);

export type RegisteredProperty = typeof REGISTERED_PROPERTIES[number];
export type RegisteredPredicate = typeof REGISTERED_PREDICATES[number];

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
    | Readonly<{ kind: "equals"; expected: DirectoryRef | DirectoryQuery }>;
}>;

export type EntriesGoal = Readonly<{
  kind: "file.property";
  property: typeof ENTRIES_PROPERTY;
  target: DirectoryRef | DirectoryQuery;
  requirement: Readonly<{ kind: "observed"; freshness: "this_run" }>;
}>;

export type GenericFilePropertyGoal = Readonly<{
  kind: "file.property";
  property: string;
  target: Readonly<Record<string, unknown>>;
  requirement: Readonly<Record<string, unknown>>;
}>;

export type FilePropertyGoal = CwdGoal | EntriesGoal | GenericFilePropertyGoal;

export type ValidatedGoal = Readonly<{
  goal: FilePropertyGoal;
  registered: boolean;
  predicate: RegisteredPredicate | null;
  unboundDirectory: boolean;
}>;

export type PropertyRequest = Readonly<{
  goal: FilePropertyGoal;
  satisfactionThreshold: number;
  state: ExplicitFileState;
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

function validateSessionCwdQuery(value: unknown): SessionCwdQuery {
  const query = expectRecord(value, "sessionCwd query");
  exactKeys(query, ["kind", "relation", "session"], "sessionCwd query");
  if (query.kind !== "cli.file-query" || query.relation !== "sessionCwd") throw new TypeError("sessionCwd query must be a cli.file-query with relation sessionCwd");
  return Object.freeze({ kind: "cli.file-query", relation: "sessionCwd", session: validateSessionRef(query.session, "sessionCwd query session") });
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

function isDirectoryRef(value: unknown): value is DirectoryRef {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (value as Record<string, unknown>).kind === "cli.directory";
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
      });
    }
    if (requirement.kind === "equals") {
      exactKeys(requirement, ["kind", "expected"], "sessionCwd equals requirement");
      const expected = isDirectoryRef(requirement.expected)
        ? validateDirectoryRef(requirement.expected, "sessionCwd expected")
        : isDirectoryQuery(requirement.expected)
          ? validateDirectoryQuery(requirement.expected)
          : null;
      if (expected === null) throw new TypeError("sessionCwd equals expected must be a directory reference or directory query");
      return Object.freeze({
        goal: Object.freeze({ kind: "file.property", property: CWD_PROPERTY, target, requirement: Object.freeze({ kind: "equals", expected }) }),
        registered: true,
        predicate: "predicate.equals.sessionCwd",
        unboundDirectory: isDirectoryQuery(expected),
      });
    }
    throw new TypeError("sessionCwd requirement must be observed or equals");
  }

  if (property === ENTRIES_PROPERTY) {
    if (requirement.kind !== "observed") throw new TypeError("directory.entries only supports observed requirement");
    exactKeys(requirement, ["kind", "freshness"], "directory.entries observed requirement");
    if (requirement.freshness !== "this_run") throw new TypeError("observed requirement must use freshness this_run");
    const target = isDirectoryRef(input.target)
      ? validateDirectoryRef(input.target, "directory.entries target")
      : isDirectoryQuery(input.target)
        ? validateDirectoryQuery(input.target)
        : null;
    if (target === null) throw new TypeError("directory.entries target must be a directory reference or directory query");
    return Object.freeze({
      goal: Object.freeze({ kind: "file.property", property: ENTRIES_PROPERTY, target, requirement: Object.freeze({ kind: "observed", freshness: "this_run" }) }),
      registered: true,
      predicate: "predicate.observe.entries",
      unboundDirectory: isDirectoryQuery(target),
    });
  }

  if (!isDirectoryRef(input.target) && !isDirectoryQuery(input.target) && !isSessionCwdQuery(input.target)
    && (typeof input.target !== "object" || input.target === null || Array.isArray(input.target))) {
    throw new TypeError("goal.target must be a typed reference or query");
  }
  return Object.freeze({
    goal: Object.freeze({ kind: "file.property", property, target: Object.freeze({ ...expectRecord(input.target, "goal.target") }), requirement: Object.freeze({ ...requirement }) }),
    registered: false,
    predicate: null,
    unboundDirectory: false,
  });
}

export function validatePropertyRequest(value: unknown, session: SessionRef): PropertyRequest {
  const input = expectRecord(value, "file.property request");
  exactKeys(input, ["goal", "satisfactionThreshold", "state"], "file.property request");
  const threshold = input.satisfactionThreshold;
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new TypeError("satisfactionThreshold must be a finite number from 0 to 100");
  }
  const validated = validateGoal(input.goal);
  const state = validateExplicitFileState(input.state);
  if (state.session !== session.sessionId) throw new TypeError("State must belong to the bound session");
  const goal = validated.goal;
  if (goal.property === CWD_PROPERTY) {
    const cwdGoal = goal as CwdGoal;
    if (cwdGoal.target.session.scenarioId !== session.scenarioId || cwdGoal.target.session.sessionId !== session.sessionId) {
      throw new TypeError("sessionCwd query must belong to the bound session");
    }
  }
  if (validated.registered) {
    const refs: DirectoryRef[] = [];
    const cwdRequirement = goal.property === CWD_PROPERTY ? (goal as CwdGoal).requirement : null;
    if (cwdRequirement !== null && cwdRequirement.kind === "equals") {
      const expected = cwdRequirement.expected;
      if (isDirectoryRef(expected)) refs.push(expected);
    }
    const entriesTarget = goal.property === ENTRIES_PROPERTY ? (goal as EntriesGoal).target : null;
    if (entriesTarget !== null && isDirectoryRef(entriesTarget)) refs.push(entriesTarget);
    for (const ref of refs) {
      if (ref.scenarioId !== session.scenarioId || ref.sessionId !== session.sessionId) {
        throw new TypeError("Directory reference must belong to the bound session and scenario");
      }
    }
  }
  return Object.freeze({ goal, satisfactionThreshold: threshold, state });
}

export function predicateOf(goal: FilePropertyGoal): RegisteredPredicate | null {
  if (goal.property === CWD_PROPERTY) {
    const cwd = goal as CwdGoal;
    return cwd.requirement.kind === "observed" ? "predicate.observe.sessionCwd" : "predicate.equals.sessionCwd";
  }
  if (goal.property === ENTRIES_PROPERTY) return "predicate.observe.entries";
  return null;
}

export function propertyOf(goal: FilePropertyGoal): RegisteredProperty | null {
  return goal.property === CWD_PROPERTY || goal.property === ENTRIES_PROPERTY ? goal.property : null;
}

export function isRegisteredGoal(goal: FilePropertyGoal): goal is CwdGoal | EntriesGoal {
  return goal.property === CWD_PROPERTY || goal.property === ENTRIES_PROPERTY;
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
    return cwd.requirement.kind === "equals" && isDirectoryRef(cwd.requirement.expected) ? cwd.requirement.expected : null;
  }
  if (goal.property === ENTRIES_PROPERTY) {
    const target = (goal as EntriesGoal).target;
    return isDirectoryRef(target) ? target : null;
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
    session: session.sessionId,
    revision: cwdKnowledge.revision,
    runId: cwdKnowledge.sourceRun,
    physicalCwd: cwdKnowledge.physicalCwd,
    physicalDirectory: null,
  });
  const directoryOrigin = directoryKnowledge !== null && authority.known({
    session: session.sessionId,
    revision: directoryKnowledge.revision,
    runId: directoryKnowledge.sourceRun,
    physicalCwd: null,
    physicalDirectory: directoryKnowledge.physicalDirectory,
  });

  if (goal.property === CWD_PROPERTY && (goal as CwdGoal).requirement.kind === "equals") {
    const known = cwdOrigin ? 1 : 0;
    const condition = known === 1 && expectedPhysical !== null && cwdKnowledge!.physicalCwd === expectedPhysical ? 1 : 0;
    const fresh = cwdOrigin && cwdKnowledge!.revision === revision
      && authority.trusted({
        session: session.sessionId,
        revision: cwdKnowledge!.revision,
        runId: cwdKnowledge!.sourceRun,
        physicalCwd: cwdKnowledge!.physicalCwd,
        physicalDirectory: null,
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
}>): "unsupported" | "DEFER" | "NOOP" | "pwd" | "cd" | "ls" {
  if (!input.registered) return "unsupported";
  if (input.unboundDirectory) return "DEFER";
  if (input.goal.property === CWD_PROPERTY) {
    if ((input.goal as CwdGoal).requirement.kind === "observed") return "pwd";
    return input.facts.hasFreshEvidence === 1 && input.facts.requiredConditionHolds === 1 ? "NOOP" : "cd";
  }
  return "ls";
}
