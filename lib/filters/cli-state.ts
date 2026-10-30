import { expectRecord } from "../core/schema.js";
import { validateDirectoryListing, type DirectoryListObservation } from "../adapters/cli/directory-listing.js";
import type { PwdObservation } from "../adapters/cli/observation.js";
import type {
  EntryInspectQuery,
  EntryType,
  InspectRef,
  OsInteger,
  PathRef,
} from "./cli-file-property.js";
import { validateCliCwd } from "./cli-path.js";

export type EntrySelectionOutcome = "selected" | "not_found" | "insufficient_evidence" | "conflict" | "rejected";

export type EntrySelectionObservation = Readonly<{
  parentPath: string;
  name: string;
  targetType: "unspecified" | "regular" | "directory";
  outcome: EntrySelectionOutcome;
  ref: string | null;
  reason: string | null;
}>;

export type EntrySelectionKnowledge = EntrySelectionObservation & Readonly<{
  sessionRevision: number;
  sourceRun: string;
}>;

export type CwdKnowledge = Readonly<{
  physicalCwd: string;
  evidence: PwdObservation;
  revision: number;
  sourceRun: string;
}>;

export type DirectoryKnowledge = Readonly<{
  physicalDirectory: string;
  entries: DirectoryListObservation["entries"];
  coverage: "complete";
  errors: readonly DirectoryListObservation["errors"][number][];
  evidence: DirectoryListObservation;
  revision: number;
  sourceRun: string;
}>;

export type PathKnowledge = Readonly<
  | {
      kind: "path.resolve";
      base: PathRef;
      input: string;
      absolutePath: string;
      parent: string;
      sourceRun: string;
      sessionRevision: number;
    }
  | {
      kind: "path.relative";
      from: PathRef;
      to: PathRef;
      relativePath: string;
      sourceRun: string;
      sessionRevision: number;
    }
  | {
      kind: "path.parts";
      path: PathRef;
      parent: string;
      name: string;
      isRoot: boolean;
      sourceRun: string;
      sessionRevision: number;
    }
  | {
      kind: "path.realpath";
      ref: InspectRef;
      physicalPath: string | null;
      entryExists: boolean | null;
      resolvedTargetExists: boolean | null;
      resolvedIdentity: Readonly<{ dev: OsInteger; ino: OsInteger }> | null;
      errno: string | null;
      sourceRun: string;
      sessionRevision: number;
    }
>;

export type EntryKnowledge = Readonly<{
  kind: "entry.inspect";
  query: EntryInspectQuery;
  absolutePath: string;
  observedWith: "stat" | "lstat" | null;
  entryExists: boolean | null;
  resolvedTargetExists: boolean | null;
  type: EntryType | null;
  size: OsInteger;
  mode: OsInteger;
  owner: Readonly<{ uid: OsInteger; gid: OsInteger }> | null;
  times: Readonly<{ atimeMs: OsInteger; mtimeMs: OsInteger; ctimeMs: OsInteger; birthtimeMs: OsInteger }> | null;
  linkTarget: string | null;
  identity: Readonly<{ dev: OsInteger; ino: OsInteger; nlink: OsInteger; rdev: OsInteger }>;
  errno: string | null;
  sourceRun: string;
  sessionRevision: number;
}>;

export type ExplicitFileState = Readonly<{
  session: string;
  cwdObservation: CwdKnowledge | null;
  directoryListing: DirectoryKnowledge | null;
  pathKnowledge?: PathKnowledge | null;
  entryKnowledge?: EntryKnowledge | null;
  entrySelection?: EntrySelectionKnowledge | null;
}>;

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function absolutePath(value: unknown, label: string): string {
  const path = nonEmpty(value, label);
  if (path.includes("\0") || !path.startsWith("/")) throw new TypeError(`${label} must be an absolute path without NUL`);
  return path;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new TypeError(`${label} must be a nonnegative integer`);
  return value as number;
}

function osInteger(value: unknown, label: string, allowNegative = false): OsInteger {
  if (value === null) return null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || (!allowNegative && value < 0)) {
      throw new TypeError(`${label} must be a ${allowNegative ? "safe integer" : "safe nonnegative integer"}`);
    }
    return value;
  }
  if (typeof value === "string" && /^-?(0|[1-9]\d*)$/.test(value) && (allowNegative || !value.startsWith("-"))) return value;
  throw new TypeError(`${label} must be a safe integer, decimal string, or null`);
}

