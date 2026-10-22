import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { createCliSession } from "../../cli.js";
import { expectRecord } from "../../core/schema.js";
import { interpretCliPath, pathParts, readCliPath, relativePath as lexicalRelativePath } from "../../filters/cli-path.js";
import {
  runDirectoryListHelper,
  type DirectoryListObservation,
  type DirectoryListingResult,
} from "./directory-listing.js";
import { readFileRange, type FileReadIo } from "./file-content.js";
import {
  readEntrySnapshot,
  readInspectRef,
  readObservedObjectRef,
  readPathRef,
  runEntryInspectHelper,
  type EntryKind,
  type LegacyDirectoryRef,
  type OsInteger,
  type ObservedEntrySnapshot,
  type ObservedObjectRef,
  type PathRef,
} from "./entry-inspection.js";
import type { CliEffect as ObservationEffect, CliFailure, CliResult, PwdObservation } from "./observation.js";

export type { ObservedEntrySnapshot } from "./entry-inspection.js";

export type CliSandboxEffect = ObservationEffect | "session.write";
type CliEffect = CliSandboxEffect;

export const CD_EXECUTABLE = "/bin/zsh" as const;
export const CD_ARGV0 = "nnanything-cd" as const;
export const CD_COMMAND_SCRIPT = 'builtin cd -- "$1" && /bin/pwd -P' as const;

export type FilesystemOwnerGrant = "filesystem.read" | "filesystem.write";

export type SessionRef = Readonly<{
  kind: "cli.session";
  scenarioId: string;
  sessionId: string;
}>;

export type DirectoryRef = Readonly<{
  kind: "cli.directory";
  scenarioId: string;
  sessionId: string;
  path: string;
}>;

export type SessionSnapshot = Readonly<{
  id: string;
  cwd: string;
  revision: number;
  grantedEffects: readonly CliEffect[];
}>;

export type SandboxEntrySpec =
  | Readonly<{ path: string; kind: "directory" }>
  | Readonly<{ path: string; kind: "file"; contents: string }>;

export type SandboxSessionSpec = Readonly<{
  id: string;
  cwd: string;
  grantedEffects: readonly CliEffect[];
}>;

export type SandboxRecipe = Readonly<{
  scenarioId: string;
  entries: readonly SandboxEntrySpec[];
  sessions: readonly SandboxSessionSpec[];
}>;

export type SemanticCwdGetCall = Readonly<{
  operation: "cwd.get";
  parameters: Readonly<{ session: SessionRef }>;
}>;

export type SemanticCwdSetCall = Readonly<{
  operation: "cwd.set";
  parameters: Readonly<{ session: SessionRef; directory: DirectoryRef }>;
}>;

export type SemanticDirectoryListCall = Readonly<{
  operation: "directory.list";
  parameters: Readonly<{ session: SessionRef; directory: DirectoryRef }>;
}>;

export type SemanticPathResolveCall = Readonly<{
  operation: "path.resolve";
  parameters: Readonly<{ base: PathRef; input: string }>;
}>;

export type SemanticPathRelativeCall = Readonly<{
  operation: "path.relative";
  parameters: Readonly<{ from: PathRef; to: PathRef }>;
}>;

export type SemanticPathPartsCall = Readonly<{
  operation: "path.parts";
  parameters: Readonly<{ path: PathRef }>;
}>;

export type SemanticEntryInspectCall = Readonly<{
  operation: "entry.inspect";
  parameters: Readonly<{ ref: PathRef | ObservedObjectRef | LegacyDirectoryRef; followSymlinks: boolean }>;
}>;

export type SemanticFileReadCall = Readonly<{
  operation: "file.read";
  parameters: Readonly<{
    ref: ObservedObjectRef;
    offset: number;
    length: number;
  }>;
}>;

export type SemanticCliCall =
  | SemanticCwdGetCall
  | SemanticCwdSetCall
  | SemanticDirectoryListCall
  | SemanticPathResolveCall
  | SemanticPathRelativeCall
  | SemanticPathPartsCall
  | SemanticEntryInspectCall
  | SemanticFileReadCall;

export type CwdSetObservation = Readonly<{
  kind: "cwd.set";
  configuredCwd: string;
  requestedPath: string;
  targetConfiguredPath: string;
  targetPhysicalPath: string;
  executable: typeof CD_EXECUTABLE;
  argv: readonly [string, string, string, string, string];
  stdout: string;
  stderr: string;
  exitCode: 0;
}>;

export type PathResolveObservation = Readonly<{
  kind: "path.resolve";
  base: PathRef;
  input: string;
  normalized: string;
  absolute: string;
  parent: string;
  inputForm: "absolute" | "relative";
}>;

export type PathRelativeObservation = Readonly<{
  kind: "path.relative";
  from: PathRef;
  to: PathRef;
  relative: string;
}>;

export type PathPartsCallObservation = Readonly<{
  kind: "path.parts";
  path: PathRef;
  absolute: string;
  parent: string;
  name: string;
  isRoot: boolean;
}>;

export type EntryInspectObservation = Readonly<{
  kind: "entry.inspect";
  ref: PathRef | ObservedObjectRef;
  followSymlinks: boolean;
  configuredPath: string;
  executable: string;
  helperPath: string;
  argv: readonly [string, string];
  stdin: string;
  stdout: string;
  stderr: string;
  exitCode: 0;
  snapshot: ObservedEntrySnapshot;
}>;

export type FileReadObservation = Readonly<{
  kind: "file.read";
  ref: ObservedObjectRef;
  absolutePath: string;
  offset: number;
  length: number;
  size: number; // file size at read time (bytes)
  bytes: string; // base64 of the actual bytes read
  bytesRead: number;
  eof: boolean;
  identity: Readonly<{ dev: OsInteger; ino: OsInteger }>;
}>;

export type SemanticCallReceipt = Readonly<{
  call: SemanticCliCall;
  status: "succeeded" | "failed";
  session_before: SessionSnapshot;
  session_after: SessionSnapshot;
  execution:
    | Readonly<{
        status: "succeeded";
        runId: string;
        executorInvoked: true;
        observation:
          | PwdObservation
          | CwdSetObservation
          | DirectoryListObservation
          | PathResolveObservation
          | PathRelativeObservation
          | PathPartsCallObservation
          | EntryInspectObservation
          | FileReadObservation;
      }>
    | Readonly<{
        status: "failed";
        runId: string;
        executorInvoked: boolean;
        error: CliFailure;
      }>;
}>;

/** Typed test dependency for the postcommit observation branch. */
export type CliSandboxObservation = (input: Readonly<{
  session: SessionRef;
  cwd: string;
  grantedEffects: readonly CliEffect[];
}>) => Promise<CliResult>;

