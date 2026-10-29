import * as fs from "node:fs";
import type { BigIntStats } from "node:fs";
import { constants } from "node:fs";
import { join } from "node:path";
import {
  validateFileBytesHelperRequest,
  type CliFileBytesEffectsObserved,
  type CliFileBytesErrorCode,
  type CliFileBytesHelperReceipt,
  type CliFileBytesHelperRequest,
  type CliFileBytesOperation,
  type CliFileByteSnapshot,
} from "./file-bytes.js";

type ExistingRequest = Extract<CliFileBytesHelperRequest, { operation: "file.replace" | "file.write" | "file.append" | "file.truncate" }>;

function codeOf(error: unknown): string | null {
  if (error !== null && (typeof error === "object" || typeof error === "function") && "code" in error) {
    const code = String(error.code);
    return code && code !== "undefined" ? code : null;
  }
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function effects(
  attempted: boolean,
  mutationCommitted: boolean,
  modifiedPaths: readonly string[],
  createdPaths: readonly string[],
  bytesWritten: number,
): CliFileBytesEffectsObserved {
  return Object.freeze({
    attempted,
    mutationCommitted,
    modifiedPaths: Object.freeze([...modifiedPaths]),
    createdPaths: Object.freeze([...createdPaths]),
    bytesWritten,
  });
}

function makeReceipt(input: Readonly<{
  operation: CliFileBytesOperation;
  status: CliFileBytesHelperReceipt["status"];
  errorCode: CliFileBytesErrorCode | null;
  errno: string | null;
  message: string | null;
  openFlagsUsed: number | null;
  preWriteSnapshot: CliFileByteSnapshot | null;
  postWriteSnapshot: CliFileByteSnapshot | null;
  sourceSnapshot: CliFileByteSnapshot | null;
  destinationSnapshot: CliFileByteSnapshot | null;
  bytesWritten: number;
  effectsObserved: CliFileBytesEffectsObserved;
}>): CliFileBytesHelperReceipt {
  return Object.freeze({
    ok: input.status === "succeeded",
    operation: input.operation,
    status: input.status,
    errorCode: input.errorCode,
    errno: input.errno,
    message: input.message,
    openFlagsUsed: input.openFlagsUsed,
    preWriteSnapshot: input.preWriteSnapshot,
    postWriteSnapshot: input.postWriteSnapshot,
    sourceSnapshot: input.sourceSnapshot,
    destinationSnapshot: input.destinationSnapshot,
    bytesWritten: input.bytesWritten,
    effectsObserved: input.effectsObserved,
  });
}

function identityOf(stats: BigIntStats): CliFileByteSnapshot["identity"] {
  return Object.freeze({ dev: stats.dev.toString(), ino: stats.ino.toString() });
}

function readExactSnapshotBytes(
  fd: number,
  expectedSize: number,
): Readonly<{ ok: true; buf: Buffer }> | Readonly<{ ok: false; bytesRead: number; errno: string | null }> {
  if (expectedSize === 0) return { ok: true, buf: Buffer.alloc(0) };
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) return { ok: false, bytesRead: 0, errno: null };
  let buf: Buffer;
  try {
    buf = Buffer.alloc(expectedSize);
  } catch {
    return { ok: false, bytesRead: 0, errno: null };
  }
  let totalRead = 0;
  while (totalRead < expectedSize) {
    let n: number;
    try {
      n = fs.readSync(fd, buf, totalRead, expectedSize - totalRead, totalRead);
    } catch (error) {
      return { ok: false, bytesRead: totalRead, errno: codeOf(error) };
    }
    if (n <= 0) return { ok: false, bytesRead: totalRead, errno: null };
    totalRead += n;
  }
  return { ok: true, buf };
}

function snapshot(fd: number, stats: BigIntStats): CliFileByteSnapshot {
  return Object.freeze({
    identity: identityOf(stats),
    size: Number(stats.size),
    bytesBase64: "",
    mtimeMs: Number(stats.mtimeMs),
    ctimeMs: Number(stats.ctimeMs),
    mode: Number(stats.mode),
    nlink: Number(stats.nlink),
  });
}