function validatePathRef(value: unknown, label: string): PathRef {
  const ref = expectRecord(value, label);
  exactKeys(ref, ["kind", "path", "scenarioId", "sessionId"], label);
  if (ref.kind !== "cli.path") throw new TypeError(`${label} must be a cli.path reference`);
  return Object.freeze({
    kind: "cli.path",
    scenarioId: nonEmpty(ref.scenarioId, `${label}.scenarioId`),
    sessionId: nonEmpty(ref.sessionId, `${label}.sessionId`),
    path: absolutePath(ref.path, `${label}.path`),
  });
}

function validateObjectIdentity(value: unknown, label: string): Readonly<{ dev: OsInteger; ino: OsInteger }> {
  const identity = expectRecord(value, label);
  exactKeys(identity, ["dev", "ino"], label);
  return Object.freeze({
    dev: osInteger(identity.dev, `${label}.dev`),
    ino: osInteger(identity.ino, `${label}.ino`),
  });
}

function validateFullIdentity(value: unknown, label: string): EntryKnowledge["identity"] {
  const identity = expectRecord(value, label);
  exactKeys(identity, ["dev", "ino", "nlink", "rdev"], label);
  return Object.freeze({
    dev: osInteger(identity.dev, `${label}.dev`),
    ino: osInteger(identity.ino, `${label}.ino`),
    nlink: osInteger(identity.nlink, `${label}.nlink`),
    rdev: osInteger(identity.rdev, `${label}.rdev`),
  });
}

function validateInspectRef(value: unknown, label: string): InspectRef {
  const ref = expectRecord(value, label);
  if (ref.kind === "cli.path") return validatePathRef(ref, label);
  if (ref.kind !== "cli.entry" && ref.kind !== "cli.file" && ref.kind !== "cli.directory") {
    throw new TypeError(`${label} must be a typed inspect reference`);
  }
  if (ref.kind === "cli.directory" && Object.hasOwn(ref, "path")) {
    exactKeys(ref, ["kind", "path", "scenarioId", "sessionId"], label);
    return Object.freeze({
      kind: "cli.directory",
      scenarioId: nonEmpty(ref.scenarioId, `${label}.scenarioId`),
      sessionId: nonEmpty(ref.sessionId, `${label}.sessionId`),
      path: nonEmpty(ref.path, `${label}.path`),
    });
  }
  exactKeys(ref, ["absolutePath", "identity", "kind", "scenarioId", "sessionId", "sessionRevision", "sourceRun", "type"], label);
  if (!["regular", "directory", "symlink", "character_device", "block_device", "fifo", "socket", "other"].includes(ref.type as string)) {
    throw new TypeError(`${label}.type must be a supported entry type`);
  }
  const observed = {
    scenarioId: nonEmpty(ref.scenarioId, `${label}.scenarioId`),
    sessionId: nonEmpty(ref.sessionId, `${label}.sessionId`),
    type: ref.type as EntryType,
    identity: validateObjectIdentity(ref.identity, `${label}.identity`),
    sourceRun: nonEmpty(ref.sourceRun, `${label}.sourceRun`),
    sessionRevision: nonnegativeInteger(ref.sessionRevision, `${label}.sessionRevision`),
    absolutePath: absolutePath(ref.absolutePath, `${label}.absolutePath`),
  };
  if (ref.kind === "cli.entry") return Object.freeze({ kind: "cli.entry", ...observed });
  if (ref.kind === "cli.file") return Object.freeze({ kind: "cli.file", ...observed });
  return Object.freeze({ kind: "cli.directory", ...observed });
}

function validateEntryInspectQuery(value: unknown): EntryInspectQuery {
  const query = expectRecord(value, "entryKnowledge.query");
  exactKeys(query, ["followSymlinks", "kind", "ref"], "entryKnowledge.query");
  if (query.kind !== "cli.entry-query" || typeof query.followSymlinks !== "boolean") {
    throw new TypeError("entryKnowledge.query must be a cli.entry-query with boolean followSymlinks");
  }
  return Object.freeze({
    kind: "cli.entry-query",
    ref: validateInspectRef(query.ref, "entryKnowledge.query.ref"),
    followSymlinks: query.followSymlinks,
  });
}

