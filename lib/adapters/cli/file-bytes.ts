import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative, resolve } from "node:path";

export type TypedBytes = Readonly<{
  kind: "cli.bytes";
  base64: string;
  byteLength: number;
}>;

export type CliFileByteIdentity = Readonly<{
  dev: string;
  ino: string;
}>;

export type CliFileByteSnapshot = Readonly<{
  identity: CliFileByteIdentity;
  size: number;
  bytesBase64: string;
  mtimeMs: number;
  ctimeMs: number;
  mode: number;
  nlink: number;
}>;

export type CliFileBytesOperation =
  | "file.replace"
  | "file.write"
  | "file.append"
  | "file.truncate"
  | "file.copy";

export type CliFileBytesErrorCode =
  | "INVALID_ARGUMENT"
  | "SAME_ENTRY_CONFLICT"
  | "STALE_REFERENCE"
  | "READ_TYPE_DENIED"
  | "PARENT_NOT_DIRECTORY"
  | "TARGET_EXISTS"
  | "TARGET_MISSING"
  | "PERMISSION_DENIED"
  | "PRE_READ_INCOMPLETE"
  | "POST_READ_FAILED"
  | "RESPONSE_TOO_LARGE"
  | "IO_ERROR";

export type CliFileBytesHelperRequest =
  | Readonly<{
      operation: "file.replace";
      workspaceRoot: string;
      targetPath: string;
      expectedIdentity: CliFileByteIdentity;
      content: TypedBytes;
    }>
  | Readonly<{
      operation: "file.write";
      workspaceRoot: string;
      targetPath: string;
      expectedIdentity: CliFileByteIdentity;
      offset: number;
      content: TypedBytes;
    }>
  | Readonly<{
      operation: "file.append";
      workspaceRoot: string;
      targetPath: string;
      expectedIdentity: CliFileByteIdentity;
      content: TypedBytes;
    }>
  | Readonly<{
      operation: "file.truncate";
      workspaceRoot: string;
      targetPath: string;
      expectedIdentity: CliFileByteIdentity;
      length: number;
    }>
  | Readonly<{
      operation: "file.copy";
      workspaceRoot: string;
      sourcePath: string;
      expectedSourceIdentity: CliFileByteIdentity;
      destinationParentPath: string;
      expectedParentIdentity: CliFileByteIdentity;
      destinationName: string;
    }>;

export type CliFileBytesEffectsObserved = Readonly<{
  attempted: boolean;
  mutationCommitted: boolean | null;
  modifiedPaths: readonly string[] | null;
  createdPaths: readonly string[] | null;
  bytesWritten: number | null;
}>;

export type CliFileBytesHelperReceipt = Readonly<{
  ok: boolean;
  operation: CliFileBytesOperation;
  status: "succeeded" | "rejected" | "failed" | "unknown";
  errorCode: CliFileBytesErrorCode | null;
  errno: string | null;
  message: string | null;
  openFlagsUsed: number | null;
  preWriteSnapshot: CliFileByteSnapshot | null;
  postWriteSnapshot: CliFileByteSnapshot | null;
  sourceSnapshot: CliFileByteSnapshot | null;
  destinationSnapshot: CliFileByteSnapshot | null;
  bytesWritten: number | null;
  effectsObserved: CliFileBytesEffectsObserved;
}>;

export type CliFileBytesVerdict = Readonly<{
  status: "achieved" | "unmet" | "unknown";
  satisfaction: 100 | 0 | null;
  replayForbidden: boolean;
}>;

export type CliFileBytesHelperRun = Readonly<{
  receipt: CliFileBytesHelperReceipt;
  executorInvoked: boolean;
  executable: string;
  helperPath: string;
  argv: readonly string[];
  stdin: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}>;

