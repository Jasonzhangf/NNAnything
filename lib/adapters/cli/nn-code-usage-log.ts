// nn-code usage log v2 storage.
//
// The module owns the per-run JSONL file, the 10 GB per-root capacity
// accounting, the short-lived filesystem lock and the event projection for
// the real call-depth result. The CLI bin only parses arguments and projects
// stdout/stderr; it must not implement storage policy here.
import { constants } from "node:fs";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import * as readline from "node:readline";
import type {
  CallDepthRunResult,
  CallDepthState,
  CallDepthUnresolvedCallsite,
  CallGraphNodeFact,
  DeclSpan,
} from "./call-depth-contract.js";
import {
  VALUE_FLOW_FEATURE_NAMES,
  VALUE_FLOW_FEATURE_SCHEMA,
  VALUE_FLOW_HR_UNIT_ID,
  VALUE_FLOW_LABELS,
  type ValueFlowLabel,
} from "./value-flow-contract.js";

export const USAGE_LOG_SCHEMA = "nnanything.nn-code.usage-log.v2" as const;
export const LEGACY_USAGE_LOG_SCHEMA = "nnanything.nn-code.run-log.v1" as const;
export const USAGE_LOG_CAPACITY_BYTES = 10_000_000_000 as const;
export const USAGE_LOG_UNKNOWN_EXCERPT_LIMIT = 16 * 1024;
export const USAGE_LOG_RUN_EXCERPT_LIMIT = 1024 * 1024;
export const USAGE_LOG_LOCK_FILE = ".nn-code-usage-log.lock" as const;
export const USAGE_LOG_DEFAULT_SUBPATH = ".local/state/nn-code/runs" as const;
export const USAGE_LOG_DIR_ENV = "NN_CODE_LOG_DIR" as const;

export const USAGE_LOG_ALLOWED_KINDS = Object.freeze([
  "start",
  "source_observed",
  "node_expanded",
  "relation_resolved",
  "relation_unknown",
  "decision",
  "finish",
] as const);

export type UsageLogAllowedKind = (typeof USAGE_LOG_ALLOWED_KINDS)[number];

export function isAllowedUsageLogKind(kind: unknown): kind is UsageLogAllowedKind {
  return typeof kind === "string" && (USAGE_LOG_ALLOWED_KINDS as readonly string[]).includes(kind);
}

export type UsageLogState = "complete" | "partial" | "disabled" | "failed";

export type UsageLogResult = Readonly<{
  enabled: boolean;
  state: UsageLogState;
  runLogPath: string | null;
  reason: string | null;
}>;

export type UsageLogEventKind =
  | "source_observed"
  | "node_expanded"
  | "relation_resolved"
  | "relation_unknown"
  | "decision";

export type UsageLogEventInput = Readonly<{
  kind: UsageLogEventKind;
  body: Readonly<Record<string, unknown>>;
}>;

export type UsageLogStartInput = Readonly<{
  request: unknown | null;
  cliVersion: string;
  semanticContractVersion: string;
  modelRef: string | null;
}>;

export type UsageLogFinishInput = Readonly<{
  outcome: unknown;
  coverage: unknown;
  resultReceipt: unknown;
  error: unknown | null;
}>;

export type UsageLogRecord = Readonly<Record<string, unknown>> & Readonly<{
  schema: string;
  runId: string;
  seq: number;
  kind: string;
  observedAt: string;
  elapsedMs: number;
}>;

export type UsageLogReadResult = Readonly<{
  kind: "v2" | "v1";
  events: readonly UsageLogRecord[];
  complete: boolean;
  interrupted: boolean;
  trailingIncompleteLine: boolean;
  malformed: boolean;
}>;

export type UsageLogRunOptions = Readonly<{
  root: string;
  runId: string;
  capacityBytes?: number;
  protectedRoots?: readonly string[];
  pid?: number;
  owner?: string;
  now?: () => number;
}>;

type LockHolder = Readonly<{
  pid: number;
  owner: string;
  acquiredAt: string;
}>;

type LockHandle = Readonly<{ release: () => Promise<void> }>;

type OwnedRunEntry = Readonly<{
  path: string;
  runId: string;
  bytes: number;
  mtimeMs: number;
  active: boolean;
  completed: boolean;
}>;

const LOG_STORE_BUSY = "LOG_STORE_BUSY";
const LOG_CAPACITY_EXCEEDED = "LOG_CAPACITY_EXCEEDED";
const LOG_WRITE_FAILED = "LOG_WRITE_FAILED";
const SANDBOX_ESCAPE = "SANDBOX_ESCAPE";

function taggedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function errorCode(error: unknown): string | null {
  if (error !== null && (typeof error === "object" || typeof error === "function") && "code" in error) {
    const code = String((error as { code?: unknown }).code);
    if (code && code !== "undefined") return code;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRunId(runId: string): string {
  if (
    typeof runId !== "string"
    || runId.length === 0
    || runId === "."
    || runId === ".."
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)
  ) {
    throw new TypeError("usage log runId must be a safe non-empty filename segment");
  }
  return runId;
}

export function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

/** Resolve a path through its nearest existing ancestor without creating it. */
export async function resolvePhysicalPath(candidatePath: string): Promise<string> {
  const absoluteCandidate = resolve(candidatePath);
  let current = absoluteCandidate;
  while (true) {
    try {
      const physicalAncestor = await realpath(current);
      const suffix = relative(current, absoluteCandidate);
      return suffix.length === 0 ? physicalAncestor : resolve(physicalAncestor, suffix);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        throw new Error(`Unable to resolve physical ancestor for path: ${candidatePath}`);
      }
      current = parent;
    }
  }
}

export function resolveUsageLogRoot(logDir: string | null): string {
  if (logDir !== null && logDir.length > 0) {
    return resolve(process.cwd(), logDir);
  }
  const envLogDir = process.env[USAGE_LOG_DIR_ENV];
  if (typeof envLogDir === "string" && envLogDir.length > 0) {
    return resolve(process.cwd(), envLogDir);
  }
  const xdgStateHome = process.env.XDG_STATE_HOME;
  if (typeof xdgStateHome === "string" && xdgStateHome.length > 0 && isAbsolute(xdgStateHome)) {
    return join(xdgStateHome, "nn-code", "runs");
  }
  return join(homedir(), USAGE_LOG_DEFAULT_SUBPATH);
}

export function disabledUsageLog(): UsageLogResult {
  return Object.freeze({ enabled: false, state: "disabled", runLogPath: null, reason: null });
}

export function failedUsageLog(reason: string): UsageLogResult {
  return Object.freeze({ enabled: true, state: "failed", runLogPath: null, reason });
}

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

