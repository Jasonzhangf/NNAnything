import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rmdir, symlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getSystemErrorName } from "node:util";
import { expectRecord } from "../../core/schema.js";
import {
  ENTRY_KINDS,
  readEntrySnapshot,
  toObservedEntrySnapshot,
  type EntryKind,
  type ObservedEntrySnapshot,
  type OsInteger,
} from "./entry-inspection.js";

export const ENTRY_MUTATION_OPERATIONS = Object.freeze([
  "directory.create",
  "file.create",
  "link.create",
  "file.link",
  "entry.move",
  "entry.remove",
] as const);

export type EntryMutationOperation = typeof ENTRY_MUTATION_OPERATIONS[number];

export type TargetEntrySlotInput = Readonly<{
  parentPhysicalPath: string;
  parentExpectedIdentity: Readonly<{ dev: OsInteger; ino: OsInteger }>;
  name: string;
}>;

export type BoundSourceEntryInput = Readonly<{
  physicalPath: string;
  expectedType: EntryKind;
  expectedIdentity: Readonly<{ dev: OsInteger; ino: OsInteger }>;
}>;

export type EntryMutationRequest =
  | Readonly<{
      operation: "directory.create" | "file.create";
      sandboxRoot: string;
      target: TargetEntrySlotInput;
    }>
  | Readonly<{
      operation: "link.create";
      sandboxRoot: string;
      target: TargetEntrySlotInput;
      targetText: string;
    }>
  | Readonly<{
      operation: "file.link";
      sandboxRoot: string;
      source: BoundSourceEntryInput;
      destination: TargetEntrySlotInput;
    }>
  | Readonly<{
      operation: "entry.move";
      sandboxRoot: string;
      source: BoundSourceEntryInput;
      destination: TargetEntrySlotInput;
    }>
  | Readonly<{
      operation: "entry.remove";
      sandboxRoot: string;
      target: BoundSourceEntryInput;
    }>;

export type EntryMutationStateSnapshot = Readonly<{
  parent: ObservedEntrySnapshot;
  source: ObservedEntrySnapshot | null;
  destination: ObservedEntrySnapshot | null;
  resolvedSourcePath: string | null;
  resolvedDestinationPath: string;
}>;

export type EntryMutationPreconditionDecision =
  | Readonly<{ outcome: "eligible"; executorInvoked: true }>
  | Readonly<{ outcome: "rejected"; code: string; message: string; executorInvoked: false }>
  | Readonly<{ outcome: "noop_satisfied"; message: string; executorInvoked: false }>;

export type NativeRenameReceipt = Readonly<{
  executable: string;
  argv: readonly [string, string, string];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  errno: string | null;
  errnoNumber: number | null;
}>;

export type EntryMutationExecutionReceipt =
  | Readonly<{
      outcome: "succeeded";
      operation: EntryMutationOperation;
      executorInvoked: true;
      destinationPhysicalPath: string;
      sourcePhysicalPath: string | null;
      postObservation: ObservedEntrySnapshot;
      postSourceObservation: ObservedEntrySnapshot | null;
      native: NativeRenameReceipt | null;
      message: null;
    }>
  | Readonly<{
      outcome: "failed";
      operation: EntryMutationOperation;
      executorInvoked: boolean;
      errno: string;
      errnoNumber: number | null;
      destinationPhysicalPath: string | null;
      sourcePhysicalPath: string | null;
      postObservation: ObservedEntrySnapshot | null;
      postSourceObservation: ObservedEntrySnapshot | null;
      native: NativeRenameReceipt | null;
      message: string;
    }>
  | Readonly<{
      outcome: "rejected";
      operation: EntryMutationOperation;
      executorInvoked: false;
      code: string;
      destinationPhysicalPath: string | null;
      sourcePhysicalPath: string | null;
      postObservation: null;
      postSourceObservation: null;
      native: null;
      message: string;
    }>
  | Readonly<{
      outcome: "noop_satisfied";
      operation: EntryMutationOperation;
      executorInvoked: false;
      destinationPhysicalPath: string;
      sourcePhysicalPath: string | null;
      postObservation: null;
      postSourceObservation: null;
      native: null;
      message: string;
    }>;

export type EntryMutationHelperProcess = Readonly<{
  executable: string;
  helperPath: string;
  argv: readonly string[];
  stdin: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}>;

