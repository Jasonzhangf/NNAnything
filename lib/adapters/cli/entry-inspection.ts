import { execFile } from "node:child_process";
import { lstat, readlink, realpath, stat } from "node:fs/promises";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { expectRecord } from "../../core/schema.js";
import type { CliFailure } from "./observation.js";

export const ENTRY_KINDS = Object.freeze([
  "regular",
  "directory",
  "symlink",
  "character_device",
  "block_device",
  "fifo",
  "socket",
  "other",
] as const);

export type EntryKind = typeof ENTRY_KINDS[number];
export type ObservedWith = "stat" | "lstat";
export type OsInteger = number | string | null;

export type PathRef = Readonly<{
  kind: "cli.path";
  scenarioId: string;
  sessionId: string;
  path: string;
}>;

export type ObservedObjectRef = Readonly<{
  kind: "cli.entry" | "cli.file" | "cli.directory";
  scenarioId: string;
  sessionId: string;
  type: EntryKind;
  identity: Readonly<{ dev: OsInteger; ino: OsInteger }>;
  sourceRun: string;
  sessionRevision: number;
  absolutePath: string;
}>;

export type LegacyDirectoryRef = Readonly<{
  kind: "cli.directory";
  scenarioId: string;
  sessionId: string;
  path: string;
}>;

export type EntrySnapshot = Readonly<{
  entryKind: EntryKind | null;
  kind: EntryKind | null;
  dev: bigint | null;
  ino: bigint | null;
  nlink: bigint | null;
  rdev: bigint | null;
  size: bigint | null;
  mode: bigint | null;
  uid: bigint | null;
  gid: bigint | null;
  atimeMs: bigint | null;
  mtimeMs: bigint | null;
  ctimeMs: bigint | null;
  birthtimeMs: bigint | null;
  atimeNs: bigint | null;
  mtimeNs: bigint | null;
  ctimeNs: bigint | null;
  birthtimeNs: bigint | null;
  linkTarget: string | null;
  errno: string | null;
  entryExists: boolean | null;
  resolvedTargetExists: boolean | null;
  observedWith: ObservedWith | null;
}>;

export type ObservedEntrySnapshot = Readonly<{
  entryKind: EntryKind | null;
  kind: EntryKind | null;
  dev: OsInteger;
  ino: OsInteger;
  nlink: OsInteger;
  rdev: OsInteger;
  size: OsInteger;
  mode: OsInteger;
  uid: OsInteger;
  gid: OsInteger;
  atimeMs: OsInteger;
  mtimeMs: OsInteger;
  ctimeMs: OsInteger;
  birthtimeMs: OsInteger;
  linkTarget: string | null;
  errno: string | null;
  entryExists: boolean | null;
  resolvedTargetExists: boolean | null;
  observedWith: ObservedWith | null;
}>;

export type EntryInspectRequest = Readonly<{
  operation: "entry.inspect";
  absolutePath: string;
  followSymlinks: boolean;
}>;

export type PathRealpathRequest = Readonly<{
  operation: "path.realpath";
  absolutePath: string;
}>;

export type EntryInspectHelperObservation = Readonly<{
  kind: "entry.inspect";
  request: EntryInspectRequest;
  entryKind: EntryKind | null;
  executable: string;
  helperPath: string;
  argv: readonly [string, string];
  stdin: string;
  stdout: string;
  stderr: string;
  exitCode: 0;
  snapshot: ObservedEntrySnapshot;
}>;

export type EntryInspectHelperResult =
  | Readonly<{ ok: true; observation: EntryInspectHelperObservation }>
  | Readonly<{ ok: false; error: CliFailure }>;

export type ObservedRealpathSnapshot = Readonly<{
  physicalPath: string | null;
  entryExists: boolean | null;
  resolvedTargetExists: boolean | null;
  resolvedIdentity: Readonly<{ dev: OsInteger; ino: OsInteger }> | null;
  errno: string | null;
}>;

export type PathRealpathHelperObservation = Readonly<{
  kind: "path.realpath";
  request: PathRealpathRequest;
  executable: string;
  helperPath: string;
  argv: readonly [string, string];
  stdin: string;
  stdout: string;
  stderr: string;
  exitCode: 0;
  snapshot: ObservedRealpathSnapshot;
}>;

export type PathRealpathHelperResult =
  | Readonly<{ ok: true; observation: PathRealpathHelperObservation }>
  | Readonly<{ ok: false; error: CliFailure }>;