/** Test dependency for deterministic listing failures. It is never a semantic-call field. */
export type DirectoryListingObserver = (input: Readonly<{
  session: SessionRef;
  directory: DirectoryRef;
  configuredDirectory: string;
  physicalDirectory: string;
  grantedEffects: readonly CliEffect[];
}>) => Promise<DirectoryListingResult>;

export interface CliFilesystemSandbox {
  readonly scenarioId: string;
  readonly scenarioRoot: string;
  bindSession(id: string): SessionRef;
  getSession(ref: SessionRef): SessionSnapshot;
  bindPath(session: SessionRef, path: string): PathRef;
  bindEntry(session: SessionRef, path: string): Promise<ObservedObjectRef>;
  bindFile(session: SessionRef, path: string): Promise<ObservedObjectRef>;
  bindDirectoryObject(session: SessionRef, path: string): Promise<ObservedObjectRef>;
  bindDirectory(session: SessionRef, path: string): Promise<DirectoryRef>;
  validateObservedObject(ref: ObservedObjectRef): Promise<void>;
  resolveDirectory(ref: DirectoryRef): Promise<Readonly<{
    ref: DirectoryRef;
    configuredPath: string;
    physicalPath: string;
  }>>;
  execute(call: unknown): Promise<SemanticCallReceipt>;
  cleanup(): Promise<Readonly<{ removed: boolean; scenarioRoot: string }>>;
}

type SandboxState = {
  readonly root: string;
  readonly scenarioId: string;
  readonly scenarioRoot: string;
  readonly sessions: Map<string, SessionSnapshot>;
  readonly grants: readonly CliEffect[];
  readonly observation?: CliSandboxObservation;
  readonly listingObserver?: DirectoryListingObserver;
  readonly fileReadIo?: FileReadIo;
  readonly boundRefs: Map<string, ObservedObjectRef>;
  active: boolean;
};

