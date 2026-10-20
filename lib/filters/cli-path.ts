import { posix } from "node:path";
import { expectNonEmptyString, expectRecord } from "../core/schema.js";

export interface PathRequest {
  readonly kind: "path";
  readonly path: string;
  readonly join?: readonly string[];
}

export interface PathObservation {
  readonly kind: "path";
  readonly input: string;
  readonly inputForm: "absolute" | "relative";
  readonly normalized: string;
  readonly absolute: string;
  readonly parent: string;
}

export interface PathPartsObservation {
  readonly absolute: string;
  readonly parent: string;
  readonly name: string;
  readonly isRoot: boolean;
}

export function readCliPath(value: unknown, label: string): string {
  const path = expectNonEmptyString(value, label);
  if (path.includes("\0")) throw new TypeError(`${label} cannot contain NUL`);
  return path;
}

export function validateCliCwd(value: unknown): string {
  const cwd = readCliPath(value, "cwd");
  if (!posix.isAbsolute(cwd)) throw new TypeError("cwd must be an explicit absolute path");
  return posix.normalize(cwd);
}

export function readPathRequest(value: unknown): PathRequest {
  const request = expectRecord(value, "path request");
  if (request.kind !== "path" || Object.keys(request).some(key => !["kind", "path", "join"].includes(key))) throw new TypeError("Expected kind:path with path and optional join only");
  const path = readCliPath(request.path, "path");
  if (!Object.hasOwn(request, "join")) return { kind: "path", path };
  if (!Array.isArray(request.join)) throw new TypeError("join must be a path segment array");
  return { kind: "path", path, join: request.join.map(segment => readCliPath(segment, "join segment")) };
}

/** Lexical interpretation only. No existence, shell expansion or symlink resolution. */
export function interpretCliPath(cwd: string, request: PathRequest): PathObservation {
  const base = validateCliCwd(cwd);
  const input = readPathRequest(request);
  const normalized = posix.normalize(posix.join(input.path, ...(input.join ?? [])));
  const absolute = posix.resolve(base, normalized);
  return { kind: "path", input: input.path, inputForm: posix.isAbsolute(input.path) ? "absolute" : "relative", normalized, absolute, parent: posix.dirname(absolute) };
}

function readAbsoluteCliPath(value: unknown, label: string): string {
  const path = readCliPath(value, label);
  if (!posix.isAbsolute(path)) throw new TypeError(`${label} must be an explicit absolute path`);
  return path;
}

/** Fixed POSIX lexical operation. It does not stat or require the paths to exist. */
export function relativePath(from: string, to: string): string {
  const base = readAbsoluteCliPath(from, "from");
  const target = readAbsoluteCliPath(to, "to");
  return posix.relative(base, target);
}

/** Fixed POSIX lexical split. It does not claim either path exists on disk. */
export function pathParts(value: unknown): PathPartsObservation {
  const slashCleaned = readAbsoluteCliPath(value, "path").replace(/\/+/g, "/");
  const absolute = slashCleaned.length > 1 && slashCleaned.endsWith("/")
    ? slashCleaned.slice(0, -1)
    : slashCleaned;
  const isRoot = absolute === "/";
  return Object.freeze({
    absolute,
    parent: isRoot ? "/" : posix.dirname(absolute),
    name: isRoot ? "" : posix.basename(absolute),
    isRoot,
  });
}