type BigIntStatsLike = Readonly<{
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  rdev: bigint;
  size: bigint;
  mode: bigint;
  uid: bigint;
  gid: bigint;
  atimeMs: bigint;
  mtimeMs: bigint;
  ctimeMs: bigint;
  birthtimeMs: bigint;
  atimeNs: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isCharacterDevice(): boolean;
  isBlockDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}>;

const helperPath = fileURLToPath(new URL("./entry-inspect-helper.js", import.meta.url));
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

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

function absolutePath(value: unknown, label: string): string {
  const path = nonEmpty(value, label);
  if (!posix.isAbsolute(path)) throw new TypeError(`${label} must be an explicit absolute path`);
  return path;
}

function sessionRevision(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
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

export function readPathRef(value: unknown): PathRef {
  const ref = expectRecord(value, "path reference");
  exactKeys(ref, ["kind", "scenarioId", "sessionId", "path"], "path reference");
  if (ref.kind !== "cli.path") throw new TypeError("Expected a cli.path reference");
  return Object.freeze({
    kind: "cli.path",
    scenarioId: nonEmpty(ref.scenarioId, "path reference scenarioId"),
    sessionId: nonEmpty(ref.sessionId, "path reference sessionId"),
    path: absolutePath(ref.path, "path reference path"),
  });
}

export function readObservedObjectRef(value: unknown): ObservedObjectRef {
  const ref = expectRecord(value, "observed object reference");
  exactKeys(ref, ["kind", "scenarioId", "sessionId", "type", "identity", "sourceRun", "sessionRevision", "absolutePath"], "observed object reference");
  if (ref.kind !== "cli.entry" && ref.kind !== "cli.file" && ref.kind !== "cli.directory") {
    throw new TypeError("Expected a cli.entry, cli.file or cli.directory observed reference");
  }
  const identity = expectRecord(ref.identity, "observed object reference identity");
  exactKeys(identity, ["dev", "ino"], "observed object reference identity");
  return Object.freeze({
    kind: ref.kind,
    scenarioId: nonEmpty(ref.scenarioId, "observed object reference scenarioId"),
    sessionId: nonEmpty(ref.sessionId, "observed object reference sessionId"),
    type: entryKind(ref.type, "observed object reference type"),
    identity: Object.freeze({
      dev: osInteger(identity.dev, "observed object reference identity.dev"),
      ino: osInteger(identity.ino, "observed object reference identity.ino"),
    }),
    sourceRun: nonEmpty(ref.sourceRun, "observed object reference sourceRun"),
    sessionRevision: sessionRevision(ref.sessionRevision, "observed object reference sessionRevision"),
    absolutePath: absolutePath(ref.absolutePath, "observed object reference absolutePath"),
  });
}

function readLegacyDirectoryRef(value: unknown): LegacyDirectoryRef {
  const ref = expectRecord(value, "legacy directory reference");
  exactKeys(ref, ["kind", "scenarioId", "sessionId", "path"], "legacy directory reference");
  if (ref.kind !== "cli.directory") throw new TypeError("Expected a legacy cli.directory reference");
  return Object.freeze({
    kind: "cli.directory",
    scenarioId: nonEmpty(ref.scenarioId, "legacy directory reference scenarioId"),
    sessionId: nonEmpty(ref.sessionId, "legacy directory reference sessionId"),
    path: nonEmpty(ref.path, "legacy directory reference path"),
  });
}

export function readInspectRef(value: unknown): PathRef | ObservedObjectRef | LegacyDirectoryRef {
  const ref = expectRecord(value, "inspect reference");
  if (ref.kind === "cli.path") return readPathRef(ref);
  if (ref.kind === "cli.directory" && !Object.hasOwn(ref, "identity")) return readLegacyDirectoryRef(ref);
  return readObservedObjectRef(ref);
}

function classify(stats: BigIntStatsLike): EntryKind {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isFile()) return "regular";
  if (stats.isDirectory()) return "directory";
  if (stats.isCharacterDevice()) return "character_device";
  if (stats.isBlockDevice()) return "block_device";
  if (stats.isFIFO()) return "fifo";
  if (stats.isSocket()) return "socket";
  return "other";
}

function errorCode(error: unknown): string | null {
  if (error !== null && (typeof error === "object" || typeof error === "function") && "code" in error) {
    const code = String(error.code);
    if (code && code !== "undefined") return code;
  }
  return null;
}