function completeSnapshot(fd: number, stats: BigIntStats): CliFileByteSnapshot | null {
  const base = snapshot(fd, stats);
  const read = readExactSnapshotBytes(fd, base.size);
  if (!read.ok) return null;
  return Object.freeze({ ...base, bytesBase64: read.buf.toString("base64") });
}

function mapOpenError(code: string | null, operation: CliFileBytesOperation): CliFileBytesErrorCode {
  if (code === "ENOENT") return "TARGET_MISSING";
  if (code === "EACCES" || code === "EPERM") return "PERMISSION_DENIED";
  if (code === "ELOOP" || code === "EISDIR" || code === "ENXIO") return "READ_TYPE_DENIED";
  if (operation === "file.copy" && code === "EEXIST") return "TARGET_EXISTS";
  return "IO_ERROR";
}

function mapParentError(code: string | null): CliFileBytesErrorCode {
  if (code === "EACCES" || code === "EPERM") return "PERMISSION_DENIED";
  return "PARENT_NOT_DIRECTORY";
}

function close(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    // A descriptor may already be closed on a prior failure path.
  }
}

function readRequest(request: unknown): CliFileBytesHelperRequest {
  return validateFileBytesHelperRequest(request);
}

function writeAll(fd: number, buf: Buffer, position: number | null): number {
  let written = 0;
  try {
    while (written < buf.length) {
      const remaining = buf.length - written;
      const n = position === null
        ? fs.writeSync(fd, buf, written, remaining, null)
        : fs.writeSync(fd, buf, written, remaining, position + written);
      if (n <= 0) throw Object.assign(new Error("write returned no bytes"), { code: "EIO" });
      written += n;
    }
    return written;
  } catch (error) {
    throw Object.assign(new Error(messageOf(error)), { code: codeOf(error) ?? "EIO", bytesWritten: written });
  }
}

function openExisting(
  request: ExistingRequest,
  flags: number,
): Readonly<{ fd: number; pre: CliFileByteSnapshot; flags: number }> | Readonly<{ receipt: CliFileBytesHelperReceipt }> {
  let fd: number;
  try {
    fd = fs.openSync(request.targetPath, flags);
  } catch (error) {
    const errno = codeOf(error) ?? "EIO";
    return {
      receipt: makeReceipt({
        operation: request.operation,
        status: "failed",
        errorCode: mapOpenError(errno, request.operation),
        errno,
        message: messageOf(error),
        openFlagsUsed: flags,
        preWriteSnapshot: null,
        postWriteSnapshot: null,
        sourceSnapshot: null,
        destinationSnapshot: null,
        bytesWritten: 0,
        effectsObserved: effects(true, false, [], [], 0),
      }),
    };
  }

  let stats: BigIntStats;
  try {
    stats = fs.fstatSync(fd, { bigint: true });
  } catch (error) {
    const errno = codeOf(error) ?? "EIO";
    close(fd);
    return {
      receipt: makeReceipt({
        operation: request.operation,
        status: "failed",
        errorCode: "IO_ERROR",
        errno,
        message: messageOf(error),
        openFlagsUsed: flags,
        preWriteSnapshot: null,
        postWriteSnapshot: null,
        sourceSnapshot: null,
        destinationSnapshot: null,
        bytesWritten: 0,
        effectsObserved: effects(true, false, [], [], 0),
      }),
    };
  }

  if (!stats.isFile()) {
    close(fd);
    return {
      receipt: makeReceipt({
        operation: request.operation,
        status: "failed",
        errorCode: "READ_TYPE_DENIED",
        errno: null,
        message: "target is not a regular file",
        openFlagsUsed: flags,
        preWriteSnapshot: null,
        postWriteSnapshot: null,
        sourceSnapshot: null,
        destinationSnapshot: null,
        bytesWritten: 0,
        effectsObserved: effects(true, false, [], [], 0),
      }),
    };
  }

  const identity = identityOf(stats);
  if (identity.dev !== request.expectedIdentity.dev || identity.ino !== request.expectedIdentity.ino) {
    close(fd);
    return {
      receipt: makeReceipt({
        operation: request.operation,
        status: "failed",
        errorCode: "STALE_REFERENCE",
        errno: null,
        message: "opened target identity differs from the inspected entry",
        openFlagsUsed: flags,
        preWriteSnapshot: null,
        postWriteSnapshot: null,
        sourceSnapshot: null,
        destinationSnapshot: null,
        bytesWritten: 0,
        effectsObserved: effects(true, false, [], [], 0),
      }),
    };
  }

  const pre = completeSnapshot(fd, stats);
  if (pre === null) {
    close(fd);
    return {
      receipt: makeReceipt({
        operation: request.operation,
        status: "failed",
        errorCode: "PRE_READ_INCOMPLETE",
        errno: null,
        message: "pre-mutation snapshot was incomplete",
        openFlagsUsed: flags,
        preWriteSnapshot: null,
        postWriteSnapshot: null,
        sourceSnapshot: null,
        destinationSnapshot: null,
        bytesWritten: 0,
        effectsObserved: effects(false, false, [], [], 0),
      }),
    };
  }

  return { fd, pre, flags };
}