function sameEntries(
  left: readonly DirectoryListObservation["entries"][number][],
  right: readonly DirectoryListObservation["entries"][number][],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return other !== undefined
      && entry.name === other.name
      && entry.path === other.path
      && entry.type === other.type;
  });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameErrors(
  left: readonly DirectoryListObservation["errors"][number][],
  right: readonly DirectoryListObservation["errors"][number][],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((error, index) => {
    const other = right[index];
    return other !== undefined
      && error.name === other.name
      && error.code === other.code
      && error.message === other.message;
  });
}

function samePwdObservation(left: PwdObservation, right: PwdObservation): boolean {
  return left.kind === right.kind
    && left.configuredCwd === right.configuredCwd
    && left.physicalCwd === right.physicalCwd
    && left.executable === right.executable
    && sameStrings(left.argv, right.argv)
    && left.stdout === right.stdout
    && left.stderr === right.stderr
    && left.exitCode === right.exitCode;
}

function sameDirectoryObservation(left: DirectoryListObservation, right: DirectoryListObservation): boolean {
  return left.kind === right.kind
    && left.configuredDirectory === right.configuredDirectory
    && left.physicalDirectory === right.physicalDirectory
    && left.executable === right.executable
    && left.helperPath === right.helperPath
    && sameStrings(left.argv, right.argv)
    && left.stdout === right.stdout
    && left.stderr === right.stderr
    && left.exitCode === right.exitCode
    && left.coverage === right.coverage
    && sameEntries(left.entries, right.entries)
    && sameErrors(left.errors, right.errors);
}

function sameEntrySelectObservation(left: EntrySelectObservation, right: EntrySelectObservation): boolean {
  return left.parentPath === right.parentPath
    && left.name === right.name
    && left.targetType === right.targetType
    && left.outcome === right.outcome
    && left.ref === right.ref
    && left.reason === right.reason;
}

function validateEntrySelectObservation(value: unknown): EntrySelectObservation {
  const observation = expectRecord(value, "entry.select observation");
  exactKeys(observation, ["name", "outcome", "parentPath", "reason", "ref", "targetType"], "entry.select observation");
  const outcome = observation.outcome;
  if (!["selected", "not_found", "insufficient_evidence", "conflict", "rejected"].includes(outcome as string)) {
    throw new TypeError("entry.select observation outcome must be a registered selection outcome");
  }
  if (observation.targetType !== "unspecified" && observation.targetType !== "regular" && observation.targetType !== "directory") {
    throw new TypeError("entry.select observation targetType must be unspecified, regular, or directory");
  }
  if (observation.reason !== null && (typeof observation.reason !== "string" || observation.reason.length === 0)) {
    throw new TypeError("entry.select observation reason must be a non-empty string or null");
  }
  return Object.freeze({
    parentPath: absolutePath(observation.parentPath, "entry.select observation parentPath"),
    name: nonEmpty(observation.name, "entry.select observation name"),
    targetType: observation.targetType as EntrySelectObservation["targetType"],
    outcome: outcome as EntrySelectionOutcome,
    ref: selectionRef(observation.ref, outcome as EntrySelectionOutcome, "entry.select observation ref"),
    reason: observation.reason as string | null,
  });
}