function emptySnapshot(input: Readonly<{
  errno: string;
  entryExists: boolean | null;
  resolvedTargetExists: boolean | null;
}>): EntrySnapshot {
  return Object.freeze({
    entryKind: null,
    kind: null,
    dev: null,
    ino: null,
    nlink: null,
    rdev: null,
    size: null,
    mode: null,
    uid: null,
    gid: null,
    atimeMs: null,
    mtimeMs: null,
    ctimeMs: null,
    birthtimeMs: null,
    atimeNs: null,
    mtimeNs: null,
    ctimeNs: null,
    birthtimeNs: null,
    linkTarget: null,
    errno: input.errno,
    entryExists: input.entryExists,
    resolvedTargetExists: input.resolvedTargetExists,
    observedWith: null,
  });
}

function fromStats(
  stats: BigIntStatsLike,
  kind: EntryKind,
  entryKind: EntryKind,
  observedWith: ObservedWith,
  entryExists: boolean,
  resolvedTargetExists: boolean | null,
  linkTarget: string | null,
  errno: string | null,
): EntrySnapshot {
  return Object.freeze({
    entryKind,
    kind,
    dev: stats.dev,
    ino: stats.ino,
    nlink: stats.nlink,
    rdev: stats.rdev,
    size: stats.size,
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    atimeMs: stats.atimeMs,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    birthtimeMs: stats.birthtimeMs === 0n ? null : stats.birthtimeMs,
    atimeNs: stats.atimeNs,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    birthtimeNs: stats.birthtimeMs === 0n ? null : stats.birthtimeNs,
    linkTarget,
    errno,
    entryExists,
    resolvedTargetExists,
    observedWith,
  });
}

/**
 * Lstat is always the source check. Follow mode adds stat for the resolved target.
 * ENOENT is an observation of absence. Other errno values stay explicit and do not
 * become exists=false.
 */
export async function readEntrySnapshot(absolutePathValue: string, followSymlinks: boolean): Promise<EntrySnapshot> {
  const path = absolutePath(absolutePathValue, "absolutePath");
  if (typeof followSymlinks !== "boolean") throw new TypeError("followSymlinks must be an explicit boolean");

  let own: BigIntStatsLike;
  try {
    own = await lstat(path, { bigint: true });
  } catch (error) {
    const code = errorCode(error);
    if (code === null) throw error;
    return emptySnapshot({
      errno: code,
      entryExists: code === "ENOENT" ? false : null,
      resolvedTargetExists: code === "ENOENT" && followSymlinks ? false : null,
    });
  }

  const ownKind = classify(own);
  let linkTarget: string | null = null;
  let linkErrno: string | null = null;
  if (ownKind === "symlink" && !followSymlinks) {
    try {
      linkTarget = await readlink(path);
    } catch (error) {
      linkErrno = errorCode(error);
      if (linkErrno === null) throw error;
    }
  }

  if (!followSymlinks) {
    return fromStats(own, ownKind, ownKind, "lstat", true, null, linkTarget, linkErrno);
  }

  let sourceLinkTarget: string | null = null;
  let sourceLinkErrno: string | null = null;
  if (ownKind === "symlink") {
    try {
      sourceLinkTarget = await readlink(path);
    } catch (error) {
      sourceLinkErrno = errorCode(error);
      if (sourceLinkErrno === null) throw error;
    }
  }
  try {
    const target = await stat(path, { bigint: true });
    return fromStats(target, classify(target), ownKind, "stat", true, true, sourceLinkTarget, sourceLinkErrno);
  } catch (error) {
    const code = errorCode(error);
    if (code === null) throw error;
    return Object.freeze({
      entryKind: ownKind,
      kind: null,
      dev: null,
      ino: null,
      nlink: null,
      rdev: null,
      size: null,
      mode: null,
      uid: null,
      gid: null,
      atimeMs: null,
      mtimeMs: null,
      ctimeMs: null,
      birthtimeMs: null,
      atimeNs: null,
      mtimeNs: null,
      ctimeNs: null,
      birthtimeNs: null,
      linkTarget: sourceLinkTarget,
      errno: code,
      entryExists: true,
      resolvedTargetExists: code === "ENOENT" ? false : null,
      observedWith: null,
    });
  }
}