async function readBytes(path: string, offset: number, length: number): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ELOOP") return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    const start = Math.max(0, offset < 0 ? info.size + offset : offset);
    const count = Math.min(length, Math.max(0, info.size - start));
    const buffer = Buffer.alloc(count);
    if (count === 0) return buffer;
    const { bytesRead } = await handle.read(buffer, 0, count, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readAllBytes(path: string): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ELOOP") return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    const buffer = Buffer.alloc(info.size);
    if (info.size === 0) return buffer;
    const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function firstCompleteLine(text: string): string | null {
  const newline = text.indexOf("\n");
  if (newline < 0) return null;
  const line = text.slice(0, newline).trim();
  return line.length === 0 ? null : line;
}

function lastCompleteLine(text: string): string | null {
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  const newline = trimmed.lastIndexOf("\n");
  const line = (newline >= 0 ? trimmed.slice(newline + 1) : trimmed).trim();
  return line.length === 0 ? null : line;
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function looksLikeV2RunLog(path: string): Promise<boolean> {
  const bytes = await readBytes(path, 0, 4096);
  if (bytes === null) return false;
  const line = firstCompleteLine(bytes.toString("utf8"));
  if (line === null) return false;
  const parsed = parseJsonLine(line);
  return isRecord(parsed) && parsed.schema === USAGE_LOG_SCHEMA && parsed.kind === "start";
}

async function looksLikeV1RunLog(path: string): Promise<boolean> {
  const bytes = await readBytes(path, 0, 4096);
  if (bytes === null) return false;
  return bytes.toString("utf8").includes(`"${LEGACY_USAGE_LOG_SCHEMA}"`);
}

async function hasFinishLine(path: string): Promise<boolean> {
  const bytes = await readBytes(path, -1024 * 1024, 1024 * 1024);
  if (bytes === null) return false;
  const line = lastCompleteLine(bytes.toString("utf8"));
  if (line === null) return false;
  const parsed = parseJsonLine(line);
  return isRecord(parsed) && parsed.kind === "finish";
}

async function readMarker(root: string, runId: string): Promise<LockHolder | null> {
  const bytes = await readBytes(join(root, `.active-${runId}`), 0, 4096);
  if (bytes === null) return null;
  const parsed = parseJsonLine(bytes.toString("utf8"));
  if (!isRecord(parsed)) return null;
  const pid = parsed.pid;
  const owner = parsed.owner;
  const acquiredAt = parsed.startedAt;
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return null;
  return Object.freeze({
    pid: pid as number,
    owner: typeof owner === "string" ? owner : "",
    acquiredAt: typeof acquiredAt === "string" ? acquiredAt : "",
  });
}

async function isRunActive(root: string, runId: string): Promise<boolean> {
  const marker = await readMarker(root, runId);
  if (marker === null) return false;
  return pidAlive(marker.pid);
}

async function acquireUsageLogLock(root: string, holder: LockHolder): Promise<LockHandle> {
  const lockPath = join(root, USAGE_LOG_LOCK_FILE);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const existingBytes = await readBytes(lockPath, 0, 4096);
      if (existingBytes === null) continue;
      const existing = parseJsonLine(existingBytes.toString("utf8"));
      if (!isRecord(existing) || !Number.isSafeInteger(existing.pid) || (existing.pid as number) <= 0) {
        throw taggedError(LOG_STORE_BUSY, "usage log lock owner is unknown");
      }
      if (pidAlive(existing.pid as number)) {
        throw taggedError(LOG_STORE_BUSY, `usage log lock is held by pid ${String(existing.pid)}`);
      }
      try {
        await unlink(lockPath);
      } catch (unlinkError) {
        if (errorCode(unlinkError) !== "ENOENT") throw unlinkError;
      }
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify(holder));
      return Object.freeze({
        release: async () => {
          try {
            await unlink(lockPath);
          } catch (error) {
            if (errorCode(error) !== "ENOENT") throw error;
          }
        },
      });
    } finally {
      await handle.close();
    }
  }
  throw taggedError(LOG_STORE_BUSY, "usage log lock could not be acquired");
}

function validPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export class UsageLogRun {
  readonly root: string;
  readonly runId: string;
  readonly runLogPath: string;
  readonly capacityBytes: number;
  readonly pid: number;
  readonly owner: string;
  private readonly protectedRoots: readonly string[];
  private readonly clock: () => number;
  private readonly startedAtMs: number;
  private seq = 0;
  private state: UsageLogState = "failed";
  private reason: string | null = "LOG_NOT_STARTED";
  private started = false;
  private fileCreated = false;
  private stopped = false;
  private excerptBytes = 0;

  constructor(options: UsageLogRunOptions) {
    if (typeof options.root !== "string" || options.root.length === 0) {
      throw new TypeError("usage log root must be a non-empty path");
    }
    this.root = resolve(options.root);
    this.runId = safeRunId(options.runId);
    this.runLogPath = join(this.root, `${this.runId}.jsonl`);
    this.capacityBytes = options.capacityBytes ?? USAGE_LOG_CAPACITY_BYTES;
    if (!validPositiveInteger(this.capacityBytes)) {
      throw new TypeError("usage log capacityBytes must be a positive safe integer");
    }
    this.pid = options.pid ?? process.pid;
    if (!validPositiveInteger(this.pid)) {
      throw new TypeError("usage log pid must be a positive safe integer");
    }
    this.owner = options.owner ?? `nn-code:${this.pid}`;
    this.protectedRoots = Object.freeze([...(options.protectedRoots ?? [])]);
    this.clock = options.now ?? Date.now;
    this.startedAtMs = this.clock();
  }

  status(): UsageLogResult {
    return Object.freeze({
      enabled: true,
      state: this.state,
      runLogPath: this.fileCreated ? this.runLogPath : null,
      reason: this.reason,
    });
  }

  async start(input: UsageLogStartInput): Promise<UsageLogResult> {
    if (this.started) throw new Error("usage log run has already started");
    try {
      await this.assertRootAllowed();
      await mkdir(this.root, { recursive: true, mode: 0o700 });
    } catch (error) {
      this.failWith(error);
      return this.status();
    }
    const persisted = await this.append("start", input, true);
    if (persisted) {
      this.started = true;
      this.state = "partial";
      this.reason = null;
    }
    return this.status();
  }

  async event(input: UsageLogEventInput): Promise<boolean> {
    if (!this.started || this.stopped) return false;
    return this.append(input.kind, input.body, false);
  }

  async finish(input: UsageLogFinishInput): Promise<UsageLogResult> {
    if (!this.started) return this.status();
    const persisted = await this.append("finish", input, false);
    if (persisted) {
      this.state = "complete";
      this.reason = null;
      await this.removeMarker();
    } else if (this.state === "partial" && this.reason === null) {
      this.reason = LOG_WRITE_FAILED;
    }
    return this.status();
  }

  /** Reserve excerpt bytes for this run; returns the accepted byte count. */
  reserveExcerptBytes(requested: number): number {
    const remaining = USAGE_LOG_RUN_EXCERPT_LIMIT - this.excerptBytes;
    const accepted = Math.max(0, Math.min(requested, remaining, USAGE_LOG_UNKNOWN_EXCERPT_LIMIT));
    this.excerptBytes += accepted;
    return accepted;
  }

  private failWith(error: unknown): void {
    const code = errorCode(error);
    if (code === SANDBOX_ESCAPE) {
      this.state = "failed";
      this.reason = SANDBOX_ESCAPE;
      return;
    }
    if (code === LOG_STORE_BUSY) {
      this.state = "partial";
      this.reason = LOG_STORE_BUSY;
      this.stopped = true;
      return;
    }
    if (code === LOG_CAPACITY_EXCEEDED) {
      this.state = "partial";
      this.reason = LOG_CAPACITY_EXCEEDED;
      this.stopped = true;
      return;
    }
    this.state = "failed";
    this.reason = code ?? LOG_WRITE_FAILED;
    this.stopped = true;
  }

  private async assertRootAllowed(): Promise<void> {
    if (this.protectedRoots.length === 0) return;
    const physicalRoot = await resolvePhysicalPath(this.root);
    for (const protectedRoot of this.protectedRoots) {
      if (isWithin(protectedRoot, physicalRoot)) {
        throw taggedError(SANDBOX_ESCAPE, "log directory must be outside target repository");
      }
    }
  }

  private async append(kind: string, body: unknown, isStart: boolean): Promise<boolean> {
    if (this.stopped) return false;
    const observedAtMs = this.clock();
    const line = `${JSON.stringify({
      ...(isRecord(body) ? body : { value: body }),
      schema: USAGE_LOG_SCHEMA,
      runId: this.runId,
      seq: this.seq,
      kind,
      observedAt: new Date(observedAtMs).toISOString(),
      elapsedMs: Math.max(0, observedAtMs - this.startedAtMs),
    })}\n`;
    const recordBytes = Buffer.byteLength(line, "utf8");
    let lock: LockHandle | null = null;
    try {
      lock = await acquireUsageLogLock(this.root, Object.freeze({
        pid: this.pid,
        owner: this.owner,
        acquiredAt: new Date(observedAtMs).toISOString(),
      }));
      if (isStart) {
        await this.writeMarker();
      }
      await this.reconcileCapacity(recordBytes);
      await this.writeLine(line);
      this.seq += 1;
      if (isStart) this.fileCreated = true;
      return true;
    } catch (error) {
      this.failWith(error);
      if (isStart) await this.removeMarker();
      return false;
    } finally {
      if (lock !== null) {
        try {
          await lock.release();
        } catch {
          // A lock file we could not remove must not mask the run result.
        }
      }
    }
  }

  private async writeMarker(): Promise<void> {
    const markerPath = join(this.root, `.active-${this.runId}`);
    let handle;
    try {
      handle = await open(markerPath, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        throw taggedError(LOG_WRITE_FAILED, `active marker already exists for run ${this.runId}`);
      }
      throw error;
    }
    try {
      await handle.writeFile(JSON.stringify({
        pid: this.pid,
        owner: this.owner,
        startedAt: new Date(this.startedAtMs).toISOString(),
      }));
    } finally {
      await handle.close();
    }
  }

  private async removeMarker(): Promise<void> {
    try {
      await unlink(join(this.root, `.active-${this.runId}`));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        // The completed finish line is the durable completion signal.
      }
    }
  }

  private async writeLine(line: string): Promise<void> {
    let handle;
    try {
      handle = await open(
        this.runLogPath,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(line);
    } finally {
      if (handle !== undefined) await handle.close();
    }
  }

  private async reconcileCapacity(recordBytes: number): Promise<void> {
    if (recordBytes > this.capacityBytes) {
      throw taggedError(LOG_CAPACITY_EXCEEDED, "single usage log event exceeds capacity");
    }
    let entries = await this.listOwnedEntries();
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    while (total + recordBytes > this.capacityBytes) {
      const victim = this.oldestRecyclable(entries);
      if (victim === null) {
        throw taggedError(LOG_CAPACITY_EXCEEDED, "usage log root capacity is exhausted");
      }
      await this.removeOwnedEntry(victim);
      entries = entries.filter(entry => entry.path !== victim.path);
      total -= victim.bytes;
    }
  }

  private oldestRecyclable(entries: readonly OwnedRunEntry[]): OwnedRunEntry | null {
    const recyclable = entries
      .filter(entry => !entry.active)
      .sort((left, right) => {
        if (left.completed !== right.completed) return left.completed ? -1 : 1;
        return left.mtimeMs - right.mtimeMs;
      });
    return recyclable[0] ?? null;
  }

  private async removeOwnedEntry(entry: OwnedRunEntry): Promise<void> {
    const info = await lstat(entry.path);
    if (info.isDirectory()) {
      throw taggedError(LOG_WRITE_FAILED, `refusing to remove directory during rotation: ${entry.path}`);
    }
    if (info.isSymbolicLink()) {
      throw taggedError(LOG_WRITE_FAILED, `refusing to remove symbolic link during rotation: ${entry.path}`);
    }
    await unlink(entry.path);
  }

  private async listOwnedEntries(): Promise<readonly OwnedRunEntry[]> {
    const entries: OwnedRunEntry[] = [];
    let dirents;
    try {
      dirents = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return Object.freeze([]);
      throw error;
    }
    for (const dirent of dirents) {
      const name = dirent.name;
      const isV2 = name.endsWith(".jsonl");
      const isV1 = name.endsWith(".json");
      if (!isV2 && !isV1) continue;
      const path = join(this.root, name);
      try {
        const info = await lstat(path);
        if (info.isDirectory()) continue;
        if (info.isSymbolicLink()) {
          // Symbolic links are never owned run logs and must not participate in
          // rotation, because unlinking them would delete the link itself.
          continue;
        }
        const owned = isV2 ? await looksLikeV2RunLog(path) : await looksLikeV1RunLog(path);
        if (!owned) continue;
        const runId = name.slice(0, isV2 ? -".jsonl".length : -".json".length);
        const active = isV2 && await isRunActive(this.root, runId);
        const completed = isV2 ? await hasFinishLine(path) : true;
        entries.push(Object.freeze({
          path,
          runId,
          bytes: info.size,
          mtimeMs: info.mtimeMs,
          active,
          completed,
        }));
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        throw error;
      }
    }
    return Object.freeze(entries);
  }
}

export function createUsageLogRun(options: UsageLogRunOptions): UsageLogRun {
  return new UsageLogRun(options);
}

/**
 * Read a usage log without sampling a trailing incomplete line. A v1 run log
 * is accepted read-only so old logs can still be inspected and rotated.
 */
export async function readUsageLog(path: string): Promise<UsageLogReadResult> {
  const bytes = await readAllBytes(path);
  if (bytes === null) throw new Error(`usage log not found: ${path}`);
  const text = bytes.toString("utf8");
  if (path.endsWith(".json")) {
    const parsed = parseJsonLine(text);
    if (isRecord(parsed) && parsed.schema === LEGACY_USAGE_LOG_SCHEMA) {
      return Object.freeze({
        kind: "v1",
        events: Object.freeze([]),
        complete: true,
        interrupted: false,
        trailingIncompleteLine: false,
        malformed: false,
      });
    }
    return Object.freeze({
      kind: "v1",
      events: Object.freeze([]),
      complete: false,
      interrupted: true,
      trailingIncompleteLine: false,
      malformed: true,
    });
  }
  const endsWithNewline = text.endsWith("\n");
  const rawLines = text.split("\n");
  const completeLines = rawLines.slice(0, -1);
  const trailing = rawLines[rawLines.length - 1] ?? "";
  const events: UsageLogRecord[] = [];
  let malformed = false;
  for (const rawLine of completeLines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const parsed = parseJsonLine(line);
    if (!isRecord(parsed)) {
      malformed = true;
      break;
    }
    events.push(parsed as UsageLogRecord);
  }
  const complete = events.length > 0 && events[events.length - 1]?.kind === "finish";
  return Object.freeze({
    kind: "v2",
    events: Object.freeze(events),
    complete,
    interrupted: !complete,
    trailingIncompleteLine: !endsWithNewline && trailing.length > 0,
    malformed,
  });
}

function sourceFileMap(state: CallDepthState | null): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const file of state?.files ?? []) map.set(file.relPath, file.sourceText);
  return map;
}

function sliceSpan(text: string, span: DeclSpan): string {
  const lines = text.split("\n");
  const start = lines[span.startLine - 1];
  const end = lines[span.endLine - 1];
  if (start === undefined || end === undefined) return "";
  if (span.startLine === span.endLine) {
    return start.slice(Math.max(0, span.startColumn - 1), Math.max(0, span.endColumn - 1));
  }
  const middle = lines.slice(span.startLine, span.endLine - 1);
  return [
    start.slice(Math.max(0, span.startColumn - 1)),
    ...middle,
    end.slice(0, Math.max(0, span.endColumn - 1)),
  ].join("\n");
}

function prefixUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}

function unknownCoverageImpact(callsite: CallDepthUnresolvedCallsite): string {
  switch (callsite.kind) {
    case "out_of_scope_external": return "scope_limited";
    case "unresolved_dynamic": return "target_unknown";
    case "unresolved_missing_or_ambiguous_target": return "target_unknown";
    default: return "target_unknown";
  }
}