export function validatePwdObservation(value: unknown): PwdObservation {
  const observation = expectRecord(value, "cwdObservation.evidence");
  exactKeys(observation, ["kind", "configuredCwd", "physicalCwd", "executable", "argv", "stdout", "stderr", "exitCode"], "pwd observation");
  if (observation.kind !== "pwd" || observation.executable !== "/bin/pwd") throw new TypeError("cwdObservation.evidence is not a native pwd observation");
  if (!Array.isArray(observation.argv) || observation.argv.length !== 1 || observation.argv[0] !== "-P") throw new TypeError("pwd observation argv must be [-P]");
  const configuredCwd = validateCliCwd(observation.configuredCwd);
  const physicalCwd = absolutePath(observation.physicalCwd, "pwd observation physicalCwd");
  if (typeof observation.stdout !== "string" || observation.stdout !== `${physicalCwd}\n`) throw new TypeError("pwd observation stdout must end with one newline");
  if (typeof observation.stderr !== "string" || observation.exitCode !== 0) throw new TypeError("pwd observation must have string stderr and exitCode 0");
  return Object.freeze({
    kind: "pwd",
    configuredCwd,
    physicalCwd,
    executable: "/bin/pwd",
    argv: Object.freeze(["-P"] as const),
    stdout: observation.stdout,
    stderr: observation.stderr,
    exitCode: 0,
  });
}

export function validateCwdKnowledge(value: unknown): CwdKnowledge {
  const knowledge = expectRecord(value, "state.cwdObservation");
  exactKeys(knowledge, ["physicalCwd", "evidence", "revision", "sourceRun"], "state.cwdObservation");
  if (!Number.isInteger(knowledge.revision) || (knowledge.revision as number) < 0) throw new TypeError("state.cwdObservation.revision must be a nonnegative integer");
  const physicalCwd = absolutePath(knowledge.physicalCwd, "state.cwdObservation.physicalCwd");
  const evidence = validatePwdObservation(knowledge.evidence);
  if (physicalCwd !== evidence.physicalCwd) {
    throw new TypeError("state.cwdObservation.physicalCwd must equal its embedded evidence");
  }
  return Object.freeze({
    physicalCwd,
    evidence,
    revision: knowledge.revision as number,
    sourceRun: nonEmpty(knowledge.sourceRun, "state.cwdObservation.sourceRun"),
  });
}

function validateListingEvidence(value: unknown): DirectoryListObservation {
  const evidence = expectRecord(value, "directoryListing.evidence");
  exactKeys(evidence, ["kind", "configuredDirectory", "physicalDirectory", "executable", "helperPath", "argv", "stdout", "stderr", "exitCode", "entries", "coverage", "errors"], "directory listing evidence");
  if (evidence.kind !== "directory.list" || evidence.coverage !== "complete" || evidence.exitCode !== 0) throw new TypeError("directoryListing.evidence must be a complete successful listing");
  if (!Array.isArray(evidence.entries) || !Array.isArray(evidence.errors)) throw new TypeError("directory listing evidence arrays required");
  if (!Array.isArray(evidence.argv) || evidence.argv.length !== 2 || evidence.argv.some(argument => typeof argument !== "string")) {
    throw new TypeError("directory listing evidence argv must contain two strings");
  }
  const physicalDirectory = absolutePath(evidence.physicalDirectory, "listing physicalDirectory");
  const argv = Object.freeze([evidence.argv[0] as string, evidence.argv[1] as string] as const);
  const listing = validateDirectoryListing({
    directory: physicalDirectory,
    entries: evidence.entries,
    coverage: evidence.coverage,
    errors: evidence.errors,
  });
  if (typeof evidence.stderr !== "string") throw new TypeError("directory listing evidence stderr must be a string");
  return Object.freeze({
    kind: "directory.list",
    configuredDirectory: absolutePath(evidence.configuredDirectory, "listing configuredDirectory"),
    physicalDirectory,
    executable: nonEmpty(evidence.executable, "listing executable"),
    helperPath: nonEmpty(evidence.helperPath, "listing helperPath"),
    argv,
    stdout: nonEmpty(evidence.stdout, "listing stdout"),
    stderr: evidence.stderr,
    exitCode: 0,
    entries: listing.entries,
    coverage: "complete",
    errors: listing.errors,
  });
}