function toOsInteger(value: bigint | null): OsInteger {
  if (value === null) return null;
  return value >= MIN_SAFE && value <= MAX_SAFE ? Number(value) : value.toString();
}

export function toObservedEntrySnapshot(snapshot: EntrySnapshot): ObservedEntrySnapshot {
  return Object.freeze({
    entryKind: snapshot.entryKind,
    kind: snapshot.kind,
    dev: toOsInteger(snapshot.dev),
    ino: toOsInteger(snapshot.ino),
    nlink: toOsInteger(snapshot.nlink),
    rdev: toOsInteger(snapshot.rdev),
    size: toOsInteger(snapshot.size),
    mode: toOsInteger(snapshot.mode),
    uid: toOsInteger(snapshot.uid),
    gid: toOsInteger(snapshot.gid),
    atimeMs: toOsInteger(snapshot.atimeMs),
    mtimeMs: toOsInteger(snapshot.mtimeMs),
    ctimeMs: toOsInteger(snapshot.ctimeMs),
    birthtimeMs: toOsInteger(snapshot.birthtimeMs),
    linkTarget: snapshot.linkTarget,
    errno: snapshot.errno,
    entryExists: snapshot.entryExists,
    resolvedTargetExists: snapshot.resolvedTargetExists,
    observedWith: snapshot.observedWith,
  });
}

function readObservedSnapshot(value: unknown): ObservedEntrySnapshot {
  const snapshot = expectRecord(value, "entry snapshot");
  exactKeys(snapshot, ["entryKind", "kind", "dev", "ino", "nlink", "rdev", "size", "mode", "uid", "gid", "atimeMs", "mtimeMs", "ctimeMs", "birthtimeMs", "linkTarget", "errno", "entryExists", "resolvedTargetExists", "observedWith"], "entry snapshot");
  if (snapshot.entryKind !== null) entryKind(snapshot.entryKind, "entry snapshot entryKind");
  if (snapshot.kind !== null) entryKind(snapshot.kind, "entry snapshot kind");
  if (snapshot.observedWith !== null && snapshot.observedWith !== "stat" && snapshot.observedWith !== "lstat") {
    throw new TypeError("entry snapshot observedWith is invalid");
  }
  if (snapshot.errno !== null) nonEmpty(snapshot.errno, "entry snapshot errno");
  if (snapshot.linkTarget !== null) nonEmpty(snapshot.linkTarget, "entry snapshot linkTarget");
  for (const key of ["entryExists", "resolvedTargetExists"] as const) {
    if (snapshot[key] !== null && typeof snapshot[key] !== "boolean") throw new TypeError(`entry snapshot ${key} is invalid`);
  }
  return Object.freeze({
    entryKind: snapshot.entryKind as EntryKind | null,
    kind: snapshot.kind as EntryKind | null,
    dev: osInteger(snapshot.dev, "entry snapshot dev"),
    ino: osInteger(snapshot.ino, "entry snapshot ino"),
    nlink: osInteger(snapshot.nlink, "entry snapshot nlink"),
    rdev: osInteger(snapshot.rdev, "entry snapshot rdev"),
    size: osInteger(snapshot.size, "entry snapshot size"),
    mode: osInteger(snapshot.mode, "entry snapshot mode"),
    uid: osInteger(snapshot.uid, "entry snapshot uid"),
    gid: osInteger(snapshot.gid, "entry snapshot gid"),
    atimeMs: osInteger(snapshot.atimeMs, "entry snapshot atimeMs"),
    mtimeMs: osInteger(snapshot.mtimeMs, "entry snapshot mtimeMs"),
    ctimeMs: osInteger(snapshot.ctimeMs, "entry snapshot ctimeMs"),
    birthtimeMs: osInteger(snapshot.birthtimeMs, "entry snapshot birthtimeMs"),
    linkTarget: snapshot.linkTarget as string | null,
    errno: snapshot.errno as string | null,
    entryExists: snapshot.entryExists as boolean | null,
    resolvedTargetExists: snapshot.resolvedTargetExists as boolean | null,
    observedWith: snapshot.observedWith as ObservedWith | null,
  });
}

export function readEntryInspectRequest(value: unknown): EntryInspectRequest {
  const request = expectRecord(value, "entry inspect request");
  exactKeys(request, ["operation", "absolutePath", "followSymlinks"], "entry inspect request");
  if (request.operation !== "entry.inspect") throw new TypeError("Expected an entry.inspect helper request");
  if (typeof request.followSymlinks !== "boolean") throw new TypeError("entry inspect request followSymlinks must be an explicit boolean");
  return Object.freeze({
    operation: "entry.inspect",
    absolutePath: absolutePath(request.absolutePath, "entry inspect request absolutePath"),
    followSymlinks: request.followSymlinks,
  });
}