const helperPath = fileURLToPath(new URL("./file-bytes-helper.js", import.meta.url));
export const FILE_BYTES_HELPER_OUTPUT_LIMIT_BYTES = 256 * 1024 * 1024;
const OPERATIONS = Object.freeze([
  "file.replace",
  "file.write",
  "file.append",
  "file.truncate",
  "file.copy",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty string without NUL`);
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

function readIdentity(value: unknown, label: string): CliFileByteIdentity {
  const record = expectRecord(value, label);
  exactKeys(record, ["dev", "ino"], label);
  const dev = nonEmpty(record.dev, `${label}.dev`);
  const ino = nonEmpty(record.ino, `${label}.ino`);
  if (!/^\d+$/.test(dev) || !/^\d+$/.test(ino)) {
    throw new TypeError(`${label} dev and ino must be decimal strings`);
  }
  return Object.freeze({ dev, ino });
}

export function validateTypedBytes(value: unknown): TypedBytes {
  const record = expectRecord(value, "typed bytes");
  exactKeys(record, ["kind", "base64", "byteLength"], "typed bytes");
  if (record.kind !== "cli.bytes") throw new TypeError("typed bytes kind must be cli.bytes");
  if (typeof record.base64 !== "string" || record.base64.includes("\0")) {
    throw new TypeError("typed bytes base64 must be a string without NUL");
  }
  const base64 = record.base64;
  const byteLength = nonNegativeSafeInteger(record.byteLength, "typed bytes byteLength");
  if (!isCanonicalBase64(base64)) throw new TypeError("typed bytes base64 must be canonical base64");
  if (Buffer.from(base64, "base64").byteLength !== byteLength) {
    throw new TypeError("typed bytes base64 length does not match byteLength");
  }
  return Object.freeze({ kind: "cli.bytes", base64, byteLength });
}

function operation(value: unknown): CliFileBytesOperation {
  if (typeof value !== "string" || !OPERATIONS.includes(value as CliFileBytesOperation)) {
    throw new TypeError("operation must be one of the five file byte operations");
  }
  return value as CliFileBytesOperation;
}

function destinationName(value: unknown): string {
  const name = nonEmpty(value, "destinationName");
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new TypeError("destinationName must be a single path segment");
  }
  if (name === "." || name === "..") throw new TypeError("destinationName cannot be . or ..");
  return name;
}

function resolvedRoot(value: unknown): string {
  const root = nonEmpty(value, "workspaceRoot");
  return resolve(root);
}

function resolveWithin(root: string, candidate: unknown, label: string, allowRoot: boolean): string {
  const text = nonEmpty(candidate, label);
  const absolute = isAbsolute(text) ? resolve(text) : resolve(root, text);
  const rel = relative(root, absolute);
  const isRoot = rel === "";
  if (!allowRoot && isRoot) throw new TypeError(`${label} must resolve inside workspaceRoot`);
  if (!isRoot && (rel === ".." || rel.startsWith("../") || isAbsolute(rel))) {
    throw new TypeError(`${label} must resolve inside workspaceRoot`);
  }
  return absolute;
}

export function validateFileBytesHelperRequest(value: unknown): CliFileBytesHelperRequest {
  const record = expectRecord(value, "file bytes helper request");
  const op = operation(record.operation);
  const root = resolvedRoot(record.workspaceRoot);

  if (op === "file.replace" || op === "file.write" || op === "file.append" || op === "file.truncate") {
    const keys = ["operation", "workspaceRoot", "targetPath", "expectedIdentity"];
    if (op === "file.write") keys.push("offset", "content");
    else if (op === "file.truncate") keys.push("length");
    else keys.push("content");
    exactKeys(record, keys, "file bytes helper request");

    const targetPath = resolveWithin(root, record.targetPath, "targetPath", false);
    const expectedIdentity = readIdentity(record.expectedIdentity, "expectedIdentity");

    if (op === "file.truncate") {
      const length = nonNegativeSafeInteger(record.length, "length");
      return Object.freeze({ operation: op, workspaceRoot: root, targetPath, expectedIdentity, length });
    }
    const content = validateTypedBytes(record.content);
    if (op === "file.write") {
      const offset = nonNegativeSafeInteger(record.offset, "offset");
      return Object.freeze({ operation: op, workspaceRoot: root, targetPath, expectedIdentity, offset, content });
    }
    return Object.freeze({ operation: op, workspaceRoot: root, targetPath, expectedIdentity, content });
  }

  exactKeys(record, [
    "operation",
    "workspaceRoot",
    "sourcePath",
    "expectedSourceIdentity",
    "destinationParentPath",
    "expectedParentIdentity",
    "destinationName",
  ], "file bytes helper request");
  const sourcePath = resolveWithin(root, record.sourcePath, "sourcePath", false);
  const destinationParentPath = resolveWithin(root, record.destinationParentPath, "destinationParentPath", true);
  const name = destinationName(record.destinationName);
  return Object.freeze({
    operation: op,
    workspaceRoot: root,
    sourcePath,
    expectedSourceIdentity: readIdentity(record.expectedSourceIdentity, "expectedSourceIdentity"),
    destinationParentPath,
    expectedParentIdentity: readIdentity(record.expectedParentIdentity, "expectedParentIdentity"),
    destinationName: name,
  });
}

const noEffects = Object.freeze({
  attempted: false,
  mutationCommitted: false,
  modifiedPaths: Object.freeze([]) as readonly string[],
  createdPaths: Object.freeze([]) as readonly string[],
  bytesWritten: 0,
});

function rejectedReceipt(
  op: CliFileBytesOperation,
  errorCode: CliFileBytesErrorCode,
  message: string,
): CliFileBytesHelperReceipt {
  return Object.freeze({
    ok: false,
    operation: op,
    status: "rejected",
    errorCode,
    errno: null,
    message,
    openFlagsUsed: null,
    preWriteSnapshot: null,
    postWriteSnapshot: null,
    sourceSnapshot: null,
    destinationSnapshot: null,
    bytesWritten: 0,
    effectsObserved: noEffects,
  });
}

function unknownReceipt(
  op: CliFileBytesOperation,
  errorCode: CliFileBytesErrorCode,
  errno: string | null,
  message: string | null,
): CliFileBytesHelperReceipt {
  return Object.freeze({
    ok: false,
    operation: op,
    status: "unknown",
    errorCode,
    errno,
    message,
    openFlagsUsed: null,
    preWriteSnapshot: null,
    postWriteSnapshot: null,
    sourceSnapshot: null,
    destinationSnapshot: null,
    bytesWritten: null,
    effectsObserved: Object.freeze({
      attempted: true,
      mutationCommitted: null,
      modifiedPaths: null,
      createdPaths: null,
      bytesWritten: null,
    }),
  });
}

function operationName(value: unknown): CliFileBytesOperation {
  return typeof value === "string" && OPERATIONS.includes(value as CliFileBytesOperation)
    ? value as CliFileBytesOperation
    : "file.replace";
}

function parseReceipt(value: string): CliFileBytesHelperReceipt | null {
  const text = value.trim();
  if (text.length === 0) return null;
  try {
    const parsed = expectRecord(JSON.parse(text), "file bytes helper receipt");
    if (typeof parsed.ok !== "boolean") return null;
    return parsed as unknown as CliFileBytesHelperReceipt;
  } catch {
    return null;
  }
}

function localRun(
  request: CliFileBytesHelperRequest | null,
  receipt: CliFileBytesHelperReceipt,
): CliFileBytesHelperRun {
  return Object.freeze({
    receipt,
    executorInvoked: false,
    executable: process.execPath,
    helperPath,
    argv: Object.freeze([]),
    stdin: request === null ? "" : `${JSON.stringify(request)}\n`,
    stdout: "",
    stderr: "",
    exitCode: null,
  });
}

function copyTargetsSameObject(
  sourcePath: string,
  destinationPath: string,
  expectedSourceIdentity: CliFileByteIdentity,
): boolean {
  try {
    const source = lstatSync(sourcePath, { bigint: true });
    const destination = lstatSync(destinationPath, { bigint: true });
    return source.isFile()
      && destination.isFile()
      && source.dev.toString() === expectedSourceIdentity.dev
      && source.ino.toString() === expectedSourceIdentity.ino
      && source.dev === destination.dev
      && source.ino === destination.ino;
  } catch {
    return false;
  }
}

export async function runFileBytesHelper(value: unknown): Promise<CliFileBytesHelperRun> {
  let request: CliFileBytesHelperRequest;
  try {
    request = validateFileBytesHelperRequest(value);
  } catch (error) {
    return localRun(null, rejectedReceipt(
      operationName(isRecord(value) ? value.operation : null),
      "INVALID_ARGUMENT",
      error instanceof Error ? error.message : String(error),
    ));
  }

  if (request.operation === "file.copy") {
    const destinationPath = join(request.destinationParentPath, request.destinationName);
    if (request.sourcePath === destinationPath
      || copyTargetsSameObject(request.sourcePath, destinationPath, request.expectedSourceIdentity)) {
      return localRun(request, rejectedReceipt("file.copy", "SAME_ENTRY_CONFLICT", "source and destination resolve to the same entry"));
    }
  }

  const stdin = `${JSON.stringify(request)}\n`;
  const argv = Object.freeze([helperPath, request.operation] as const);
  return new Promise(resolveRun => {
    const child = execFile(
      process.execPath,
      [...argv],
      { shell: false, encoding: "utf8", maxBuffer: FILE_BYTES_HELPER_OUTPUT_LIMIT_BYTES },
      (error, stdout, stderr) => {
        const parsed = parseReceipt(error === null ? stdout : (stderr || stdout));
        if (parsed !== null) {
          resolveRun(Object.freeze({
            receipt: parsed,
            executorInvoked: true,
            executable: process.execPath,
            helperPath,
            argv,
            stdin,
            stdout,
            stderr,
            exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : null,
          }));
          return;
        }
        const code = error !== null && typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : null;
        const message = error !== null
          ? (stderr.trim() || error.message)
          : "file bytes helper returned an invalid response";
        const receipt = unknownReceipt(request.operation, "IO_ERROR", code, message);
        resolveRun(Object.freeze({
          receipt,
          executorInvoked: true,
          executable: process.execPath,
          helperPath,
          argv,
          stdin,
          stdout,
          stderr,
          exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : null,
        }));
      },
    );
    child.stdin?.end(stdin);
  });
}

function sameIdentity(a: CliFileByteIdentity | null, b: CliFileByteIdentity | null): boolean {
  return a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
}

function snapshotBuffer(snapshot: CliFileByteSnapshot | null): Buffer | null {
  return snapshot === null ? null : Buffer.from(snapshot.bytesBase64, "base64");
}

function unknownVerdict(): CliFileBytesVerdict {
  return Object.freeze({ status: "unknown", satisfaction: null, replayForbidden: true });
}

function unmetVerdict(receipt: CliFileBytesHelperReceipt): CliFileBytesVerdict {
  return Object.freeze({
    status: "unmet",
    satisfaction: 0,
    replayForbidden: receipt.effectsObserved.mutationCommitted === true,
  });
}

function achievedVerdict(): CliFileBytesVerdict {
  return Object.freeze({ status: "achieved", satisfaction: 100, replayForbidden: false });
}

export function verifyFileReplaceReceipt(
  receipt: CliFileBytesHelperReceipt,
  expectedContent: TypedBytes,
): CliFileBytesVerdict {
  if (receipt.errorCode === "POST_READ_FAILED" || receipt.status === "unknown") return unknownVerdict();
  const valid =
    receipt.status === "succeeded"
    && receipt.operation === "file.replace"
    && sameIdentity(receipt.preWriteSnapshot?.identity ?? null, receipt.postWriteSnapshot?.identity ?? null)
    && receipt.postWriteSnapshot?.size === expectedContent.byteLength
    && receipt.postWriteSnapshot?.bytesBase64 === expectedContent.base64;
  return valid ? achievedVerdict() : unmetVerdict(receipt);
}

export function verifyFileWriteReceipt(
  receipt: CliFileBytesHelperReceipt,
  offset: number,
  expectedPatch: TypedBytes,
): CliFileBytesVerdict {
  if (receipt.errorCode === "POST_READ_FAILED" || receipt.status === "unknown") return unknownVerdict();
  const oldBuf = snapshotBuffer(receipt.preWriteSnapshot);
  const newBuf = snapshotBuffer(receipt.postWriteSnapshot);
  const patchBuf = Buffer.from(expectedPatch.base64, "base64");
  if (receipt.status !== "succeeded" || receipt.operation !== "file.write" || oldBuf === null || newBuf === null) {
    return unmetVerdict(receipt);
  }
  if (!sameIdentity(receipt.preWriteSnapshot?.identity ?? null, receipt.postWriteSnapshot?.identity ?? null)) {
    return unmetVerdict(receipt);
  }
  const patchLen = patchBuf.length;
  const oldSize = oldBuf.length;
  if (patchLen === 0) {
    const valid = newBuf.length === oldSize && Buffer.compare(newBuf, oldBuf) === 0;
    return valid ? achievedVerdict() : unmetVerdict(receipt);
  }
  const validLength = newBuf.length === Math.max(oldSize, offset + patchLen);
  const windowEqual = newBuf.subarray(offset, offset + patchLen).equals(patchBuf);
  const prefixLen = Math.min(offset, oldSize);
  const prefixEqual = newBuf.subarray(0, prefixLen).equals(oldBuf.subarray(0, prefixLen));
  let gapZero = true;
  if (offset > oldSize) {
    gapZero = newBuf.subarray(oldSize, offset).every(byte => byte === 0);
  }
  let suffixEqual = true;
  if (offset + patchLen < oldSize) {
    suffixEqual = newBuf.subarray(offset + patchLen, oldSize).equals(oldBuf.subarray(offset + patchLen, oldSize));
  }
  return validLength && windowEqual && prefixEqual && gapZero && suffixEqual
    ? achievedVerdict()
    : unmetVerdict(receipt);
}

export function verifyFileAppendReceipt(
  receipt: CliFileBytesHelperReceipt,
  expectedSuffix: TypedBytes,
): CliFileBytesVerdict {
  if (receipt.errorCode === "POST_READ_FAILED" || receipt.status === "unknown") return unknownVerdict();
  const oldBuf = snapshotBuffer(receipt.preWriteSnapshot);
  const newBuf = snapshotBuffer(receipt.postWriteSnapshot);
  const suffixBuf = Buffer.from(expectedSuffix.base64, "base64");
  const valid =
    receipt.status === "succeeded"
    && receipt.operation === "file.append"
    && oldBuf !== null
    && newBuf !== null
    && sameIdentity(receipt.preWriteSnapshot?.identity ?? null, receipt.postWriteSnapshot?.identity ?? null)
    && receipt.postWriteSnapshot?.size === (receipt.preWriteSnapshot?.size ?? 0) + expectedSuffix.byteLength
    && newBuf.subarray(0, oldBuf.length).equals(oldBuf)
    && newBuf.subarray(oldBuf.length).equals(suffixBuf);
  return valid ? achievedVerdict() : unmetVerdict(receipt);
}

export function verifyFileTruncateReceipt(
  receipt: CliFileBytesHelperReceipt,
  expectedLength: number,
): CliFileBytesVerdict {
  if (receipt.errorCode === "POST_READ_FAILED" || receipt.status === "unknown") return unknownVerdict();
  const oldBuf = snapshotBuffer(receipt.preWriteSnapshot);
  const newBuf = snapshotBuffer(receipt.postWriteSnapshot);
  const valid =
    receipt.status === "succeeded"
    && receipt.operation === "file.truncate"
    && oldBuf !== null
    && newBuf !== null
    && sameIdentity(receipt.preWriteSnapshot?.identity ?? null, receipt.postWriteSnapshot?.identity ?? null)
    && receipt.postWriteSnapshot?.size === expectedLength
    && newBuf.subarray(0, Math.min(oldBuf.length, expectedLength)).equals(oldBuf.subarray(0, Math.min(oldBuf.length, expectedLength)))
    && (expectedLength <= oldBuf.length || newBuf.subarray(oldBuf.length, expectedLength).every(byte => byte === 0));
  return valid ? achievedVerdict() : unmetVerdict(receipt);
}

export function verifyFileCopyReceipt(receipt: CliFileBytesHelperReceipt): CliFileBytesVerdict {
  if (receipt.errorCode === "POST_READ_FAILED" || receipt.status === "unknown") return unknownVerdict();
  const pre = receipt.preWriteSnapshot;
  const source = receipt.sourceSnapshot;
  const destination = receipt.destinationSnapshot;
  const sourceUnchanged =
    pre !== null
    && source !== null
    && sameIdentity(source.identity, pre.identity)
    && source.size === pre.size
    && source.bytesBase64 === pre.bytesBase64;
  const destinationMatchesSource =
    destination !== null
    && source !== null
    && destination.size === source.size
    && destination.bytesBase64 === source.bytesBase64
    && (destination.identity.dev !== source.identity.dev || destination.identity.ino !== source.identity.ino);
  const valid =
    receipt.status === "succeeded"
    && receipt.operation === "file.copy"
    && receipt.effectsObserved.createdPaths?.length === 1
    && receipt.effectsObserved.mutationCommitted === true
    && sourceUnchanged
    && destinationMatchesSource;
  return valid ? achievedVerdict() : unmetVerdict(receipt);
}

export function fileBytesHelperPath(): string {
  return helperPath;
}
