// B-A1 E2 Node-side CDP runtime caller.
//
// This module owns the dedicated CDP target, the active current-control
// provider slot, the page projection request/response transport, and projection
// response validation. The page bridge is injected separately; this module never
// manufactures DOM objects or uses the observation envelope as authority.

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { createCurrentControlAuthority } from "./current-control-authority.js";
import {
  validateSearchInputHostCandidate,
  validateSearchInputHostCoverage,
  type SearchInputHostCandidate,
  type SearchInputHostCoverage,
} from "./search-input-host-contract.js";
import type { BA1Identity } from "../../training/b-a1-evaluator.js";
import type {
  BA1RealSiteBrowserProjectionRequest,
  BA1RealSiteBrowserProjectionResponse,
  BA1RealSiteProjectedObservation,
} from "./b-a1-real-site-browser-projection.js";

export type BA1RealSiteCdpErrorCode =
  | "invalid_request"
  | "projection_failed"
  | "invalid_projection"
  | "stale_candidate"
  | "provider_replaced"
  | "cdp_failure";

export class BA1RealSiteCdpRuntimeError extends Error {
  readonly code: BA1RealSiteCdpErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(
    code: BA1RealSiteCdpErrorCode,
    message: string,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "BA1RealSiteCdpRuntimeError";
    this.code = code;
    this.detail = detail;
  }
}

export interface BA1RealSiteControlRead {
  readonly identity: BA1Identity;
  readonly generation: number;
}

export interface BA1RealSiteControlProvider {
  beginObservation(): BA1Identity;
  currentControl(): BA1Identity;
}

export interface BA1RealSiteControlSlot {
  generation(): number;
  current(): BA1RealSiteControlProvider;
  replace(provider: BA1RealSiteControlProvider): number;
  read(): BA1RealSiteControlRead;
}

export interface BA1RealSiteProjectionOperation {
  readonly operation: BA1RealSiteControlRead;
  readonly projection: BA1RealSiteProjectedObservation;
}

export interface BA1RealSiteCdpRuntime {
  readonly slot: BA1RealSiteControlSlot;
  installProjectionBundle(source: string): Promise<void>;
  setDocumentContent(html: string, documentRef: string): Promise<void>;
  navigate(url: string, documentRef: string): Promise<void>;
  beginProjection(input: {
    readonly scopeSelector: string;
    readonly requestedRole: string;
    readonly access: BA1RealSiteBrowserProjectionRequest["access"];
  }): Promise<BA1RealSiteProjectionOperation>;
  readControl(): BA1RealSiteControlRead;
  replaceDocument(documentRef: string): BA1RealSiteControlRead;
  close(): Promise<void>;
}

interface CdpResponse {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string; readonly data?: unknown };
}

interface CdpEvent {
  readonly method?: string;
  readonly params?: unknown;
  readonly sessionId?: string;
}

interface PendingCdpRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

function sameIdentity(left: BA1Identity, right: BA1Identity): boolean {
  return left.documentRef === right.documentRef
    && left.observationId === right.observationId
    && left.revision === right.revision;
}

function sameRead(left: BA1RealSiteControlRead, right: BA1RealSiteControlRead): boolean {
  return left.generation === right.generation && sameIdentity(left.identity, right.identity);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  const unknown = Object.keys(value).filter(key => !expected.has(key));
  const missing = keys.filter(key => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new TypeError(
      `${label} must contain exactly ${keys.join(", ")}`
      + (unknown.length > 0 ? `; unknown: ${unknown.join(", ")}` : "")
      + (missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""),
    );
  }
}

function parseIdentity(value: unknown, label: string): BA1Identity {
  const identity = requireRecord(value, label);
  exactKeys(identity, ["documentRef", "observationId", "revision"], label);
  const revision = identity.revision;
  if (typeof revision !== "number" || !Number.isInteger(revision)) {
    throw new TypeError(`${label}.revision must be an integer`);
  }
  return {
    documentRef: requireNonEmptyString(identity.documentRef, `${label}.documentRef`),
    observationId: requireNonEmptyString(identity.observationId, `${label}.observationId`),
    revision,
  };
}