export function validateDirectoryKnowledge(value: unknown): DirectoryKnowledge {
  const knowledge = expectRecord(value, "state.directoryListing");
  exactKeys(knowledge, ["physicalDirectory", "entries", "coverage", "errors", "evidence", "revision", "sourceRun"], "state.directoryListing");
  if (knowledge.coverage !== "complete") throw new TypeError("state.directoryListing must be complete");
  if (!Array.isArray(knowledge.errors) || knowledge.errors.length !== 0) throw new TypeError("state.directoryListing.errors must be empty");
  if (!Array.isArray(knowledge.entries)) throw new TypeError("state.directoryListing.entries must be an array");
  if (!Number.isInteger(knowledge.revision) || (knowledge.revision as number) < 0) throw new TypeError("state.directoryListing.revision must be a nonnegative integer");
  const physicalDirectory = absolutePath(knowledge.physicalDirectory, "state.directoryListing.physicalDirectory");
  const evidence = validateListingEvidence(knowledge.evidence);
  if (physicalDirectory !== evidence.physicalDirectory) {
    throw new TypeError("state.directoryListing.physicalDirectory must equal its embedded evidence");
  }
  if (!sameEntries(knowledge.entries, evidence.entries)) {
    throw new TypeError("state.directoryListing.entries must equal its embedded evidence entries");
  }
  return Object.freeze({
    physicalDirectory,
    entries: evidence.entries,
    coverage: "complete",
    errors: evidence.errors,
    evidence,
    revision: knowledge.revision as number,
    sourceRun: nonEmpty(knowledge.sourceRun, "state.directoryListing.sourceRun"),
  });
}

export function validatePathKnowledge(value: unknown): PathKnowledge {
  const knowledge = expectRecord(value, "state.pathKnowledge");
  if (knowledge.kind === "path.resolve") {
    exactKeys(knowledge, ["absolutePath", "base", "input", "kind", "parent", "sessionRevision", "sourceRun"], "path.resolve knowledge");
    return Object.freeze({
      kind: "path.resolve",
      base: validatePathRef(knowledge.base, "path.resolve knowledge base"),
      input: nonEmpty(knowledge.input, "path.resolve knowledge input"),
      absolutePath: absolutePath(knowledge.absolutePath, "path.resolve knowledge absolutePath"),
      parent: absolutePath(knowledge.parent, "path.resolve knowledge parent"),
      sourceRun: nonEmpty(knowledge.sourceRun, "path.resolve knowledge sourceRun"),
      sessionRevision: nonnegativeInteger(knowledge.sessionRevision, "path.resolve knowledge sessionRevision"),
    });
  }
  if (knowledge.kind === "path.relative") {
    exactKeys(knowledge, ["from", "kind", "relativePath", "sessionRevision", "sourceRun", "to"], "path.relative knowledge");
    if (typeof knowledge.relativePath !== "string" || knowledge.relativePath.includes("\0")) {
      throw new TypeError("path.relative knowledge relativePath must be a string without NUL");
    }
    return Object.freeze({
      kind: "path.relative",
      from: validatePathRef(knowledge.from, "path.relative knowledge from"),
      to: validatePathRef(knowledge.to, "path.relative knowledge to"),
      relativePath: knowledge.relativePath,
      sourceRun: nonEmpty(knowledge.sourceRun, "path.relative knowledge sourceRun"),
      sessionRevision: nonnegativeInteger(knowledge.sessionRevision, "path.relative knowledge sessionRevision"),
    });
  }
  if (knowledge.kind === "path.parts") {
    exactKeys(knowledge, ["isRoot", "kind", "name", "parent", "path", "sessionRevision", "sourceRun"], "path.parts knowledge");
    if (typeof knowledge.name !== "string" || knowledge.name.includes("\0") || typeof knowledge.isRoot !== "boolean") {
      throw new TypeError("path.parts knowledge name/isRoot are invalid");
    }
    return Object.freeze({
      kind: "path.parts",
      path: validatePathRef(knowledge.path, "path.parts knowledge path"),
      parent: absolutePath(knowledge.parent, "path.parts knowledge parent"),
      name: knowledge.name,
      isRoot: knowledge.isRoot,
      sourceRun: nonEmpty(knowledge.sourceRun, "path.parts knowledge sourceRun"),
      sessionRevision: nonnegativeInteger(knowledge.sessionRevision, "path.parts knowledge sessionRevision"),
    });
  }
  if (knowledge.kind === "path.realpath") {
    exactKeys(
      knowledge,
      ["entryExists", "errno", "kind", "physicalPath", "ref", "resolvedIdentity", "resolvedTargetExists", "sessionRevision", "sourceRun"],
      "path.realpath knowledge",
    );
    for (const key of ["entryExists", "resolvedTargetExists"] as const) {
      if (knowledge[key] !== null && typeof knowledge[key] !== "boolean") {
        throw new TypeError(`path.realpath knowledge ${key} must be boolean or null`);
      }
    }
    if (knowledge.errno !== null && (typeof knowledge.errno !== "string" || knowledge.errno.length === 0)) {
      throw new TypeError("path.realpath knowledge errno must be a non-empty string or null");
    }
    return Object.freeze({
      kind: "path.realpath",
      ref: validateInspectRef(knowledge.ref, "path.realpath knowledge ref"),
      physicalPath: knowledge.physicalPath === null ? null : absolutePath(knowledge.physicalPath, "path.realpath knowledge physicalPath"),
      entryExists: knowledge.entryExists as boolean | null,
      resolvedTargetExists: knowledge.resolvedTargetExists as boolean | null,
      resolvedIdentity: knowledge.resolvedIdentity === null
        ? null
        : validateObjectIdentity(knowledge.resolvedIdentity, "path.realpath knowledge resolvedIdentity"),
      errno: knowledge.errno as string | null,
      sourceRun: nonEmpty(knowledge.sourceRun, "path.realpath knowledge sourceRun"),
      sessionRevision: nonnegativeInteger(knowledge.sessionRevision, "path.realpath knowledge sessionRevision"),
    });
  }
  throw new TypeError("state.pathKnowledge.kind must be path.resolve, path.relative, path.parts, or path.realpath");
}

