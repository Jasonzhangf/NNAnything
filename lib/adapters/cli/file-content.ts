import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";

// S10: minimal fixed read-range capability. Direct observation (O), no policy
// head, no training.
//
// Open boundary (P1 fix): the pre-open lstat is not the security boundary by
// itself. Between lstat and open the path can be replaced. The fixed open
// strategy therefore:
//   - opens with O_NOFOLLOW, so a final symlink (including one swapped in
//     between lstat and open) fails with ELOOP instead of being followed;
//   - opens with O_NONBLOCK, so a FIFO swapped in between lstat and open
//     cannot block the process before the type check;
//   - compares dev/ino after open against the pre-open lstat, so a swap to a
//     different regular file is refused (READ_TARGET_CHANGED);
//   - checks the opened handle type via fstat and refuses anything that is
//     not a regular file.
// Only regular files are ever read; FIFO/socket/device streams are never
// treated as regular files. Zero-length reads are legal, still verify the
// target through the same open+identity check, and never claim EOF.

export type FileReadRange = Readonly<{
  kind: "read";
  absolutePath: string;
  offset: number;
  length: number;
  size: number; // file size at read time (bytes)
  bytes: string; // base64 of the actual bytes read
  bytesRead: number;
  eof: boolean; // short-read flag: bytesRead < length; NOT a real file-end signal
  end_observed: boolean; // real file end reached: offset + bytesRead >= size (empty file: true)
  observedRange: Readonly<{ offset: number; length: number }>;
  identity: Readonly<{ dev: number | string; ino: number | string }>;
}>;

export type FileReadResult =
  | Readonly<{ ok: true; observation: FileReadRange }>
  | Readonly<{ ok: false; error: { stage: "validate" | "observe"; code: string; message: string } }>;

export type FileReadLinesProcess = Readonly<{
  executable: "/usr/bin/head" | "/usr/bin/tail";
  argv: readonly ["-n", string];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  captureComplete: boolean;
  terminationReason: "exit" | "spawn_error" | "timeout" | "abort" | "stdout_limit" | "stderr_limit" | "stream_error" | "close_error";
}>;

export type FileReadLinesNativeResult = Readonly<{
  kind: "file.read.lines";
  absolutePath: string;
  anchor: "head" | "tail";
  requestedCount: number;
  bytes: string;
  bytesRead: number;
  logicalLines: number;
  identity: Readonly<{ dev: number | string; ino: number | string }>;
  executorInvoked: boolean;
}>;

export type FileReadLinesResult =
  | Readonly<{ ok: true; observation: FileReadLinesNativeResult; process: FileReadLinesProcess }>
  | Readonly<{ ok: false; error: { stage: "validate" | "observe"; code: string; message: string }; process?: FileReadLinesProcess; executorInvoked: boolean }>;

export type FileReadLinesOptions = Readonly<{
  timeoutMs: number;
  killGraceMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  signal?: AbortSignal;
}>;

export interface FileReadLinesIo extends FileReadIo {
  spawn(executable: string, argv: readonly string[], options: { readonly shell: false; readonly stdio: readonly [number, "pipe", "pipe"] }): ChildProcess;
}

/** Test seam mirrors collectDirectoryListing's io injection; defaults to the
 * real node:fs/promises implementations. */
export interface FileReadIo {
  lstat(path: string, options: { readonly bigint: true }): Promise<BigIntStats>;
  open(path: string, flags: number): Promise<FileHandle>;
  spawn?(executable: string, argv: readonly string[], options: { readonly shell: false; readonly stdio: readonly [number, "pipe", "pipe"] }): ChildProcess;
}

const defaultIo: FileReadIo = {
  lstat: lstat as FileReadIo["lstat"],
  open: open as FileReadIo["open"],
};

const defaultSpawn: FileReadLinesIo["spawn"] = (executable, argv, options) => spawn(executable, [...argv], { shell: false, stdio: [...options.stdio] });

function linesIoFrom(io: FileReadIo): FileReadLinesIo {
  return typeof io.spawn === "function" ? io as FileReadLinesIo : { ...io, spawn: defaultSpawn };
}

function failure(stage: "validate" | "observe", code: string, message: string): FileReadResult {
  return { ok: false, error: { stage, code, message } };
}

function errorCode(error: unknown): string | null {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return null;
  const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : null;
  return code && code.length > 0 ? code : null;
}