/**
 * Reject values that are not JSON-safe before they can be treated as measured
 * facts. This catches callbacks, symbols, functions, and DOM-like objects that a
 * caller might try to pass through a malformed bridge response.
 */
function assertJsonSafe(value: unknown, label: string, seen = new Set<unknown>()): void {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value === "function" || typeof value === "undefined" || typeof value === "symbol"
    || typeof value === "bigint") {
    throw new TypeError(`${label} must be JSON-safe; got ${typeof value}`);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError(`${label} must not contain cycles`);
    seen.add(value);
    value.forEach((entry, index) => assertJsonSafe(entry, `${label}[${index}]`, seen));
    seen.delete(value);
    return;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("nodeType" in record || "ownerDocument" in record || "tagName" in record) {
      throw new TypeError(`${label} must not contain a DOM-like object`);
    }
    if (seen.has(value)) throw new TypeError(`${label} must not contain cycles`);
    seen.add(value);
    for (const [key, entry] of Object.entries(record)) {
      assertJsonSafe(entry, `${label}.${key}`, seen);
    }
    seen.delete(value);
    return;
  }
  throw new TypeError(`${label} must be JSON-safe`);
}

function parseProjection(
  raw: unknown,
  requestId: string,
  request: BA1RealSiteBrowserProjectionRequest,
  token: BA1Identity,
): BA1RealSiteProjectedObservation {
  assertJsonSafe(raw, "projection response");
  const response = requireRecord(raw, "projection response");
  if (response.schema !== "nnanything.b-a1.real-site-browser-projection-response.v1") {
    throw new BA1RealSiteCdpRuntimeError("invalid_projection", "projection response schema is invalid");
  }
  if (response.requestId !== requestId) {
    throw new BA1RealSiteCdpRuntimeError("invalid_projection", "projection response requestId does not match");
  }
  if (response.ok === false) {
    exactKeys(response, ["schema", "requestId", "ok", "error"], "projection failure");
    const error = requireRecord(response.error, "projection failure.error");
    const code = requireNonEmptyString(error.code, "projection failure.error.code");
    const stage = requireNonEmptyString(error.stage, "projection failure.error.stage");
    const message = requireNonEmptyString(error.message, "projection failure.error.message");
    throw new BA1RealSiteCdpRuntimeError("projection_failed", message, { code, stage });
  }
  if (response.ok !== true) {
    throw new BA1RealSiteCdpRuntimeError("invalid_projection", "projection response ok must be true or false");
  }
  exactKeys(response, ["schema", "requestId", "ok", "projection"], "projection response");
  const projection = requireRecord(response.projection, "projection");
  exactKeys(
    projection,
    ["identity", "scopeRef", "requestedRole", "candidates", "outsideScopeRefs", "coverage"],
    "projection",
  );
  if (!Array.isArray(projection.candidates)) {
    throw new BA1RealSiteCdpRuntimeError("invalid_projection", "projection.candidates must be an array");
  }
  if (!Array.isArray(projection.outsideScopeRefs)) {
    throw new BA1RealSiteCdpRuntimeError("invalid_projection", "projection.outsideScopeRefs must be an array");
  }

  const identity = parseIdentity(projection.identity, "projection.identity");
  if (!sameIdentity(identity, token)) {
    throw new BA1RealSiteCdpRuntimeError("stale_candidate", "projection identity does not match the issued token");
  }
  const scopeRef = requireNonEmptyString(projection.scopeRef, "projection.scopeRef");
  const requestedRole = requireNonEmptyString(projection.requestedRole, "projection.requestedRole");
  if (requestedRole !== request.requestedRole) {
    throw new BA1RealSiteCdpRuntimeError("invalid_projection", "projection requestedRole does not match");
  }

  const refs = new Set<string>();
  const candidates = projection.candidates.map((rawCandidate, index) => {
    const candidate = validateSearchInputHostCandidate(
      rawCandidate,
      `projection.candidates[${index}]`,
    ) as SearchInputHostCandidate;
    if (refs.has(candidate.ref)) {
      throw new BA1RealSiteCdpRuntimeError(
        "invalid_projection",
        `projection candidate ref ${candidate.ref} appears twice`,
      );
    }
    refs.add(candidate.ref);
    if (!sameIdentity(candidate, token)) {
      throw new BA1RealSiteCdpRuntimeError(
        "stale_candidate",
        `projection candidate ${candidate.ref} identity does not match the token`,
      );
    }
    if (candidate.scopeRef !== scopeRef) {
      throw new BA1RealSiteCdpRuntimeError(
        "invalid_projection",
        `projection candidate ${candidate.ref} scopeRef does not match`,
      );
    }
    return candidate;
  });

  const coverage = validateSearchInputHostCoverage(projection.coverage) as SearchInputHostCoverage;
  if (coverage.scopeRef !== scopeRef) {
    throw new BA1RealSiteCdpRuntimeError("invalid_projection", "projection coverage scopeRef does not match");
  }
  const outsideScopeRefs = projection.outsideScopeRefs.map((rawRef, index) => {
    const ref = requireNonEmptyString(rawRef, `projection.outsideScopeRefs[${index}]`);
    if (!refs.has(ref)) {
      throw new BA1RealSiteCdpRuntimeError(
        "invalid_projection",
        `projection outsideScopeRefs contains unknown ref ${ref}`,
      );
    }
    return ref;
  });

  return Object.freeze({
    identity,
    scopeRef,
    requestedRole,
    candidates: Object.freeze(candidates),
    outsideScopeRefs: Object.freeze(outsideScopeRefs),
    coverage,
  });
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate a local CDP port"));
        return;
      }
      const port = address.port;
      server.close(error => (error === undefined ? resolve(port) : reject(error)));
    });
  });
}