export function validateEntryKnowledge(value: unknown): EntryKnowledge {
  const knowledge = expectRecord(value, "state.entryKnowledge");
  const required = [
    "absolutePath", "entryExists", "errno", "identity", "kind", "linkTarget", "mode", "owner",
    "query", "resolvedTargetExists", "sessionRevision", "size", "sourceRun", "times", "type",
  ];
  if (Object.keys(knowledge).some(key => !required.includes(key) && key !== "observedWith")
    || required.some(key => !Object.hasOwn(knowledge, key))) {
    throw new TypeError(`state.entryKnowledge must contain ${required.join(", ")} and optional observedWith`);
  }
  if (knowledge.kind !== "entry.inspect") throw new TypeError("state.entryKnowledge.kind must be entry.inspect");
  if (knowledge.observedWith !== undefined && knowledge.observedWith !== null
    && knowledge.observedWith !== "stat" && knowledge.observedWith !== "lstat") {
    throw new TypeError("entryKnowledge.observedWith must be stat, lstat, or null");
  }
  if (knowledge.entryExists !== null && typeof knowledge.entryExists !== "boolean") throw new TypeError("entryKnowledge.entryExists must be boolean or null");
  if (knowledge.resolvedTargetExists !== null && typeof knowledge.resolvedTargetExists !== "boolean") {
    throw new TypeError("entryKnowledge.resolvedTargetExists must be boolean or null");
  }
  if (knowledge.type !== null && !["regular", "directory", "symlink", "character_device", "block_device", "fifo", "socket", "other"].includes(knowledge.type as string)) {
    throw new TypeError("entryKnowledge.type must be a supported entry type or null");
  }
  if (knowledge.linkTarget !== null && (typeof knowledge.linkTarget !== "string" || knowledge.linkTarget.includes("\0"))) {
    throw new TypeError("entryKnowledge.linkTarget must be a string without NUL or null");
  }
  if (knowledge.errno !== null && (typeof knowledge.errno !== "string" || knowledge.errno.length === 0)) {
    throw new TypeError("entryKnowledge.errno must be a non-empty string or null");
  }
  let owner: EntryKnowledge["owner"] = null;
  if (knowledge.owner !== null) {
    const raw = expectRecord(knowledge.owner, "entryKnowledge.owner");
    exactKeys(raw, ["gid", "uid"], "entryKnowledge.owner");
    owner = Object.freeze({ uid: osInteger(raw.uid, "entryKnowledge.owner.uid"), gid: osInteger(raw.gid, "entryKnowledge.owner.gid") });
  }
  let times: EntryKnowledge["times"] = null;
  if (knowledge.times !== null) {
    const raw = expectRecord(knowledge.times, "entryKnowledge.times");
    exactKeys(raw, ["atimeMs", "birthtimeMs", "ctimeMs", "mtimeMs"], "entryKnowledge.times");
    times = Object.freeze({
      atimeMs: osInteger(raw.atimeMs, "entryKnowledge.times.atimeMs", true),
      mtimeMs: osInteger(raw.mtimeMs, "entryKnowledge.times.mtimeMs", true),
      ctimeMs: osInteger(raw.ctimeMs, "entryKnowledge.times.ctimeMs", true),
      birthtimeMs: osInteger(raw.birthtimeMs, "entryKnowledge.times.birthtimeMs", true),
    });
  }
  return Object.freeze({
    kind: "entry.inspect",
    query: validateEntryInspectQuery(knowledge.query),
    absolutePath: absolutePath(knowledge.absolutePath, "entryKnowledge.absolutePath"),
    observedWith: knowledge.observedWith === undefined || knowledge.observedWith === null
      ? null
      : knowledge.observedWith as "stat" | "lstat",
    entryExists: knowledge.entryExists as boolean | null,
    resolvedTargetExists: knowledge.resolvedTargetExists as boolean | null,
    type: knowledge.type as EntryType | null,
    size: osInteger(knowledge.size, "entryKnowledge.size"),
    mode: osInteger(knowledge.mode, "entryKnowledge.mode"),
    owner,
    times,
    linkTarget: knowledge.linkTarget as string | null,
    identity: validateFullIdentity(knowledge.identity, "entryKnowledge.identity"),
    errno: knowledge.errno as string | null,
    sourceRun: nonEmpty(knowledge.sourceRun, "entryKnowledge.sourceRun"),
    sessionRevision: nonnegativeInteger(knowledge.sessionRevision, "entryKnowledge.sessionRevision"),
  });
}