export type EntryMutationHelperResult = Readonly<{
  receipt: EntryMutationExecutionReceipt;
  helper: EntryMutationHelperProcess;
}>;

type MutationPaths = Readonly<{
  sandboxRoot: string;
  parentPath: string | null;
  destinationPath: string;
  sourcePath: string | null;
}>;

class GuardError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function stringWithoutNul(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new TypeError(`${label} must be a string without NUL`);
  }
  return value;
}

function nonEmpty(value: unknown, label: string): string {
  const text = stringWithoutNul(value, label);
  if (text.length === 0) throw new TypeError(`${label} must not be empty`);
  return text;
}

function absolutePath(value: unknown, label: string): string {
  const path = nonEmpty(value, label);
  if (!isAbsolute(path)) throw new TypeError(`${label} must be an absolute path`);
  return path;
}

function osInteger(value: unknown, label: string): OsInteger {
  if (value === null) return null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer`);
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
  throw new TypeError(`${label} must be a safe integer, decimal string or null`);
}

function entryKind(value: unknown, label: string): EntryKind {
  if (typeof value !== "string" || !ENTRY_KINDS.includes(value as EntryKind)) {
    throw new TypeError(`${label} is not a supported entry kind`);
  }
  return value as EntryKind;
}

function identity(value: unknown, label: string): Readonly<{ dev: OsInteger; ino: OsInteger }> {
  const input = expectRecord(value, label);
  exactKeys(input, ["dev", "ino"], label);
  return Object.freeze({
    dev: osInteger(input.dev, `${label}.dev`),
    ino: osInteger(input.ino, `${label}.ino`),
  });
}

function readTarget(value: unknown, label: string): TargetEntrySlotInput {
  const target = expectRecord(value, label);
  exactKeys(target, ["parentPhysicalPath", "parentExpectedIdentity", "name"], label);
  return Object.freeze({
    parentPhysicalPath: absolutePath(target.parentPhysicalPath, `${label}.parentPhysicalPath`),
    parentExpectedIdentity: identity(target.parentExpectedIdentity, `${label}.parentExpectedIdentity`),
    name: nonEmpty(target.name, `${label}.name`),
  });
}

function readSource(value: unknown, label: string): BoundSourceEntryInput {
  const source = expectRecord(value, label);
  exactKeys(source, ["physicalPath", "expectedType", "expectedIdentity"], label);
  return Object.freeze({
    physicalPath: absolutePath(source.physicalPath, `${label}.physicalPath`),
    expectedType: entryKind(source.expectedType, `${label}.expectedType`),
    expectedIdentity: identity(source.expectedIdentity, `${label}.expectedIdentity`),
  });
}

export function readEntryMutationRequest(value: unknown): EntryMutationRequest {
  const request = expectRecord(value, "entry mutation request");
  if (typeof request.operation !== "string"
    || !ENTRY_MUTATION_OPERATIONS.includes(request.operation as EntryMutationOperation)) {
    throw new TypeError("entry mutation request operation is not supported");
  }
  const operation = request.operation as EntryMutationOperation;
  if (operation === "directory.create" || operation === "file.create") {
    exactKeys(request, ["operation", "sandboxRoot", "target"], "entry mutation request");
    return Object.freeze({
      operation,
      sandboxRoot: absolutePath(request.sandboxRoot, "entry mutation request sandboxRoot"),
      target: readTarget(request.target, "entry mutation request target"),
    });
  }
  if (operation === "link.create") {
    exactKeys(request, ["operation", "sandboxRoot", "target", "targetText"], "entry mutation request");
    return Object.freeze({
      operation,
      sandboxRoot: absolutePath(request.sandboxRoot, "entry mutation request sandboxRoot"),
      target: readTarget(request.target, "entry mutation request target"),
      targetText: stringWithoutNul(request.targetText, "entry mutation request targetText"),
    });
  }
  if (operation === "file.link" || operation === "entry.move") {
    exactKeys(request, ["operation", "sandboxRoot", "source", "destination"], "entry mutation request");
    return Object.freeze({
      operation,
      sandboxRoot: absolutePath(request.sandboxRoot, "entry mutation request sandboxRoot"),
      source: readSource(request.source, "entry mutation request source"),
      destination: readTarget(request.destination, "entry mutation request destination"),
    });
  }
  exactKeys(request, ["operation", "sandboxRoot", "target"], "entry mutation request");
  return Object.freeze({
    operation: "entry.remove",
    sandboxRoot: absolutePath(request.sandboxRoot, "entry mutation request sandboxRoot"),
    target: readSource(request.target, "entry mutation request target"),
  });
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function validEntryName(name: string): boolean {
  return name !== "." && name !== ".." && !name.includes("/");
}

function sourcePathOf(request: EntryMutationRequest): string | null {
  if (request.operation === "file.link" || request.operation === "entry.move") {
    return resolve(request.source.physicalPath);
  }
  if (request.operation === "entry.remove") return resolve(request.target.physicalPath);
  return null;
}

function destinationSlot(request: EntryMutationRequest): TargetEntrySlotInput {
  if (request.operation === "file.link" || request.operation === "entry.move") {
    return request.destination;
  }
  if (request.operation === "entry.remove") {
    throw new TypeError("entry.remove has no target destination slot");
  }
  return request.target;
}

function resolveMutationPaths(request: EntryMutationRequest): MutationPaths {
  const sandboxRoot = resolve(request.sandboxRoot);
  if (request.operation === "entry.remove") {
    const destinationPath = resolve(request.target.physicalPath);
    if (!within(sandboxRoot, destinationPath) || destinationPath === sandboxRoot) {
      throw new GuardError("SANDBOX_BOUNDARY_VIOLATION", "The target entry is outside the sandbox root");
    }
    return Object.freeze({
      sandboxRoot,
      parentPath: null,
      destinationPath,
      sourcePath: destinationPath,
    });
  }

  const destination = destinationSlot(request);
  if (!validEntryName(destination.name)) {
    throw new GuardError(
      "INVALID_ENTRY_NAME",
      "The target name must be one non-special path segment without a slash",
    );
  }
  const parentPath = resolve(destination.parentPhysicalPath);
  const destinationPath = join(parentPath, destination.name);
  if (!within(sandboxRoot, parentPath)
    || !within(sandboxRoot, destinationPath)
    || destinationPath === sandboxRoot) {
    throw new GuardError("SANDBOX_BOUNDARY_VIOLATION", "The target entry is outside the sandbox root");
  }
  const sourcePath = sourcePathOf(request);
  if (sourcePath !== null
    && (!within(sandboxRoot, sourcePath) || sourcePath === sandboxRoot)) {
    throw new GuardError("SANDBOX_BOUNDARY_VIOLATION", "The source entry is outside the sandbox root");
  }
  return Object.freeze({ sandboxRoot, parentPath, destinationPath, sourcePath });
}

function identityMatches(
  expected: Readonly<{ dev: OsInteger; ino: OsInteger }>,
  observed: ObservedEntrySnapshot,
): boolean {
  if (expected.dev === null || expected.ino === null || observed.dev === null || observed.ino === null) return false;
  return String(expected.dev) === String(observed.dev) && String(expected.ino) === String(observed.ino);
}

function parentRejection(
  request: EntryMutationRequest,
  parent: ObservedEntrySnapshot,
): EntryMutationPreconditionDecision | null {
  if (request.operation === "entry.remove") return null;
  if (parent.entryExists !== true) {
    return Object.freeze({
      outcome: "rejected",
      code: "STALE_REFERENCE",
      message: "The target parent no longer exists",
      executorInvoked: false,
    });
  }
  if (parent.kind !== "directory") {
    return Object.freeze({
      outcome: "rejected",
      code: "ENOTDIR",
      message: "The target parent is not a directory",
      executorInvoked: false,
    });
  }
  if (!identityMatches(destinationSlot(request).parentExpectedIdentity, parent)) {
    return Object.freeze({
      outcome: "rejected",
      code: "STALE_REFERENCE",
      message: "The target parent identity changed",
      executorInvoked: false,
    });
  }
  return null;
}

function sourceRejection(
  expectedType: EntryKind,
  expectedIdentity: Readonly<{ dev: OsInteger; ino: OsInteger }>,
  source: ObservedEntrySnapshot,
): EntryMutationPreconditionDecision | null {
  if (source.entryExists !== true || source.kind !== expectedType || !identityMatches(expectedIdentity, source)) {
    return Object.freeze({
      outcome: "rejected",
      code: "STALE_REFERENCE",
      message: "The source entry type or identity changed",
      executorInvoked: false,
    });
  }
  return null;
}

function nlinkAtLeastTwo(value: OsInteger): boolean {
  if (value === null) return false;
  try {
    return BigInt(value) >= 2n;
  } catch {
    return false;
  }
}

export function evaluateEntryMutationPrecondition(
  requestValue: EntryMutationRequest,
  state: EntryMutationStateSnapshot,
): EntryMutationPreconditionDecision {
  const request = readEntryMutationRequest(requestValue);
  let paths: MutationPaths;
  try {
    paths = resolveMutationPaths(request);
  } catch (error) {
    if (error instanceof GuardError) {
      return Object.freeze({
        outcome: "rejected",
        code: error.code,
        message: error.message,
        executorInvoked: false,
      });
    }
    throw error;
  }

  const parentDecision = parentRejection(request, state.parent);
  if (parentDecision !== null) return parentDecision;

  if (request.operation === "file.link" || request.operation === "entry.move") {
    if (state.source === null) {
      return Object.freeze({
        outcome: "rejected",
        code: "STALE_REFERENCE",
        message: "The source snapshot is missing",
        executorInvoked: false,
      });
    }
    const sourceDecision = sourceRejection(request.source.expectedType, request.source.expectedIdentity, state.source);
    if (sourceDecision !== null) return sourceDecision;
  }
  if (request.operation === "entry.remove") {
    if (state.source === null) {
      return Object.freeze({
        outcome: "rejected",
        code: "STALE_REFERENCE",
        message: "The target snapshot is missing",
        executorInvoked: false,
      });
    }
    const targetDecision = sourceRejection(request.target.expectedType, request.target.expectedIdentity, state.source);
    if (targetDecision !== null) return targetDecision;
  }

  if (request.operation === "file.link") {
    if (paths.sourcePath === paths.destinationPath) {
      return Object.freeze({
        outcome: "rejected",
        code: "SAME_ENTRY_CONFLICT",
        message: "file.link must create a new directory entry and cannot target the source entry itself",
        executorInvoked: false,
      });
    }
    if (request.source.expectedType !== "regular") {
      return Object.freeze({
        outcome: "rejected",
        code: "INVALID_HARDLINK_SOURCE_TYPE",
        message: "Hard links require a regular-file source",
        executorInvoked: false,
      });
    }
    if (state.destination?.entryExists === true
      && state.destination.kind === "regular"
      && identityMatches(request.source.expectedIdentity, state.destination)
      && nlinkAtLeastTwo(state.destination.nlink)) {
      return Object.freeze({
        outcome: "noop_satisfied",
        message: "A distinct destination name already references the source inode",
        executorInvoked: false,
      });
    }
    return Object.freeze({ outcome: "eligible", executorInvoked: true });
  }

  if (request.operation === "entry.move") {
    if (paths.sourcePath === paths.destinationPath) {
      return Object.freeze({
        outcome: "noop_satisfied",
        message: "The source already occupies the requested destination path",
        executorInvoked: false,
      });
    }
    if (state.destination?.entryExists === true) {
      return Object.freeze({
        outcome: "rejected",
        code: "DESTINATION_ALREADY_EXISTS",
        message: "entry.move does not replace an existing destination",
        executorInvoked: false,
      });
    }
  }

  return Object.freeze({ outcome: "eligible", executorInvoked: true });
}

function errorCode(error: unknown): string {
  if (error !== null && (typeof error === "object" || typeof error === "function") && "code" in error) {
    const code = String(error.code);
    if (code && code !== "undefined") return code;
  }
  return "EIO";
}

function errorNumber(error: unknown): number | null {
  if (error !== null && (typeof error === "object" || typeof error === "function") && "errno" in error
    && typeof error.errno === "number") {
    return error.errno;
  }
  return null;
}

function rejectedReceipt(
  request: EntryMutationRequest,
  paths: MutationPaths,
  code: string,
  message: string,
): EntryMutationExecutionReceipt {
  return Object.freeze({
    outcome: "rejected",
    operation: request.operation,
    executorInvoked: false,
    code,
    destinationPhysicalPath: paths.destinationPath,
    sourcePhysicalPath: paths.sourcePath,
    postObservation: null,
    postSourceObservation: null,
    native: null,
    message,
  });
}

function failedReceipt(
  request: EntryMutationRequest,
  paths: MutationPaths | null,
  errno: string,
  errnoNumber: number | null,
  message: string,
  native: NativeRenameReceipt | null,
): EntryMutationExecutionReceipt {
  return Object.freeze({
    outcome: "failed",
    operation: request.operation,
    executorInvoked: true,
    errno,
    errnoNumber,
    destinationPhysicalPath: paths?.destinationPath ?? null,
    sourcePhysicalPath: paths?.sourcePath ?? null,
    postObservation: null,
    postSourceObservation: null,
    native,
    message,
  });
}

function noopReceipt(
  request: EntryMutationRequest,
  paths: MutationPaths,
  message: string,
): EntryMutationExecutionReceipt {
  return Object.freeze({
    outcome: "noop_satisfied",
    operation: request.operation,
    executorInvoked: false,
    destinationPhysicalPath: paths.destinationPath,
    sourcePhysicalPath: paths.sourcePath,
    postObservation: null,
    postSourceObservation: null,
    native: null,
    message,
  });
}

function exitCodeFromError(error: unknown): number | null {
  if (error !== null && (typeof error === "object" || typeof error === "function") && "code" in error
    && typeof error.code === "number") {
    return error.code;
  }
  return null;
}

function signalFromError(error: unknown): NodeJS.Signals | null {
  if (error !== null && (typeof error === "object" || typeof error === "function") && "signal" in error
    && typeof error.signal === "string") {
    return error.signal as NodeJS.Signals;
  }
  return null;
}

function nativeErrno(stderr: string): Readonly<{ errno: string | null; errnoNumber: number | null }> {
  const match = /^(\d+)\s/.exec(stderr);
  if (match?.[1] === undefined) return Object.freeze({ errno: null, errnoNumber: null });
  const number = Number(match[1]);
  if (!Number.isSafeInteger(number)) return Object.freeze({ errno: null, errnoNumber: null });
  try {
    return Object.freeze({ errno: getSystemErrorName(-number), errnoNumber: number });
  } catch {
    return Object.freeze({ errno: null, errnoNumber: number });
  }
}

let nativeRenameBinaryPromise: Promise<string> | null = null;

function moduleDirectory(): string {
  return dirname(fileURLToPath(import.meta.url));
}

export function ensureNativeRenameBinary(): Promise<string> {
  if (nativeRenameBinaryPromise !== null) return nativeRenameBinaryPromise;
  nativeRenameBinaryPromise = (async () => {
    const directory = moduleDirectory();
    const binaryPath = join(directory, "native-rename-noreplace");
    try {
      const stats = await lstat(binaryPath);
      if (stats.isFile() && (stats.mode & 0o111) !== 0) return binaryPath;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }

    const repositoryRoot = resolve(directory, "../../..");
    const sourcePath = join(repositoryRoot, "lib/adapters/cli/native-rename-noreplace.c");
    const compiler = process.env.CC ?? "cc";
    await mkdir(directory, { recursive: true });
    await new Promise<void>((resolveCompile, rejectCompile) => {
      execFile(
        compiler,
        ["-std=c11", "-O2", "-Wall", "-Wextra", "-o", binaryPath, sourcePath],
        { shell: false, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error === null) {
            resolveCompile();
            return;
          }
          rejectCompile(Object.assign(
            new Error(`native-rename-noreplace compilation failed: ${(stderr || stdout || error.message).trim()}`),
            { code: errorCode(error) },
          ));
        },
      );
    });
    return binaryPath;
  })();
  return nativeRenameBinaryPromise;
}

async function runNativeRename(sourcePath: string, destinationPath: string): Promise<NativeRenameReceipt> {
  const executable = await ensureNativeRenameBinary();
  const argv = Object.freeze([executable, sourcePath, destinationPath] as const);
  return new Promise(resolveRun => {
    execFile(
      executable,
      [sourcePath, destinationPath],
      { shell: false, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const exitCode = error === null ? 0 : exitCodeFromError(error);
        const errno = exitCode === 0 ? { errno: null, errnoNumber: null } : nativeErrno(stderr);
        resolveRun(Object.freeze({
          executable,
          argv,
          exitCode,
          signal: signalFromError(error),
          stdout,
          stderr,
          errno: errno.errno,
          errnoNumber: errno.errnoNumber,
        }));
      },
    );
  });
}

async function observePost(
  paths: MutationPaths,
  operation: EntryMutationOperation,
): Promise<Readonly<{
  postObservation: ObservedEntrySnapshot;
  postSourceObservation: ObservedEntrySnapshot | null;
}>> {
  const postObservation = toObservedEntrySnapshot(await readEntrySnapshot(paths.destinationPath, false));
  if (operation !== "entry.move" || paths.sourcePath === null) {
    return Object.freeze({ postObservation, postSourceObservation: null });
  }
  const postSourceObservation = toObservedEntrySnapshot(await readEntrySnapshot(paths.sourcePath, false));
  return Object.freeze({ postObservation, postSourceObservation });
}

export async function executeEntryMutation(requestValue: EntryMutationRequest): Promise<EntryMutationExecutionReceipt> {
  const request = readEntryMutationRequest(requestValue);
  let paths: MutationPaths;
  try {
    paths = resolveMutationPaths(request);
  } catch (error) {
    if (error instanceof GuardError) {
      return Object.freeze({
        outcome: "rejected",
        operation: request.operation,
        executorInvoked: false,
        code: error.code,
        destinationPhysicalPath: null,
        sourcePhysicalPath: null,
        postObservation: null,
        postSourceObservation: null,
        native: null,
        message: error.message,
      });
    }
    throw error;
  }

  if (paths.parentPath !== null) {
    const parent = toObservedEntrySnapshot(await readEntrySnapshot(paths.parentPath, false));
    const parentDecision = parentRejection(request, parent);
    if (parentDecision?.outcome === "rejected") {
      return rejectedReceipt(request, paths, parentDecision.code, parentDecision.message);
    }
  }
  if (paths.sourcePath !== null) {
    const source = toObservedEntrySnapshot(await readEntrySnapshot(paths.sourcePath, false));
    if (request.operation === "file.link" || request.operation === "entry.move") {
      const sourceDecision = sourceRejection(request.source.expectedType, request.source.expectedIdentity, source);
      if (sourceDecision?.outcome === "rejected") {
        return rejectedReceipt(request, paths, sourceDecision.code, sourceDecision.message);
      }
    } else if (request.operation === "entry.remove") {
      const targetDecision = sourceRejection(request.target.expectedType, request.target.expectedIdentity, source);
      if (targetDecision?.outcome === "rejected") {
        return rejectedReceipt(request, paths, targetDecision.code, targetDecision.message);
      }
    }
  }

  if (request.operation === "file.link") {
    if (paths.sourcePath === paths.destinationPath) {
      return rejectedReceipt(
        request,
        paths,
        "SAME_ENTRY_CONFLICT",
        "file.link must create a new directory entry and cannot target the source entry itself",
      );
    }
    if (request.source.expectedType !== "regular") {
      return rejectedReceipt(
        request,
        paths,
        "INVALID_HARDLINK_SOURCE_TYPE",
        "Hard links require a regular-file source",
      );
    }
  }
  if (request.operation === "entry.move" && paths.sourcePath === paths.destinationPath) {
    return noopReceipt(request, paths, "The source already occupies the requested destination path");
  }

  let native: NativeRenameReceipt | null = null;
  try {
    if (request.operation === "directory.create") {
      await mkdir(paths.destinationPath, { recursive: false, mode: 0o777 });
    } else if (request.operation === "file.create") {
      const handle = await open(
        paths.destinationPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o666,
      );
      await handle.close();
    } else if (request.operation === "link.create") {
      await symlink(request.targetText, paths.destinationPath);
    } else if (request.operation === "file.link") {
      if (paths.sourcePath === null) throw Object.assign(new Error("Missing hardlink source path"), { code: "EINVAL" });
      await link(paths.sourcePath, paths.destinationPath);
    } else if (request.operation === "entry.move") {
      if (paths.sourcePath === null) throw Object.assign(new Error("Missing move source path"), { code: "EINVAL" });
      native = await runNativeRename(paths.sourcePath, paths.destinationPath);
      if (native.exitCode !== 0) {
        return failedReceipt(
          request,
          paths,
          native.errno ?? "EIO",
          native.errnoNumber,
          native.stderr.trim() || "native-rename-noreplace failed",
          native,
        );
      }
    } else if (request.operation === "entry.remove") {
      if (request.target.expectedType === "directory") {
        await rmdir(paths.destinationPath);
      } else {
        await unlink(paths.destinationPath);
      }
    } else {
      throw Object.assign(new Error("Unsupported entry mutation operation"), { code: "EINVAL" });
    }
  } catch (error) {
    return failedReceipt(
      request,
      paths,
      errorCode(error),
      errorNumber(error),
      error instanceof Error ? error.message : String(error),
      native,
    );
  }

  const post = await observePost(paths, request.operation);
  return Object.freeze({
    outcome: "succeeded",
    operation: request.operation,
    executorInvoked: true,
    destinationPhysicalPath: paths.destinationPath,
    sourcePhysicalPath: paths.sourcePath,
    postObservation: post.postObservation,
    postSourceObservation: post.postSourceObservation,
    native,
    message: null,
  });
}

function parseSuccessEnvelope(stdout: string, operation: EntryMutationOperation): EntryMutationExecutionReceipt {
  const envelope = expectRecord(JSON.parse(stdout), "entry mutation helper response");
  exactKeys(envelope, ["ok", "receipt"], "entry mutation helper response");
  if (envelope.ok !== true) throw new TypeError("Entry mutation helper did not report success");
  const receipt = expectRecord(envelope.receipt, "entry mutation receipt");
  if (receipt.operation !== operation) throw new TypeError("Entry mutation helper returned a different operation");
  if (receipt.outcome !== "succeeded"
    && receipt.outcome !== "failed"
    && receipt.outcome !== "rejected"
    && receipt.outcome !== "noop_satisfied") {
    throw new TypeError("Entry mutation helper returned an invalid outcome");
  }
  return receipt as EntryMutationExecutionReceipt;
}

function parseFailureEnvelope(stderr: string): Readonly<{ errno: string; message: string }> | null {
  try {
    const envelope = expectRecord(JSON.parse(stderr), "entry mutation helper failure");
    exactKeys(envelope, ["ok", "errno", "message"], "entry mutation helper failure");
    if (envelope.ok !== false) return null;
    return Object.freeze({
      errno: nonEmpty(envelope.errno, "entry mutation helper failure errno"),
      message: nonEmpty(envelope.message, "entry mutation helper failure message"),
    });
  } catch {
    return null;
  }
}

export async function runEntryMutationHelper(requestValue: EntryMutationRequest): Promise<EntryMutationHelperResult> {
  const request = readEntryMutationRequest(requestValue);
  const helperPath = join(moduleDirectory(), "entry-mutation-helper.js");
  const executable = process.execPath;
  const argv = Object.freeze([helperPath, request.operation]);
  const stdin = `${JSON.stringify(request)}\n`;

  return new Promise(resolveRun => {
    const child = execFile(
      executable,
      [...argv],
      { shell: false, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const helper = Object.freeze({
          executable,
          helperPath,
          argv,
          stdin,
          stdout,
          stderr,
          exitCode: error === null ? 0 : exitCodeFromError(error),
          signal: signalFromError(error),
        });
        if (error === null) {
          let receipt: EntryMutationExecutionReceipt;
          try {
            receipt = parseSuccessEnvelope(stdout, request.operation);
          } catch (decodeError) {
            resolveRun(Object.freeze({
              receipt: failedReceipt(
                request,
                null,
                "INVALID_HELPER_RESPONSE",
                null,
                decodeError instanceof Error ? decodeError.message : String(decodeError),
                null,
              ),
              helper,
            }));
            return;
          }
          resolveRun(Object.freeze({ receipt, helper }));
          return;
        }
        const failure = parseFailureEnvelope(stderr.trim());
        resolveRun(Object.freeze({
          receipt: failedReceipt(
            request,
            null,
            failure?.errno ?? errorCode(error),
            errorNumber(error),
            failure?.message ?? (stderr.trim() || error.message),
            null,
          ),
          helper,
        }));
      },
    );
    child.stdin?.end(stdin);
  });
}