export function readPathRealpathRequest(value: unknown): PathRealpathRequest {
  const request = expectRecord(value, "path.realpath helper request");
  exactKeys(request, ["operation", "absolutePath"], "path.realpath helper request");
  if (request.operation !== "path.realpath") throw new TypeError("Expected a path.realpath helper request");
  return Object.freeze({
    operation: "path.realpath",
    absolutePath: absolutePath(request.absolutePath, "path.realpath helper request absolutePath"),
  });
}

export function entryInspectHelperPath(): string {
  return helperPath;
}

function helperFailure(result: Readonly<{
  code: string;
  message: string;
}>): EntryInspectHelperResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ operation: "entry.inspect", stage: "observe", code: result.code, message: result.message }),
  });
}

function parseFailureReceipt(value: string): Readonly<{ code: string; message: string }> | null {
  try {
    const receipt = expectRecord(JSON.parse(value), "entry inspect failure receipt");
    exactKeys(receipt, ["ok", "errno", "message"], "entry inspect failure receipt");
    if (receipt.ok !== false) return null;
    return Object.freeze({
      code: nonEmpty(receipt.errno, "entry inspect failure receipt errno"),
      message: nonEmpty(receipt.message, "entry inspect failure receipt message"),
    });
  } catch {
    return null;
  }
}

function parseSuccessReceipt(value: string): ObservedEntrySnapshot {
  const receipt = expectRecord(JSON.parse(value), "entry inspect helper receipt");
  exactKeys(receipt, ["ok", "snapshot"], "entry inspect helper receipt");
  if (receipt.ok !== true) throw new TypeError("Entry inspect helper did not report success");
  return readObservedSnapshot(receipt.snapshot);
}

function readObservedRealpathSnapshot(value: unknown): ObservedRealpathSnapshot {
  const snapshot = expectRecord(value, "path.realpath snapshot");
  exactKeys(snapshot, ["entryExists", "errno", "physicalPath", "resolvedIdentity", "resolvedTargetExists"], "path.realpath snapshot");
  if (snapshot.errno !== null) nonEmpty(snapshot.errno, "path.realpath snapshot errno");
  if (snapshot.physicalPath !== null) absolutePath(snapshot.physicalPath, "path.realpath snapshot physicalPath");
  for (const key of ["entryExists", "resolvedTargetExists"] as const) {
    if (snapshot[key] !== null && typeof snapshot[key] !== "boolean") throw new TypeError(`path.realpath snapshot ${key} is invalid`);
  }
  let resolvedIdentity: ObservedRealpathSnapshot["resolvedIdentity"] = null;
  if (snapshot.resolvedIdentity !== null) {
    const identity = expectRecord(snapshot.resolvedIdentity, "path.realpath resolvedIdentity");
    exactKeys(identity, ["dev", "ino"], "path.realpath resolvedIdentity");
    resolvedIdentity = Object.freeze({
      dev: osInteger(identity.dev, "path.realpath resolvedIdentity.dev"),
      ino: osInteger(identity.ino, "path.realpath resolvedIdentity.ino"),
    });
  }
  return Object.freeze({
    physicalPath: snapshot.physicalPath as string | null,
    entryExists: snapshot.entryExists as boolean | null,
    resolvedTargetExists: snapshot.resolvedTargetExists as boolean | null,
    resolvedIdentity,
    errno: snapshot.errno as string | null,
  });
}

function parseRealpathSuccessReceipt(value: string): ObservedRealpathSnapshot {
  const receipt = expectRecord(JSON.parse(value), "path.realpath helper receipt");
  exactKeys(receipt, ["ok", "snapshot"], "path.realpath helper receipt");
  if (receipt.ok !== true) throw new TypeError("Path realpath helper did not report success");
  return readObservedRealpathSnapshot(receipt.snapshot);
}