export function validateExplicitFileState(value: unknown): ExplicitFileState {
  const state = expectRecord(value, "property state");
  const keys = ["session", "cwdObservation", "directoryListing"], allowed = [...keys, "pathKnowledge", "entryKnowledge", "entrySelection"];
  if (Object.keys(state).some(key => !allowed.includes(key)) || keys.some(key => !Object.hasOwn(state, key))) {
    throw new TypeError(`property state must contain ${keys.join(", ")} and optional pathKnowledge, entryKnowledge, entrySelection`);
  }
  return Object.freeze({
    session: nonEmpty(state.session, "state.session"),
    cwdObservation: state.cwdObservation === null ? null : validateCwdKnowledge(state.cwdObservation),
    directoryListing: state.directoryListing === null ? null : validateDirectoryKnowledge(state.directoryListing),
    pathKnowledge: state.pathKnowledge === undefined || state.pathKnowledge === null ? null : validatePathKnowledge(state.pathKnowledge),
    entryKnowledge: state.entryKnowledge === undefined || state.entryKnowledge === null ? null : validateEntryKnowledge(state.entryKnowledge),
    ...(state.entrySelection === undefined || state.entrySelection === null
      ? {}
      : { entrySelection: validateEntrySelectionKnowledge(state.entrySelection) }),
  });
}

function selectionRef(value: unknown, outcome: EntrySelectionOutcome, label: string): string | null {
  if (outcome === "selected") {
    if (typeof value === "string") return nonEmpty(value, label);
    throw new TypeError(`${label} must be a non-empty string reference for a selected entry`);
  }
  if (value !== null) throw new TypeError(`${label} must be null when outcome is ${outcome}`);
  return null;
}

