// nn-code usage log v2 storage.
//
// The module owns the per-run JSONL file, the 10 GB per-root capacity
// accounting, the short-lived filesystem lock and the event projection for
// the real call-depth result. The CLI bin only parses arguments and projects
// stdout/stderr; it must not implement storage policy here.
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  CallDepthRunResult,
  CallDepthState,
  CallDepthUnresolvedCallsite,
  CallGraphNodeFact,
  DeclSpan,
} from "./call-depth-contract.js";

export const USAGE_LOG_SCHEMA = "nnanything.nn-code.usage-log.v2" as const;
export const LEGACY_USAGE_LOG_SCHEMA = "nnanything.nn-code.run-log.v1" as const;
export const USAGE_LOG_CAPACITY_BYTES = 10_000_000_000 as const;
export const USAGE_LOG_UNKNOWN_EXCERPT_LIMIT = 16 * 1024;
export const USAGE_LOG_RUN_EXCERPT_LIMIT = 1024 * 1024;
export const USAGE_LOG_LOCK_FILE = ".nn-code-usage-log.lock" as const;
export const USAGE_LOG_DEFAULT_SUBPATH = ".local/state/nn-code/runs" as const;
export const USAGE_LOG_DIR_ENV = "NN_CODE_LOG_DIR" as const;

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
