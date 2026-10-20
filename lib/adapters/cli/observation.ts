import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { expectRecord } from "../../core/schema.js";
import { interpretCliPath, readCliPath, readPathRequest, validateCliCwd, type PathObservation, type PathRequest } from "../../filters/cli-path.js";
import { readEntrySnapshot, type EntrySnapshot } from "./entry-inspection.js";

export type CliEffect = "filesystem.read" | "process.exec";
export type CliRequest =
  | { readonly kind: "pwd" }
  | PathRequest
  | { readonly kind: "attributes"; readonly path: string; readonly followSymlinks: boolean };

export interface PwdObservation {
  readonly kind: "pwd";
  readonly configuredCwd: string;
  readonly physicalCwd: string;
  readonly executable: "/bin/pwd";
  readonly argv: readonly ["-P"];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: 0;
}

export interface FileAttributes {
  readonly kind: "attributes";
  readonly absolutePath: string;
  readonly observedWith: "stat" | "lstat";
  readonly type: "file" | "directory" | "symlink" | "other";
  readonly sizeBytes: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly atimeMs: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly birthtimeMs: number | null;
  readonly linkTarget?: string;
}

export type CliObservation = PathObservation | PwdObservation | FileAttributes;
export interface CliFailure {
  readonly operation: string;
  readonly stage: "validate" | "authorize" | "observe";
  readonly code: string;
  readonly message: string;
}
export type CliResult = { readonly ok: true; readonly observation: CliObservation } | { readonly ok: false; readonly error: CliFailure };

export function readCliRequest(value: unknown): CliRequest {
  const request = expectRecord(value, "CLI request");
  if (request.kind === "path") return readPathRequest(value);
  if (request.kind === "pwd" && Object.keys(request).length === 1) return { kind: "pwd" };
  if (request.kind === "attributes" && Object.keys(request).every(key => ["kind", "path", "followSymlinks"].includes(key))) {
    const path = readCliPath(request.path, "path");
    if (typeof request.followSymlinks !== "boolean") throw new TypeError("followSymlinks must be an explicit boolean");
    return { kind: "attributes", path, followSymlinks: request.followSymlinks };
  }
  throw new TypeError("Unsupported CLI request or extra fields");
}

const execFileAsync = promisify(execFile);
const failure = (operation: string, stage: CliFailure["stage"], code: string, message: string): CliResult => ({ ok: false, error: { operation, stage, code, message } });

function safeNumber(value: bigint | null, label: string): number | null {
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} is outside the supported M0 number range`);
  return number;
}

function milliseconds(value: bigint | null, nanoseconds: bigint | null, label: string): number | null {
  if (value !== null && nanoseconds !== null) {
    const remainder = nanoseconds - value * 1_000_000n;
    const number = Number(value) + Number(remainder) / 1_000_000;
    if (Number.isFinite(number)) return number;
  }
  return safeNumber(value, label);
}

function m0Type(snapshot: EntrySnapshot): FileAttributes["type"] {
  if (snapshot.kind === "regular") return "file";
  if (snapshot.kind === "directory") return "directory";
  if (snapshot.kind === "symlink") return "symlink";
  return "other";
}

function m0Attributes(absolutePath: string, snapshot: EntrySnapshot): FileAttributes {
  if (snapshot.kind === null || snapshot.observedWith === null) throw new TypeError("Successful entry inspection needs a kind and observation method");
  const sizeBytes = safeNumber(snapshot.size, "size");
  const mode = safeNumber(snapshot.mode, "mode");
  const uid = safeNumber(snapshot.uid, "uid");
  const gid = safeNumber(snapshot.gid, "gid");
  const atimeMs = milliseconds(snapshot.atimeMs, snapshot.atimeNs, "atimeMs");
  const mtimeMs = milliseconds(snapshot.mtimeMs, snapshot.mtimeNs, "mtimeMs");
  const ctimeMs = milliseconds(snapshot.ctimeMs, snapshot.ctimeNs, "ctimeMs");
  if ([sizeBytes, mode, uid, gid, atimeMs, mtimeMs, ctimeMs].some(value => value === null)) {
    throw new TypeError("Successful M0 attributes need all required numeric fields");
  }
  return {
    kind: "attributes",
    absolutePath,
    observedWith: snapshot.observedWith,
    type: m0Type(snapshot),
    sizeBytes: sizeBytes!,
    mode: mode!,
    uid: uid!,
    gid: gid!,
    atimeMs: atimeMs!,
    mtimeMs: mtimeMs!,
    ctimeMs: ctimeMs!,
    birthtimeMs: milliseconds(snapshot.birthtimeMs, snapshot.birthtimeNs, "birthtimeMs"),
    ...(snapshot.linkTarget === null ? {} : { linkTarget: snapshot.linkTarget }),
  };
}

/** Business IO is authorized per request; a cwd is a base, not a sandbox. */
export async function observeCliRequest(cwd: string, value: unknown, grantedEffects: ReadonlySet<CliEffect>): Promise<CliResult> {
  let request: CliRequest;
  const operation = typeof value === "object" && value !== null && "kind" in value && typeof value.kind === "string" && value.kind.length ? value.kind : "invalid";
  try {
    validateCliCwd(cwd);
    request = readCliRequest(value);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return failure(operation, "validate", "EINVAL", error.message);
  }
  if (request.kind === "path") return { ok: true, observation: interpretCliPath(cwd, request) };
  const required: readonly CliEffect[] = request.kind === "pwd" ? ["filesystem.read", "process.exec"] : ["filesystem.read"];
  const missing = required.filter(effect => !grantedEffects.has(effect));
  if (missing.length) return failure(request.kind, "authorize", "EFFECT_DENIED", `Missing CLI effect grant: ${missing.join(", ")}`);
  try {
    if (request.kind === "pwd") {
      const { stdout, stderr } = await execFileAsync("/bin/pwd", ["-P"], { cwd, shell: false, encoding: "utf8" });
      const physicalCwd = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
      if (physicalCwd !== await realpath(cwd)) return failure("pwd", "observe", "PWD_MISMATCH", "pwd output differs from the configured directory's physical path");
      return { ok: true, observation: { kind: "pwd", configuredCwd: cwd, physicalCwd, executable: "/bin/pwd", argv: ["-P"], stdout, stderr, exitCode: 0 } };
    }
    const absolutePath = interpretCliPath(cwd, { kind: "path", path: request.path }).absolute;
    const snapshot = await readEntrySnapshot(absolutePath, request.followSymlinks);
    if (snapshot.errno !== null) return failure("attributes", "observe", snapshot.errno, `Entry observation failed with ${snapshot.errno}`);
    return { ok: true, observation: m0Attributes(absolutePath, snapshot) };
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || (typeof error.code !== "string" && typeof error.code !== "number")) throw error;
    return failure(request.kind, "observe", String(error.code), error.message);
  }
}
