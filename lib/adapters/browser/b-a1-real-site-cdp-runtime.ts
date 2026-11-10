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
  | "action_failed"
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

export type BA1RealSiteNativeAction =
  | { readonly action: "click" }
  | { readonly action: "replace-text"; readonly text: string }
  | { readonly action: "submit-enter"; readonly expectedText: string };

export type BA1RealSiteActionTarget =
  | {
      readonly kind: "projected-candidate";
      readonly control: BA1RealSiteControlRead;
      readonly scopeSelector: string;
      readonly candidateRef: string;
    }
  | {
      readonly kind: "unique-recipe-selector";
      readonly control: BA1RealSiteControlRead;
      readonly selector: string;
      readonly expectedTag: string;
      readonly expectedRole: string;
      readonly expectedAccessibleName: string;
    };

export type BA1RealSiteActionErrorCode =
  | "STALE_BEFORE_DISPATCH"
  | "AMBIGUOUS_TARGET"
  | "TARGET_NOT_ACTIONABLE"
  | "FOCUS_NOT_ACQUIRED"
  | "VALUE_MISMATCH"
  | "DISPATCH_FAILED"
  | "UNKNOWN_DISPATCH";

export interface BA1RealSiteActionReceipt {
  readonly schema: "nnanything.b-a1.real-site-action-receipt.v1";
  readonly actionId: string;
  readonly action: "click" | "replace-text" | "submit-enter";
  readonly control: {
    readonly documentRef: string;
    readonly observationId: string;
    readonly revision: number;
    readonly generation: number;
  };
  readonly target: {
    readonly candidateRef: string | null;
    readonly tag: "input" | "button" | "other";
    readonly type: "text" | "search" | null;
    readonly geometry: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
    readonly visible: boolean;
    readonly enabled: boolean;
    readonly editable: boolean;
  };
  readonly dispatch: "not_sent" | "complete" | "partial" | "unknown";
  readonly focus: "target" | "other" | "unknown";
  readonly readback: {
    readonly status: "exact" | "mismatch" | "not_applicable" | "unknown";
    readonly value: string | null;
  };
  readonly effectKnowledge: "none" | "focused" | "text_written" | "submitted" | "unknown";
  readonly error: {
    readonly code: BA1RealSiteActionErrorCode;
    readonly message: string;
  } | null;
}

