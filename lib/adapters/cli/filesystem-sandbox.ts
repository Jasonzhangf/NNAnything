import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { createCliSession } from "../../cli.js";
import { expectRecord } from "../../core/schema.js";
import {
  runDirectoryListHelper,
  type DirectoryListObservation,
  type DirectoryListingResult,
} from "./directory-listing.js";
import type { CliEffect as ObservationEffect, CliFailure, CliResult, PwdObservation } from "./observation.js";

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

export type SemanticCliCall = SemanticCwdGetCall | SemanticCwdSetCall | SemanticDirectoryListCall;

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
        observation: PwdObservation | CwdSetObservation | DirectoryListObservation;
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
  bindDirectory(session: SessionRef, path: string): Promise<DirectoryRef>;
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
  throw new TypeError("Only cwd.get, cwd.set and directory.list are supported");
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
    session_after: snapshot(state, { kind: "cli.session", scenarioId: call.parameters.session.scenarioId, sessionId: call.parameters.session.sessionId }),
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

export async function createCliFilesystemSandbox(options: {
  readonly root: string;
  readonly recipe: SandboxRecipe;
  readonly ownerGrantedEffects: readonly FilesystemOwnerGrant[];
  readonly observation?: CliSandboxObservation;
  readonly listingObserver?: DirectoryListingObserver;
}): Promise<CliFilesystemSandbox> {
  const input = expectRecord(options, "sandbox options");
  const allowed = [
    "root",
    "recipe",
    "ownerGrantedEffects",
    ...(Object.hasOwn(input, "observation") ? ["observation"] : []),
    ...(Object.hasOwn(input, "listingObserver") ? ["listingObserver"] : []),
  ];
  exactKeys(input, allowed, "sandbox options");
  if (Object.hasOwn(input, "observation") && typeof input.observation !== "function") throw new TypeError("sandbox observation must be a function");
  if (Object.hasOwn(input, "listingObserver") && typeof input.listingObserver !== "function") throw new TypeError("sandbox listingObserver must be a function");
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
    ...(input.observation === undefined ? {} : { observation: input.observation as CliSandboxObservation }),
    ...(input.listingObserver === undefined ? {} : { listingObserver: input.listingObserver as DirectoryListingObserver }),
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
    resolveDirectory(ref: DirectoryRef) {
      return resolveDirectory(state, ref);
    },
    async execute(value: unknown): Promise<SemanticCallReceipt> {
      if (!state.active) throw new Error("Filesystem sandbox is closed");
      const call = readSemanticCliCall(value);
      const before = snapshot(state, call.parameters.session);
      if (call.operation === "cwd.get") return executeGet(state, call, before);
      if (call.operation === "cwd.set") return executeSet(state, call, before);
      return executeList(state, call, before);
    },
    async cleanup() {
      if (!state.active) return Object.freeze({ removed: false, scenarioRoot: state.scenarioRoot });
      state.active = false;
      await rm(state.scenarioRoot, { recursive: true, force: true });
      return Object.freeze({ removed: true, scenarioRoot: state.scenarioRoot });
    },
  });
}