function nodeBody(node: CallGraphNodeFact): Readonly<Record<string, unknown>> {
  return Object.freeze({
    nodeId: node.nodeId,
    file: node.filePath,
    symbolName: node.symbolName,
    lexicalScopeChain: node.lexicalScopeChain,
    minDepth: node.minDepth,
    bodyExtracted: node.bodyExtracted,
    declSpan: node.declSpan,
    observedRef: node.fileObjectRef === null
      ? null
      : Object.freeze({
          sourceRun: node.fileObjectRef.sourceRun,
          sessionRevision: node.fileObjectRef.sessionRevision,
        }),
  });
}

export type ProjectCallDepthEventsInput = Readonly<{
  result: CallDepthRunResult;
  repoRoot: string;
  reserveExcerptBytes: (requested: number) => number;
}>;

/**
 * Project the actual call-depth result into usage events. The projector only
 * reads facts that are already present in the run result; it never re-runs
 * parsing or resolves a new relation.
 */
export function projectCallDepthUsageEvents(
  input: ProjectCallDepthEventsInput,
): readonly UsageLogEventInput[] {
  const { result, repoRoot } = input;
  const state = result.finalState;
  const files = sourceFileMap(state);
  const events: UsageLogEventInput[] = [];

  for (const file of state?.files ?? []) {
    const readBytes = Buffer.from(file.initialBytesBase64, "base64").length;
    const complete = readBytes === file.size;
    events.push(Object.freeze({
      kind: "source_observed" as const,
      body: Object.freeze({
        repoRoot,
        file: file.relPath,
        readRange: Object.freeze({ startByte: 0, endByte: readBytes, complete }),
        beforeStat: Object.freeze({
          size: file.size,
          dev: file.dev,
          ino: file.ino,
        }),
        afterStat: null,
        afterStatStatus: "not_observed" as const,
        unchangedAtClosure: file.verifiedUnchangedAtClosure,
        truncated: state?.truncated ?? false,
      }),
    }));
  }

  for (const partial of state?.partialSources ?? []) {
    events.push(Object.freeze({
      kind: "source_observed" as const,
      body: Object.freeze({
        repoRoot,
        file: partial.relPath,
        readRange: Object.freeze({ startByte: 0, endByte: partial.bytesRead, complete: false }),
        beforeStat: Object.freeze({
          size: partial.size,
          dev: partial.dev,
          ino: partial.ino,
        }),
        afterStat: null,
        afterStatStatus: "not_observed" as const,
        unchangedAtClosure: false,
        truncated: true,
      }),
    }));
  }

  for (const node of result.nodes) {
    events.push(Object.freeze({ kind: "node_expanded" as const, body: nodeBody(node) }));
  }

  for (const edge of result.edges) {
    events.push(Object.freeze({
      kind: "relation_resolved" as const,
      body: Object.freeze({
        callerId: edge.callerId,
        calleeId: edge.calleeId,
        edgeKind: edge.edgeKind,
        isCycleEdge: edge.isCycleEdge,
        calleeInDegree: edge.calleeInDegree,
        callsiteSpan: edge.callsiteSpan,
        evidenceRef: edge.evidenceSnippet,
      }),
    }));
  }

  for (const callsite of result.unresolvedCallsites) {
    const file = result.nodes.find(node => node.nodeId === callsite.callerId)?.filePath ?? null;
    const source = file === null ? undefined : files.get(file);
    const excerpt = file === null || source === undefined ? "" : sliceSpan(source, callsite.callsiteSpan);
    const requested = Buffer.byteLength(excerpt, "utf8");
    const accepted = input.reserveExcerptBytes(requested);
    const complete = accepted === requested && requested <= USAGE_LOG_UNKNOWN_EXCERPT_LIMIT;
    const text = complete ? excerpt : prefixUtf8(excerpt, accepted);
    events.push(Object.freeze({
      kind: "relation_unknown" as const,
      body: Object.freeze({
        unknownId: `${callsite.callerId}:${callsite.callsiteSpan.startLine}:${callsite.callsiteSpan.startColumn}`,
        callerNodeId: callsite.callerId,
        callsiteSpan: callsite.callsiteSpan,
        calleeExpression: callsite.calleeExpr,
        reasonCode: callsite.reasonCode,
        targetHint: Object.freeze({}),
        evidenceRefs: Object.freeze(file === null ? [] : [`${file}:${callsite.callsiteSpan.startLine}`]),
        missingEvidence: Object.freeze(["target_binding"]),
        coverageImpact: unknownCoverageImpact(callsite),
        sourceExcerpt: file === null
          ? null
          : Object.freeze({
              file,
              startLine: callsite.callsiteSpan.startLine,
              text,
              complete,
            }),
        reviewState: "unreviewed" as const,
      }),
    }));
  }

  return Object.freeze(events);
}

export type UsageLogStreamOptions = Readonly<{
  logRoot: string;
  signal?: AbortSignal;
}>;

export type UsageLogFileStatSnapshot = Readonly<{
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}>;

export type VerifiedUsageLogCandidateItem = Readonly<{
  type: "candidate";
  logRoot: string;
  runId: string;
  file: string;
  seq: number;
  observedAt: string;
  kind: "relation_unknown" | "decision";
  modelRef: string | null;
  body: Readonly<Record<string, unknown>>;
}>;

export type VerifiedUsageLogRunDiagnosticItem = Readonly<{
  type: "run_diagnostic";
  logRoot: string;
  runId: string;
  file: string;
  line: number | null;
  status:
    | "verified_complete"
    | "incomplete_missing_start"
    | "incomplete_missing_finish"
    | "incomplete_active_run"
    | "corrupted_v2"
    | "corrupted_v1"
    | "legacy_v1_ignored"
    | "evidence_unavailable_rotated"
    | "modified_or_rotated_during_pass2";
  reason: string | null;
  lineCount: number;
  decisionEventsInRun: number;
  relationUnknownEventsInRun: number;
  sawNonNullModelRef: boolean;
}>;

export type UsageLogPoolSummary = Readonly<{
  logRoot: string;
  v2CompleteRuns: number;
  v2IncompleteMissingStartCount: number;
  v2IncompleteMissingFinishCount: number;
  v2ActiveIncompleteCount: number;
  v1LegacyRunsCount: number;
  corruptedFileCount: number;
  corruptedLogEntryCount: number;
  rotatedBeforePass2RunCount: number;
  modifiedDuringPass2RunCount: number;
  totalDecisionEventsObserved: number;
  totalRelationUnknownEventsObserved: number;
  totalNonNullModelRefObserved: number;
}>;

export type CommittedRunFileInfo = Readonly<{
  logRoot: string;
  runId: string;
  committedFilePath: string;
  candidateCount: number;
}>;

export type SpoolUsageLogCandidatesOptions = Readonly<{
  logRoot: string;
  batchStagingDir: string;
  protectedRoots: readonly string[];
  onDiagnostic?: (item: VerifiedUsageLogRunDiagnosticItem) => void | Promise<void>;
  onRunCommitted?: (info: CommittedRunFileInfo) => void | Promise<void>;
  signal?: AbortSignal;
}>;

export type SpoolUsageLogCandidatesReceipt = Readonly<{
  status: "completed" | "staging_batch_dir_occupied";
  reason: string | null;
  batchStagingDir: string;
  summary: UsageLogPoolSummary | null;
  committedRunCount: number;
  committedCandidateCount: number;
  rolledBackRunCount: number;
  committedRunFiles: readonly string[];
}>;