function kindOf(stats: BigIntStats): string {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isFIFO()) return "fifo";
  if (stats.isSocket()) return "socket";
  if (stats.isCharacterDevice()) return "character_device";
  if (stats.isBlockDevice()) return "block_device";
  return "other";
}

function osInteger(value: bigint): number | string {
  return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

function identityOf(stats: BigIntStats): FileReadRange["identity"] {
  return Object.freeze({ dev: osInteger(stats.dev), ino: osInteger(stats.ino) });
}

async function openVerifiedHandle(
  absolutePath: string,
  io: FileReadIo,
): Promise<Readonly<{ ok: true; before: BigIntStats; handle: FileHandle; after: BigIntStats }> | Readonly<{ ok: false; error: { stage: "validate" | "observe"; code: string; message: string } }>> {
  let before: BigIntStats;
  try {
    before = await io.lstat(absolutePath, { bigint: true });
  } catch (error) {
    const code = errorCode(error) ?? "EIO";
    return { ok: false, error: { stage: "observe", code, message: error instanceof Error ? error.message : String(error) } };
  }
  if (before.isSymbolicLink()) {
    return { ok: false, error: { stage: "observe", code: "ELOOP", message: "Refusing to read through a final symlink" } };
  }
  if (!before.isFile()) {
    return { ok: false, error: { stage: "observe", code: "READ_TYPE_DENIED", message: `Read is only allowed for regular files, not ${kindOf(before)}` } };
  }
  let handle: FileHandle | undefined;
  try {
    handle = await io.open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const after = await handle.stat({ bigint: true });
    if (!after.isFile()) {
      await handle.close().catch(() => undefined);
      return { ok: false, error: { stage: "observe", code: "READ_TYPE_DENIED", message: `Opened handle is not a regular file (${kindOf(after)})` } };
    }
    if (after.dev !== before.dev || after.ino !== before.ino) {
      await handle.close().catch(() => undefined);
      return { ok: false, error: { stage: "observe", code: "READ_TARGET_CHANGED", message: "Opened target identity differs from the inspected entry" } };
    }
    return { ok: true, before, handle, after };
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    const code = errorCode(error) ?? "EIO";
    return { ok: false, error: { stage: "observe", code, message: error instanceof Error ? error.message : String(error) } };
  }
}

export async function readFileRange(
  absolutePath: string,
  offset: number,
  length: number,
  io: FileReadIo = defaultIo,
): Promise<FileReadResult> {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return failure("validate", "EINVAL", "offset must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    return failure("validate", "EINVAL", "length must be a non-negative safe integer");
  }
  const opened = await openVerifiedHandle(absolutePath, io);
  if (!opened.ok) return failure(opened.error.stage, opened.error.code, opened.error.message);
  const { handle, after } = opened;
  try {
    if (length === 0) {
      // Legal zero-length read. The target was opened and identity checked.
      const size = Number(after.size);
      return { ok: true, observation: { kind: "read", absolutePath, offset, length, size, bytes: "", bytesRead: 0, eof: false, end_observed: offset >= size, observedRange: { offset, length }, identity: identityOf(after) } };
    }
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const bytes = bytesRead > 0 ? buffer.subarray(0, bytesRead) : Buffer.alloc(0);
    const size = Number(after.size);
    return { ok: true, observation: { kind: "read", absolutePath, offset, length, size, bytes: bytes.toString("base64"), bytesRead, eof: bytesRead < length, end_observed: offset + bytesRead >= size, observedRange: { offset, length }, identity: identityOf(after) } };
  } catch (error) {
    const code = errorCode(error) ?? "EIO";
    return failure("observe", code, error instanceof Error ? error.message : String(error));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function sameIdentity(value: number | string | null, actual: bigint): boolean {
  if (value === null) return false;
  try {
    return BigInt(value) === actual;
  } catch {
    return false;
  }
}

function positiveSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validFileReadLinesOptions(options: FileReadLinesOptions): string | null {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) return "timeoutMs must be a positive safe integer";
  if (!Number.isSafeInteger(options.killGraceMs) || options.killGraceMs <= 0) return "killGraceMs must be a positive safe integer";
  if (!positiveSafeInteger(options.maxStdoutBytes)) return "maxStdoutBytes must be a positive safe integer";
  if (!Number.isSafeInteger(options.maxStderrBytes) || options.maxStderrBytes < 0) return "maxStderrBytes must be a non-negative safe integer";
  if (options.signal !== undefined) {
    if (options.signal === null || typeof options.signal !== "object"
      || typeof options.signal.aborted !== "boolean"
      || typeof options.signal.addEventListener !== "function"
      || typeof options.signal.removeEventListener !== "function") {
      return "signal must be an AbortSignal";
    }
  }
  return null;
}

function logicalLineCount(stdout: Buffer): number {
  let count = 0;
  for (const byte of stdout) if (byte === 0x0a) count += 1;
  if (stdout.length > 0 && stdout[stdout.length - 1] !== 0x0a) count += 1;
  return count;
}

type NativeLineReadRun =
  | Readonly<{ ok: true; stdout: Buffer; process: FileReadLinesProcess }>
  | Readonly<{ ok: false; error: { stage: "validate" | "observe"; code: string; message: string }; process?: FileReadLinesProcess; executorInvoked: boolean }>;

function processReceipt(
  executable: "/usr/bin/head" | "/usr/bin/tail",
  argv: readonly ["-n", string],
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stderr: Buffer,
  captureComplete: boolean,
  terminationReason: FileReadLinesProcess["terminationReason"],
): FileReadLinesProcess {
  return Object.freeze({ executable, argv, exitCode, signal, stderr: stderr.toString("base64"), captureComplete, terminationReason });
}

async function runNativeLineRead(
  fd: number,
  anchor: "head" | "tail",
  requestedCount: number,
  options: FileReadLinesOptions,
  io: FileReadLinesIo,
): Promise<NativeLineReadRun> {
  const optionsError = validFileReadLinesOptions(options);
  if (optionsError !== null) {
    return { ok: false, error: { stage: "validate", code: "EINVAL", message: optionsError }, executorInvoked: false };
  }
  if (!positiveSafeInteger(requestedCount)) {
    return { ok: false, error: { stage: "validate", code: "EINVAL", message: "count must be a positive safe integer" }, executorInvoked: false };
  }
  if (options.signal?.aborted === true) {
    return { ok: false, error: { stage: "observe", code: "ABORT_ERR", message: "Native line read was aborted before spawn" }, executorInvoked: false };
  }
  const executable = anchor === "head" ? "/usr/bin/head" : "/usr/bin/tail";
  const argv = Object.freeze(["-n", String(requestedCount)] as const);
  let child: ChildProcess;
  try {
    child = io.spawn(executable, argv, { shell: false, stdio: [fd, "pipe", "pipe"] });
  } catch (error) {
    const process = processReceipt(executable, argv, null, null, Buffer.alloc(0), false, "spawn_error");
    return { ok: false, error: { stage: "observe", code: errorCode(error) ?? "SPAWN_ERROR", message: error instanceof Error ? error.message : String(error) }, process, executorInvoked: true };
  }
  return await new Promise<NativeLineReadRun>(resolve => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutComplete = true;
    let stderrComplete = true;
    let settled = false;
    let terminationReason: FileReadLinesProcess["terminationReason"] | null = null;
    let spawnErrorCode: string | null = null;
    let spawnErrorMessage = "";
    let timeout: NodeJS.Timeout | undefined;
    let killTimeout: NodeJS.Timeout | undefined;
    const abortListener = (): void => terminate("abort");

    const clearTimers = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (killTimeout !== undefined) clearTimeout(killTimeout);
      options.signal?.removeEventListener("abort", abortListener);
    };

    const terminate = (reason: FileReadLinesProcess["terminationReason"]): void => {
      if (terminationReason === null) terminationReason = reason;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      if (killTimeout === undefined) {
        killTimeout = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, options.killGraceMs);
      }
    };

    const capture = (chunk: Buffer, stream: "stdout" | "stderr"): void => {
      const max = stream === "stdout" ? options.maxStdoutBytes : options.maxStderrBytes;
      const current = stream === "stdout" ? stdoutBytes : stderrBytes;
      const remaining = max - current;
      if (remaining <= 0) {
        if (stream === "stdout") stdoutComplete = false; else stderrComplete = false;
        terminate(stream === "stdout" ? "stdout_limit" : "stderr_limit");
        return;
      }
      const saved = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      if (stream === "stdout") {
        stdoutChunks.push(saved);
        stdoutBytes += saved.length;
      } else {
        stderrChunks.push(saved);
        stderrBytes += saved.length;
      }
      if (saved.length !== chunk.length) {
        if (stream === "stdout") stdoutComplete = false; else stderrComplete = false;
        terminate(stream === "stdout" ? "stdout_limit" : "stderr_limit");
      }
    };

    child.stdout?.on("data", chunk => capture(Buffer.from(chunk), "stdout"));
    child.stderr?.on("data", chunk => capture(Buffer.from(chunk), "stderr"));
    child.stdout?.on("error", () => terminate("stream_error"));
    child.stderr?.on("error", () => terminate("stream_error"));
    if (child.stdout === null || child.stderr === null) terminate("stream_error");
    child.once("error", error => {
      spawnErrorCode = errorCode(error) ?? "SPAWN_ERROR";
      spawnErrorMessage = error instanceof Error ? error.message : String(error);
      terminate("spawn_error");
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      const stderr = Buffer.concat(stderrChunks);
      const captureComplete = stdoutComplete && stderrComplete && spawnErrorCode === null && terminationReason !== "stream_error";
      const reason = spawnErrorCode !== null ? "spawn_error" : terminationReason ?? "exit";
      const process = processReceipt(executable, argv, exitCode, signal, stderr, captureComplete, reason);
      if (reason === "exit" && exitCode === 0 && signal === null && captureComplete) {
        resolve({ ok: true, stdout: Buffer.concat(stdoutChunks), process });
        return;
      }
      let code: string;
      let message: string;
      if (spawnErrorCode !== null) {
        code = spawnErrorCode;
        message = spawnErrorMessage;
      } else if (reason === "timeout") {
        code = "ETIMEDOUT";
        message = `Native line read exceeded ${options.timeoutMs} ms`;
      } else if (reason === "abort") {
        code = "ABORT_ERR";
        message = "Native line read was aborted";
      } else if (reason === "stdout_limit") {
        code = "STDOUT_LIMIT";
        message = `Native line read stdout exceeded ${options.maxStdoutBytes} bytes`;
      } else if (reason === "stderr_limit") {
        code = "STDERR_LIMIT";
        message = `Native line read stderr exceeded ${options.maxStderrBytes} bytes`;
      } else if (reason === "stream_error") {
        code = "STREAM_ERROR";
        message = "Native line read output stream failed";
      } else if (signal !== null) {
        code = "PROCESS_SIGNAL";
        message = `Native line read exited on signal ${signal}`;
      } else {
        code = "PROCESS_EXIT";
        message = `Native line read exited with code ${String(exitCode)}`;
      }
      resolve({ ok: false, error: { stage: "observe", code, message }, process, executorInvoked: true });
    });

    if (options.signal !== undefined) options.signal.addEventListener("abort", abortListener, { once: true });
    timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);
    if (options.signal?.aborted === true) abortListener();
  });
}

