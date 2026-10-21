import { lstat, open } from "node:fs/promises";

// S10: minimal fixed read-range capability. Direct observation (O), no policy
// head, no training. Reads only regular files; refuses final symlinks and
// FIFO/socket/device/directory before opening the byte stream. Zero-length
// reads are legal but still verify the target is a regular file; they never
// claim EOF by themselves.

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

function failure(stage: "validate" | "observe", code: string, message: string): FileReadResult {
  return { ok: false, error: { stage, code, message } };
}

function errorCode(error: unknown): string | null {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return null;
  const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : null;
  return code && code.length > 0 ? code : null;
}

function kindOf(stats: Awaited<ReturnType<typeof lstat>>): string {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isFIFO()) return "fifo";
  if (stats.isSocket()) return "socket";
  if (stats.isCharacterDevice()) return "character_device";
  if (stats.isBlockDevice()) return "block_device";
  return "other";
}

export async function readFileRange(absolutePath: string, offset: number, length: number): Promise<FileReadResult> {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return failure("validate", "EINVAL", "offset must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    return failure("validate", "EINVAL", "length must be a non-negative safe integer");
  }
  let stats;
  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    const code = errorCode(error) ?? "EIO";
    return failure("observe", code, error instanceof Error ? error.message : String(error));
  }
  if (stats.isSymbolicLink()) {
    return failure("observe", "ELOOP", "Refusing to read through a final symlink");
  }
  if (!stats.isFile()) {
    return failure("observe", "READ_TYPE_DENIED", `Read is only allowed for regular files, not ${kindOf(stats)}`);
  }
  if (length === 0) {
    // Legal zero-length read. We do not claim EOF.
    return { ok: true, observation: { kind: "read", absolutePath, offset, length, size: Number(stats.size), bytes: "", bytesRead: 0, eof: false, observedRange: { offset, length } } };
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(absolutePath, "r");
    const handleStats = await handle.stat();
    if (!handleStats.isFile()) {
      return failure("observe", "READ_TYPE_DENIED", "Opened handle is not a regular file");
    }
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const bytes = bytesRead > 0 ? buffer.subarray(0, bytesRead) : Buffer.alloc(0);
    return { ok: true, observation: { kind: "read", absolutePath, offset, length, size: Number(handleStats.size), bytes: bytes.toString("base64"), bytesRead, eof: bytesRead < length, observedRange: { offset, length } } };
  } catch (error) {
    const code = errorCode(error) ?? "EIO";
    return failure("observe", code, error instanceof Error ? error.message : String(error));
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
}