function defaultChromePath(): string {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "google-chrome",
    "chromium",
    "chromium-browser",
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const candidate of candidates) {
    if (candidate.includes("/")) {
      if (existsSync(candidate)) return candidate;
    } else {
      return candidate;
    }
  }
  throw new BA1RealSiteCdpRuntimeError("cdp_failure", "no Chrome/Chromium executable found");
}

class CdpConnection {
  private readonly process: ChildProcessByStdio<null, null, Readable>;
  private readonly userDataDir: string;
  private readonly websocket: WebSocket;
  private readonly pending = new Map<number, PendingCdpRequest>();
  private readonly stderr: string[] = [];
  private nextId = 1;
  private sessionId: string | null = null;
  private closed = false;

  private constructor(
    process: ChildProcessByStdio<null, null, Readable>,
    userDataDir: string,
    websocket: WebSocket,
  ) {
    this.process = process;
    this.userDataDir = userDataDir;
    this.websocket = websocket;
    this.process.stderr.on("data", chunk => {
      this.stderr.push(String(chunk));
      if (this.stderr.length > 20) this.stderr.shift();
    });
    this.websocket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data)) as CdpResponse & CdpEvent;
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (pending === undefined) return;
        this.pending.delete(message.id);
        if (message.error !== undefined) {
          pending.reject(new BA1RealSiteCdpRuntimeError(
            "cdp_failure",
            message.error.message ?? "CDP request failed",
            { code: message.error.code, data: message.error.data },
          ));
        } else {
          pending.resolve(message.result);
        }
      }
    });
    this.websocket.addEventListener("close", () => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        pending.reject(new BA1RealSiteCdpRuntimeError("cdp_failure", "CDP websocket closed"));
      }
      this.pending.clear();
    });
    this.websocket.addEventListener("error", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new BA1RealSiteCdpRuntimeError("cdp_failure", "CDP websocket error"));
      }
      this.pending.clear();
    });
  }

  static async launch(chromePath: string, headless: boolean): Promise<CdpConnection> {
    const userDataDir = await mkdtemp(join(tmpdir(), "nnanything-b-a1-cdp-"));
    const port = await freePort();
    const args = [
      ...(headless ? ["--headless=new"] : []),
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ];
    const process = spawn(chromePath, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let websocketUrl: string | null = null;
    const deadline = Date.now() + 15_000;
    while (websocketUrl === null && Date.now() < deadline) {
      if (process.exitCode !== null) {
        throw new BA1RealSiteCdpRuntimeError(
          "cdp_failure",
          `Chrome exited before CDP became available (${process.exitCode})`,
        );
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) {
          const version = await response.json() as { webSocketDebuggerUrl?: unknown };
          if (typeof version.webSocketDebuggerUrl === "string") {
            websocketUrl = version.webSocketDebuggerUrl;
          }
        }
      } catch {
        // Chrome is still starting.
      }
      if (websocketUrl === null) await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (websocketUrl === null) {
      process.kill("SIGTERM");
      await rm(userDataDir, { recursive: true, force: true });
      throw new BA1RealSiteCdpRuntimeError("cdp_failure", "Chrome CDP endpoint did not become ready");
    }

    const websocket = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(websocketUrl);
      socket.addEventListener("open", () => resolve(socket), { once: true });
      socket.addEventListener("error", () => reject(
        new BA1RealSiteCdpRuntimeError("cdp_failure", "failed to connect to Chrome CDP websocket"),
      ), { once: true });
    });
    const connection = new CdpConnection(process, userDataDir, websocket);
    try {
      const target = requireRecord(
        await connection.send("Target.createTarget", { url: "about:blank" }),
        "Target.createTarget",
      );
      const targetId = requireNonEmptyString(target.targetId, "Target.createTarget.targetId");
      const attached = requireRecord(
        await connection.send("Target.attachToTarget", { targetId, flatten: true }),
        "Target.attachToTarget",
      );
      connection.sessionId = requireNonEmptyString(attached.sessionId, "Target.attachToTarget.sessionId");
      await connection.send("Page.enable");
      await connection.send("Runtime.enable");
      return connection;
    } catch (error) {
      await connection.close();
      throw error;
    }
  }

  private async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) throw new BA1RealSiteCdpRuntimeError("cdp_failure", "CDP connection is closed");
    const id = this.nextId++;
    const message = {
      id,
      method,
      params,
      ...(this.sessionId === null ? {} : { sessionId: this.sessionId }),
    };
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.websocket.send(JSON.stringify(message));
    });
  }

  async installProjectionBundle(source: string): Promise<void> {
    await this.evaluate(source);
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = requireRecord(
      await this.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: false,
      }),
      "Runtime.evaluate",
    );
    if (result.exceptionDetails !== undefined) {
      throw new BA1RealSiteCdpRuntimeError(
        "projection_failed",
        "page evaluation threw",
        { exceptionDetails: result.exceptionDetails },
      );
    }
    return result.result === undefined
      ? undefined
      : requireRecord(result.result, "Runtime.evaluate.result").value;
  }

  async setDocumentContent(html: string, documentRef: string): Promise<void> {
    const slot = this.slot;
    slot.replace(createCurrentControlAuthority({ documentRef }));
    const frameTree = requireRecord(await this.send("Page.getFrameTree"), "Page.getFrameTree");
    const frameTreeValue = requireRecord(frameTree.frameTree, "Page.getFrameTree.frameTree");
    const frame = requireRecord(frameTreeValue.frame, "Page.getFrameTree.frameTree.frame");
    const frameId = requireNonEmptyString(frame.id, "Page.getFrameTree.frameTree.frame.id");
    await this.send("Page.setDocumentContent", { frameId, html });
    await this.waitForDocumentReady();
  }

  async navigate(url: string, documentRef: string): Promise<void> {
    this.slot.replace(createCurrentControlAuthority({ documentRef }));
    await this.send("Page.navigate", { url });
    await this.waitForDocumentReady();
  }

  async waitForDocumentReady(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await this.evaluate("document.readyState") === "complete") return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new BA1RealSiteCdpRuntimeError("cdp_failure", "document did not reach readyState=complete");
  }

  get slot(): BA1RealSiteControlSlot {
    if (this.slotValue === null) {
      this.slotValue = new BA1RealSiteControlSlotImpl();
    }
    return this.slotValue;
  }

  private slotValue: BA1RealSiteControlSlotImpl | null = null;

  async close(): Promise<void> {
    if (this.closed && this.process.exitCode !== null) {
      await rm(this.userDataDir, { recursive: true, force: true });
      return;
    }
    this.closed = true;
    try {
      this.websocket.close();
    } catch {
      // The socket may already be closed.
    }
    if (this.process.exitCode === null) {
      this.process.kill("SIGTERM");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await rm(this.userDataDir, { recursive: true, force: true });
  }
}