export async function runEntryInspectHelper(input: Readonly<{
  absolutePath: string;
  followSymlinks: boolean;
}>): Promise<EntryInspectHelperResult> {
  const request = readEntryInspectRequest({
    operation: "entry.inspect",
    absolutePath: input.absolutePath,
    followSymlinks: input.followSymlinks,
  });
  const stdin = `${JSON.stringify(request)}\n`;
  const argv = Object.freeze([helperPath, "entry.inspect"] as const);
  return new Promise(resolve => {
    const child = execFile(
      process.execPath,
      [...argv],
      { shell: false, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          let snapshot: ObservedEntrySnapshot;
          try {
            snapshot = parseSuccessReceipt(stdout);
          } catch (decodeError) {
            resolve(helperFailure({
              code: "INVALID_HELPER_RESPONSE",
              message: decodeError instanceof Error ? decodeError.message : String(decodeError),
            }));
            return;
          }
          resolve(Object.freeze({
            ok: true,
            observation: Object.freeze({
              kind: "entry.inspect",
              request,
              entryKind: snapshot.entryKind,
              executable: process.execPath,
              helperPath,
              argv,
              stdin,
              stdout,
              stderr,
              exitCode: 0,
              snapshot,
            }),
          }));
          return;
        }
        const receipt = parseFailureReceipt(stderr.trim());
        resolve(helperFailure(receipt ?? {
          code: errorCode(error) ?? "HELPER_FAILED",
          message: stderr.trim() || error.message,
        }));
      },
    );
    child.stdin?.end(stdin);
  });
}

async function readRealpathSnapshot(absolutePathValue: string): Promise<ObservedRealpathSnapshot> {
  const path = absolutePath(absolutePathValue, "path.realpath absolutePath");
  try {
    await lstat(path, { bigint: true });
  } catch (error) {
    const code = errorCode(error);
    if (code === null) throw error;
    return Object.freeze({
      physicalPath: null,
      entryExists: code === "ENOENT" ? false : null,
      resolvedTargetExists: code === "ENOENT" ? false : null,
      resolvedIdentity: null,
      errno: code,
    });
  }
  try {
    const physicalPath = await realpath(path, { encoding: "utf8" });
    const target = await stat(physicalPath, { bigint: true });
    return Object.freeze({
      physicalPath,
      entryExists: true,
      resolvedTargetExists: true,
      resolvedIdentity: Object.freeze({
        dev: toOsInteger(target.dev),
        ino: toOsInteger(target.ino),
      }),
      errno: null,
    });
  } catch (error) {
    const code = errorCode(error);
    if (code === null) throw error;
    return Object.freeze({
      physicalPath: null,
      entryExists: true,
      resolvedTargetExists: code === "ENOENT" ? false : null,
      resolvedIdentity: null,
      errno: code,
    });
  }
}

export async function runRealpathHelperSnapshot(absolutePathValue: string): Promise<ObservedRealpathSnapshot> {
  return readRealpathSnapshot(absolutePathValue);
}

export async function runPathRealpathHelper(input: Readonly<{
  absolutePath: string;
}>): Promise<PathRealpathHelperResult> {
  const request = readPathRealpathRequest({ operation: "path.realpath", absolutePath: input.absolutePath });
  const stdin = `${JSON.stringify(request)}\n`;
  const argv = Object.freeze([helperPath, "path.realpath"] as const);
  return new Promise(resolve => {
    const child = execFile(
      process.execPath,
      [...argv],
      { shell: false, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          let snapshot: ObservedRealpathSnapshot;
          try {
            snapshot = parseRealpathSuccessReceipt(stdout);
          } catch (decodeError) {
            resolve(Object.freeze({
              ok: false,
              error: Object.freeze({
                operation: "path.realpath",
                stage: "observe",
                code: "INVALID_HELPER_RESPONSE",
                message: decodeError instanceof Error ? decodeError.message : String(decodeError),
              }),
            }));
            return;
          }
          resolve(Object.freeze({
            ok: true,
            observation: Object.freeze({
              kind: "path.realpath",
              request,
              executable: process.execPath,
              helperPath,
              argv,
              stdin,
              stdout,
              stderr,
              exitCode: 0,
              snapshot,
            }),
          }));
          return;
        }
        const receipt = parseFailureReceipt(stderr.trim());
        resolve(Object.freeze({
          ok: false,
          error: Object.freeze({
            operation: "path.realpath",
            stage: "observe",
            code: receipt?.code ?? errorCode(error) ?? "HELPER_FAILED",
            message: receipt?.message ?? (stderr.trim() || error.message),
          }),
        }));
      },
    );
    child.stdin?.end(stdin);
  });
}