export type ValueFlowDecisionProjectionInput = Readonly<{
  requestId: string;
  callsiteKey: string;
  candidateKey: string;
  syntaxPatternKey: string;
  requestScopeKey?: string;
  profileRef: string;
  modelRef: string;
  preDecisionFeatures: readonly number[];
  inputMissingMask: readonly boolean[];
  legalCandidates: readonly ValueFlowLabel[];
  originalChoice: ValueFlowLabel;
  scoresByLabel?: Readonly<Record<ValueFlowLabel, number>>;
}>;

type UsageLogRunInspection = Readonly<{
  status: VerifiedUsageLogRunDiagnosticItem["status"];
  reason: string | null;
  line: number | null;
  lineCount: number;
  decisionEventsInRun: number;
  relationUnknownEventsInRun: number;
  nonNullModelRefCount: number;
  corruptedEntryCount: number;
  beforeStat: UsageLogFileStatSnapshot | null;
}>;

function statSnapshot(info: Awaited<ReturnType<typeof lstat>>): UsageLogFileStatSnapshot {
  return Object.freeze({
    dev: Number(info.dev),
    ino: Number(info.ino),
    size: Number(info.size),
    mtimeMs: Number(info.mtimeMs),
  });
}

function sameStatSnapshot(
  left: UsageLogFileStatSnapshot,
  right: UsageLogFileStatSnapshot,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("usage log stream aborted");
  }
}

function emptyUsageLogSummary(logRoot: string): {
  logRoot: string;
  v2CompleteRuns: number;
  v2IncompleteMissingStartCount: number;
  v2IncompleteMissingFinishCount: number;
  v2ActiveIncompleteCount: number;
  v1LegacyRunsCount: number;
  corruptedFileCount: number;
  corruptedLogEntryCount: number;
  rotatedBeforePass2RunCount: number;
  modifiedDuringPass2RunCount: number;
  totalDecisionEventsObserved: number;
  totalRelationUnknownEventsObserved: number;
  totalNonNullModelRefObserved: number;
} {
  return {
    logRoot,
    v2CompleteRuns: 0,
    v2IncompleteMissingStartCount: 0,
    v2IncompleteMissingFinishCount: 0,
    v2ActiveIncompleteCount: 0,
    v1LegacyRunsCount: 0,
    corruptedFileCount: 0,
    corruptedLogEntryCount: 0,
    rotatedBeforePass2RunCount: 0,
    modifiedDuringPass2RunCount: 0,
    totalDecisionEventsObserved: 0,
    totalRelationUnknownEventsObserved: 0,
    totalNonNullModelRefObserved: 0,
  };
}

function frozenUsageLogSummary(
  summary: ReturnType<typeof emptyUsageLogSummary>,
): UsageLogPoolSummary {
  return Object.freeze({ ...summary });
}

function validRunId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value !== "."
    && value !== ".."
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

async function inspectUsageLogRunPass1(
  filePath: string,
  runId: string,
): Promise<UsageLogRunInspection> {
  let beforeStat: UsageLogFileStatSnapshot | null = null;
  try {
    const info = await lstat(filePath);
    if (info.isDirectory() || info.isSymbolicLink()) {
      return Object.freeze({
        status: "corrupted_v2",
        reason: "NON_FILE_USAGE_LOG",
        line: null,
        lineCount: 0,
        decisionEventsInRun: 0,
        relationUnknownEventsInRun: 0,
        nonNullModelRefCount: 0,
        corruptedEntryCount: 1,
        beforeStat: null,
      });
    }
    beforeStat = statSnapshot(info);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return Object.freeze({
        status: "evidence_unavailable_rotated",
        reason: "evidence_unavailable_rotated",
        line: null,
        lineCount: 0,
        decisionEventsInRun: 0,
        relationUnknownEventsInRun: 0,
        nonNullModelRefCount: 0,
        corruptedEntryCount: 0,
        beforeStat: null,
      });
    }
    throw error;
  }

  let stream: ReturnType<typeof createReadStream> | null = null;
  let rl: readline.Interface | null = null;
  let lineNumber = 0;
  let lineCount = 0;
  let decisionEventsInRun = 0;
  let relationUnknownEventsInRun = 0;
  let nonNullModelRefCount = 0;
  let corruptedEntryCount = 0;
  let firstKind: string | null = null;
  let lastKind: string | null = null;
  let lastSeq = Number.NEGATIVE_INFINITY;
  let sawStart = false;
  let sawFinish = false;
  let corruptedLine: number | null = null;

  try {
    stream = createReadStream(filePath, { encoding: "utf8" });
    rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const rawLine of rl) {
      lineNumber += 1;
      const line = rawLine.trim();
      if (line.length === 0) continue;
      lineCount += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        corruptedEntryCount += 1;
        corruptedLine = corruptedLine ?? lineNumber;
        continue;
      }
      if (!isRecord(parsed) || parsed.schema !== USAGE_LOG_SCHEMA || parsed.runId !== runId) {
        corruptedEntryCount += 1;
        corruptedLine = corruptedLine ?? lineNumber;
        continue;
      }
      const kind = parsed.kind;
      const seq = parsed.seq;
      if (
        !isAllowedUsageLogKind(kind)
        || !Number.isSafeInteger(seq)
        || (seq as number) <= lastSeq
      ) {
        corruptedEntryCount += 1;
        corruptedLine = corruptedLine ?? lineNumber;
        continue;
      }
      lastSeq = seq as number;
      firstKind = firstKind ?? kind;
      lastKind = kind;
      if (kind === "start") sawStart = true;
      if (kind === "finish") sawFinish = true;
      if (kind === "decision") decisionEventsInRun += 1;
      if (kind === "relation_unknown") relationUnknownEventsInRun += 1;
      if (parsed.modelRef !== null && parsed.modelRef !== undefined) nonNullModelRefCount += 1;
    }
  } catch (error) {
    return Object.freeze({
      status: "corrupted_v2",
      reason: error instanceof Error ? error.message : "USAGE_LOG_READ_FAILED",
      line: lineNumber > 0 ? lineNumber : null,
      lineCount,
      decisionEventsInRun,
      relationUnknownEventsInRun,
      nonNullModelRefCount,
      corruptedEntryCount,
      beforeStat,
    });
  } finally {
    rl?.close();
    stream?.destroy();
  }

  if (corruptedLine !== null) {
    return Object.freeze({
      status: "corrupted_v2",
      reason: "CORRUPTED_V2_JSONL",
      line: corruptedLine,
      lineCount,
      decisionEventsInRun,
      relationUnknownEventsInRun,
      nonNullModelRefCount,
      corruptedEntryCount,
      beforeStat,
    });
  }
  if (!sawStart || firstKind !== "start") {
    return Object.freeze({
      status: "incomplete_missing_start",
      reason: "MISSING_START",
      line: null,
      lineCount,
      decisionEventsInRun,
      relationUnknownEventsInRun,
      nonNullModelRefCount,
      corruptedEntryCount,
      beforeStat,
    });
  }
  if (!sawFinish || lastKind !== "finish") {
    return Object.freeze({
      status: "incomplete_missing_finish",
      reason: "MISSING_FINISH",
      line: null,
      lineCount,
      decisionEventsInRun,
      relationUnknownEventsInRun,
      nonNullModelRefCount,
      corruptedEntryCount,
      beforeStat,
    });
  }
  return Object.freeze({
    status: "verified_complete",
    reason: null,
    line: null,
    lineCount,
    decisionEventsInRun,
    relationUnknownEventsInRun,
    nonNullModelRefCount,
    corruptedEntryCount,
    beforeStat,
  });
}