class BA1RealSiteControlSlotImpl implements BA1RealSiteControlSlot {
  private generationValue = 0;
  private providerValue: BA1RealSiteControlProvider | null = null;

  generation(): number {
    return this.generationValue;
  }

  current(): BA1RealSiteControlProvider {
    if (this.providerValue === null) {
      throw new BA1RealSiteCdpRuntimeError("invalid_request", "active control provider is not installed");
    }
    return this.providerValue;
  }

  replace(provider: BA1RealSiteControlProvider): number {
    this.generationValue += 1;
    this.providerValue = provider;
    return this.generationValue;
  }

  read(): BA1RealSiteControlRead {
    return {
      identity: this.current().currentControl(),
      generation: this.generationValue,
    };
  }
}

export function createBA1RealSiteControlSlot(): BA1RealSiteControlSlot {
  return new BA1RealSiteControlSlotImpl();
}

export async function createBA1RealSiteCdpRuntime(options: {
  readonly chromePath?: string;
  readonly headless?: boolean;
} = {}): Promise<BA1RealSiteCdpRuntime> {
  const connection = await CdpConnection.launch(
    options.chromePath ?? defaultChromePath(),
    options.headless ?? true,
  );
  const runtime: BA1RealSiteCdpRuntime = {
    slot: connection.slot,
    installProjectionBundle: source => connection.installProjectionBundle(source),
    setDocumentContent: (html, documentRef) => connection.setDocumentContent(html, documentRef),
    navigate: (url, documentRef) => connection.navigate(url, documentRef),
    beginProjection: async input => {
      const provider = runtime.slot.current();
      const generation = runtime.slot.generation();
      const token = provider.beginObservation();
      const request: BA1RealSiteBrowserProjectionRequest = {
        schema: "nnanything.b-a1.real-site-browser-projection-request.v1",
        requestId: randomUUID(),
        identity: token,
        scopeSelector: requireNonEmptyString(input.scopeSelector, "beginProjection.scopeSelector"),
        requestedRole: requireNonEmptyString(input.requestedRole, "beginProjection.requestedRole"),
        access: input.access,
      };
      const rawResponse = await connection.evaluate(
        `globalThis.__nnanythingBA1RealSiteProjection(${JSON.stringify(request)})`,
      );
      const projection = parseProjection(
        rawResponse as BA1RealSiteBrowserProjectionResponse,
        request.requestId,
        request,
        token,
      );
      const operation = { identity: token, generation };
      const current = runtime.slot.read();
      if (!sameRead(operation, current) || !sameIdentity(provider.currentControl(), token)) {
        throw new BA1RealSiteCdpRuntimeError(
          "stale_candidate",
          "active provider changed before the projection response was accepted",
          { operation, current },
        );
      }
      return { operation, projection };
    },
    readControl: () => runtime.slot.read(),
    replaceDocument: documentRef => {
      runtime.slot.replace(createCurrentControlAuthority({
        documentRef: requireNonEmptyString(documentRef, "documentRef"),
      }));
      return runtime.slot.read();
    },
    close: () => connection.close(),
  };
  return runtime;
}