export function validateEntrySelectionKnowledge(value: unknown): EntrySelectionKnowledge {
  const knowledge = expectRecord(value, "state.entrySelection");
  const keys = Object.keys(knowledge);
  if (keys.some(key => key !== "name" && key !== "outcome" && key !== "parentPath" && key !== "reason" && key !== "ref" && key !== "sessionRevision" && key !== "sourceRun" && key !== "targetType")
    || !["name", "outcome", "parentPath", "ref", "sessionRevision", "sourceRun", "targetType"].every(key => Object.hasOwn(knowledge, key))) {
    throw new TypeError("state.entrySelection must contain name, outcome, parentPath, ref, sessionRevision, sourceRun, targetType and an optional reason");
  }
  const outcome = knowledge.outcome;
  if (!["selected", "not_found", "insufficient_evidence", "conflict", "rejected"].includes(outcome as string)) {
    throw new TypeError("state.entrySelection.outcome must be a registered selection outcome");
  }
  if (knowledge.targetType !== "unspecified" && knowledge.targetType !== "regular" && knowledge.targetType !== "directory") {
    throw new TypeError("state.entrySelection.targetType must be unspecified, regular, or directory");
  }
  if (knowledge.reason !== null && (typeof knowledge.reason !== "string" || knowledge.reason.length === 0)) {
    throw new TypeError("state.entrySelection.reason must be a non-empty string or null");
  }
  return Object.freeze({
    parentPath: absolutePath(knowledge.parentPath, "state.entrySelection.parentPath"),
    name: nonEmpty(knowledge.name, "state.entrySelection.name"),
    targetType: knowledge.targetType as EntrySelectionKnowledge["targetType"],
    outcome: outcome as EntrySelectionOutcome,
    ref: selectionRef(knowledge.ref, outcome as EntrySelectionOutcome, "state.entrySelection.ref"),
    reason: knowledge.reason as string | null,
    sessionRevision: nonnegativeInteger(knowledge.sessionRevision, "state.entrySelection.sessionRevision"),
    sourceRun: nonEmpty(knowledge.sourceRun, "state.entrySelection.sourceRun"),
  });
}

export type EvidenceRecord =
  | Readonly<{
      kind: "pwd";
      session: string;
      revision: number;
      runId: string;
      observation: PwdObservation;
    }>
  | Readonly<{
      kind: "directory.list";
      session: string;
      revision: number;
      runId: string;
      observation: DirectoryListObservation;
    }>
  | EntrySelectEvidenceRecord;

export type EntrySelectObservation = Readonly<{
  parentPath: string;
  name: string;
  targetType: "unspecified" | "regular" | "directory";
  outcome: EntrySelectionOutcome;
  ref: string | null;
  reason: string | null;
}>;

export type EntrySelectEvidenceRecord = Readonly<{
  kind: "entry.select";
  session: string;
  revision: number;
  runId: string;
  observation: EntrySelectObservation;
}>;

export type EvidenceAuthority = Readonly<{
  record(value: EvidenceRecord): void;
  known(value: EvidenceRecord): boolean;
  trusted(value: EvidenceRecord): boolean;
}>;

function sameObservation(left: EvidenceRecord, right: EvidenceRecord): boolean {
  if (left.kind === "pwd" && right.kind === "pwd") return samePwdObservation(left.observation, right.observation);
  if (left.kind === "directory.list" && right.kind === "directory.list") {
    return sameDirectoryObservation(left.observation, right.observation);
  }
  if (left.kind === "entry.select" && right.kind === "entry.select") {
    return sameEntrySelectObservation(left.observation, right.observation);
  }
  return false;
}

/** Local, non-persistent authority. It only maps this policy's receipts to immutable observations. */
export function createEvidenceAuthority(): EvidenceAuthority {
  const records = new Map<string, EvidenceRecord>();
  return Object.freeze({
    record(value: EvidenceRecord) {
      const key = `${value.session}\u0000${value.runId}`;
      if (records.has(key)) throw new TypeError("Evidence run identity was already recorded");
      if (value.kind === "pwd") {
        records.set(key, Object.freeze({ ...value, observation: validatePwdObservation(value.observation) }));
        return;
      }
    if (value.kind === "entry.select") {
      records.set(key, Object.freeze({ ...value, observation: validateEntrySelectObservation(value.observation) }));
      return;
    }
      records.set(key, Object.freeze({ ...value, observation: validateListingEvidence(value.observation) }));
    },
    known(value: EvidenceRecord) {
      const record = records.get(`${value.session}\u0000${value.runId}`);
      return record !== undefined && sameObservation(record, value);
    },
    trusted(value: EvidenceRecord) {
      const record = records.get(`${value.session}\u0000${value.runId}`);
      return record !== undefined
        && record.revision === value.revision
        && sameObservation(record, value);
    },
  });
}