export async function readFileLines(
  absolutePath: string,
  anchor: "head" | "tail",
  requestedCount: number,
  options: FileReadLinesOptions,
  expectedIdentity: Readonly<{ dev: number | string | null; ino: number | string | null }> | undefined,
  io: FileReadIo = defaultIo,
): Promise<FileReadLinesResult> {
  const optionsError = validFileReadLinesOptions(options);
  if (optionsError !== null) {
    return { ok: false, error: { stage: "validate", code: "EINVAL", message: optionsError }, executorInvoked: false };
  }
  if (!positiveSafeInteger(requestedCount)) {
    return { ok: false, error: { stage: "validate", code: "EINVAL", message: "count must be a positive safe integer" }, executorInvoked: false };
  }
  if (options.signal?.aborted === true) {
    return { ok: false, error: { stage: "observe", code: "ABORT_ERR", message: "Native line read was aborted before open" }, executorInvoked: false };
  }
  const opened = await openVerifiedHandle(absolutePath, io);
  if (!opened.ok) {
    return { ok: false, error: opened.error, executorInvoked: false };
  }
  const { handle, after } = opened;
  try {
    if (expectedIdentity !== undefined
      && (!sameIdentity(expectedIdentity.dev, after.dev) || !sameIdentity(expectedIdentity.ino, after.ino))) {
      return { ok: false, error: { stage: "observe", code: "STALE_REFERENCE", message: "Opened file identity no longer matches the trusted reference" }, executorInvoked: false };
    }
    const run = await runNativeLineRead(handle.fd, anchor, requestedCount, options, linesIoFrom(io));
    if (!run.ok) return run;
    return {
      ok: true,
      process: run.process,
      observation: Object.freeze({
        kind: "file.read.lines",
        absolutePath,
        anchor,
        requestedCount,
        bytes: run.stdout.toString("base64"),
        bytesRead: run.stdout.length,
        logicalLines: logicalLineCount(run.stdout),
        identity: identityOf(after),
        executorInvoked: true,
      }),
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