const execFileAsync = promisify(execFile);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty string without NUL`);
  }
  return value;
}

function segment(value: unknown, label: string): string {
  const name = nonEmpty(value, label);
  if (name === "." || name === ".." || isAbsolute(name) || name.includes("/") || name.includes("\\")) {
    throw new TypeError(`${label} must be one local path segment`);
  }
  return name;
}

function relativePath(value: unknown, label: string, allowCurrent = false): string {
  const path = nonEmpty(value, label);
  if (isAbsolute(path)) throw new TypeError(`${label} must be relative`);
  // Directory references resolve against the session cwd at call time, so
  // sibling and parent targets inside the scene stay legal here. Scene
  // containment is enforced by resolveDirectory and by the recipe/entry
  // checks, where the owner root is known.
  if (path === "." && !allowCurrent) throw new TypeError(`${label} must not be the owner root`);
  return path;
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("../") && rel !== ".." && !isAbsolute(rel));
}

function effects(value: unknown, label: string): readonly CliEffect[] {
  if (!Array.isArray(value) || value.some(effect => effect !== "filesystem.read" && effect !== "process.exec" && effect !== "session.write")) {
    throw new TypeError(`${label} must contain only filesystem.read, process.exec and session.write`);
  }
  return Object.freeze([...new Set(value)] as CliEffect[]);
}

function observationEffects(value: readonly CliEffect[]): readonly ObservationEffect[] {
  return value.filter(effect => effect === "filesystem.read" || effect === "process.exec");
}

function ownerGrants(value: unknown): readonly FilesystemOwnerGrant[] {
  if (!Array.isArray(value) || value.some(grant => grant !== "filesystem.read" && grant !== "filesystem.write")) {
    throw new TypeError("ownerGrantedEffects must contain only filesystem.read and filesystem.write");
  }
  if (!value.includes("filesystem.write")) throw new TypeError("Sandbox creation requires explicit filesystem.write");
  return Object.freeze([...new Set(value)] as FilesystemOwnerGrant[]);
}

function readEntry(value: unknown, index: number): SandboxEntrySpec {
  const entry = expectRecord(value, `recipe.entries[${index}]`);
  if (entry.kind === "directory") {
    exactKeys(entry, ["path", "kind"], `recipe.entries[${index}]`);
    return Object.freeze({ path: relativePath(entry.path, `recipe.entries[${index}].path`), kind: "directory" });
  }
  if (entry.kind === "file") {
    exactKeys(entry, ["path", "kind", "contents"], `recipe.entries[${index}]`);
    if (typeof entry.contents !== "string" || entry.contents.includes("\0")) {
      throw new TypeError(`recipe.entries[${index}].contents must be a string without NUL`);
    }
    return Object.freeze({
      path: relativePath(entry.path, `recipe.entries[${index}].path`),
      kind: "file",
      contents: entry.contents,
    });
  }
  throw new TypeError(`recipe.entries[${index}].kind must be directory or file`);
}

function readRecipe(value: unknown): SandboxRecipe {
  const recipe = expectRecord(value, "sandbox recipe");
  exactKeys(recipe, ["scenarioId", "entries", "sessions"], "sandbox recipe");
  const scenarioId = segment(recipe.scenarioId, "recipe.scenarioId");
  if (!Array.isArray(recipe.entries)) throw new TypeError("recipe.entries must be an array");
  if (!Array.isArray(recipe.sessions)) throw new TypeError("recipe.sessions must be an array");
  const entries = recipe.entries.map(readEntry);
  const sessionIds = new Set<string>();
  const sessions = recipe.sessions.map((value, index): SandboxSessionSpec => {
    const session = expectRecord(value, `recipe.sessions[${index}]`);
    exactKeys(session, ["id", "cwd", "grantedEffects"], `recipe.sessions[${index}]`);
    const id = nonEmpty(session.id, `recipe.sessions[${index}].id`);
    if (sessionIds.has(id)) throw new TypeError(`Duplicate sandbox session ${id}`);
    sessionIds.add(id);
    const cwd = relativePath(session.cwd, `recipe.sessions[${index}].cwd`, true);
    if (!within("/scenario", resolve("/scenario", cwd))) throw new TypeError("Session cwd escapes its scenario root");
    return Object.freeze({
      id,
      cwd,
      grantedEffects: effects(session.grantedEffects, `recipe.sessions[${index}].grantedEffects`),
    });
  });
  return Object.freeze({ scenarioId, entries: Object.freeze(entries), sessions: Object.freeze(sessions) });
}

function assertRef(value: unknown, label: string): Record<string, unknown> {
  const ref = expectRecord(value, label);
  if (ref.kind !== "cli.session" && ref.kind !== "cli.directory") throw new TypeError(`${label} has an unknown reference kind`);
  return ref;
}

function readSessionRef(value: unknown): SessionRef {
  const ref = assertRef(value, "session reference");
  exactKeys(ref, ["kind", "scenarioId", "sessionId"], "session reference");
  if (ref.kind !== "cli.session") throw new TypeError("Expected a cli.session reference");
  return Object.freeze({
    kind: "cli.session",
    scenarioId: nonEmpty(ref.scenarioId, "session reference scenarioId"),
    sessionId: nonEmpty(ref.sessionId, "session reference sessionId"),
  });
}

function readDirectoryRef(value: unknown): DirectoryRef {
  const ref = assertRef(value, "directory reference");
  exactKeys(ref, ["kind", "scenarioId", "sessionId", "path"], "directory reference");
  if (ref.kind !== "cli.directory") throw new TypeError("Expected a cli.directory reference");
  return Object.freeze({
    kind: "cli.directory",
    scenarioId: nonEmpty(ref.scenarioId, "directory reference scenarioId"),
    sessionId: nonEmpty(ref.sessionId, "directory reference sessionId"),
    path: relativePath(ref.path, "directory reference path", true),
  });
}

export function readSemanticCliCall(value: unknown): SemanticCliCall {
  const call = expectRecord(value, "semantic CLI call");
  exactKeys(call, ["operation", "parameters"], "semantic CLI call");
  if (call.operation === "cwd.get") {
    const parameters = expectRecord(call.parameters, "semantic CLI parameters");
    exactKeys(parameters, ["session"], "semantic CLI parameters");
    return Object.freeze({
      operation: "cwd.get",
      parameters: Object.freeze({ session: readSessionRef(parameters.session) }),
    });
  }
  if (call.operation === "cwd.set") {
    const parameters = expectRecord(call.parameters, "semantic CLI parameters");
    exactKeys(parameters, ["session", "directory"], "semantic CLI parameters");
    const session = readSessionRef(parameters.session), directory = readDirectoryRef(parameters.directory);
    return Object.freeze({
      operation: "cwd.set",
      parameters: Object.freeze({
        session,
        directory,
      }),
    });
  }
  if (call.operation === "directory.list") {
    const parameters = expectRecord(call.parameters, "semantic CLI parameters");
    exactKeys(parameters, ["session", "directory"], "semantic CLI parameters");
    return Object.freeze({
      operation: "directory.list",
      parameters: Object.freeze({
        session: readSessionRef(parameters.session),
        directory: readDirectoryRef(parameters.directory),
      }),
    });
  }
  if (call.operation === "path.resolve") {
    const parameters = expectRecord(call.parameters, "semantic CLI parameters");
    exactKeys(parameters, ["base", "input"], "semantic CLI parameters");
    return Object.freeze({
      operation: "path.resolve",
      parameters: Object.freeze({
        base: readPathRef(parameters.base),
        input: readCliPath(parameters.input, "path text"),
      }),
    });
  }
  if (call.operation === "path.relative") {
    const parameters = expectRecord(call.parameters, "semantic CLI parameters");
    exactKeys(parameters, ["from", "to"], "semantic CLI parameters");
    return Object.freeze({
      operation: "path.relative",
      parameters: Object.freeze({
        from: readPathRef(parameters.from),
        to: readPathRef(parameters.to),
      }),
    });
  }
  if (call.operation === "path.parts") {
    const parameters = expectRecord(call.parameters, "semantic CLI parameters");
    exactKeys(parameters, ["path"], "semantic CLI parameters");
    return Object.freeze({
      operation: "path.parts",
      parameters: Object.freeze({ path: readPathRef(parameters.path) }),
    });
  }
  if (call.operation === "entry.inspect") {
    const parameters = expectRecord(call.parameters, "semantic CLI parameters");
    exactKeys(parameters, ["ref", "followSymlinks"], "semantic CLI parameters");
    if (typeof parameters.followSymlinks !== "boolean") throw new TypeError("entry.inspect followSymlinks must be an explicit boolean");
    return Object.freeze({
      operation: "entry.inspect",
      parameters: Object.freeze({
        ref: readInspectRef(parameters.ref),
        followSymlinks: parameters.followSymlinks,
      }),
    });
  }
  if (call.operation === "file.read") {
    const parameters = expectRecord(call.parameters, "semantic CLI parameters");
    exactKeys(parameters, ["ref", "offset", "length"], "semantic CLI parameters");
    const offset = parameters.offset;
    const length = parameters.length;
    if (!Number.isSafeInteger(offset) || (offset as number) < 0) {
      throw new TypeError("file.read offset must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(length) || (length as number) < 0) {
      throw new TypeError("file.read length must be a non-negative safe integer");
    }
    return Object.freeze({
      operation: "file.read",
      parameters: Object.freeze({
        ref: readObservedObjectRef(parameters.ref),
        offset: offset as number,
        length: length as number,
      }),
    });
  }
  throw new TypeError("Only cwd.get, cwd.set, directory.list, path.resolve, path.relative, path.parts, entry.inspect and file.read are supported");
}

function snapshot(state: SandboxState, ref: SessionRef): SessionSnapshot {
  if (!state.active) throw new Error("Filesystem sandbox is closed");
  const value = readSessionRef(ref);
  if (value.scenarioId !== state.scenarioId) throw new TypeError("Session reference belongs to another scenario");
  const current = state.sessions.get(value.sessionId);
  if (!current) throw new TypeError(`Unknown sandbox session: ${value.sessionId}`);
  return Object.freeze({
    id: current.id,
    cwd: current.cwd,
    revision: current.revision,
    grantedEffects: Object.freeze([...current.grantedEffects]),
  });
}

async function resolveDirectory(state: SandboxState, value: unknown, rejectFinalSymlink = false) {
  if (!state.active) throw new Error("Filesystem sandbox is closed");
  const ref = readDirectoryRef(value);
  if (ref.scenarioId !== state.scenarioId) throw new TypeError("Directory reference belongs to another scenario");
  const session = snapshot(state, { kind: "cli.session", scenarioId: ref.scenarioId, sessionId: ref.sessionId });
  const configuredPath = resolve(session.cwd, ref.path);
  if (!within(state.scenarioRoot, configuredPath)) throw Object.assign(new TypeError("Directory reference escapes the scenario root"), { code: "SANDBOX_ESCAPE" });
  if (rejectFinalSymlink) {
    const finalAttributes = await lstat(configuredPath);
    if (finalAttributes.isSymbolicLink()) {
      throw Object.assign(new TypeError("Final directory target must not be a symlink"), { code: "FINAL_SYMLINK" });
    }
  }
  const physicalPath = await realpath(configuredPath);
  if (!within(state.scenarioRoot, physicalPath)) throw Object.assign(new TypeError("Directory physical target escapes the scenario root"), { code: "SANDBOX_ESCAPE" });
  const attributes = await lstat(physicalPath);
  if (!attributes.isDirectory()) throw Object.assign(new TypeError("Bound directory path is not a directory"), { code: "NOT_DIRECTORY" });
  return Object.freeze({ ref, configuredPath, physicalPath });
}

function failureCode(error: unknown): string {
  if (error !== null && (typeof error === "object" || typeof error === "function") && "code" in error) {
    const code = String(error.code);
    if (code && code !== "undefined") return code;
  }
  return "EINVAL";
}

function sessionOfRef(ref: PathRef | ObservedObjectRef | LegacyDirectoryRef): SessionRef {
  return Object.freeze({ kind: "cli.session", scenarioId: ref.scenarioId, sessionId: ref.sessionId });
}

function sessionOfCall(call: SemanticCliCall): SessionRef {
  if (call.operation === "cwd.get" || call.operation === "cwd.set" || call.operation === "directory.list") {
    return call.parameters.session;
  }
  if (call.operation === "path.resolve") return sessionOfRef(call.parameters.base);
  if (call.operation === "path.relative") return sessionOfRef(call.parameters.from);
  if (call.operation === "path.parts") return sessionOfRef(call.parameters.path);
  return sessionOfRef(call.parameters.ref);
}

function sameSession(state: SandboxState, before: SessionSnapshot, right: PathRef | ObservedObjectRef | LegacyDirectoryRef): boolean {
  return before.id === right.sessionId && state.scenarioId === right.scenarioId;
}

function sameIdentity(left: ObservedObjectRef["identity"], right: ObservedObjectRef["identity"]): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameObservedRef(left: ObservedObjectRef, right: ObservedObjectRef): boolean {
  return left.kind === right.kind
    && left.scenarioId === right.scenarioId
    && left.sessionId === right.sessionId
    && left.type === right.type
    && sameIdentity(left.identity, right.identity)
    && left.sourceRun === right.sourceRun
    && left.sessionRevision === right.sessionRevision
    && left.absolutePath === right.absolutePath;
}

function identityMatches(value: number | string | null, observed: bigint | null): boolean {
  if (value === null || observed === null) return false;
  return BigInt(value) === observed;
}

function sameOsInteger(left: number | string | null, right: number | string): boolean {
  if (left === null) return false;
  try {
    return BigInt(left) === BigInt(right);
  } catch {
    return false;
  }
}

async function physicalEntryCandidate(state: SandboxState, configuredPath: string): Promise<string> {
  if (configuredPath === state.scenarioRoot) return configuredPath;
  const finalComponent = basename(configuredPath);
  if (configuredPath.endsWith("/") || finalComponent === "." || finalComponent === "..") {
    try {
      const physical = await realpath(configuredPath);
      if (!within(state.scenarioRoot, physical)) {
        throw Object.assign(new TypeError("Entry path resolves outside the scenario root"), { code: "SANDBOX_ESCAPE" });
      }
      return configuredPath;
    } catch (error) {
      const code = failureCode(error);
      if (code === "SANDBOX_ESCAPE") throw error;
      if (code !== "ENOENT" && code !== "ENOTDIR") return configuredPath;
    }
  }
  let ancestor = dirname(configuredPath);
  while (true) {
    try {
      const physical = await realpath(ancestor);
      if (!within(state.scenarioRoot, physical)) {
        throw Object.assign(new TypeError("Entry ancestor resolves outside the scenario root"), { code: "SANDBOX_ESCAPE" });
      }
      return configuredPath;
    } catch (error) {
      const code = failureCode(error);
      if (code === "SANDBOX_ESCAPE") throw error;
      if (code !== "ENOENT") return configuredPath;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      throw Object.assign(new TypeError("Entry path has no resolvable ancestor inside the scenario root"), { code: "SANDBOX_ESCAPE" });
    }
    ancestor = parent;
  }
}

async function followTargetWithin(state: SandboxState, configuredPath: string, snapshot: Awaited<ReturnType<typeof readEntrySnapshot>>): Promise<void> {
  if (snapshot.kind !== "symlink" || snapshot.linkTarget === null) return;
  const target = isAbsolute(snapshot.linkTarget)
    ? snapshot.linkTarget
    : `${dirname(configuredPath)}/${snapshot.linkTarget}`;
  await physicalEntryCandidate(state, target);
  try {
    const physical = await realpath(target);
    if (!within(state.scenarioRoot, physical)) {
      throw Object.assign(new TypeError("Followed entry resolves outside the scenario root"), { code: "SANDBOX_ESCAPE" });
    }
  } catch (error) {
    const code = failureCode(error);
    if (code === "SANDBOX_ESCAPE") throw error;
    if (code === "ENOENT" || code === "ELOOP" || code === "EACCES" || code === "EPERM" || code === "ENOTDIR") return;
    throw error;
  }
}

async function observedObjectPath(
  state: SandboxState,
  configuredPath: string,
  observed: Awaited<ReturnType<typeof readEntrySnapshot>>,
): Promise<string> {
  if (observed.kind === "symlink") {
    const parent = await realpath(dirname(configuredPath));
    const physical = join(parent, basename(configuredPath));
    if (!within(state.scenarioRoot, parent) || !within(state.scenarioRoot, physical)) {
      throw Object.assign(new TypeError("Entry path escapes the scenario root"), { code: "SANDBOX_ESCAPE" });
    }
    return physical;
  }
  const physical = await realpath(configuredPath);
  if (!within(state.scenarioRoot, physical)) {
    throw Object.assign(new TypeError("Entry path escapes the scenario root"), { code: "SANDBOX_ESCAPE" });
  }
  return physical;
}

function assertObservedRefType(ref: ObservedObjectRef, kind: EntryKind): void {
  if (ref.kind === "cli.file" && kind !== "regular") throw Object.assign(new TypeError("File reference no longer names a regular file"), { code: "STALE_REFERENCE" });
  if (ref.kind === "cli.directory" && kind !== "directory") throw Object.assign(new TypeError("Directory reference no longer names a directory"), { code: "STALE_REFERENCE" });
  if (ref.type !== kind) throw Object.assign(new TypeError("Observed reference type no longer matches"), { code: "STALE_REFERENCE" });
}

function validateObservedRef(
  state: SandboxState,
  before: SessionSnapshot,
  ref: ObservedObjectRef,
  current: Awaited<ReturnType<typeof readEntrySnapshot>>,
): void {
  const bound = state.boundRefs.get(ref.sourceRun);
  if (bound === undefined || !sameObservedRef(bound, ref)) {
    throw Object.assign(new TypeError("Observed reference was not issued by this sandbox"), { code: "binding_identity_missing" });
  }
  if (before.revision !== ref.sessionRevision) {
    throw Object.assign(new TypeError("Observed reference belongs to an older session revision"), { code: "STALE_REFERENCE" });
  }
  if (ref.identity.dev === null || ref.identity.ino === null) {
    throw Object.assign(new TypeError("Observed reference has no identity"), { code: "binding_identity_missing" });
  }
  if (current.errno !== null) throw Object.assign(new TypeError(`Observed reference lookup failed with ${current.errno}`), { code: current.errno });
  if (current.entryExists !== true || current.kind === null) {
    throw Object.assign(new TypeError("Observed reference no longer exists"), { code: "ENOENT" });
  }
  assertObservedRefType(ref, current.kind);
  if (!identityMatches(ref.identity.dev, current.dev) || !identityMatches(ref.identity.ino, current.ino)) {
    throw Object.assign(new TypeError("Observed reference identity changed"), { code: "STALE_REFERENCE" });
  }
}

function failedReceipt(
  call: SemanticCliCall,
  sessionBefore: SessionSnapshot,
  state: SandboxState,
  runId: string,
  code: string,
  message: string,
  stage: CliFailure["stage"],
  executorInvoked: boolean,
): SemanticCallReceipt {
  return Object.freeze({
    call,
    status: "failed",
    session_before: sessionBefore,
    session_after: snapshot(state, sessionOfCall(call)),
    execution: Object.freeze({
      status: "failed",
      runId,
      executorInvoked,
      error: { operation: call.operation, stage, code, message },
    }),
  });
}

async function executeGet(state: SandboxState, call: SemanticCwdGetCall, before: SessionSnapshot): Promise<SemanticCallReceipt> {
  const runId = randomUUID();
  if (before.grantedEffects.includes("filesystem.read") && before.grantedEffects.includes("process.exec")) {
    try {
      const physicalCwd = await realpath(before.cwd);
      if (!within(state.scenarioRoot, physicalCwd)) {
        return failedReceipt(call, before, state, runId, "SANDBOX_ESCAPE", "Session cwd resolves outside the scenario", "authorize", false);
      }
    } catch (error) {
      return failedReceipt(call, before, state, runId, failureCode(error), error instanceof Error ? error.message : String(error), "observe", false);
    }
  }
  const result = state.observation === undefined
    ? await createCliSession({ cwd: before.cwd, grantedEffects: observationEffects(before.grantedEffects) }).observe({ kind: "pwd" })
    : await state.observation({ session: call.parameters.session, cwd: before.cwd, grantedEffects: before.grantedEffects });
  const execution = result.ok && result.observation.kind === "pwd"
    ? { status: "succeeded" as const, runId, executorInvoked: true as const, observation: result.observation }
    : {
        status: "failed" as const,
        runId,
        executorInvoked: true as const,
        error: result.ok
          ? { operation: "cwd.get", stage: "observe" as const, code: "INVALID_OBSERVATION", message: "pwd returned a non-pwd observation" }
          : result.error,
      };
  return Object.freeze({
    call,
    status: execution.status,
    session_before: before,
    session_after: snapshot(state, call.parameters.session),
    execution: Object.freeze(execution),
  });
}

async function executeSet(state: SandboxState, call: SemanticCwdSetCall, before: SessionSnapshot): Promise<SemanticCallReceipt> {
  const runId = randomUUID();
  if (call.parameters.session.scenarioId !== call.parameters.directory.scenarioId || call.parameters.session.sessionId !== call.parameters.directory.sessionId) {
    return failedReceipt(call, before, state, runId, "EINVAL", "Directory reference must belong to the selected session and scenario", "validate", false);
  }
  const missing = (["filesystem.read", "process.exec", "session.write"] as const)
    .filter(effect => !before.grantedEffects.includes(effect));
  if (missing.length) {
    return failedReceipt(call, before, state, runId, "EFFECT_DENIED", `Missing CLI effect grant: ${missing.join(", ")}`, "authorize", false);
  }
  let target: Awaited<ReturnType<typeof resolveDirectory>>;
  try {
    target = await resolveDirectory(state, call.parameters.directory, true);
  } catch (error) {
    return failedReceipt(call, before, state, runId, failureCode(error), error instanceof Error ? error.message : String(error), "authorize", false);
  }
  const argv = Object.freeze(["-f", "-c", CD_COMMAND_SCRIPT, CD_ARGV0, call.parameters.directory.path] as const);
  try {
    const { stdout, stderr } = await execFileAsync(CD_EXECUTABLE, [...argv], { cwd: before.cwd, shell: false, encoding: "utf8" });
    const physicalTarget = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
    if (physicalTarget !== target.physicalPath) {
      return failedReceipt(call, before, state, runId, "TARGET_MISMATCH", "Fixed cd output differs from the independently resolved target", "observe", true);
    }
    state.sessions.set(before.id, Object.freeze({
      id: before.id,
      cwd: target.physicalPath,
      revision: before.revision + 1,
      grantedEffects: before.grantedEffects,
    }));
    const observation: CwdSetObservation = Object.freeze({
      kind: "cwd.set",
      configuredCwd: before.cwd,
      requestedPath: call.parameters.directory.path,
      targetConfiguredPath: target.configuredPath,
      targetPhysicalPath: target.physicalPath,
      executable: CD_EXECUTABLE,
      argv,
      stdout,
      stderr,
      exitCode: 0,
    });
    return Object.freeze({
      call,
      status: "succeeded",
      session_before: before,
      session_after: snapshot(state, call.parameters.session),
      execution: Object.freeze({ status: "succeeded", runId, executorInvoked: true, observation }),
    });
  } catch (error) {
    return failedReceipt(call, before, state, runId, failureCode(error), error instanceof Error ? error.message : String(error), "observe", true);
  }
}

async function executeList(state: SandboxState, call: SemanticDirectoryListCall, before: SessionSnapshot): Promise<SemanticCallReceipt> {
  const runId = randomUUID();
  if (call.parameters.session.scenarioId !== call.parameters.directory.scenarioId || call.parameters.session.sessionId !== call.parameters.directory.sessionId) {
    return failedReceipt(call, before, state, runId, "EINVAL", "Directory reference must belong to the selected session and scenario", "validate", false);
  }
  const missing = (["filesystem.read", "process.exec"] as const)
    .filter(effect => !before.grantedEffects.includes(effect));
  if (missing.length) {
    return failedReceipt(call, before, state, runId, "EFFECT_DENIED", `Missing CLI effect grant: ${missing.join(", ")}`, "authorize", false);
  }
  let target: Awaited<ReturnType<typeof resolveDirectory>>;
  try {
    target = await resolveDirectory(state, call.parameters.directory, true);
  } catch (error) {
    return failedReceipt(call, before, state, runId, failureCode(error), error instanceof Error ? error.message : String(error), "authorize", false);
  }
  const result = state.listingObserver === undefined
    ? await runDirectoryListHelper({ configuredDirectory: target.configuredPath, physicalDirectory: target.physicalPath })
    : await state.listingObserver({
        session: call.parameters.session,
        directory: call.parameters.directory,
        configuredDirectory: target.configuredPath,
        physicalDirectory: target.physicalPath,
        grantedEffects: before.grantedEffects,
      });
  const execution = result.ok
    ? Object.freeze({ status: "succeeded" as const, runId, executorInvoked: true as const, observation: result.observation })
    : Object.freeze({
        status: "failed" as const,
        runId,
        executorInvoked: true as const,
        error: result.error,
      });
  return Object.freeze({
    call,
    status: execution.status,
    session_before: before,
    session_after: snapshot(state, call.parameters.session),
    execution,
  });
}

function executePathResolve(state: SandboxState, call: SemanticPathResolveCall, before: SessionSnapshot): SemanticCallReceipt {
  const runId = randomUUID();
  if (!sameSession(state, before, call.parameters.base)) {
    return failedReceipt(call, before, state, runId, "EINVAL", "Path reference must belong to the selected session and scenario", "validate", false);
  }
  const interpreted = interpretCliPath(call.parameters.base.path, { kind: "path", path: call.parameters.input });
  const observation: PathResolveObservation = Object.freeze({
    kind: "path.resolve",
    base: call.parameters.base,
    input: call.parameters.input,
    normalized: interpreted.normalized,
    absolute: interpreted.absolute,
    parent: interpreted.parent,
    inputForm: interpreted.inputForm,
  });
  return Object.freeze({
    call,
    status: "succeeded",
    session_before: before,
    session_after: before,
    execution: Object.freeze({ status: "succeeded", runId, executorInvoked: true, observation }),
  });
}

function executePathRelative(state: SandboxState, call: SemanticPathRelativeCall, before: SessionSnapshot): SemanticCallReceipt {
  const runId = randomUUID();
  if (!sameSession(state, before, call.parameters.from) || !sameSession(state, before, call.parameters.to)) {
    return failedReceipt(call, before, state, runId, "EINVAL", "Both path references must belong to the selected session and scenario", "validate", false);
  }
  const observation: PathRelativeObservation = Object.freeze({
    kind: "path.relative",
    from: call.parameters.from,
    to: call.parameters.to,
    relative: lexicalRelativePath(call.parameters.from.path, call.parameters.to.path),
  });
  return Object.freeze({
    call,
    status: "succeeded",
    session_before: before,
    session_after: before,
    execution: Object.freeze({ status: "succeeded", runId, executorInvoked: true, observation }),
  });
}

function executePathParts(state: SandboxState, call: SemanticPathPartsCall, before: SessionSnapshot): SemanticCallReceipt {
  const runId = randomUUID();
  if (!sameSession(state, before, call.parameters.path)) {
    return failedReceipt(call, before, state, runId, "EINVAL", "Path reference must belong to the selected session and scenario", "validate", false);
  }
  const parts = pathParts(call.parameters.path.path);
  const observation: PathPartsCallObservation = Object.freeze({
    kind: "path.parts",
    path: call.parameters.path,
    absolute: parts.absolute,
    parent: parts.parent,
    name: parts.name,
    isRoot: parts.isRoot,
  });
  return Object.freeze({
    call,
    status: "succeeded",
    session_before: before,
    session_after: before,
    execution: Object.freeze({ status: "succeeded", runId, executorInvoked: true, observation }),
  });
}

async function executeEntryInspect(state: SandboxState, call: SemanticEntryInspectCall, before: SessionSnapshot): Promise<SemanticCallReceipt> {
  const runId = randomUUID();
  const ref = call.parameters.ref;
  if (!sameSession(state, before, ref)) {
    return failedReceipt(call, before, state, runId, "EINVAL", "Inspect reference must belong to the selected session and scenario", "validate", false);
  }
  const missing = (["filesystem.read", "process.exec"] as const)
    .filter(effect => !before.grantedEffects.includes(effect));
  if (missing.length) {
    return failedReceipt(call, before, state, runId, "EFFECT_DENIED", `Missing CLI effect grant: ${missing.join(", ")}`, "authorize", false);
  }
  if (ref.kind === "cli.directory" && !("absolutePath" in ref)) {
    return failedReceipt(call, before, state, runId, "binding_identity_missing", "Legacy directory references need observed identity for entry.inspect", "authorize", false);
  }

  const referencedPath = ref.kind === "cli.path" ? ref.path : ref.absolutePath;
  let configuredPath: string;
  let preflight: Awaited<ReturnType<typeof readEntrySnapshot>>;
  try {
    configuredPath = await physicalEntryCandidate(state, referencedPath);
    preflight = await readEntrySnapshot(configuredPath, false);
    if (ref.kind !== "cli.path") {
      validateObservedRef(state, before, ref, preflight);
    }
    if (call.parameters.followSymlinks) await followTargetWithin(state, configuredPath, preflight);
  } catch (error) {
    return failedReceipt(call, before, state, runId, failureCode(error), error instanceof Error ? error.message : String(error), "authorize", false);
  }

  const result = await runEntryInspectHelper({
    absolutePath: configuredPath,
    followSymlinks: call.parameters.followSymlinks,
  });
  if (!result.ok) return failedReceipt(call, before, state, runId, result.error.code, result.error.message, "observe", true);
  if (result.observation.snapshot.errno !== null && result.observation.snapshot.errno !== "ENOENT") {
    return failedReceipt(call, before, state, runId, result.observation.snapshot.errno, `Entry inspection failed with ${result.observation.snapshot.errno}`, "observe", true);
  }
  if (ref.kind !== "cli.path" && result.observation.snapshot.errno === "ENOENT") {
    return failedReceipt(call, before, state, runId, "ENOENT", "Observed reference target resolution failed", "observe", true);
  }
  const observation: EntryInspectObservation = Object.freeze({
    kind: "entry.inspect",
    ref,
    followSymlinks: call.parameters.followSymlinks,
    configuredPath,
    executable: result.observation.executable,
    helperPath: result.observation.helperPath,
    argv: result.observation.argv,
    stdin: result.observation.stdin,
    stdout: result.observation.stdout,
    stderr: result.observation.stderr,
    exitCode: 0,
    snapshot: result.observation.snapshot,
  });
  return Object.freeze({
    call,
    status: "succeeded",
    session_before: before,
    session_after: before,
    execution: Object.freeze({ status: "succeeded", runId, executorInvoked: true, observation }),
  });
}

async function executeFileRead(state: SandboxState, call: SemanticFileReadCall, before: SessionSnapshot): Promise<SemanticCallReceipt> {
  const runId = randomUUID();
  const ref = call.parameters.ref;
  if (!sameSession(state, before, ref)) {
    return failedReceipt(call, before, state, runId, "EINVAL", "File reference must belong to the selected session and scenario", "validate", false);
  }
  const missing = (["filesystem.read"] as const)
    .filter(effect => !before.grantedEffects.includes(effect));
  if (missing.length) {
    return failedReceipt(call, before, state, runId, "EFFECT_DENIED", `Missing CLI effect grant: ${missing.join(", ")}`, "authorize", false);
  }
  if (ref.kind !== "cli.file" || ref.type !== "regular") {
    return failedReceipt(call, before, state, runId, "NOT_REGULAR_FILE", "file.read requires a cli.file reference to a regular file", "authorize", false);
  }

  let configuredPath: string;
  let preflight: Awaited<ReturnType<typeof readEntrySnapshot>>;
  try {
    configuredPath = await physicalEntryCandidate(state, ref.absolutePath);
    preflight = await readEntrySnapshot(configuredPath, false);
    validateObservedRef(state, before, ref, preflight);
  } catch (error) {
    return failedReceipt(call, before, state, runId, failureCode(error), error instanceof Error ? error.message : String(error), "authorize", false);
  }

  const result = state.fileReadIo === undefined
    ? await readFileRange(configuredPath, call.parameters.offset, call.parameters.length)
    : await readFileRange(configuredPath, call.parameters.offset, call.parameters.length, state.fileReadIo);
  if (!result.ok) {
    return failedReceipt(call, before, state, runId, result.error.code, result.error.message, result.error.stage, result.error.stage === "observe");
  }
  if (!sameOsInteger(ref.identity.dev, result.observation.identity.dev)
    || !sameOsInteger(ref.identity.ino, result.observation.identity.ino)) {
    return failedReceipt(call, before, state, runId, "STALE_REFERENCE", "Opened file identity no longer matches the trusted reference", "observe", true);
  }

  const observation: FileReadObservation = Object.freeze({
    kind: "file.read",
    ref,
    absolutePath: configuredPath,
    offset: call.parameters.offset,
    length: call.parameters.length,
    size: result.observation.size,
    bytes: result.observation.bytes,
    bytesRead: result.observation.bytesRead,
    eof: result.observation.eof,
    identity: Object.freeze({
      dev: result.observation.identity.dev as OsInteger,
      ino: result.observation.identity.ino as OsInteger,
    }),
  });
  return Object.freeze({
    call,
    status: "succeeded",
    session_before: before,
    session_after: before,
    execution: Object.freeze({ status: "succeeded", runId, executorInvoked: true, observation }),
  });
}

export async function executeSemanticCliCall(
  sandbox: CliFilesystemSandbox,
  value: unknown,
): Promise<SemanticCallReceipt> {
  if (!sandbox || typeof sandbox !== "object" || !(sandbox instanceof Object)
    || typeof sandbox.getSession !== "function" || typeof sandbox.scenarioRoot !== "string") {
    throw new TypeError("A filesystem sandbox is required");
  }
  return sandbox.execute(value);
}

async function bindObservedObject(
  state: SandboxState,
  sessionRef: SessionRef,
  path: string,
  expected: "entry" | "file" | "directory",
): Promise<ObservedObjectRef> {
  if (!state.active) throw new Error("Filesystem sandbox is closed");
  const session = snapshot(state, sessionRef);
  if (!session.grantedEffects.includes("filesystem.read")) {
    throw Object.assign(new TypeError("Binding an observed object needs filesystem.read"), { code: "EFFECT_DENIED" });
  }
  const configuredPath = isAbsolute(path)
    ? nonEmpty(path, "entry path")
    : `${session.cwd}/${relativePath(path, "entry path", true)}`;
  const candidate = await physicalEntryCandidate(state, configuredPath);
  const observed = await readEntrySnapshot(candidate, false);
  if (observed.errno !== null) throw Object.assign(new TypeError(`Entry binding failed with ${observed.errno}`), { code: observed.errno });
  if (observed.entryExists !== true || observed.kind === null || observed.dev === null || observed.ino === null) {
    throw Object.assign(new TypeError("Entry binding needs an existing entry with identity"), { code: "binding_identity_missing" });
  }
  if (expected === "file" && observed.kind !== "regular") throw Object.assign(new TypeError("File reference must name a regular file"), { code: "NOT_REGULAR_FILE" });
  if (expected === "directory" && observed.kind !== "directory") throw Object.assign(new TypeError("Directory reference must name a directory"), { code: "NOT_DIRECTORY" });
  const absolutePath = await observedObjectPath(state, candidate, observed);
  const sourceRun = randomUUID();
  const ref: ObservedObjectRef = Object.freeze({
    kind: expected === "file" ? "cli.file" : expected === "directory" ? "cli.directory" : "cli.entry",
    scenarioId: state.scenarioId,
    sessionId: session.id,
    type: observed.kind,
    identity: Object.freeze({
      dev: observed.dev <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(observed.dev) : observed.dev.toString(),
      ino: observed.ino <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(observed.ino) : observed.ino.toString(),
    }),
    sourceRun,
    sessionRevision: session.revision,
    absolutePath,
  });
  state.boundRefs.set(sourceRun, ref);
  return ref;
}

export async function createCliFilesystemSandbox(options: {
  readonly root: string;
  readonly recipe: SandboxRecipe;
  readonly ownerGrantedEffects: readonly FilesystemOwnerGrant[];
  readonly observation?: CliSandboxObservation;
  readonly listingObserver?: DirectoryListingObserver;
  readonly fileReadIo?: FileReadIo;
}): Promise<CliFilesystemSandbox> {
  const input = expectRecord(options, "sandbox options");
  const allowed = [
    "root",
    "recipe",
    "ownerGrantedEffects",
    ...(Object.hasOwn(input, "observation") ? ["observation"] : []),
    ...(Object.hasOwn(input, "listingObserver") ? ["listingObserver"] : []),
    ...(Object.hasOwn(input, "fileReadIo") ? ["fileReadIo"] : []),
  ];
  exactKeys(input, allowed, "sandbox options");
  if (Object.hasOwn(input, "observation") && typeof input.observation !== "function") throw new TypeError("sandbox observation must be a function");
  if (Object.hasOwn(input, "listingObserver") && typeof input.listingObserver !== "function") throw new TypeError("sandbox listingObserver must be a function");
  if (Object.hasOwn(input, "fileReadIo")) {
    const io = input.fileReadIo;
    if (!isRecord(io) || typeof io.lstat !== "function" || typeof io.open !== "function") {
      throw new TypeError("sandbox fileReadIo must provide lstat and open functions");
    }
  }
  const rootValue = nonEmpty(input.root, "sandbox root");
  if (!isAbsolute(rootValue)) throw new TypeError("sandbox root must be absolute");
  ownerGrants(input.ownerGrantedEffects);
  const recipe = readRecipe(input.recipe);
  const physicalRoot = await realpath(rootValue);
  const rootAttributes = await lstat(physicalRoot);
  if (!rootAttributes.isDirectory()) throw new TypeError("sandbox root must be a directory");
  const scenarioRoot = join(physicalRoot, recipe.scenarioId);
  if (!within(physicalRoot, scenarioRoot)) throw new TypeError("scenario escapes sandbox root");
  await mkdir(scenarioRoot);
  const physicalScenarioRoot = await realpath(scenarioRoot);
  const state: SandboxState = {
    root: physicalRoot,
    scenarioId: recipe.scenarioId,
    scenarioRoot: physicalScenarioRoot,
    sessions: new Map(recipe.sessions.map(session => [session.id, Object.freeze({
      id: session.id,
      cwd: join(physicalScenarioRoot, session.cwd),
      revision: 0,
      grantedEffects: Object.freeze([...session.grantedEffects]),
    })])),
    grants: Object.freeze(recipe.sessions.flatMap(session => session.grantedEffects)),
    boundRefs: new Map(),
    ...(input.observation === undefined ? {} : { observation: input.observation as CliSandboxObservation }),
    ...(input.listingObserver === undefined ? {} : { listingObserver: input.listingObserver as DirectoryListingObserver }),
    ...(input.fileReadIo === undefined ? {} : { fileReadIo: input.fileReadIo as FileReadIo }),
    active: true,
  };
  try {
    const directories = recipe.entries.filter(entry => entry.kind === "directory")
      .sort((left, right) => left.path.split("/").length - right.path.split("/").length);
    for (const entry of directories) {
      const path = resolve(state.scenarioRoot, entry.path);
      if (!within(state.scenarioRoot, path)) throw new TypeError("Sandbox entry escapes the scenario root");
      await mkdir(path);
    }
    for (const entry of recipe.entries.filter(value => value.kind === "file")) {
      const path = resolve(state.scenarioRoot, entry.path);
      if (!within(state.scenarioRoot, path)) throw new TypeError("Sandbox entry escapes the scenario root");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, entry.contents, { flag: "wx" });
    }
  } catch (error) {
    await rm(state.scenarioRoot, { recursive: true, force: true });
    throw error;
  }

  return Object.freeze({
    scenarioId: state.scenarioId,
    scenarioRoot: state.scenarioRoot,
    bindSession(id: string): SessionRef {
      if (!state.active) throw new Error("Filesystem sandbox is closed");
      const sessionId = nonEmpty(id, "session id");
      if (!state.sessions.has(sessionId)) throw new TypeError(`Unknown sandbox session: ${sessionId}`);
      return Object.freeze({ kind: "cli.session", scenarioId: state.scenarioId, sessionId });
    },
    getSession(ref: SessionRef): SessionSnapshot {
      return snapshot(state, ref);
    },
    bindPath(sessionRef: SessionRef, path: string): PathRef {
      const session = snapshot(state, sessionRef);
      const value = nonEmpty(path, "path");
      if (!isAbsolute(value) || value.includes("\0")) throw new TypeError("path reference must be an explicit absolute path without NUL");
      return Object.freeze({
        kind: "cli.path",
        scenarioId: state.scenarioId,
        sessionId: session.id,
        path: value,
      });
    },
    bindEntry(sessionRef: SessionRef, path: string): Promise<ObservedObjectRef> {
      return bindObservedObject(state, sessionRef, path, "entry");
    },
    bindFile(sessionRef: SessionRef, path: string): Promise<ObservedObjectRef> {
      return bindObservedObject(state, sessionRef, path, "file");
    },
    bindDirectoryObject(sessionRef: SessionRef, path: string): Promise<ObservedObjectRef> {
      return bindObservedObject(state, sessionRef, path, "directory");
    },
    async bindDirectory(sessionRef: SessionRef, path: string): Promise<DirectoryRef> {
      const session = snapshot(state, sessionRef);
      const relativeValue = relativePath(path, "directory path", true);
      const ref = Object.freeze({
        kind: "cli.directory" as const,
        scenarioId: state.scenarioId,
        sessionId: session.id,
        path: relativeValue,
      });
      await resolveDirectory(state, ref);
      return ref;
    },
    async validateObservedObject(ref: ObservedObjectRef): Promise<void> {
      if (!state.active) throw new Error("Filesystem sandbox is closed");
      const value = readObservedObjectRef(ref);
      const before = snapshot(state, sessionOfRef(value));
      const configuredPath = await physicalEntryCandidate(state, value.absolutePath);
      const current = await readEntrySnapshot(configuredPath, false);
      validateObservedRef(state, before, value, current);
    },
    resolveDirectory(ref: DirectoryRef) {
      return resolveDirectory(state, ref);
    },
    async execute(value: unknown): Promise<SemanticCallReceipt> {
      if (!state.active) throw new Error("Filesystem sandbox is closed");
      const call = readSemanticCliCall(value);
      const before = snapshot(state, sessionOfCall(call));
      if (call.operation === "cwd.get") return executeGet(state, call, before);
      if (call.operation === "cwd.set") return executeSet(state, call, before);
      if (call.operation === "directory.list") return executeList(state, call, before);
      if (call.operation === "path.resolve") return executePathResolve(state, call, before);
      if (call.operation === "path.relative") return executePathRelative(state, call, before);
      if (call.operation === "path.parts") return executePathParts(state, call, before);
      if (call.operation === "file.read") return executeFileRead(state, call, before);
      return executeEntryInspect(state, call, before);
    },
    async cleanup() {
      if (!state.active) return Object.freeze({ removed: false, scenarioRoot: state.scenarioRoot });
      state.active = false;
      await rm(state.scenarioRoot, { recursive: true, force: true });
      return Object.freeze({ removed: true, scenarioRoot: state.scenarioRoot });
    },
  });
}