function finishExisting(
  operation: CliFileBytesOperation,
  fd: number,
  flags: number,
  pre: CliFileByteSnapshot,
  effectsObserved: CliFileBytesEffectsObserved,
  bytesWritten: number,
): CliFileBytesHelperReceipt {
  let stats: BigIntStats;
  try {
    stats = fs.fstatSync(fd, { bigint: true });
  } catch (error) {
    close(fd);
    return makeReceipt({
      operation,
      status: "unknown",
      errorCode: "POST_READ_FAILED",
      errno: codeOf(error),
      message: messageOf(error),
      openFlagsUsed: flags,
      preWriteSnapshot: pre,
      postWriteSnapshot: null,
      sourceSnapshot: null,
      destinationSnapshot: null,
      bytesWritten,
      effectsObserved,
    });
  }
  const post = completeSnapshot(fd, stats);
  close(fd);
  if (post === null) {
    return makeReceipt({
      operation,
      status: "unknown",
      errorCode: "POST_READ_FAILED",
      errno: null,
      message: "post-mutation snapshot was incomplete",
      openFlagsUsed: flags,
      preWriteSnapshot: pre,
      postWriteSnapshot: null,
      sourceSnapshot: null,
      destinationSnapshot: null,
      bytesWritten,
      effectsObserved,
    });
  }
  return makeReceipt({
    operation,
    status: "succeeded",
    errorCode: null,
    errno: null,
    message: null,
    openFlagsUsed: flags,
    preWriteSnapshot: pre,
    postWriteSnapshot: post,
    sourceSnapshot: null,
    destinationSnapshot: null,
    bytesWritten,
    effectsObserved,
  });
}

function existingMutationFailure(
  operation: CliFileBytesOperation,
  fd: number,
  flags: number,
  pre: CliFileByteSnapshot,
  error: unknown,
  bytesWritten: number,
  mutationCommitted: boolean,
  modifiedPaths: readonly string[],
): CliFileBytesHelperReceipt {
  let stats: BigIntStats | null = null;
  try {
    stats = fs.fstatSync(fd, { bigint: true });
  } catch {
    stats = null;
  }
  const post = stats === null ? null : completeSnapshot(fd, stats);
  close(fd);
  return makeReceipt({
    operation,
    status: "failed",
    errorCode: "IO_ERROR",
    errno: codeOf(error) ?? "EIO",
    message: messageOf(error),
    openFlagsUsed: flags,
    preWriteSnapshot: pre,
    postWriteSnapshot: post,
    sourceSnapshot: null,
    destinationSnapshot: null,
    bytesWritten,
    effectsObserved: effects(true, mutationCommitted, modifiedPaths, [], bytesWritten),
  });
}