function diagnosticFromInspection(
  logRoot: string,
  runId: string,
  filePath: string,
  inspection: UsageLogRunInspection,
): VerifiedUsageLogRunDiagnosticItem {
  return Object.freeze({
    type: "run_diagnostic",
    logRoot,
    runId,
    file: filePath,
    line: inspection.line,
    status: inspection.status,
    reason: inspection.reason,
    lineCount: inspection.lineCount,
    decisionEventsInRun: inspection.decisionEventsInRun,
    relationUnknownEventsInRun: inspection.relationUnknownEventsInRun,
    sawNonNullModelRef: inspection.nonNullModelRefCount > 0,
  });
}

function addInspectionToSummary(
  summary: ReturnType<typeof emptyUsageLogSummary>,
  inspection: UsageLogRunInspection,
): void {
  summary.totalDecisionEventsObserved += inspection.decisionEventsInRun;
  summary.totalRelationUnknownEventsObserved += inspection.relationUnknownEventsInRun;
  summary.totalNonNullModelRefObserved += inspection.nonNullModelRefCount;
  switch (inspection.status) {
    case "verified_complete":
      summary.v2CompleteRuns += 1;
      break;
    case "incomplete_missing_start":
      summary.v2IncompleteMissingStartCount += 1;
      break;
    case "incomplete_missing_finish":
      summary.v2IncompleteMissingFinishCount += 1;
      break;
    case "incomplete_active_run":
      summary.v2ActiveIncompleteCount += 1;
      break;
    case "corrupted_v2":
      summary.corruptedFileCount += 1;
      summary.corruptedLogEntryCount += inspection.corruptedEntryCount;
      break;
    case "corrupted_v1":
      summary.corruptedFileCount += 1;
      summary.corruptedLogEntryCount += 1;
      break;
    case "evidence_unavailable_rotated":
      summary.rotatedBeforePass2RunCount += 1;
      break;
    case "modified_or_rotated_during_pass2":
      summary.modifiedDuringPass2RunCount += 1;
      break;
    case "legacy_v1_ignored":
      break;
  }
}

async function listUsageLogFiles(logRoot: string): Promise<readonly string[]> {
  let dirents;
  try {
    dirents = await readdir(logRoot, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return Object.freeze([]);
    throw error;
  }
  const names = dirents
    .filter(entry => entry.name.endsWith(".jsonl") || entry.name.endsWith(".json"))
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right));
  return Object.freeze(names.map(name => join(logRoot, name)));
}

export async function* iterateVerifiedUsageLogRuns(
  options: UsageLogStreamOptions,
): AsyncGenerator<VerifiedUsageLogRunDiagnosticItem, UsageLogPoolSummary, void> {
  const logRoot = resolve(options.logRoot);
  const summary = emptyUsageLogSummary(logRoot);
  const files = await listUsageLogFiles(logRoot);
  for (const filePath of files) {
    abortIfRequested(options.signal);
    if (filePath.endsWith(".json")) {
      const v1 = await looksLikeV1RunLog(filePath);
      const runId = filePath.slice(filePath.lastIndexOf("/") + 1, -".json".length);
      const inspection: UsageLogRunInspection = Object.freeze({
        status: v1 ? "legacy_v1_ignored" : "corrupted_v1",
        reason: v1 ? "LEGACY_V1_IGNORED" : "CORRUPTED_V1_JSON",
        line: v1 ? null : 1,
        lineCount: v1 ? 1 : 0,
        decisionEventsInRun: 0,
        relationUnknownEventsInRun: 0,
        nonNullModelRefCount: 0,
        corruptedEntryCount: v1 ? 0 : 1,
        beforeStat: null,
      });
      if (v1) summary.v1LegacyRunsCount += 1;
      addInspectionToSummary(summary, inspection);
      yield diagnosticFromInspection(logRoot, runId, filePath, inspection);
      continue;
    }
    const runId = safeRunId(filePath.slice(filePath.lastIndexOf("/") + 1, -".jsonl".length));
    if (await isRunActive(logRoot, runId)) {
      const inspection: UsageLogRunInspection = Object.freeze({
        status: "incomplete_active_run",
        reason: "ACTIVE_RUN_MARKER_PRESENT",
        line: null,
        lineCount: 0,
        decisionEventsInRun: 0,
        relationUnknownEventsInRun: 0,
        nonNullModelRefCount: 0,
        corruptedEntryCount: 0,
        beforeStat: null,
      });
      addInspectionToSummary(summary, inspection);
      yield diagnosticFromInspection(logRoot, runId, filePath, inspection);
      continue;
    }
    const inspection = await inspectUsageLogRunPass1(filePath, runId);
    addInspectionToSummary(summary, inspection);
    yield diagnosticFromInspection(logRoot, runId, filePath, inspection);
  }
  return frozenUsageLogSummary(summary);
}

async function* streamVerifiedUsageLogRunCandidates(
  logRoot: string,
  filePath: string,
  runId: string,
  beforeStat: UsageLogFileStatSnapshot,
  expectedLineCount: number,
  expectedDecisionEvents: number,
  expectedRelationUnknownEvents: number,
  expectedNonNullModelRef: boolean,
  signal?: AbortSignal,
): AsyncGenerator<VerifiedUsageLogCandidateItem | VerifiedUsageLogRunDiagnosticItem, void, void> {
  let stream: ReturnType<typeof createReadStream> | null = null;
  let rl: readline.Interface | null = null;
  let lineCount = 0;
  let lastKind: string | null = null;
  let decisionEventsInRun = 0;
  let relationUnknownEventsInRun = 0;
  let sawNonNullModelRef = false;
  let modified = false;
  let reason: string | null = null;
  try {
    let openedStat: UsageLogFileStatSnapshot;
    try {
      const info = await lstat(filePath);
      if (info.isDirectory() || info.isSymbolicLink()) {
        yield Object.freeze({
          type: "run_diagnostic",
          logRoot,
          runId,
          file: filePath,
          line: null,
          status: "modified_or_rotated_during_pass2",
          reason: "NON_FILE_USAGE_LOG",
          lineCount: 0,
          decisionEventsInRun: 0,
          relationUnknownEventsInRun: 0,
          sawNonNullModelRef: false,
        });
        return;
      }
      openedStat = statSnapshot(info);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        yield Object.freeze({
          type: "run_diagnostic",
          logRoot,
          runId,
          file: filePath,
          line: null,
          status: "evidence_unavailable_rotated",
          reason: "evidence_unavailable_rotated",
          lineCount: 0,
          decisionEventsInRun: 0,
          relationUnknownEventsInRun: 0,
          sawNonNullModelRef: false,
        });
        return;
      }
      throw error;
    }
    if (!sameStatSnapshot(beforeStat, openedStat)) {
      yield Object.freeze({
        type: "run_diagnostic",
        logRoot,
        runId,
        file: filePath,
        line: null,
        status: "modified_or_rotated_during_pass2",
        reason: "CHANGED_BEFORE_PASS2_OPEN",
        lineCount: 0,
        decisionEventsInRun: 0,
        relationUnknownEventsInRun: 0,
        sawNonNullModelRef: false,
      });
      return;
    }
    stream = createReadStream(filePath, { encoding: "utf8" });
    rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const rawLine of rl) {
      abortIfRequested(signal);
      const line = rawLine.trim();
      if (line.length === 0) continue;
      lineCount += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        modified = true;
        reason = "CORRUPTED_V2_JSONL_DURING_PASS2";
        break;
      }
      if (!isRecord(parsed) || parsed.schema !== USAGE_LOG_SCHEMA || parsed.runId !== runId) {
        modified = true;
        reason = "INVALID_V2_EVENT_DURING_PASS2";
        break;
      }
      const kind = parsed.kind;
      const seq = parsed.seq;
      if (
        !isAllowedUsageLogKind(kind)
        || !Number.isSafeInteger(seq)
      ) {
        modified = true;
        reason = "INVALID_V2_EVENT_DURING_PASS2";
        break;
      }
      lastKind = kind;
      if (kind === "decision") decisionEventsInRun += 1;
      if (kind === "relation_unknown") relationUnknownEventsInRun += 1;
      if (parsed.modelRef !== null && parsed.modelRef !== undefined) sawNonNullModelRef = true;
      if (kind === "decision" || kind === "relation_unknown") {
        yield Object.freeze({
          type: "candidate",
          logRoot,
          runId,
          file: filePath,
          seq: seq as number,
          observedAt: typeof parsed.observedAt === "string" ? parsed.observedAt : "",
          kind,
          modelRef: typeof parsed.modelRef === "string" ? parsed.modelRef : null,
          body: Object.freeze({ ...parsed }),
        });
      }
    }
    let endStat: UsageLogFileStatSnapshot;
    try {
      endStat = statSnapshot(await lstat(filePath));
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        modified = true;
        reason = "ROTATED_DURING_PASS2";
        endStat = beforeStat;
      } else {
        throw error;
      }
    }
    if (
      modified
      || !sameStatSnapshot(beforeStat, endStat)
      || lineCount !== expectedLineCount
      || lastKind !== "finish"
      || decisionEventsInRun !== expectedDecisionEvents
      || relationUnknownEventsInRun !== expectedRelationUnknownEvents
      || sawNonNullModelRef !== expectedNonNullModelRef
    ) {
      yield Object.freeze({
        type: "run_diagnostic",
        logRoot,
        runId,
        file: filePath,
        line: null,
        status: "modified_or_rotated_during_pass2",
        reason: reason ?? "CHANGED_DURING_PASS2",
        lineCount,
        decisionEventsInRun,
        relationUnknownEventsInRun,
        sawNonNullModelRef,
      });
      return;
    }
    yield Object.freeze({
      type: "run_diagnostic",
      logRoot,
      runId,
      file: filePath,
      line: null,
      status: "verified_complete",
      reason: null,
      lineCount,
      decisionEventsInRun,
      relationUnknownEventsInRun,
      sawNonNullModelRef,
    });
  } catch (error) {
    yield Object.freeze({
      type: "run_diagnostic",
      logRoot,
      runId,
      file: filePath,
      line: null,
      status: "modified_or_rotated_during_pass2",
      reason: error instanceof Error ? error.message : "PASS2_READ_FAILED",
      lineCount,
      decisionEventsInRun,
      relationUnknownEventsInRun,
      sawNonNullModelRef,
    });
  } finally {
    rl?.close();
    stream?.destroy();
  }
}