export interface BA1RealSiteTransitionReceipt {
  readonly schema: "nnanything.b-a1.real-site-transition-receipt.v1";
  readonly settleId: string;
  readonly actionReceiptRef: string;
  readonly control: {
    readonly documentRef: string;
    readonly observationId: string;
    readonly revision: number;
    readonly generation: number;
  };
  readonly scopeSelector: string;
  readonly observation:
    | "document_transition"
    | "scope_appeared"
    | "ambiguous_scope"
    | "timeout"
    | "unknown";
  readonly next: {
    readonly documentRef: string;
    readonly observationId: string;
    readonly revision: number;
    readonly generation: number;
  } | null;
  readonly armedAt: string;
  readonly observedAt: string;
  readonly detail: Readonly<Record<string, unknown>>;
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
  executeNativeAction(input: {
    readonly target: BA1RealSiteActionTarget;
    readonly action: BA1RealSiteNativeAction;
  }): Promise<BA1RealSiteActionReceipt>;
  armPostDispatchObservation(input: {
    readonly control: BA1RealSiteControlRead;
    readonly scopeSelector: string;
  }): Promise<{ readonly settleId: string }>;
  awaitPostDispatchObservation(input: {
    readonly settleId: string;
    readonly actionReceiptRef: string;
    readonly transitionSignalDeadlineMs: number;
  }): Promise<BA1RealSiteTransitionReceipt>;
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

interface ContextWaiter {
  readonly resolve: (contextId: number) => void;
  readonly reject: (error: Error) => void;
}

interface DocumentEpochWaiter {
  readonly epoch: number;
  readonly reject: (error: Error) => void;
}

interface SettleTransitionWaiter {
  readonly epoch: number;
  readonly resolve: (value: { readonly epoch: number; readonly documentRef: string }) => void;
}

interface PendingSettle {
  readonly settleId: string;
  readonly control: BA1RealSiteControlRead;
  readonly scopeSelector: string;
  readonly armedEpoch: number;
  readonly armedAt: string;
  readonly transition: Promise<{ readonly epoch: number; readonly documentRef: string }>;
  readonly transitionWaiter: SettleTransitionWaiter;
  readonly appearance: Promise<{
    readonly appeared: boolean;
    readonly scopeCount: number;
    readonly eligibleInputCount: number;
  }> | null;
  readonly ambiguousScope: boolean;
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

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative integer`);
  }
  return value;
}

function parseActionControl(value: unknown, label: string): BA1RealSiteControlRead {
  const control = requireRecord(value, label);
  exactKeys(control, ["identity", "generation"], label);
  return {
    identity: parseIdentity(control.identity, `${label}.identity`),
    generation: nonNegativeInteger(control.generation, `${label}.generation`),
  };
}

function parseNativeAction(value: unknown): BA1RealSiteNativeAction {
  const action = requireRecord(value, "native action");
  const kind = requireNonEmptyString(action.action, "native action.action");
  if (kind === "click") {
    exactKeys(action, ["action"], "click action");
    return { action: "click" };
  }
  if (kind === "replace-text") {
    exactKeys(action, ["action", "text"], "replace-text action");
    return { action: "replace-text", text: requireNonEmptyString(action.text, "replace-text action.text") };
  }
  if (kind === "submit-enter") {
    exactKeys(action, ["action", "expectedText"], "submit-enter action");
    return {
      action: "submit-enter",
      expectedText: requireNonEmptyString(action.expectedText, "submit-enter action.expectedText"),
    };
  }
  throw new TypeError(`unsupported native action: ${kind}`);
}

function parseActionTarget(value: unknown): BA1RealSiteActionTarget {
  const target = requireRecord(value, "native action target");
  const kind = requireNonEmptyString(target.kind, "native action target.kind");
  if (kind === "projected-candidate") {
    exactKeys(
      target,
      ["kind", "control", "scopeSelector", "candidateRef"],
      "projected-candidate target",
    );
    return {
      kind,
      control: parseActionControl(target.control, "projected-candidate target.control"),
      scopeSelector: requireNonEmptyString(
        target.scopeSelector,
        "projected-candidate target.scopeSelector",
      ),
      candidateRef: requireNonEmptyString(target.candidateRef, "projected-candidate target.candidateRef"),
    };
  }
  if (kind === "unique-recipe-selector") {
    exactKeys(
      target,
      ["kind", "control", "selector", "expectedTag", "expectedRole", "expectedAccessibleName"],
      "unique-recipe-selector target",
    );
    return {
      kind,
      control: parseActionControl(target.control, "unique-recipe-selector target.control"),
      selector: requireNonEmptyString(target.selector, "unique-recipe-selector target.selector"),
      expectedTag: requireNonEmptyString(target.expectedTag, "unique-recipe-selector target.expectedTag"),
      expectedRole: requireNonEmptyString(target.expectedRole, "unique-recipe-selector target.expectedRole"),
      expectedAccessibleName: requireNonEmptyString(
        target.expectedAccessibleName,
        "unique-recipe-selector target.expectedAccessibleName",
      ),
    };
  }
  throw new TypeError(`unsupported native action target kind: ${kind}`);
}

function pageActionRequest(
  requestId: string,
  op: string,
  fields: Readonly<Record<string, unknown>>,
): string {
  const request = {
    schema: "nnanything.b-a1.real-site-browser-action-request.v1",
    requestId,
    op,
    ...fields,
  };
  return `globalThis.__nnanythingBA1RealSiteAction(${JSON.stringify(request)})`;
}

function parseActionPageResponse(raw: unknown, requestId: string): Readonly<Record<string, unknown>> {
  assertJsonSafe(raw, "action response");
  const response = requireRecord(raw, "action response");
  if (response.schema !== "nnanything.b-a1.real-site-browser-action-response.v1") {
    throw new BA1RealSiteCdpRuntimeError("action_failed", "action response schema is invalid");
  }
  if (response.requestId !== requestId) {
    throw new BA1RealSiteCdpRuntimeError("action_failed", "action response requestId does not match");
  }
  if (response.ok === false) {
    const error = requireRecord(response.error, "action response.error");
    throw new BA1RealSiteCdpRuntimeError(
      "action_failed",
      requireNonEmptyString(error.message, "action response.error.message"),
      { code: requireNonEmptyString(error.code, "action response.error.code") },
    );
  }
  if (response.ok !== true) {
    throw new BA1RealSiteCdpRuntimeError("action_failed", "action response ok must be true or false");
  }
  return requireRecord(response.result, "action response.result");
}

function pageActionErrorCode(error: unknown): string | null {
  if (!(error instanceof BA1RealSiteCdpRuntimeError)) return null;
  const code = error.detail.code;
  return typeof code === "string" ? code : null;
}

const EMPTY_ACTION_TARGET: BA1RealSiteActionReceipt["target"] = Object.freeze({
  candidateRef: null,
  tag: "other" as const,
  type: null,
  geometry: Object.freeze({ x: 0, y: 0, width: 0, height: 0 }),
  visible: false,
  enabled: false,
  editable: false,
});

function buildActionReceipt(input: {
  readonly actionId: string;
  readonly action: BA1RealSiteNativeAction["action"];
  readonly control: BA1RealSiteControlRead;
  readonly target?: BA1RealSiteActionReceipt["target"];
  readonly dispatch: BA1RealSiteActionReceipt["dispatch"];
  readonly focus: BA1RealSiteActionReceipt["focus"];
  readonly readback: BA1RealSiteActionReceipt["readback"];
  readonly effectKnowledge: BA1RealSiteActionReceipt["effectKnowledge"];
  readonly error: BA1RealSiteActionReceipt["error"];
}): BA1RealSiteActionReceipt {
  return Object.freeze({
    schema: "nnanything.b-a1.real-site-action-receipt.v1" as const,
    actionId: input.actionId,
    action: input.action,
    control: Object.freeze({
      documentRef: input.control.identity.documentRef,
      observationId: input.control.identity.observationId,
      revision: input.control.identity.revision,
      generation: input.control.generation,
    }),
    target: input.target ?? EMPTY_ACTION_TARGET,
    dispatch: input.dispatch,
    focus: input.focus,
    readback: Object.freeze(input.readback),
    effectKnowledge: input.effectKnowledge,
    error: input.error === null ? null : Object.freeze(input.error),
  });
}

interface NativeActionTargetFacts {
  readonly elementRef: string;
  readonly tag: "input" | "button" | "other";
  readonly type: "text" | "search" | null;
  readonly geometry: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly editable: boolean;
  readonly focused: boolean;
  readonly value: string | null;
}

function parseNativeActionFacts(value: unknown): NativeActionTargetFacts {
  const facts = requireRecord(value, "action target facts");
  const geometry = requireRecord(facts.geometry, "action target facts.geometry");
  const tag = facts.tag;
  if (tag !== "input" && tag !== "button" && tag !== "other") {
    throw new BA1RealSiteCdpRuntimeError("action_failed", "action target facts.tag is invalid");
  }
  const type = facts.type;
  if (type !== "text" && type !== "search" && type !== null) {
    throw new BA1RealSiteCdpRuntimeError("action_failed", "action target facts.type is invalid");
  }
  const number = (entry: unknown, label: string): number => {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw new BA1RealSiteCdpRuntimeError("action_failed", `${label} must be a finite number`);
    }
    return entry;
  };
  if (
    typeof facts.visible !== "boolean"
    || typeof facts.enabled !== "boolean"
    || typeof facts.editable !== "boolean"
    || typeof facts.focused !== "boolean"
    || !(facts.value === null || typeof facts.value === "string")
  ) {
    throw new BA1RealSiteCdpRuntimeError("action_failed", "action target facts are invalid");
  }
  return {
    elementRef: requireNonEmptyString(facts.elementRef, "action target facts.elementRef"),
    tag,
    type,
    geometry: {
      x: number(geometry.x, "action target facts.geometry.x"),
      y: number(geometry.y, "action target facts.geometry.y"),
      width: number(geometry.width, "action target facts.geometry.width"),
      height: number(geometry.height, "action target facts.geometry.height"),
    },
    visible: facts.visible,
    enabled: facts.enabled,
    editable: facts.editable,
    focused: facts.focused,
    value: facts.value,
  };
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
  private mainFrameId: string | null = null;
  private defaultContextId: number | null = null;
  private projectionBundleSource: string | null = null;
  private projectionInstalledContextId: number | null = null;
  private documentEpoch = 0;
  private generatedDocumentSequence = 0;
  private explicitBoundarySuppression = 0;
  private readonly contextWaiters = new Set<ContextWaiter>();
  private readonly documentEpochWaiters = new Set<DocumentEpochWaiter>();
  private readonly settleTransitionWaiters = new Set<SettleTransitionWaiter>();
  private readonly settles = new Map<string, PendingSettle>();
  private settleSequence = 0;

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
        return;
      }
      this.handleCdpEvent(message);
    });
    this.websocket.addEventListener("close", () => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        pending.reject(new BA1RealSiteCdpRuntimeError("cdp_failure", "CDP websocket closed"));
      }
      this.pending.clear();
      this.rejectContextWaiters(new BA1RealSiteCdpRuntimeError("cdp_failure", "CDP websocket closed"));
      this.rejectDocumentEpochWaiters(
        new BA1RealSiteCdpRuntimeError("cdp_failure", "CDP websocket closed"),
      );
    });
    this.websocket.addEventListener("error", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new BA1RealSiteCdpRuntimeError("cdp_failure", "CDP websocket error"));
      }
      this.pending.clear();
      this.rejectContextWaiters(new BA1RealSiteCdpRuntimeError("cdp_failure", "CDP websocket error"));
      this.rejectDocumentEpochWaiters(
        new BA1RealSiteCdpRuntimeError("cdp_failure", "CDP websocket error"),
      );
    });
  }

  private handleCdpEvent(message: CdpEvent): void {
    switch (message.method) {
      case "Runtime.executionContextsCleared":
        this.handleMainDocumentBoundary("execution_contexts_cleared");
        return;
      case "Runtime.executionContextDestroyed": {
        const params = requireRecord(message.params ?? {}, "Runtime.executionContextDestroyed.params");
        if (params.executionContextId !== this.defaultContextId) return;
        this.handleMainDocumentBoundary("execution_context_destroyed");
        return;
      }
      case "Runtime.executionContextCreated": {
        const params = requireRecord(message.params ?? {}, "Runtime.executionContextCreated.params");
        const context = requireRecord(params.context, "Runtime.executionContextCreated.params.context");
        const contextId = context.id;
        const auxData = requireRecord(
          context.auxData ?? {},
          "Runtime.executionContextCreated.params.context.auxData",
        );
        if (
          typeof contextId !== "number"
          || !Number.isInteger(contextId)
          || auxData.isDefault !== true
          || auxData.frameId !== this.mainFrameId
        ) {
          return;
        }
        this.defaultContextId = contextId;
        this.projectionInstalledContextId = null;
        this.resolveContextWaiters(contextId);
        return;
      }
      case "Page.frameNavigated": {
        const params = requireRecord(message.params ?? {}, "Page.frameNavigated.params");
        if (params.type === "SameDocument") return;
        const frame = requireRecord(params.frame, "Page.frameNavigated.params.frame");
        if (frame.id !== this.mainFrameId || this.defaultContextId === null) return;
        this.handleMainDocumentBoundary("frame_navigated");
        return;
      }
      default:
        return;
    }
  }

  private handleMainDocumentBoundary(reason: string): void {
    if (this.defaultContextId === null) return;
    this.defaultContextId = null;
    this.projectionInstalledContextId = null;
    if (this.explicitBoundarySuppression > 0) return;
    this.replaceProvider(this.nextGeneratedDocumentRef(), reason);
  }

  private nextGeneratedDocumentRef(): string {
    this.generatedDocumentSequence += 1;
    return `page-document-${this.generatedDocumentSequence}`;
  }

  private replaceProvider(documentRef: string, reason: string): void {
    const previousEpoch = this.documentEpoch;
    this.documentEpoch += 1;
    this.projectionInstalledContextId = null;
    this.slot.replace(createCurrentControlAuthority({
      documentRef: requireNonEmptyString(documentRef, "documentRef"),
    }));
    for (const waiter of this.settleTransitionWaiters) {
      if (waiter.epoch < this.documentEpoch) {
        waiter.resolve({ epoch: this.documentEpoch, documentRef });
        this.settleTransitionWaiters.delete(waiter);
      }
    }
    for (const waiter of this.documentEpochWaiters) {
      if (waiter.epoch === previousEpoch) {
        waiter.reject(new BA1RealSiteCdpRuntimeError(
          "provider_replaced",
          `active document was replaced by ${reason}`,
        ));
        this.documentEpochWaiters.delete(waiter);
      }
    }
  }

  private resolveContextWaiters(contextId: number): void {
    for (const waiter of this.contextWaiters) {
      waiter.resolve(contextId);
      this.contextWaiters.delete(waiter);
    }
  }

  private rejectContextWaiters(error: Error): void {
    for (const waiter of this.contextWaiters) {
      waiter.reject(error);
      this.contextWaiters.delete(waiter);
    }
  }

  private rejectDocumentEpochWaiters(error: Error): void {
    for (const waiter of this.documentEpochWaiters) {
      waiter.reject(error);
      this.documentEpochWaiters.delete(waiter);
    }
  }

  private async waitForDefaultContext(deadline: number): Promise<number> {
    if (this.defaultContextId !== null) return this.defaultContextId;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new BA1RealSiteCdpRuntimeError("cdp_failure", "main-frame execution context did not become ready");
    }
    return await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.contextWaiters.delete(waiter);
        reject(new BA1RealSiteCdpRuntimeError(
          "cdp_failure",
          "main-frame execution context did not become ready",
        ));
      }, remaining);
      const waiter: ContextWaiter = {
        resolve: contextId => {
          clearTimeout(timer);
          resolve(contextId);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.contextWaiters.add(waiter);
    });
  }

  private async evaluateInDocument(expression: string, expectedEpoch: number): Promise<unknown> {
    if (this.documentEpoch !== expectedEpoch) {
      throw new BA1RealSiteCdpRuntimeError(
        "provider_replaced",
        "document changed before the projection request was sent",
      );
    }
    let waiter: DocumentEpochWaiter | null = null;
    const invalidation = new Promise<never>((_, reject) => {
      waiter = {
        epoch: expectedEpoch,
        reject: error => {
          reject(error);
        },
      };
      this.documentEpochWaiters.add(waiter);
    });
    try {
      const operation = (async () => {
        const contextId = await this.waitForDefaultContext(Date.now() + 10_000);
        if (this.documentEpoch !== expectedEpoch) {
          throw new BA1RealSiteCdpRuntimeError(
            "provider_replaced",
            "document changed before evaluate used the main-frame context",
          );
        }
        return await this.evaluate(expression, contextId);
      })();
      return await Promise.race([operation, invalidation]);
    } finally {
      if (waiter !== null) this.documentEpochWaiters.delete(waiter);
    }
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
      const frameTree = requireRecord(await connection.send("Page.getFrameTree"), "Page.getFrameTree");
      const frameTreeValue = requireRecord(frameTree.frameTree, "Page.getFrameTree.frameTree");
      const frame = requireRecord(frameTreeValue.frame, "Page.getFrameTree.frameTree.frame");
      connection.mainFrameId = requireNonEmptyString(
        frame.id,
        "Page.getFrameTree.frameTree.frame.id",
      );
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
    this.projectionBundleSource = source;
    this.projectionInstalledContextId = null;
    await this.ensureProjectionBundle();
  }

  private async ensureProjectionBundle(): Promise<void> {
    const source = this.projectionBundleSource;
    if (source === null) return;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const contextId = await this.waitForDefaultContext(deadline);
      if (this.projectionInstalledContextId === contextId) return;
      const epoch = this.documentEpoch;
      try {
        await this.evaluate(source, contextId);
      } catch (error) {
        if (this.documentEpoch !== epoch || this.defaultContextId !== contextId) continue;
        throw error;
      }
      if (this.documentEpoch === epoch && this.defaultContextId === contextId) {
        this.projectionInstalledContextId = contextId;
        return;
      }
    }
    throw new BA1RealSiteCdpRuntimeError(
      "cdp_failure",
      "projection bundle did not bind to the main-frame execution context",
    );
  }

  async evaluate(expression: string, contextId?: number): Promise<unknown> {
    const result = requireRecord(
      await this.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: false,
        ...(contextId === undefined ? {} : { contextId }),
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
    this.replaceProvider(documentRef, "explicit_set_document_content");
    this.explicitBoundarySuppression += 1;
    try {
      const frameId = this.mainFrameId;
      if (frameId === null) {
        throw new BA1RealSiteCdpRuntimeError("cdp_failure", "main frame is not known");
      }
      await this.send("Page.setDocumentContent", { frameId, html });
      await this.waitForDocumentReady();
    } finally {
      this.explicitBoundarySuppression -= 1;
    }
  }

  async navigate(url: string, documentRef: string): Promise<void> {
    this.replaceProvider(documentRef, "explicit_navigate");
    this.explicitBoundarySuppression += 1;
    try {
      await this.send("Page.navigate", { url });
      await this.waitForDocumentReady();
    } finally {
      this.explicitBoundarySuppression -= 1;
    }
  }

  async waitForDocumentReady(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const contextId = await this.waitForDefaultContext(deadline);
      try {
        const state = await this.evaluate("document.readyState", contextId);
        if (state === "complete" && this.defaultContextId === contextId) return;
      } catch (error) {
        if (this.defaultContextId !== contextId) {
          continue;
        }
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new BA1RealSiteCdpRuntimeError("cdp_failure", "document did not reach readyState=complete");
  }

  documentEpochValue(): number {
    return this.documentEpoch;
  }

  async evaluateProjectionRequest(expression: string, expectedEpoch: number): Promise<unknown> {
    await this.waitForDocumentReady();
    await this.ensureProjectionBundle();
    return await this.evaluateInDocument(expression, expectedEpoch);
  }

  private async evaluateActionRequest(expression: string, expectedEpoch: number): Promise<unknown> {
    await this.waitForDocumentReady();
    await this.ensureProjectionBundle();
    return await this.evaluateInDocument(expression, expectedEpoch);
  }

  private async pageAction(
    op: string,
    fields: Readonly<Record<string, unknown>>,
    expectedEpoch: number,
  ): Promise<Readonly<Record<string, unknown>>> {
    const requestId = randomUUID();
    const raw = await this.evaluateActionRequest(pageActionRequest(requestId, op, fields), expectedEpoch);
    return parseActionPageResponse(raw, requestId);
  }

  private async dispatchClickAt(geometry: NativeActionTargetFacts["geometry"]): Promise<BA1RealSiteActionReceipt["dispatch"]> {
    const x = geometry.x + geometry.width / 2;
    const y = geometry.y + geometry.height / 2;
    try {
      await this.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
    } catch {
      return "not_sent";
    }
    try {
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
    } catch {
      return "partial";
    }
    return "complete";
  }

  private async selectAllText(): Promise<BA1RealSiteActionReceipt["dispatch"]> {
    try {
      await this.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65,
        commands: ["selectAll"],
      });
    } catch {
      return "not_sent";
    }
    try {
      await this.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65,
      });
    } catch {
      return "partial";
    }
    return "complete";
  }

  private async insertText(text: string): Promise<boolean> {
    try {
      await this.send("Input.insertText", { text });
      return true;
    } catch {
      return false;
    }
  }

  private async pressEnter(): Promise<BA1RealSiteActionReceipt["dispatch"]> {
    try {
      await this.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        text: "\r",
        unmodifiedText: "\r",
      });
    } catch {
      return "not_sent";
    }
    try {
      await this.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
    } catch {
      return "partial";
    }
    return "complete";
  }

  private tryReadControl(): BA1RealSiteControlRead | null {
    try {
      return this.slot.read();
    } catch {
      return null;
    }
  }

  async executeNativeAction(input: {
    readonly target: BA1RealSiteActionTarget;
    readonly action: BA1RealSiteNativeAction;
  }): Promise<BA1RealSiteActionReceipt> {
    const target = parseActionTarget(input.target);
    const action = parseNativeAction(input.action);
    const actionId = randomUUID();
    const control = target.control;
    const fail = (
      code: BA1RealSiteActionErrorCode,
      message: string,
      dispatch: BA1RealSiteActionReceipt["dispatch"] = "not_sent",
      extras: {
        readonly target?: BA1RealSiteActionReceipt["target"];
        readonly focus?: BA1RealSiteActionReceipt["focus"];
        readonly readback?: BA1RealSiteActionReceipt["readback"];
        readonly effectKnowledge?: BA1RealSiteActionReceipt["effectKnowledge"];
      } = {},
    ): BA1RealSiteActionReceipt => buildActionReceipt({
      actionId,
      action: action.action,
      control,
      ...(extras.target === undefined ? {} : { target: extras.target }),
      dispatch,
      focus: extras.focus ?? "unknown",
      readback: extras.readback ?? { status: "not_applicable", value: null },
      effectKnowledge: extras.effectKnowledge ?? "none",
      error: { code, message },
    });

    const armedRead = this.tryReadControl();
    if (armedRead === null || !sameRead(control, armedRead)) {
      return fail("STALE_BEFORE_DISPATCH", "active control no longer matches the action target");
    }
    const expectedEpoch = this.documentEpoch;
    const pageTarget = target.kind === "projected-candidate"
      ? {
          kind: target.kind,
          scopeSelector: target.scopeSelector,
          identity: control.identity,
          candidateRef: target.candidateRef,
        }
      : {
          kind: target.kind,
          selector: target.selector,
          expectedTag: target.expectedTag,
          expectedRole: target.expectedRole,
          expectedAccessibleName: target.expectedAccessibleName,
        };
    let facts: NativeActionTargetFacts;
    try {
      const resolved = await this.pageAction("resolve-target", { target: pageTarget }, expectedEpoch);
      if (resolved.kind !== "target_resolved") {
        throw new BA1RealSiteCdpRuntimeError("action_failed", "action target resolution response is invalid");
      }
      facts = parseNativeActionFacts(resolved.facts);
    } catch (error) {
      if (error instanceof BA1RealSiteCdpRuntimeError && error.code === "provider_replaced") {
        return fail("STALE_BEFORE_DISPATCH", "active document changed before target resolution");
      }
      const pageCode = pageActionErrorCode(error);
      const message = error instanceof Error ? error.message : String(error);
      if (pageCode === "invalid_request") throw new TypeError(message);
      if (pageCode === "scope_ambiguous" || pageCode === "target_not_unique" || pageCode === "target_mismatch") {
        return fail("AMBIGUOUS_TARGET", message);
      }
      if (pageCode === "target_missing" || pageCode === "target_stale" || pageCode === "scope_not_found") {
        return fail("STALE_BEFORE_DISPATCH", message);
      }
      return fail("DISPATCH_FAILED", message);
    }

    const targetReceipt: BA1RealSiteActionReceipt["target"] = Object.freeze({
      candidateRef: target.kind === "projected-candidate" ? target.candidateRef : null,
      tag: facts.tag,
      type: facts.type,
      geometry: Object.freeze({ ...facts.geometry }),
      visible: facts.visible,
      enabled: facts.enabled,
      editable: facts.editable,
    });
    const initialFocus: BA1RealSiteActionReceipt["focus"] = facts.focused ? "target" : "other";
    if (!facts.visible || !facts.enabled) {
      return fail("TARGET_NOT_ACTIONABLE", "target is not visible and enabled", "not_sent", {
        target: targetReceipt,
        focus: initialFocus,
      });
    }
    const currentRead = this.tryReadControl();
    if (this.documentEpoch !== expectedEpoch || currentRead === null || !sameRead(control, currentRead)) {
      return fail("STALE_BEFORE_DISPATCH", "document changed before dispatch", "not_sent", {
        target: targetReceipt,
        focus: initialFocus,
      });
    }

    const readTarget = async (): Promise<NativeActionTargetFacts | null> => {
      try {
        const read = await this.pageAction(
          "read-target",
          { elementRef: facts.elementRef },
          expectedEpoch,
        );
        if (read.kind !== "target_read") return null;
        return parseNativeActionFacts(read.facts);
      } catch (error) {
        if (error instanceof BA1RealSiteCdpRuntimeError && error.code === "provider_replaced") return null;
        return null;
      }
    };

    if (action.action === "click") {
      const dispatch = await this.dispatchClickAt(facts.geometry);
      if (dispatch !== "complete") {
        return fail("DISPATCH_FAILED", `click dispatch ${dispatch}`, dispatch, {
          target: targetReceipt,
          focus: initialFocus,
        });
      }
      const after = await readTarget();
      const focus: BA1RealSiteActionReceipt["focus"] = after === null
        ? "unknown" : after.focused ? "target" : "other";
      return buildActionReceipt({
        actionId,
        action: action.action,
        control,
        target: targetReceipt,
        dispatch: "complete",
        focus,
        readback: { status: "not_applicable", value: null },
        effectKnowledge: focus === "target" ? "focused" : "none",
        error: null,
      });
    }

    if (!facts.editable) {
      return fail("TARGET_NOT_ACTIONABLE", "target is not editable", "not_sent", {
        target: targetReceipt,
        focus: initialFocus,
      });
    }

    if (action.action === "replace-text") {
      const clickDispatch = await this.dispatchClickAt(facts.geometry);
      if (clickDispatch !== "complete") {
        return fail("DISPATCH_FAILED", `click dispatch ${clickDispatch}`, clickDispatch, {
          target: targetReceipt,
          focus: initialFocus,
        });
      }
      const focused = await readTarget();
      if (focused === null || !focused.focused) {
        return fail("FOCUS_NOT_ACQUIRED", "target focus was not acquired after click", "partial", {
          target: targetReceipt,
          focus: focused === null ? "unknown" : focused.focused ? "target" : "other",
        });
      }
      const selectDispatch = await this.selectAllText();
      if (selectDispatch !== "complete") {
        return fail("DISPATCH_FAILED", `select-all dispatch ${selectDispatch}`, "partial", {
          target: targetReceipt,
          focus: "target",
        });
      }
      if (!(await this.insertText(action.text))) {
        return fail("DISPATCH_FAILED", "text insertion dispatch failed", "partial", {
          target: targetReceipt,
          focus: "target",
        });
      }
      const after = await readTarget();
      const readbackStatus = after !== null && after.value === action.text ? "exact" as const : "mismatch" as const;
      return buildActionReceipt({
        actionId,
        action: action.action,
        control,
        target: targetReceipt,
        dispatch: "complete",
        focus: after === null ? "unknown" : after.focused ? "target" : "other",
        readback: { status: readbackStatus, value: after?.value ?? null },
        effectKnowledge: readbackStatus === "exact" ? "text_written" : "unknown",
        error: readbackStatus === "exact"
          ? null
          : { code: "VALUE_MISMATCH", message: "inserted text did not match the declared literal" },
      });
    }

    const precheck = await readTarget();
    if (precheck === null) {
      return fail("STALE_BEFORE_DISPATCH", "target read failed before submit", "not_sent", {
        target: targetReceipt,
        focus: "unknown",
      });
    }
    if (!precheck.focused) {
      return fail("FOCUS_NOT_ACQUIRED", "target is not focused before submit", "not_sent", {
        target: targetReceipt,
        focus: "other",
        readback: { status: "exact", value: precheck.value },
      });
    }
    if (precheck.value !== action.expectedText) {
      return fail("VALUE_MISMATCH", "target value does not match expectedText before submit", "not_sent", {
        target: targetReceipt,
        focus: "target",
        readback: { status: "mismatch", value: precheck.value },
      });
    }
    const submitRead = this.tryReadControl();
    if (this.documentEpoch !== expectedEpoch || submitRead === null || !sameRead(control, submitRead)) {
      return fail("STALE_BEFORE_DISPATCH", "document changed before submit dispatch", "not_sent", {
        target: targetReceipt,
        focus: "target",
        readback: { status: "exact", value: precheck.value },
      });
    }
    const enterDispatch = await this.pressEnter();
    if (enterDispatch !== "complete") {
      return fail("DISPATCH_FAILED", `enter dispatch ${enterDispatch}`, enterDispatch, {
        target: targetReceipt,
        focus: "target",
        readback: { status: "exact", value: precheck.value },
        effectKnowledge: "unknown",
      });
    }
    return buildActionReceipt({
      actionId,
      action: action.action,
      control,
      target: targetReceipt,
      dispatch: "complete",
      focus: "target",
      readback: { status: "exact", value: precheck.value },
      effectKnowledge: "submitted",
      error: null,
    });
  }

  async armPostDispatchObservation(input: {
    readonly control: BA1RealSiteControlRead;
    readonly scopeSelector: string;
  }): Promise<{ readonly settleId: string }> {
    const control = parseActionControl(input.control, "armPostDispatchObservation.control");
    const scopeSelector = requireNonEmptyString(
      input.scopeSelector,
      "armPostDispatchObservation.scopeSelector",
    );
    const currentRead = this.tryReadControl();
    if (currentRead === null || !sameRead(control, currentRead)) {
      throw new BA1RealSiteCdpRuntimeError(
        "stale_candidate",
        "armPostDispatchObservation control is not current",
      );
    }
    const settleId = `settle-${++this.settleSequence}`;
    const armedEpoch = this.documentEpoch;
    let resolveTransition!: (value: { readonly epoch: number; readonly documentRef: string }) => void;
    const transition = new Promise<{ readonly epoch: number; readonly documentRef: string }>(resolve => {
      resolveTransition = resolve;
    });
    const transitionWaiter: SettleTransitionWaiter = {
      epoch: armedEpoch,
      resolve: value => resolveTransition(value),
    };
    this.settleTransitionWaiters.add(transitionWaiter);
    let appearance: Promise<{
      readonly appeared: boolean;
      readonly scopeCount: number;
      readonly eligibleInputCount: number;
    }> | null = null;
    let ambiguousScope = false;
    try {
      const presence = await this.pageAction(
        "scope-presence",
        { scopeSelector },
        armedEpoch,
      );
      if (presence.kind !== "scope_presence" || typeof presence.scopeCount !== "number") {
        throw new BA1RealSiteCdpRuntimeError("action_failed", "scope presence response is invalid");
      }
      const eligibleInputCount = typeof presence.eligibleInputCount === "number"
        ? presence.eligibleInputCount
        : 0;
      if (presence.scopeCount === 0 && this.documentEpoch === armedEpoch) {
        await this.pageAction(
          "arm-scope-observer",
          { scopeSelector, timeoutMs: 120_000 },
          armedEpoch,
        );
        appearance = this.pageAction(
          "await-scope-appearance",
          { scopeSelector, timeoutMs: 120_000 },
          armedEpoch,
        ).then(value => {
          if (value.kind !== "scope_appearance"
            || typeof value.appeared !== "boolean"
            || typeof value.scopeCount !== "number") {
            return { appeared: false, scopeCount: 0, eligibleInputCount: 0 };
          }
          return {
            appeared: value.appeared,
            scopeCount: value.scopeCount,
            eligibleInputCount: typeof value.eligibleInputCount === "number"
              ? value.eligibleInputCount
              : 0,
          };
        }).catch(() => ({ appeared: false, scopeCount: 0, eligibleInputCount: 0 }));
      } else if (presence.scopeCount > 1 || eligibleInputCount !== 1) {
        ambiguousScope = true;
      }
    } catch (error) {
      this.settleTransitionWaiters.delete(transitionWaiter);
      throw error;
    }
    this.settles.set(settleId, {
      settleId,
      control,
      scopeSelector,
      armedEpoch,
      armedAt: new Date().toISOString(),
      transition,
      transitionWaiter,
      appearance,
      ambiguousScope,
    });
    return { settleId };
  }

  async awaitPostDispatchObservation(input: {
    readonly settleId: string;
    readonly actionReceiptRef: string;
    readonly transitionSignalDeadlineMs: number;
  }): Promise<BA1RealSiteTransitionReceipt> {
    const settleId = requireNonEmptyString(input.settleId, "awaitPostDispatchObservation.settleId");
    const actionReceiptRef = requireNonEmptyString(
      input.actionReceiptRef,
      "awaitPostDispatchObservation.actionReceiptRef",
    );
    const deadlineMs = input.transitionSignalDeadlineMs;
    if (typeof deadlineMs !== "number" || !Number.isFinite(deadlineMs) || deadlineMs <= 0) {
      throw new TypeError("awaitPostDispatchObservation.transitionSignalDeadlineMs must be positive");
    }
    const settle = this.settles.get(settleId);
    if (settle === undefined) {
      throw new BA1RealSiteCdpRuntimeError(
        "invalid_request",
        `unknown post-dispatch settle: ${settleId}`,
      );
    }
    const timeout = new Promise<{ readonly kind: "timeout" }>(resolve => {
      setTimeout(() => resolve({ kind: "timeout" }), deadlineMs);
    });
    const transition = settle.transition.then(value => ({ kind: "document_transition" as const, value }));
    const appearance = settle.ambiguousScope
      ? Promise.resolve({ kind: "ambiguous_scope" as const })
      : settle.appearance === null
        ? new Promise<never>(() => undefined)
        : settle.appearance.then(value => ({ kind: "appearance" as const, value }));
    const outcome = await Promise.race([transition, appearance, timeout]);
    this.settles.delete(settleId);
    this.settleTransitionWaiters.delete(settle.transitionWaiter);
    void this.pageAction("release", {}, this.documentEpoch).catch(() => undefined);

    const observedTransition = outcome.kind === "document_transition"
      || (outcome.kind === "appearance" && outcome.value.appeared);
    if (outcome.kind === "document_transition") {
      try {
        this.slot.current().beginObservation();
      } catch {
        // The new provider is not readable yet; the receipt stays without a next control.
      }
    }
    const current = this.tryReadControl();
    const next = observedTransition && current !== null
      ? Object.freeze({
          documentRef: current.identity.documentRef,
          observationId: current.identity.observationId,
          revision: current.identity.revision,
          generation: current.generation,
        })
      : null;
    return Object.freeze({
      schema: "nnanything.b-a1.real-site-transition-receipt.v1" as const,
      settleId,
      actionReceiptRef,
      control: Object.freeze({
        documentRef: settle.control.identity.documentRef,
        observationId: settle.control.identity.observationId,
        revision: settle.control.identity.revision,
        generation: settle.control.generation,
      }),
      scopeSelector: settle.scopeSelector,
      observation: outcome.kind === "document_transition"
        ? "document_transition" as const
        : outcome.kind === "appearance"
          ? outcome.value.appeared
            ? "scope_appeared" as const
            : outcome.value.scopeCount > 0 ? "ambiguous_scope" as const : "timeout" as const
          : outcome.kind === "ambiguous_scope" ? "ambiguous_scope" as const : "timeout" as const,
      next,
      armedAt: settle.armedAt,
      observedAt: new Date().toISOString(),
      detail: Object.freeze(
        outcome.kind === "document_transition"
          ? { documentEpoch: outcome.value.epoch }
          : outcome.kind === "appearance"
            ? {
                scopeCount: outcome.value.scopeCount,
                eligibleInputCount: outcome.value.eligibleInputCount,
              }
            : { deadlineMs },
      ),
    });
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
      const expectedEpoch = connection.documentEpochValue();
      const request: BA1RealSiteBrowserProjectionRequest = {
        schema: "nnanything.b-a1.real-site-browser-projection-request.v1",
        requestId: randomUUID(),
        identity: token,
        scopeSelector: requireNonEmptyString(input.scopeSelector, "beginProjection.scopeSelector"),
        requestedRole: requireNonEmptyString(input.requestedRole, "beginProjection.requestedRole"),
        access: input.access,
      };
      const rawResponse = await connection.evaluateProjectionRequest(
        `globalThis.__nnanythingBA1RealSiteProjection(${JSON.stringify(request)})`,
        expectedEpoch,
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
    executeNativeAction: input => connection.executeNativeAction(input),
    armPostDispatchObservation: input => connection.armPostDispatchObservation(input),
    awaitPostDispatchObservation: input => connection.awaitPostDispatchObservation(input),
    close: () => connection.close(),
  };
  return runtime;
}
