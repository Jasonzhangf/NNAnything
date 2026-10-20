import { execFile } from "node:child_process";
import { lstat as nativeLstat, readdir as nativeReaddir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { expectRecord } from "../../core/schema.js";
import type { CliFailure } from "./observation.js";

export type DirectoryEntryType = "file" | "directory" | "symlink" | "other" | "unknown";

export type DirectoryListingEntry = Readonly<{
  name: string;
  path: string;
  type: DirectoryEntryType;
}>;

export type DirectoryListingError = Readonly<{
  name: string;
  code: string;
  message: string;
}>;

export type DirectoryListing = Readonly<{
  directory: string;
  entries: readonly DirectoryListingEntry[];
  coverage: "complete" | "partial";
  errors: readonly DirectoryListingError[];
}>;

export type DirectoryListingStats = Readonly<{
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}>;

/** Test and harness dependency. It is never part of a semantic call or model input. */
export type DirectoryListingIo = Readonly<{
  readdir(directory: string): Promise<readonly string[]>;
  lstat(path: string): Promise<DirectoryListingStats>;
}>;

export type DirectoryListObservation = Readonly<{
  kind: "directory.list";
  configuredDirectory: string;
  physicalDirectory: string;
  executable: string;
  helperPath: string;
  argv: readonly [string, string];
  stdout: string;
  stderr: string;
  exitCode: 0;
  entries: readonly DirectoryListingEntry[];
  coverage: "complete" | "partial";
  errors: readonly DirectoryListingError[];
}>;

export type DirectoryListingResult =
  | Readonly<{ ok: true; observation: DirectoryListObservation }>
  | Readonly<{ ok: false; error: CliFailure }>;

const execFileAsync = promisify(execFile);
const helperPath = fileURLToPath(new URL("./directory-list-helper.js", import.meta.url));

function failure(code: string, message: string): DirectoryListingResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ operation: "directory.list", stage: "observe", code, message }),
  });
}

function errorCode(error: unknown): string {
  if (error !== null && (typeof error === "object" || typeof error === "function") && "code" in error) {
    const code = String(error.code);
    if (code && code !== "undefined") return code;
  }
  return "EINVAL";
}

function entryType(attributes: DirectoryListingStats): Exclude<DirectoryEntryType, "unknown"> {
  if (attributes.isFile()) return "file";
  if (attributes.isDirectory()) return "directory";
  if (attributes.isSymbolicLink()) return "symlink";
  return "other";
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty string without NUL`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

export function validateDirectoryListing(value: unknown): DirectoryListing {
  const listing = expectRecord(value, "directory listing");
  exactKeys(listing, ["directory", "entries", "coverage", "errors"], "directory listing");
  const directory = nonEmpty(listing.directory, "directory listing directory");
  if (!isAbsolute(directory)) throw new TypeError("directory listing directory must be absolute");
  if (listing.coverage !== "complete" && listing.coverage !== "partial") throw new TypeError("directory listing coverage is invalid");
  if (!Array.isArray(listing.entries) || !Array.isArray(listing.errors)) throw new TypeError("directory listing entries and errors must be arrays");
  const entries = listing.entries.map((raw, index) => {
    const entry = expectRecord(raw, `directory listing entries[${index}]`);
    exactKeys(entry, ["name", "path", "type"], `directory listing entries[${index}]`);
    if (!["file", "directory", "symlink", "other", "unknown"].includes(String(entry.type))) {
      throw new TypeError(`directory listing entries[${index}].type is invalid`);
    }
    const path = nonEmpty(entry.path, `directory listing entries[${index}].path`);
    if (!isAbsolute(path)) throw new TypeError(`directory listing entries[${index}].path must be absolute`);
    return Object.freeze({
      name: nonEmpty(entry.name, `directory listing entries[${index}].name`),
      path,
      type: entry.type as DirectoryEntryType,
    });
  });
  const errors = listing.errors.map((raw, index) => {
    const error = expectRecord(raw, `directory listing errors[${index}]`);
    exactKeys(error, ["name", "code", "message"], `directory listing errors[${index}]`);
    return Object.freeze({
      name: nonEmpty(error.name, `directory listing errors[${index}].name`),
      code: nonEmpty(error.code, `directory listing errors[${index}].code`),
      message: nonEmpty(error.message, `directory listing errors[${index}].message`),
    });
  });
  const hasUnknown = entries.some(entry => entry.type === "unknown");
  if (listing.coverage === "complete" && (errors.length > 0 || hasUnknown)) {
    throw new TypeError("Complete directory listing cannot retain errors or unknown entry types");
  }
  if (listing.coverage === "partial" && errors.length === 0) {
    throw new TypeError("Partial directory listing needs at least one retained error");
  }
  return Object.freeze({
    directory,
    entries: Object.freeze(entries),
    coverage: listing.coverage,
    errors: Object.freeze(errors),
  });
}

export async function collectDirectoryListing(
  directory: string,
  io: DirectoryListingIo = {
    readdir: nativeReaddir,
    lstat: nativeLstat,
  },
): Promise<DirectoryListing> {
  const root = nonEmpty(directory, "directory");
  if (!isAbsolute(root)) throw new TypeError("directory must be absolute");
  const names = [...await io.readdir(root)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const entries: DirectoryListingEntry[] = [];
  const errors: DirectoryListingError[] = [];
  for (const name of names) {
    const path = join(root, name);
    try {
      const attributes = await io.lstat(path);
      entries.push(Object.freeze({ name, path, type: entryType(attributes) }));
    } catch (error) {
      entries.push(Object.freeze({ name, path, type: "unknown" }));
      errors.push(Object.freeze({
        name,
        code: errorCode(error),
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  return Object.freeze({
    directory: root,
    entries: Object.freeze(entries),
    coverage: errors.length === 0 ? "complete" : "partial",
    errors: Object.freeze(errors),
  });
}

export function directoryListHelperPath(): string {
  return helperPath;
}

export async function runDirectoryListHelper(input: Readonly<{
  configuredDirectory: string;
  physicalDirectory: string;
}>): Promise<DirectoryListingResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [helperPath, input.physicalDirectory],
      { shell: false, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    let decoded: DirectoryListing;
    try {
      decoded = validateDirectoryListing(JSON.parse(stdout));
    } catch (error) {
      return failure("INVALID_HELPER_RESPONSE", error instanceof Error ? error.message : String(error));
    }
    if (decoded.directory !== input.physicalDirectory) {
      return failure("TARGET_MISMATCH", "Helper directory differs from the resolved target");
    }
    return Object.freeze({
      ok: true,
      observation: Object.freeze({
        kind: "directory.list",
        configuredDirectory: input.configuredDirectory,
        physicalDirectory: input.physicalDirectory,
        executable: process.execPath,
        helperPath,
        argv: Object.freeze([helperPath, input.physicalDirectory] as const),
        stdout,
        stderr,
        exitCode: 0 as const,
        entries: decoded.entries,
        coverage: decoded.coverage,
        errors: decoded.errors,
      }),
    });
  } catch (error) {
    return failure(errorCode(error), error instanceof Error ? error.message : String(error));
  }
}

export async function observeDirectoryListing(
  input: Readonly<{ configuredDirectory: string; physicalDirectory: string }>,
): Promise<DirectoryListingResult> {
  return runDirectoryListHelper(input);
}