function replace(request: Extract<CliFileBytesHelperRequest, { operation: "file.replace" }>): CliFileBytesHelperReceipt {
  const flags = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const opened = openExisting(request, flags);
  if ("receipt" in opened) return opened.receipt;
  const { fd, pre } = opened;
  let bytesWritten = 0;
  let mutationCommitted = false;
  try {
    fs.ftruncateSync(fd, 0);
    mutationCommitted = true;
    bytesWritten = writeAll(fd, Buffer.from(request.content.base64, "base64"), 0);
  } catch (error) {
    bytesWritten = typeof (error as { bytesWritten?: unknown }).bytesWritten === "number"
      ? (error as { bytesWritten: number }).bytesWritten
      : bytesWritten;
    return existingMutationFailure(request.operation, fd, flags, pre, error, bytesWritten, mutationCommitted, [request.targetPath]);
  }
  return finishExisting(
    request.operation,
    fd,
    flags,
    pre,
    effects(true, mutationCommitted, [request.targetPath], [], bytesWritten),
    bytesWritten,
  );
}

function write(request: Extract<CliFileBytesHelperRequest, { operation: "file.write" }>): CliFileBytesHelperReceipt {
  const flags = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const opened = openExisting(request, flags);
  if ("receipt" in opened) return opened.receipt;
  const { fd, pre } = opened;
  const payload = Buffer.from(request.content.base64, "base64");
  let bytesWritten = 0;
  let mutationCommitted = false;
  try {
    if (payload.length === 0) {
      fs.writeSync(fd, payload, 0, 0, request.offset);
    } else {
      bytesWritten = writeAll(fd, payload, request.offset);
      mutationCommitted = true;
    }
  } catch (error) {
    bytesWritten = typeof (error as { bytesWritten?: unknown }).bytesWritten === "number"
      ? (error as { bytesWritten: number }).bytesWritten
      : bytesWritten;
    return existingMutationFailure(
      request.operation,
      fd,
      flags,
      pre,
      error,
      bytesWritten,
      mutationCommitted || bytesWritten > 0,
      bytesWritten > 0 ? [request.targetPath] : [],
    );
  }
  return finishExisting(
    request.operation,
    fd,
    flags,
    pre,
    effects(true, mutationCommitted, mutationCommitted ? [request.targetPath] : [], [], bytesWritten),
    bytesWritten,
  );
}

function append(request: Extract<CliFileBytesHelperRequest, { operation: "file.append" }>): CliFileBytesHelperReceipt {
  const flags = constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const opened = openExisting(request, flags);
  if ("receipt" in opened) return opened.receipt;
  const { fd, pre } = opened;
  let bytesWritten = 0;
  let mutationCommitted = false;
  try {
    bytesWritten = writeAll(fd, Buffer.from(request.content.base64, "base64"), null);
    mutationCommitted = bytesWritten > 0;
  } catch (error) {
    bytesWritten = typeof (error as { bytesWritten?: unknown }).bytesWritten === "number"
      ? (error as { bytesWritten: number }).bytesWritten
      : bytesWritten;
    return existingMutationFailure(
      request.operation,
      fd,
      flags,
      pre,
      error,
      bytesWritten,
      mutationCommitted || bytesWritten > 0,
      bytesWritten > 0 ? [request.targetPath] : [],
    );
  }
  return finishExisting(
    request.operation,
    fd,
    flags,
    pre,
    effects(true, mutationCommitted, mutationCommitted ? [request.targetPath] : [], [], bytesWritten),
    bytesWritten,
  );
}

function truncate(request: Extract<CliFileBytesHelperRequest, { operation: "file.truncate" }>): CliFileBytesHelperReceipt {
  const flags = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const opened = openExisting(request, flags);
  if ("receipt" in opened) return opened.receipt;
  const { fd, pre } = opened;
  try {
    fs.ftruncateSync(fd, request.length);
  } catch (error) {
    return existingMutationFailure(request.operation, fd, flags, pre, error, 0, false, []);
  }
  return finishExisting(
    request.operation,
    fd,
    flags,
    pre,
    effects(true, true, [request.targetPath], [], 0),
    0,
  );
}