export async function* iterateVerifiedUsageLogCandidates(
  options: UsageLogStreamOptions,
): AsyncGenerator<VerifiedUsageLogCandidateItem | VerifiedUsageLogRunDiagnosticItem, UsageLogPoolSummary, void> {
  const logRoot = resolve(options.logRoot);
  const summary = emptyUsageLogSummary(logRoot);
  const files = await listUsageLogFiles(logRoot);
  for (const filePath of files) {
    abortIfRequested(options.signal);
    if (filePath.endsWith(".json")) {
      const v1 = await looksLikeV1RunLog(filePath);
      const runId = filePath.slice(filePath.lastIndexOf("/") + 1, -".json".length);
      const inspection: UsageLogRunInspection = Object.freeze({
        status: v1 ? "legacy_v1_ignored" : "corrupted_v1",
        reason: v1 ? "LEGACY_V1_IGNORED" : "CORRUPTED_V1_JSON",
        line: v1 ? null : 1,
        lineCount: v1 ? 1 : 0,
        decisionEventsInRun: 0,
        relationUnknownEventsInRun: 0,
        nonNullModelRefCount: 0,
        corruptedEntryCount: v1 ? 0 : 1,
        beforeStat: null,
      });
      if (v1) summary.v1LegacyRunsCount += 1;
      addInspectionToSummary(summary, inspection);
      yield diagnosticFromInspection(logRoot, runId, filePath, inspection);
      continue;
    }
    const runId = safeRunId(filePath.slice(filePath.lastIndexOf("/") + 1, -".jsonl".length));
    if (await isRunActive(logRoot, runId)) {
      const inspection: UsageLogRunInspection = Object.freeze({
        status: "incomplete_active_run",
        reason: "ACTIVE_RUN_MARKER_PRESENT",
        line: null,
        lineCount: 0,
        decisionEventsInRun: 0,
        relationUnknownEventsInRun: 0,
        nonNullModelRefCount: 0,
        corruptedEntryCount: 0,
        beforeStat: null,
      });
      addInspectionToSummary(summary, inspection);
      yield diagnosticFromInspection(logRoot, runId, filePath, inspection);
      continue;
    }
    const inspection = await inspectUsageLogRunPass1(filePath, runId);
    if (inspection.status !== "verified_complete" || inspection.beforeStat === null) {
      addInspectionToSummary(summary, inspection);
      yield diagnosticFromInspection(logRoot, runId, filePath, inspection);
      continue;
    }
    for await (const item of streamVerifiedUsageLogRunCandidates(
      logRoot,
      filePath,
      runId,
      inspection.beforeStat,
      inspection.lineCount,
      inspection.decisionEventsInRun,
      inspection.relationUnknownEventsInRun,
      inspection.nonNullModelRefCount > 0,
      options.signal,
    )) {
      if (item.type === "run_diagnostic") {
        if (item.status === "modified_or_rotated_during_pass2") {
          summary.modifiedDuringPass2RunCount += 1;
        } else if (item.status === "evidence_unavailable_rotated") {
          summary.rotatedBeforePass2RunCount += 1;
        } else if (item.status === "verified_complete") {
          summary.v2CompleteRuns += 1;
          summary.totalDecisionEventsObserved += item.decisionEventsInRun;
          summary.totalRelationUnknownEventsObserved += item.relationUnknownEventsInRun;
          summary.totalNonNullModelRefObserved += inspection.nonNullModelRefCount;
        }
      }
      yield item;
    }
  }
  return frozenUsageLogSummary(summary);
}

