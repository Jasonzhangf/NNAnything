import { execFile } from "node:child_process";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { expectRecord } from "../../core/schema.js";
import type { CliFailure } from "./observation.js";
import {
  ENTRY_KINDS,
  toObservedEntrySnapshot,
  type EntryKind,
  type EntrySnapshot,
  type ObservedEntrySnapshot,
  type OsInteger,
} from "./entry-inspection.js";

export const ENTRY_METADATA_OPERATIONS = Object.freeze([
  "entry.mode.set",
  "entry.owner.set",
  "entry.times.set",
] as const);

export type EntryMetadataOperation = typeof ENTRY_METADATA_OPERATIONS[number];

export type MutableMetadataEntryKind = "regular" | "directory";

export const MIN_ENTRY_MODE = 0;
export const MAX_ENTRY_MODE = 0o7777; // 4095
export type EntryModeValue = number;

export const MIN_OWNER_ID = 0n;
export const MAX_OWNER_ID = 4_294_967_294n; // 0xFFFFFFFE, excludes POSIX -1 leave-unchanged sentinel

export type EntryOwnerValue = Readonly<{
  uid: number | string;
  gid: number | string;
}>;

export const MIN_SUPPORTED_TIME_NS = 0n;
export const MAX_SUPPORTED_TIME_NS = 4_102_444_800_000_000_000n; // 2100-01-01T00:00:00Z
export const DEFAULT_TIMES_PRECISION_NS = 1_000n; // fixed 1000 ns (1 us)

export type EntryTimesValue = Readonly<{
  atimeNs: number | string;
  mtimeNs: number | string;
}>;

export type EntryModeSetRequest = Readonly<{
  operation: "entry.mode.set";
  absolutePath: string;
  expectedType: EntryKind;
  expectedIdentity: Readonly<{ dev: number | string; ino: number | string }>;
  mode: EntryModeValue;
}>;

export type EntryOwnerSetRequest = Readonly<{
  operation: "entry.owner.set";
  absolutePath: string;
  expectedType: EntryKind;
  expectedIdentity: Readonly<{ dev: number | string; ino: number | string }>;
  owner: EntryOwnerValue;
}>;

export type EntryTimesSetRequest = Readonly<{
  operation: "entry.times.set";
  absolutePath: string;
  expectedType: EntryKind;
  expectedIdentity: Readonly<{ dev: number | string; ino: number | string }>;
  times: EntryTimesValue;
}>;

export type EntryMetadataRequest =
  | EntryModeSetRequest
  | EntryOwnerSetRequest
  | EntryTimesSetRequest;

export type EntryMetadataObservation = Readonly<{
  kind: EntryMetadataOperation;
  request: EntryMetadataRequest;
  executable: string;
  helperPath: string;
  argv: readonly [string, EntryMetadataOperation];
  stdin: string;
  stdout: string;
  stderr: string;
  exitCode: 0;
  beforeSnapshot: ObservedEntrySnapshot;
  afterSnapshot: ObservedEntrySnapshot;
}>;

export type EntryMetadataHelperResult =
  | Readonly<{ ok: true; executorInvoked: true; observation: EntryMetadataObservation }>
  | Readonly<{ ok: false; executorInvoked: boolean; error: CliFailure }>;

export type ApplyEntryMetadataResult =
  | Readonly<{ ok: true; beforeSnapshot: ObservedEntrySnapshot; afterSnapshot: ObservedEntrySnapshot }>
  | Readonly<{ ok: false; code: string; message: string }>;

const helperPath = fileURLToPath(new URL("./entry-metadata-helper.js", import.meta.url));
const SNAPSHOT_KEYS = [
  "entryKind",
  "kind",
  "dev",
  "ino",
  "nlink",
  "rdev",
  "size",
  "mode",
  "uid",
  "gid",
  "atimeMs",
  "mtimeMs",
  "ctimeMs",
  "birthtimeMs",
  "linkTarget",
  "errno",
  "entryExists",
  "resolvedTargetExists",
  "observedWith",
] as const;

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function requireEntryKind(value: unknown, label: string): EntryKind {
  if (typeof value !== "string" || !ENTRY_KINDS.includes(value as EntryKind)) {
    throw new TypeError(`${label} is not a supported entry kind`);
  }
  return value as EntryKind;
}

function requireAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !posix.isAbsolute(value)) {
    throw new TypeError(`${label} must be an explicit absolute path without NUL`);
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

function errorCode(error: unknown): string | null {
  if (error !== null && (typeof error === "object" || typeof error === "function") && "code" in error) {
    const code = String((error as { code?: unknown }).code);
    if (code && code !== "undefined") return code;
  }
  return null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function parseNonNegativeBigInt(value: unknown, label: string): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${label} must be a non-negative safe integer or decimal integer string`);
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    if (!/^(0|[1-9]\d*)$/.test(value)) {
      throw new TypeError(`${label} must be a canonical non-negative decimal integer string`);
    }
    return BigInt(value);
  }
  throw new TypeError(`${label} must be a non-negative safe integer or decimal integer string`);
}

export function validateModeValue(value: unknown, label = "mode"): EntryModeValue {
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_ENTRY_MODE || value > MAX_ENTRY_MODE) {
    throw new TypeError(`${label} must be an integer satisfying 0 <= mode <= 4095 (0o7777)`);
  }
  return value;
}

export function parseOwnerId(value: unknown, label = "owner id"): number {
  const id = parseNonNegativeBigInt(value, label);
  if (id < MIN_OWNER_ID || id > MAX_OWNER_ID) {
    throw new TypeError(
      `${label} must satisfy 0 <= id <= 4294967294 (4294967295 is reserved as POSIX -1 leave-unchanged sentinel)`,
    );
  }
  return Number(id);
}

export function validateOwnerValue(value: unknown, label = "owner"): EntryOwnerValue {
  const record = expectRecord(value, label);
  exactKeys(record, ["uid", "gid"], label);
  parseOwnerId(record.uid, `${label}.uid`);
  parseOwnerId(record.gid, `${label}.gid`);
  return Object.freeze({
    uid: record.uid as number | string,
    gid: record.gid as number | string,
  });
}

export function parseSupportedTimeNs(value: unknown, label = "timestampNs"): bigint {
  const ns = parseNonNegativeBigInt(value, label);
  if (ns < MIN_SUPPORTED_TIME_NS || ns > MAX_SUPPORTED_TIME_NS) {
    throw new TypeError(
      `${label} must satisfy 0 <= ns <= ${MAX_SUPPORTED_TIME_NS.toString()} (2100-01-01T00:00:00Z)`,
    );
  }
  return ns;
}

export function nsToFutimesSeconds(value: unknown, label = "timestampNs"): number {
  const ns = typeof value === "bigint"
    ? (() => {
        if (value < MIN_SUPPORTED_TIME_NS || value > MAX_SUPPORTED_TIME_NS) {
          throw new TypeError(`${label} must satisfy 0 <= ns <= ${MAX_SUPPORTED_TIME_NS.toString()}`);
        }
        return value;
      })()
    : parseSupportedTimeNs(value, label);
  return Number(ns / 1_000_000_000n) + Number(ns % 1_000_000_000n) / 1e9;
}

export function validateTimesValue(value: unknown, label = "times"): EntryTimesValue {
  const record = expectRecord(value, label);
  exactKeys(record, ["atimeNs", "mtimeNs"], label);
  parseSupportedTimeNs(record.atimeNs, `${label}.atimeNs`);
  parseSupportedTimeNs(record.mtimeNs, `${label}.mtimeNs`);
  return Object.freeze({
    atimeNs: record.atimeNs as number | string,
    mtimeNs: record.mtimeNs as number | string,
  });
}

export function compareModeEquals(observedMode: OsInteger, expectedMode: EntryModeValue): boolean {
  const validExpected = validateModeValue(expectedMode, "expectedMode");
  if (observedMode === null) return false;
  const observedBits = Number(parseNonNegativeBigInt(observedMode, "observedMode") & 0o7777n);
  return observedBits === validExpected;
}

export function compareOwnerEquals(
  observedOwner: Readonly<{ uid: OsInteger; gid: OsInteger }> | null,
  expectedOwner: EntryOwnerValue,
): boolean {
  const validExpected = validateOwnerValue(expectedOwner, "expectedOwner");
  if (observedOwner === null || observedOwner.uid === null || observedOwner.gid === null) return false;
  return parseNonNegativeBigInt(observedOwner.uid, "observedOwner.uid")
    === BigInt(parseOwnerId(validExpected.uid, "expectedOwner.uid"))
    && parseNonNegativeBigInt(observedOwner.gid, "observedOwner.gid")
    === BigInt(parseOwnerId(validExpected.gid, "expectedOwner.gid"));
}

export function compareTimesEquals(
  observedTimes: Readonly<{ atimeNs: OsInteger; mtimeNs: OsInteger }> | null,
  expectedTimes: EntryTimesValue,
  precisionNs: bigint = DEFAULT_TIMES_PRECISION_NS,
): boolean {
  const validExpected = validateTimesValue(expectedTimes, "expectedTimes");
  if (precisionNs < 0n) throw new TypeError("precisionNs must be a non-negative bigint");
  if (observedTimes === null || observedTimes.atimeNs === null || observedTimes.mtimeNs === null) return false;
  const obsA = parseNonNegativeBigInt(observedTimes.atimeNs, "observedTimes.atimeNs");
  const obsM = parseNonNegativeBigInt(observedTimes.mtimeNs, "observedTimes.mtimeNs");
  const expA = parseSupportedTimeNs(validExpected.atimeNs, "expectedTimes.atimeNs");
  const expM = parseSupportedTimeNs(validExpected.mtimeNs, "expectedTimes.mtimeNs");
  const diffA = obsA >= expA ? obsA - expA : expA - obsA;
  const diffM = obsM >= expM ? obsM - expM : expM - obsM;
  return diffA <= precisionNs && diffM <= precisionNs;
}

function readExpectedIdentity(value: unknown): Readonly<{ dev: number | string; ino: number | string }> {
  const record = expectRecord(value, "entry metadata request expectedIdentity");
  exactKeys(record, ["dev", "ino"], "entry metadata request expectedIdentity");
  parseNonNegativeBigInt(record.dev, "entry metadata request expectedIdentity.dev");
  parseNonNegativeBigInt(record.ino, "entry metadata request expectedIdentity.ino");
  return Object.freeze({
    dev: record.dev as number | string,
    ino: record.ino as number | string,
  });
}

export function readEntryMetadataRequest(value: unknown): EntryMetadataRequest {
  const record = expectRecord(value, "entry metadata request");
  const operation = record.operation;
  if (operation === "entry.mode.set") {
    exactKeys(record, ["operation", "absolutePath", "expectedType", "expectedIdentity", "mode"], "entry.mode.set request");
    return Object.freeze({
      operation,
      absolutePath: requireAbsolutePath(record.absolutePath, "entry.mode.set request absolutePath"),
      expectedType: requireEntryKind(record.expectedType, "entry.mode.set request expectedType"),
      expectedIdentity: readExpectedIdentity(record.expectedIdentity),
      mode: validateModeValue(record.mode),
    });
  }
  if (operation === "entry.owner.set") {
    exactKeys(record, ["operation", "absolutePath", "expectedType", "expectedIdentity", "owner"], "entry.owner.set request");
    return Object.freeze({
      operation,
      absolutePath: requireAbsolutePath(record.absolutePath, "entry.owner.set request absolutePath"),
      expectedType: requireEntryKind(record.expectedType, "entry.owner.set request expectedType"),
      expectedIdentity: readExpectedIdentity(record.expectedIdentity),
      owner: validateOwnerValue(record.owner),
    });
  }
  if (operation === "entry.times.set") {
    exactKeys(record, ["operation", "absolutePath", "expectedType", "expectedIdentity", "times"], "entry.times.set request");
    return Object.freeze({
      operation,
      absolutePath: requireAbsolutePath(record.absolutePath, "entry.times.set request absolutePath"),
      expectedType: requireEntryKind(record.expectedType, "entry.times.set request expectedType"),
      expectedIdentity: readExpectedIdentity(record.expectedIdentity),
      times: validateTimesValue(record.times),
    });
  }
  throw new TypeError("Unsupported entry metadata operation or extra fields");
}

function classify(stats: BigIntStats): EntryKind {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isFile()) return "regular";
  if (stats.isDirectory()) return "directory";
  if (stats.isCharacterDevice()) return "character_device";
  if (stats.isBlockDevice()) return "block_device";
  if (stats.isFIFO()) return "fifo";
  if (stats.isSocket()) return "socket";
  return "other";
}

function snapshotFromStats(stats: BigIntStats, kind: EntryKind, observedWith: "stat" | "lstat"): EntrySnapshot {
  const linkTarget = kind === "symlink" ? "" : null;
  return Object.freeze({
    entryKind: kind,
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
    errno: null,
    entryExists: true,
    resolvedTargetExists: null,
    observedWith,
  });
}

function unsupportedType(request: EntryMetadataRequest): EntryMetadataHelperResult {
  return Object.freeze({
    ok: false,
    executorInvoked: false,
    error: Object.freeze({
      operation: request.operation,
      stage: "validate",
      code: "TYPE_UNSUPPORTED",
      message: `entry metadata mutation is unsupported for target type ${request.expectedType}`,
    }),
  });
}

/**
 * Runs the fixed fd-bound mutation sequence. Returns a structured failure instead of
 * throwing for OS errors so the caller can preserve the real errno and side effects.
 */
export async function applyEntryMetadataRequest(request: EntryMetadataRequest): Promise<ApplyEntryMetadataResult> {
  let before: BigIntStats;
  try {
    before = await lstat(request.absolutePath, { bigint: true });
  } catch (error) {
    return Object.freeze({ ok: false, code: errorCode(error) ?? "EIO", message: messageOf(error) });
  }

  const beforeKind = classify(before);
  const expectedDev = parseNonNegativeBigInt(request.expectedIdentity.dev, "expectedIdentity.dev");
  const expectedIno = parseNonNegativeBigInt(request.expectedIdentity.ino, "expectedIdentity.ino");
  if (before.dev !== expectedDev || before.ino !== expectedIno || beforeKind !== request.expectedType) {
    return Object.freeze({
      ok: false,
      code: "STALE_REFERENCE",
      message: "entry identity or type no longer matches the observed reference",
    });
  }
  if (beforeKind !== "regular" && beforeKind !== "directory") {
    return Object.freeze({
      ok: false,
      code: "TYPE_UNSUPPORTED",
      message: `entry metadata mutation is unsupported for target type ${beforeKind}`,
    });
  }

  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let handle;
  try {
    handle = await open(request.absolutePath, flags);
  } catch (error) {
    return Object.freeze({ ok: false, code: errorCode(error) ?? "EIO", message: messageOf(error) });
  }

  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || classify(opened) !== beforeKind) {
      return Object.freeze({
        ok: false,
        code: "STALE_REFERENCE",
        message: "opened descriptor identity no longer matches the observed reference",
      });
    }

    if (request.operation === "entry.mode.set") {
      await handle.chmod(validateModeValue(request.mode));
    } else if (request.operation === "entry.owner.set") {
      await handle.chown(
        parseOwnerId(request.owner.uid, "owner.uid"),
        parseOwnerId(request.owner.gid, "owner.gid"),
      );
    } else {
      await handle.utimes(
        nsToFutimesSeconds(request.times.atimeNs, "times.atimeNs"),
        nsToFutimesSeconds(request.times.mtimeNs, "times.mtimeNs"),
      );
    }

    const after = await handle.stat({ bigint: true });
    return Object.freeze({
      ok: true,
      beforeSnapshot: toObservedEntrySnapshot(snapshotFromStats(before, beforeKind, "lstat")),
      afterSnapshot: toObservedEntrySnapshot(snapshotFromStats(after, classify(after), "stat")),
    });
  } catch (error) {
    return Object.freeze({ ok: false, code: errorCode(error) ?? "EIO", message: messageOf(error) });
  } finally {
    await handle.close();
  }
}

export function entryMetadataHelperPath(): string {
  return helperPath;
}

function readObservedSnapshot(value: unknown): ObservedEntrySnapshot {
  const snapshot = expectRecord(value, "entry metadata snapshot");
  exactKeys(snapshot, SNAPSHOT_KEYS, "entry metadata snapshot");
  const entryKind = snapshot.entryKind === null ? null : requireEntryKind(snapshot.entryKind, "entry metadata snapshot entryKind");
  const kind = snapshot.kind === null ? null : requireEntryKind(snapshot.kind, "entry metadata snapshot kind");
  if (snapshot.observedWith !== null && snapshot.observedWith !== "stat" && snapshot.observedWith !== "lstat") {
    throw new TypeError("entry metadata snapshot observedWith is invalid");
  }
  if (snapshot.errno !== null && (typeof snapshot.errno !== "string" || snapshot.errno.length === 0)) {
    throw new TypeError("entry metadata snapshot errno is invalid");
  }
  if (snapshot.linkTarget !== null && (typeof snapshot.linkTarget !== "string" || snapshot.linkTarget.length === 0)) {
    throw new TypeError("entry metadata snapshot linkTarget is invalid");
  }
  for (const key of ["entryExists", "resolvedTargetExists"] as const) {
    if (snapshot[key] !== null && typeof snapshot[key] !== "boolean") {
      throw new TypeError(`entry metadata snapshot ${key} is invalid`);
    }
  }
  return Object.freeze({
    entryKind,
    kind,
    dev: osInteger(snapshot.dev, "entry metadata snapshot dev"),
    ino: osInteger(snapshot.ino, "entry metadata snapshot ino"),
    nlink: osInteger(snapshot.nlink, "entry metadata snapshot nlink"),
    rdev: osInteger(snapshot.rdev, "entry metadata snapshot rdev"),
    size: osInteger(snapshot.size, "entry metadata snapshot size"),
    mode: osInteger(snapshot.mode, "entry metadata snapshot mode"),
    uid: osInteger(snapshot.uid, "entry metadata snapshot uid"),
    gid: osInteger(snapshot.gid, "entry metadata snapshot gid"),
    atimeMs: osInteger(snapshot.atimeMs, "entry metadata snapshot atimeMs"),
    mtimeMs: osInteger(snapshot.mtimeMs, "entry metadata snapshot mtimeMs"),
    ctimeMs: osInteger(snapshot.ctimeMs, "entry metadata snapshot ctimeMs"),
    birthtimeMs: osInteger(snapshot.birthtimeMs, "entry metadata snapshot birthtimeMs"),
    linkTarget: snapshot.linkTarget as string | null,
    errno: snapshot.errno as string | null,
    entryExists: snapshot.entryExists as boolean | null,
    resolvedTargetExists: snapshot.resolvedTargetExists as boolean | null,
    observedWith: snapshot.observedWith as "stat" | "lstat" | null,
  });
}

function parseFailureReceipt(value: string): Readonly<{ code: string; message: string }> | null {
  try {
    const receipt = expectRecord(JSON.parse(value), "entry metadata failure receipt");
    exactKeys(receipt, ["ok", "errno", "message"], "entry metadata failure receipt");
    if (receipt.ok !== false) return null;
    if (typeof receipt.errno !== "string" || receipt.errno.length === 0) return null;
    if (typeof receipt.message !== "string") return null;
    return Object.freeze({ code: receipt.errno, message: receipt.message });
  } catch {
    return null;
  }
}

function parseSuccessReceipt(value: string): Readonly<{
  beforeSnapshot: ObservedEntrySnapshot;
  afterSnapshot: ObservedEntrySnapshot;
}> {
  const receipt = expectRecord(JSON.parse(value), "entry metadata helper receipt");
  exactKeys(receipt, ["ok", "beforeSnapshot", "afterSnapshot"], "entry metadata helper receipt");
  if (receipt.ok !== true) throw new TypeError("Entry metadata helper did not report success");
  return Object.freeze({
    beforeSnapshot: readObservedSnapshot(receipt.beforeSnapshot),
    afterSnapshot: readObservedSnapshot(receipt.afterSnapshot),
  });
}

function helperFailure(
  request: EntryMetadataRequest,
  executorInvoked: boolean,
  code: string,
  message: string,
): EntryMetadataHelperResult {
  return Object.freeze({
    ok: false,
    executorInvoked,
    error: Object.freeze({ operation: request.operation, stage: "observe", code, message }),
  });
}

async function runHelperProcess(request: EntryMetadataRequest): Promise<EntryMetadataHelperResult> {
  const stdin = `${JSON.stringify(request)}\n`;
  const argv = Object.freeze([helperPath, request.operation] as const);
  return new Promise(resolve => {
    const child = execFile(
      process.execPath,
      [...argv],
      { shell: false, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          let parsed: Readonly<{ beforeSnapshot: ObservedEntrySnapshot; afterSnapshot: ObservedEntrySnapshot }>;
          try {
            parsed = parseSuccessReceipt(stdout);
          } catch (decodeError) {
            resolve(helperFailure(request, true, "INVALID_HELPER_RESPONSE", messageOf(decodeError)));
            return;
          }
          resolve(Object.freeze({
            ok: true,
            executorInvoked: true,
            observation: Object.freeze({
              kind: request.operation,
              request,
              executable: process.execPath,
              helperPath,
              argv,
              stdin,
              stdout,
              stderr,
              exitCode: 0,
              beforeSnapshot: parsed.beforeSnapshot,
              afterSnapshot: parsed.afterSnapshot,
            }),
          }));
          return;
        }
        const receipt = parseFailureReceipt(stderr.trim());
        resolve(helperFailure(
          request,
          true,
          receipt?.code ?? errorCode(error) ?? "HELPER_FAILED",
          receipt?.message ?? (stderr.trim() || error.message),
        ));
      },
    );
    child.stdin?.end(stdin);
  });
}

/**
 * Validates the typed request synchronously (throws TypeError with zero subprocess
 * spawn), rejects non-mutable kinds before spawn, then runs the fixed subprocess.
 */
export function runEntryMetadataHelper(value: unknown): Promise<EntryMetadataHelperResult> {
  const request = readEntryMetadataRequest(value);
  if (request.expectedType !== "regular" && request.expectedType !== "directory") {
    return Promise.resolve(unsupportedType(request));
  }
  return runHelperProcess(request);
}