function copy(request: Extract<CliFileBytesHelperRequest, { operation: "file.copy" }>): CliFileBytesHelperReceipt {
  const sourceFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let flags = sourceFlags;
  let srcFd: number;
  try {
    srcFd = fs.openSync(request.sourcePath, sourceFlags);
  } catch (error) {
    const errno = codeOf(error) ?? "EIO";
    return makeReceipt({
      operation: "file.copy",
      status: "failed",
      errorCode: mapOpenError(errno, "file.copy"),
      errno,
      message: messageOf(error),
      openFlagsUsed: flags,
      preWriteSnapshot: null,
      postWriteSnapshot: null,
      sourceSnapshot: null,
      destinationSnapshot: null,
      bytesWritten: 0,
      effectsObserved: effects(true, false, [], [], 0),
    });
  }

  let sourceStats: BigIntStats;
  try {
    sourceStats = fs.fstatSync(srcFd, { bigint: true });
  } catch (error) {
    close(srcFd);
    return makeReceipt({
      operation: "file.copy",
      status: "failed",
      errorCode: "IO_ERROR",
      errno: codeOf(error),
      message: messageOf(error),
      openFlagsUsed: flags,
      preWriteSnapshot: null,
      postWriteSnapshot: null,
      sourceSnapshot: null,
      destinationSnapshot: null,
      bytesWritten: 0,
      effectsObserved: effects(true, false, [], [], 0),
    });
  }

  if (!sourceStats.isFile()) {
    close(srcFd);
    return makeReceipt({
      operation: "file.copy",
      status: "failed",
      errorCode: "READ_TYPE_DENIED",
      errno: null,
      message: "source is not a regular file",
      openFlagsUsed: flags,
      preWriteSnapshot: null,
      postWriteSnapshot: null,
      sourceSnapshot: null,
      destinationSnapshot: null,
      bytesWritten: 0,
      effectsObserved: effects(true, false, [], [], 0),
    });
  }

  const sourceIdentity = identityOf(sourceStats);
  if (sourceIdentity.dev !== request.expectedSourceIdentity.dev || sourceIdentity.ino !== request.expectedSourceIdentity.ino) {
    close(srcFd);
    return makeReceipt({
      operation: "file.copy",
      status: "failed",
      errorCode: "STALE_REFERENCE",
      errno: null,
      message: "opened source identity differs from the inspected entry",
      openFlagsUsed: flags,
      preWriteSnapshot: null,
      postWriteSnapshot: null,
      sourceSnapshot: null,
      destinationSnapshot: null,
      bytesWritten: 0,
      effectsObserved: effects(true, false, [], [], 0),
    });
  }

  const pre = completeSnapshot(srcFd, sourceStats);
  if (pre === null) {
    close(srcFd);
    return makeReceipt({
      operation: "file.copy",
      status: "failed",
      errorCode: "PRE_READ_INCOMPLETE",
      errno: null,
      message: "pre-copy source snapshot was incomplete",
      openFlagsUsed: flags,
      preWriteSnapshot: null,
      postWriteSnapshot: null,
      sourceSnapshot: null,
      destinationSnapshot: null,
      bytesWritten: 0,
      effectsObserved: effects(false, false, [], [], 0),
    });
  }

  let parentStats: BigIntStats;
  try {
    parentStats = fs.lstatSync(request.destinationParentPath, { bigint: true });
  } catch (error) {
    close(srcFd);
    const errno = codeOf(error) ?? "EIO";
    return makeReceipt({
      operation: "file.copy",
      status: "failed",
      errorCode: mapParentError(errno),
      errno,
      message: messageOf(error),
      openFlagsUsed: flags,
      preWriteSnapshot: pre,
      postWriteSnapshot: null,
      sourceSnapshot: null,
      destinationSnapshot: null,
      bytesWritten: 0,
      effectsObserved: effects(true, false, [], [], 0),
    });
  }
  if (!parentStats.isDirectory()) {
    close(srcFd);
    return makeReceipt({
      operation: "file.copy",
      status: "failed",
      errorCode: "PARENT_NOT_DIRECTORY",
      errno: null,
      message: "destination parent is not a directory",
      openFlagsUsed: flags,
      preWriteSnapshot: pre,
      postWriteSnapshot: null,
      sourceSnapshot: null,
      destinationSnapshot: null,
      bytesWritten: 0,
      effectsObserved: effects(true, false, [], [], 0),
    });
  }
  const parentIdentity = identityOf(parentStats);
  if (parentIdentity.dev !== request.expectedParentIdentity.dev || parentIdentity.ino !== request.expectedParentIdentity.ino) {
    close(srcFd);
    return makeReceipt({
      operation: "file.copy",
      status: "failed",
      errorCode: "STALE_REFERENCE",
      errno: null,
      message: "destination parent identity differs from the inspected entry",
      openFlagsUsed: flags,
      preWriteSnapshot: pre,
      postWriteSnapshot: null,
      sourceSnapshot: null,
      destinationSnapshot: null,
      bytesWritten: 0,
      effectsObserved: effects(true, false, [], [], 0),
    });
  }

  const destPath = join(request.destinationParentPath, request.destinationName);
  const destFlags = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  flags = sourceFlags | destFlags;
  let destFd: number;
  try {
    destFd = fs.openSync(destPath, destFlags, Number(sourceStats.mode) & 0o777);
  } catch (error) {
    close(srcFd);
    const errno = codeOf(error) ?? "EIO";
    return makeReceipt({
      operation: "file.copy",
      status: "failed",
      errorCode: mapOpenError(errno, "file.copy"),
      errno,
      message: messageOf(error),
      openFlagsUsed: flags,
      preWriteSnapshot: pre,
      postWriteSnapshot: null,
      sourceSnapshot: null,
      destinationSnapshot: null,
      bytesWritten: 0,
      effectsObserved: effects(true, false, [], [], 0),
    });
  }

  const createdEffects = effects(true, true, [], [destPath], 0);
  let destStats: BigIntStats;
  try {
    destStats = fs.fstatSync(destFd, { bigint: true });
  } catch (error) {
    close(destFd);
    close(srcFd);
    return makeReceipt({
      operation: "file.copy",
      status: "failed",
      errorCode: "IO_ERROR",
      errno: codeOf(error),
      message: messageOf(error),
      openFlagsUsed: flags,
      preWriteSnapshot: pre,
      postWriteSnapshot: null,
      sourceSnapshot: null,
      destinationSnapshot: null,
      bytesWritten: 0,
      effectsObserved: createdEffects,
    });
  }
  if (!destStats.isFile()) {
    close(destFd);
    close(srcFd);
    return makeReceipt({
      operation: "file.copy",
      status: "failed",
      errorCode: "READ_TYPE_DENIED",
      errno: null,
      message: "destination is not a regular file",
      openFlagsUsed: flags,
      preWriteSnapshot: pre,
      postWriteSnapshot: null,
      sourceSnapshot: null,
      destinationSnapshot: null,
      bytesWritten: 0,
      effectsObserved: createdEffects,
    });
  }

  const destIdentity = identityOf(destStats);
  if (destIdentity.dev === sourceIdentity.dev && destIdentity.ino === sourceIdentity.ino) {
    close(destFd);
    close(srcFd);
    return makeReceipt({
      operation: "file.copy",
      status: "failed",
      errorCode: "SAME_ENTRY_CONFLICT",
      errno: null,
      message: "destination resolves to the source object",
      openFlagsUsed: flags,
      preWriteSnapshot: pre,
      postWriteSnapshot: null,
      sourceSnapshot: null,
      destinationSnapshot: null,
      bytesWritten: 0,
      effectsObserved: createdEffects,
    });
  }

  const sourceBytes = Buffer.from(pre.bytesBase64, "base64");
  let bytesWritten = 0;
  try {
    bytesWritten = writeAll(destFd, sourceBytes, 0);
  } catch (error) {
    bytesWritten = typeof (error as { bytesWritten?: unknown }).bytesWritten === "number"
      ? (error as { bytesWritten: number }).bytesWritten
      : bytesWritten;
    close(destFd);
    close(srcFd);
    return makeReceipt({
      operation: "file.copy",
      status: "failed",
      errorCode: "IO_ERROR",
      errno: codeOf(error) ?? "EIO",
      message: messageOf(error),
      openFlagsUsed: flags,
      preWriteSnapshot: pre,
      postWriteSnapshot: null,
      sourceSnapshot: null,
      destinationSnapshot: null,
      bytesWritten,
      effectsObserved: effects(true, true, [], [destPath], bytesWritten),
    });
  }

  let sourceStatsAfter: BigIntStats;
  try {
    sourceStatsAfter = fs.fstatSync(srcFd, { bigint: true });
  } catch (error) {
    close(destFd);
    close(srcFd);
    return makeReceipt({
      operation: "file.copy",
      status: "unknown",
      errorCode: "POST_READ_FAILED",
      errno: codeOf(error),
      message: messageOf(error),
      openFlagsUsed: flags,
      preWriteSnapshot: pre,
      postWriteSnapshot: null,
      sourceSnapshot: null,
      destinationSnapshot: null,
      bytesWritten,
      effectsObserved: effects(true, true, [], [destPath], bytesWritten),
    });
  }
  const sourceSnapshot = completeSnapshot(srcFd, sourceStatsAfter);
  let destStatsAfter: BigIntStats;
  try {
    destStatsAfter = fs.fstatSync(destFd, { bigint: true });
  } catch (error) {
    close(destFd);
    close(srcFd);
    return makeReceipt({
      operation: "file.copy",
      status: "unknown",
      errorCode: "POST_READ_FAILED",
      errno: codeOf(error),
      message: messageOf(error),
      openFlagsUsed: flags,
      preWriteSnapshot: pre,
      postWriteSnapshot: null,
      sourceSnapshot,
      destinationSnapshot: null,
      bytesWritten,
      effectsObserved: effects(true, true, [], [destPath], bytesWritten),
    });
  }
  const destinationSnapshot = completeSnapshot(destFd, destStatsAfter);
  close(destFd);
  close(srcFd);
  if (sourceSnapshot === null || destinationSnapshot === null) {
    return makeReceipt({
      operation: "file.copy",
      status: "unknown",
      errorCode: "POST_READ_FAILED",
      errno: null,
      message: "post-copy snapshot was incomplete",
      openFlagsUsed: flags,
      preWriteSnapshot: pre,
      postWriteSnapshot: null,
      sourceSnapshot,
      destinationSnapshot,
      bytesWritten,
      effectsObserved: effects(true, true, [], [destPath], bytesWritten),
    });
  }
  return makeReceipt({
    operation: "file.copy",
    status: "succeeded",
    errorCode: null,
    errno: null,
    message: null,
    openFlagsUsed: flags,
    preWriteSnapshot: pre,
    postWriteSnapshot: null,
    sourceSnapshot,
    destinationSnapshot,
    bytesWritten,
    effectsObserved: effects(true, true, [], [destPath], bytesWritten),
  });
}

