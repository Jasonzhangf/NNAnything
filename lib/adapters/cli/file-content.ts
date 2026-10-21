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
  eof: boolean;
  observedRange: Readonly<{ offset: number; length: number }>;
}>;

export type FileReadResult =
  | Readonly<{ ok: true; observation: FileReadRange }>
  | Readonly<{ ok: false; error: { stage: "validate" | "observe"; code: string; message: string } }>;

/** Test seam mirrors collectDirectoryListing's io injection; defaults to the
 * real node:fs/promises implementations. */
export interface FileReadIo {
  lstat(path: string, options: { readonly bigint: true }): Promise<BigIntStats>;
  open(path: string, flags: number): Promise<FileHandle>;
}

const defaultIo: FileReadIo = {
  lstat: lstat as FileReadIo["lstat"],
  open: open as FileReadIo["open"],
};

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
  let before: BigIntStats;
  try {
    before = await io.lstat(absolutePath, { bigint: true });
  } catch (error) {
    const code = errorCode(error) ?? "EIO";
    return failure("observe", code, error instanceof Error ? error.message : String(error));
  }
  if (before.isSymbolicLink()) {
    return failure("observe", "ELOOP", "Refusing to read through a final symlink");
  }
  if (!before.isFile()) {
    return failure("observe", "READ_TYPE_DENIED", `Read is only allowed for regular files, not ${kindOf(before)}`);
  }
  let handle: FileHandle | undefined;
  try {
    handle = await io.open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const after = await handle.stat({ bigint: true });
    if (!after.isFile()) {
      return failure("observe", "READ_TYPE_DENIED", `Opened handle is not a regular file (${kindOf(after)})`);
    }
    if (after.dev !== before.dev || after.ino !== before.ino) {
      return failure("observe", "READ_TARGET_CHANGED", "Opened target identity differs from the inspected entry");
    }
    if (length === 0) {
      // Legal zero-length read. The target was opened and identity checked.
      return { ok: true, observation: { kind: "read", absolutePath, offset, length, size: Number(after.size), bytes: "", bytesRead: 0, eof: false, observedRange: { offset, length } } };
    }
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const bytes = bytesRead > 0 ? buffer.subarray(0, bytesRead) : Buffer.alloc(0);
    return { ok: true, observation: { kind: "read", absolutePath, offset, length, size: Number(after.size), bytes: bytes.toString("base64"), bytesRead, eof: bytesRead < length, observedRange: { offset, length } } };
  } catch (error) {
    const code = errorCode(error) ?? "EIO";
    return failure("observe", code, error instanceof Error ? error.message : String(error));
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
}