function taggedSpoolError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export async function spoolVerifiedUsageLogCandidates(
  options: SpoolUsageLogCandidatesOptions,
): Promise<SpoolUsageLogCandidatesReceipt> {
  if (typeof options.batchStagingDir !== "string" || options.batchStagingDir.length === 0) {
    throw new TypeError("batchStagingDir must be a non-empty path");
  }
  const resolvedBatchDir = resolve(options.batchStagingDir);
  if (
    !Array.isArray(options.protectedRoots)
    || options.protectedRoots.some(root => typeof root !== "string" || root.length === 0)
  ) {
    throw new TypeError("protectedRoots must be a list of non-empty paths");
  }
  const physicalBatchDir = await resolvePhysicalPath(resolvedBatchDir);
  for (const protectedRoot of options.protectedRoots) {
    const physicalProtectedRoot = await resolvePhysicalPath(protectedRoot);
    const rel = relative(physicalProtectedRoot, physicalBatchDir);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      throw taggedSpoolError(
        "STAGING_DIR_INSIDE_PROTECTED_TREE",
        `batchStagingDir must not be inside a protected source tree: ${resolvedBatchDir}`,
      );
    }
  }
  const receiptBase = {
    status: "staging_batch_dir_occupied" as const,
    reason: "STAGING_BATCH_DIR_ALREADY_EXISTS",
    batchStagingDir: resolvedBatchDir,
    summary: null,
    committedRunCount: 0,
    committedCandidateCount: 0,
    rolledBackRunCount: 0,
    committedRunFiles: Object.freeze([]),
  };
  try {
    await mkdir(dirname(resolvedBatchDir), { recursive: true, mode: 0o700 });
    await mkdir(resolvedBatchDir, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (errorCode(error) === "EEXIST") return Object.freeze(receiptBase);
    throw error;
  }

  const ownedUncommittedTempFiles = new Set<string>();
  let activeRunId: string | null = null;
  let activeSpoolPath: string | null = null;
  let activeHandle: Awaited<ReturnType<typeof open>> | null = null;
  let activeCandidateCount = 0;
  const committedRunFiles: string[] = [];
  let committedRunCount = 0;
  let committedCandidateCount = 0;
  let rolledBackRunCount = 0;
  let summary: UsageLogPoolSummary | null = null;

  const closeActiveHandle = async (): Promise<void> => {
    if (activeHandle !== null) {
      const handle = activeHandle;
      activeHandle = null;
      await handle.close();
    }
  };

  try {
    const iterator = iterateVerifiedUsageLogCandidates({
      logRoot: options.logRoot,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    while (true) {
      abortIfRequested(options.signal);
      const next = await iterator.next();
      if (next.done) {
        summary = next.value;
        break;
      }
      const item = next.value;
      if (item.type === "candidate") {
        if (activeRunId !== item.runId) {
          if (activeSpoolPath !== null) {
            await closeActiveHandle();
            if (ownedUncommittedTempFiles.has(activeSpoolPath)) {
              await unlink(activeSpoolPath);
              ownedUncommittedTempFiles.delete(activeSpoolPath);
            }
          }
          activeRunId = item.runId;
          activeSpoolPath = join(resolvedBatchDir, `.spool-${safeRunId(item.runId)}.jsonl`);
          activeHandle = await open(activeSpoolPath, "wx", 0o600);
          ownedUncommittedTempFiles.add(activeSpoolPath);
          activeCandidateCount = 0;
        }
        if (activeHandle === null) throw new Error("spool writer is not open");
        await activeHandle.writeFile(`${JSON.stringify(item)}\n`);
        activeCandidateCount += 1;
        continue;
      }

      await options.onDiagnostic?.(item);
      if (item.status === "verified_complete") {
        if (activeRunId === item.runId && activeSpoolPath !== null) {
          await closeActiveHandle();
          const committedPath = join(
            resolvedBatchDir,
            `unconfirmed-candidates-${safeRunId(item.runId)}.jsonl`,
          );
          try {
            await lstat(committedPath);
            throw taggedSpoolError(
              "COMMITTED_CANDIDATE_FILE_ALREADY_EXISTS",
              `refusing to overwrite existing candidate file: ${committedPath}`,
            );
          } catch (error) {
            if (errorCode(error) !== "ENOENT") throw error;
          }
          await rename(activeSpoolPath, committedPath);
          ownedUncommittedTempFiles.delete(activeSpoolPath);
          committedRunCount += 1;
          committedCandidateCount += activeCandidateCount;
          committedRunFiles.push(committedPath);
          await options.onRunCommitted?.(Object.freeze({
            logRoot: item.logRoot,
            runId: item.runId,
            committedFilePath: committedPath,
            candidateCount: activeCandidateCount,
          }));
        }
        activeRunId = null;
        activeSpoolPath = null;
        activeCandidateCount = 0;
        continue;
      }

      if (
        activeRunId === item.runId
        && activeSpoolPath !== null
        && ownedUncommittedTempFiles.has(activeSpoolPath)
      ) {
        await closeActiveHandle();
        await unlink(activeSpoolPath);
        ownedUncommittedTempFiles.delete(activeSpoolPath);
        rolledBackRunCount += 1;
        activeRunId = null;
        activeSpoolPath = null;
        activeCandidateCount = 0;
      }
    }
    return Object.freeze({
      status: "completed",
      reason: null,
      batchStagingDir: resolvedBatchDir,
      summary,
      committedRunCount,
      committedCandidateCount,
      rolledBackRunCount,
      committedRunFiles: Object.freeze([...committedRunFiles]),
    });
  } finally {
    try {
      await closeActiveHandle();
    } finally {
      for (const spoolPath of [...ownedUncommittedTempFiles]) {
        try {
          await unlink(spoolPath);
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
        ownedUncommittedTempFiles.delete(spoolPath);
      }
    }
  }
}

export function projectValueFlowDecisionUsageEvent(
  input: ValueFlowDecisionProjectionInput,
): UsageLogEventInput {
  if (typeof input.requestId !== "string" || input.requestId.length === 0) {
    throw new TypeError("requestId must be a non-empty string");
  }
  if (typeof input.callsiteKey !== "string" || input.callsiteKey.length === 0) {
    throw new TypeError("callsiteKey must be a non-empty string");
  }
  if (typeof input.candidateKey !== "string" || input.candidateKey.length === 0) {
    throw new TypeError("candidateKey must be a non-empty string");
  }
  if (typeof input.syntaxPatternKey !== "string" || input.syntaxPatternKey.length === 0) {
    throw new TypeError("syntaxPatternKey must be a non-empty string");
  }
  if (typeof input.profileRef !== "string" || input.profileRef.length === 0) {
    throw new TypeError("profileRef must be a non-empty string");
  }
  if (typeof input.modelRef !== "string" || input.modelRef.length === 0) {
    throw new TypeError("modelRef must be a non-empty string");
  }
  if (input.preDecisionFeatures.length !== VALUE_FLOW_FEATURE_NAMES.length
      || !input.preDecisionFeatures.every(value => typeof value === "number" && Number.isFinite(value))) {
    throw new TypeError(`preDecisionFeatures must contain ${VALUE_FLOW_FEATURE_NAMES.length} finite numbers`);
  }
  if (input.inputMissingMask.length !== VALUE_FLOW_FEATURE_NAMES.length
      || !input.inputMissingMask.every(value => typeof value === "boolean")) {
    throw new TypeError(`inputMissingMask must contain ${VALUE_FLOW_FEATURE_NAMES.length} booleans`);
  }
  if (
    input.legalCandidates.length !== VALUE_FLOW_LABELS.length
    || new Set(input.legalCandidates).size !== VALUE_FLOW_LABELS.length
    || !VALUE_FLOW_LABELS.every(label => input.legalCandidates.includes(label))
  ) {
    throw new TypeError(`legalCandidates must be exactly ${VALUE_FLOW_LABELS.join(", ")}`);
  }
  if (!VALUE_FLOW_LABELS.includes(input.originalChoice)) {
    throw new TypeError("originalChoice must be one of holds, insufficient, refuted");
  }
  return Object.freeze({
    kind: "decision",
    body: Object.freeze({
      unitId: VALUE_FLOW_HR_UNIT_ID,
      featureSchema: VALUE_FLOW_FEATURE_SCHEMA,
      labelSchema: "cli.value-flow.candidate-labels-3.v1",
      requestId: input.requestId,
      callsiteKey: input.callsiteKey,
      candidateKey: input.candidateKey,
      syntaxPatternKey: input.syntaxPatternKey,
      requestScopeKey: input.requestScopeKey ?? "default_scope",
      profileRef: input.profileRef,
      modelRef: input.modelRef,
      preDecisionFeatures: Object.freeze([...input.preDecisionFeatures]),
      inputMissingMask: Object.freeze([...input.inputMissingMask]),
      legalCandidates: Object.freeze([...input.legalCandidates]),
      originalChoice: input.originalChoice,
      scoresByLabel: input.scoresByLabel === undefined
        ? null
        : Object.freeze({ ...input.scoresByLabel }),
      reviewState: "unreviewed",
      decisionRuntimeCollectionIntegrated: false,
    }),
  });
}