function execute(request: CliFileBytesHelperRequest): CliFileBytesHelperReceipt {
  switch (request.operation) {
    case "file.replace":
      return replace(request);
    case "file.write":
      return write(request);
    case "file.append":
      return append(request);
    case "file.truncate":
      return truncate(request);
    case "file.copy":
      return copy(request);
  }
}

async function main(): Promise<void> {
  const operation = process.argv[2];
  if (process.argv.length !== 3 || (operation !== "file.replace"
    && operation !== "file.write"
    && operation !== "file.append"
    && operation !== "file.truncate"
    && operation !== "file.copy")) {
    throw Object.assign(new TypeError("Usage: file-bytes-helper.js <file operation> < typed-json-stdin"), { code: "EINVAL" });
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const request = readRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (request.operation !== operation) {
    throw Object.assign(new TypeError("stdin request operation does not match argv"), { code: "EINVAL" });
  }
  process.stdout.write(`${JSON.stringify(execute(request))}\n`);
}

function writeFailure(error: unknown): void {
  const operation = process.argv[2] as CliFileBytesOperation | undefined;
  const fallback = operation && ["file.replace", "file.write", "file.append", "file.truncate", "file.copy"].includes(operation)
    ? operation
    : "file.replace";
  const receipt = makeReceipt({
    operation: fallback,
    status: "failed",
    errorCode: "IO_ERROR",
    errno: codeOf(error) ?? "EINVAL",
    message: messageOf(error),
    openFlagsUsed: null,
    preWriteSnapshot: null,
    postWriteSnapshot: null,
    sourceSnapshot: null,
    destinationSnapshot: null,
    bytesWritten: 0,
    effectsObserved: effects(false, false, [], [], 0),
  });
  process.stderr.write(`${JSON.stringify(receipt)}\n`);
  process.exitCode = 1;
}

main().catch(writeFailure);
