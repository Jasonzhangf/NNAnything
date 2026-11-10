// B-A1 E2 page-side projection.
//
// This module runs in the page main world. It owns live DOM measurement and
// returns only JSON-safe candidate facts. The Node runtime must never receive a
// live Element, Document, Window, or `propertiesOf` callback from this module.

import {
  projectSearchInputHostCandidates,
  searchInputHostHostOf,
} from "./search-input-host-projection.js";
import {
  createStableNodeRefRegistry,
  observeLiveDom,
} from "./live-dom.js";
import {
  SEARCH_INPUT_HOST_ROLE,
  validateSearchInputHostCandidate,
  validateSearchInputHostCoverage,
  type SearchInputHostAccess,
  type SearchInputHostCandidate,
  type SearchInputHostCoverage,
} from "./search-input-host-contract.js";
import type { BA1Identity } from "../../training/b-a1-evaluator.js";

export const BA1_REAL_SITE_BROWSER_PROJECTION_REQUEST_SCHEMA =
  "nnanything.b-a1.real-site-browser-projection-request.v1" as const;
export const BA1_REAL_SITE_BROWSER_PROJECTION_RESPONSE_SCHEMA =
  "nnanything.b-a1.real-site-browser-projection-response.v1" as const;

/**
 * The accepted successor deliberately stops at the host-document scope. The
 * MDN shadow-root path is not traversed in this milestone, so host-scope
 * coverage must be reported as partial/unresolved rather than full coverage.
 */
export const BA1_REAL_SITE_MDN_SHADOW_ROOT_COVERAGE = "partial" as const;

export interface BA1RealSiteBrowserProjectionRequest {
  readonly schema: typeof BA1_REAL_SITE_BROWSER_PROJECTION_REQUEST_SCHEMA;
  readonly requestId: string;
  readonly identity: BA1Identity;
  readonly scopeSelector: string;
  readonly requestedRole: string;
  readonly access: SearchInputHostAccess;
}

export interface BA1RealSiteProjectedObservation {
  readonly identity: BA1Identity;
  readonly scopeRef: string;
  readonly requestedRole: string;
  readonly candidates: readonly SearchInputHostCandidate[];
  readonly outsideScopeRefs: readonly string[];
  readonly coverage: SearchInputHostCoverage;
}

export interface BA1RealSiteBrowserProjectionSuccess {
  readonly schema: typeof BA1_REAL_SITE_BROWSER_PROJECTION_RESPONSE_SCHEMA;
  readonly requestId: string;
  readonly ok: true;
  readonly projection: BA1RealSiteProjectedObservation;
}

export interface BA1RealSiteBrowserProjectionFailure {
  readonly schema: typeof BA1_REAL_SITE_BROWSER_PROJECTION_RESPONSE_SCHEMA;
  readonly requestId: string;
  readonly ok: false;
  readonly error: {
    readonly code:
      | "invalid_request"
      | "scope_not_found"
      | "scope_ambiguous"
      | "observation_failed"
      | "projection_failed";
    readonly stage: "request" | "resolver" | "observation" | "projection";
    readonly message: string;
  };
}

export type BA1RealSiteBrowserProjectionResponse =
  | BA1RealSiteBrowserProjectionSuccess
  | BA1RealSiteBrowserProjectionFailure;

export const BA1_REAL_SITE_BROWSER_ACTION_REQUEST_SCHEMA =
  "nnanything.b-a1.real-site-browser-action-request.v1" as const;
export const BA1_REAL_SITE_BROWSER_ACTION_RESPONSE_SCHEMA =
  "nnanything.b-a1.real-site-browser-action-response.v1" as const;

export type BA1RealSiteBrowserActionErrorCode =
  | "invalid_request"
  | "scope_not_found"
  | "scope_ambiguous"
  | "target_missing"
  | "target_stale"
  | "target_not_unique"
  | "target_mismatch"
  | "action_failed";

export interface BA1RealSiteBrowserActionFailure {
  readonly schema: typeof BA1_REAL_SITE_BROWSER_ACTION_RESPONSE_SCHEMA;
  readonly requestId: string;
  readonly ok: false;
  readonly error: {
    readonly code: BA1RealSiteBrowserActionErrorCode;
    readonly message: string;
  };
}

interface ActionTargetFacts {
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

export type BA1RealSiteBrowserActionResult =
  | {
      readonly kind: "target_resolved";
      readonly facts: ActionTargetFacts;
    }
  | {
      readonly kind: "target_read";
      readonly facts: ActionTargetFacts;
    }
  | {
      readonly kind: "scope_presence";
      readonly scopeCount: number;
      readonly eligibleInputCount: number;
      readonly url: string;
    }
  | {
      readonly kind: "scope_observer_armed";
      readonly observerId: string;
    }
  | {
      readonly kind: "scope_observer_result";
      readonly mode: "appearance" | "rerender";
      readonly appeared: boolean;
      readonly scopeCount: number;
      readonly eligibleInputCount: number;
      readonly url: string;
    }
  | {
      readonly kind: "scope_observer_released";
      readonly observerId: string;
      readonly released: boolean;
    };

export interface BA1RealSiteBrowserActionSuccess {
  readonly schema: typeof BA1_REAL_SITE_BROWSER_ACTION_RESPONSE_SCHEMA;
  readonly requestId: string;
  readonly ok: true;
  readonly result: BA1RealSiteBrowserActionResult;
}

export type BA1RealSiteBrowserActionResponse =
  | BA1RealSiteBrowserActionSuccess
  | BA1RealSiteBrowserActionFailure;

interface RegisteredActionTarget {
  readonly observationKey: string;
  readonly weak: WeakRef<Element>;
  readonly scopeSelector: string | null;
  readonly recipeSelector: string | null;
}

interface ScopeObserverRecord {
  readonly observerId: string;
  readonly scopeSelector: string;
  readonly mode: "appearance" | "rerender";
  readonly observer: MutationObserver;
  readonly timer: ReturnType<typeof setTimeout>;
  claimed: boolean;
  readonly promise: Promise<{
    readonly appeared: boolean;
    readonly scopeCount: number;
    readonly eligibleInputCount: number;
    readonly url: string;
  }>;
  readonly resolve: (value: {
    readonly appeared: boolean;
    readonly scopeCount: number;
    readonly eligibleInputCount: number;
    readonly url: string;
  }) => void;
}

const actionTargetRegistry = new Map<string, RegisteredActionTarget>();
const scopeObservers = new Map<string, ScopeObserverRecord>();
let nextActionSequence = 1;

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

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
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
  requireExactKeys(identity, ["documentRef", "observationId", "revision"], label);
  const revision = identity.revision;
  if (typeof revision !== "number" || !Number.isInteger(revision)) {
    throw new TypeError(`${label}.revision must be an integer`);
  }
  return Object.freeze({
    documentRef: requireNonEmptyString(identity.documentRef, `${label}.documentRef`),
    observationId: requireNonEmptyString(identity.observationId, `${label}.observationId`),
    revision,
  });
}

function requireAccess(value: unknown, label: string): SearchInputHostAccess {
  if (
    value !== "available"
    && value !== "login_required"
    && value !== "challenge"
    && value !== "unknown"
  ) {
    throw new TypeError(`${label} must be available, login_required, challenge or unknown`);
  }
  return value;
}

function validateRequest(raw: unknown): BA1RealSiteBrowserProjectionRequest {
  const request = requireRecord(raw, "projection request");
  requireExactKeys(
    request,
    ["schema", "requestId", "identity", "scopeSelector", "requestedRole", "access"],
    "projection request",
  );
  if (request.schema !== BA1_REAL_SITE_BROWSER_PROJECTION_REQUEST_SCHEMA) {
    throw new TypeError("projection request schema is invalid");
  }
  return Object.freeze({
    schema: BA1_REAL_SITE_BROWSER_PROJECTION_REQUEST_SCHEMA,
    requestId: requireNonEmptyString(request.requestId, "projection request.requestId"),
    identity: parseIdentity(request.identity, "projection request.identity"),
    scopeSelector: requireNonEmptyString(request.scopeSelector, "projection request.scopeSelector"),
    requestedRole: requireNonEmptyString(request.requestedRole, "projection request.requestedRole"),
    access: requireAccess(request.access, "projection request.access"),
  });
}

function failure(
  requestId: string,
  code: BA1RealSiteBrowserProjectionFailure["error"]["code"],
  stage: BA1RealSiteBrowserProjectionFailure["error"]["stage"],
  message: string,
): BA1RealSiteBrowserProjectionFailure {
  return {
    schema: BA1_REAL_SITE_BROWSER_PROJECTION_RESPONSE_SCHEMA,
    requestId,
    ok: false,
    error: { code, stage, message },
  };
}

function isWithinScope(element: Element, scopeRoot: Element): boolean {
  let cursor: Element | null = element;
  while (cursor !== null) {
    if (cursor === scopeRoot) return true;
    cursor = cursor.parentElement;
  }
  return false;
}

function openShadowRootCount(scopeRoot: Element): number {
  let count = 0;
  const visit = (root: Element): void => {
    if (root.shadowRoot !== null) count += 1;
    for (const child of Array.from(root.children)) visit(child);
  };
  visit(scopeRoot);
  return count;
}

function correctMissingMeasurements(
  candidate: SearchInputHostCandidate,
  properties: Record<string, unknown> | null,
): SearchInputHostCandidate {
  const disabledMeasured = properties !== null && typeof properties.disabled === "boolean";
  const disabled = disabledMeasured ? (properties.disabled as boolean) : null;
  const editable = disabledMeasured && candidate.readOnly !== null
    ? !disabled && candidate.readOnly !== true
    : null;
  return { ...candidate, disabled, editable };
}

function measureProjection(
  request: BA1RealSiteBrowserProjectionRequest,
): BA1RealSiteProjectedObservation {
  let scopeRoot: Element;
  try {
    const matches = document.querySelectorAll(request.scopeSelector);
    if (matches.length === 0) {
      throw Object.assign(new Error(`scope selector matched no elements: ${request.scopeSelector}`), {
        projectionCode: "scope_not_found",
        projectionStage: "resolver",
      });
    }
    if (matches.length !== 1) {
      throw Object.assign(new Error(`scope selector matched ${matches.length} elements`), {
        projectionCode: "scope_ambiguous",
        projectionStage: "resolver",
      });
    }
    scopeRoot = matches[0]!;
  } catch (error) {
    if (error instanceof Error && "projectionCode" in error) throw error;
    throw Object.assign(new Error(`scope selector is invalid: ${request.scopeSelector}`), {
      projectionCode: "invalid_request",
      projectionStage: "resolver",
    });
  }

  if (!(scopeRoot instanceof Element)) {
    throw Object.assign(new Error("scope selector did not resolve to an Element"), {
      projectionCode: "observation_failed",
      projectionStage: "resolver",
    });
  }

  const scopeRef = request.scopeSelector;
  let live: {
    readonly observed: readonly { readonly nodeRef: string; readonly element: Element }[];
    readonly observedHosts: readonly { readonly nodeRef: string; readonly element: Element }[];
    readonly propertiesOf: (nodeRef: string) => Record<string, unknown> | null;
  };
  try {
    const snapshot = observeLiveDom({
      document,
      window,
      registry: createStableNodeRefRegistry("node"),
      excludeRoot: null,
      snapshotRef: request.identity.observationId,
      documentRef: request.identity.documentRef,
    });
    const observed = snapshot.observation.nodes.flatMap(node => {
      const element = snapshot.resolveElement(node.nodeRef);
      return element === null || !isWithinScope(element, scopeRoot)
        ? []
        : [{ nodeRef: node.nodeRef, element }];
    });
    const observedHosts = observed.filter(node => searchInputHostHostOf(node.element) !== null);
    live = {
      observed,
      observedHosts,
      propertiesOf: (nodeRef: string) => {
        const properties = snapshot.properties.get(nodeRef);
        return properties === undefined ? null : properties as unknown as Record<string, unknown>;
      },
    };
  } catch (error) {
    throw Object.assign(
      new Error(error instanceof Error ? error.message : String(error)),
      { projectionCode: "observation_failed", projectionStage: "observation" },
    );
  }

  let projected: readonly SearchInputHostCandidate[];
  try {
    projected = projectSearchInputHostCandidates({
      scopeRef,
      documentRef: request.identity.documentRef,
      observationId: request.identity.observationId,
      revision: request.identity.revision,
      scopeRoot,
      nodes: live.observed,
      propertiesOf: live.propertiesOf,
      coverage: {
        scopeRef,
        observedCandidateCount: live.observedHosts.length,
        unassessedIframeCount: scopeRoot.querySelectorAll("iframe").length,
        unassessedObjectCount: scopeRoot.querySelectorAll("object, embed").length,
        unassessedOpenShadowRootCount: openShadowRootCount(scopeRoot),
        excluded: [],
      },
      access: request.access,
    });
  } catch (error) {
    throw Object.assign(
      new Error(error instanceof Error ? error.message : String(error)),
      { projectionCode: "observation_failed", projectionStage: "observation" },
    );
  }

  let candidates: readonly SearchInputHostCandidate[];
  let coverage: SearchInputHostCoverage;
  try {
    candidates = Object.freeze(projected.map((candidate, index) =>
      validateSearchInputHostCandidate(
        correctMissingMeasurements(candidate, live.propertiesOf(candidate.ref)),
        `projection.candidates[${index}]`,
      )));
    coverage = validateSearchInputHostCoverage({
      scopeRef,
      observedCandidateCount: live.observedHosts.length,
      unassessedIframeCount: scopeRoot.querySelectorAll("iframe").length,
      unassessedObjectCount: scopeRoot.querySelectorAll("object, embed").length,
      unassessedOpenShadowRootCount: openShadowRootCount(scopeRoot),
      excluded: [],
    });
  } catch (error) {
    throw Object.assign(
      new Error(error instanceof Error ? error.message : String(error)),
      { projectionCode: "projection_failed", projectionStage: "projection" },
    );
  }

  const candidateByRef = new Map(live.observed.map(node => [node.nodeRef, node.element]));
  const outsideScopeRefs = candidates
    .filter(candidate => {
      const element = candidateByRef.get(candidate.ref);
      return element === undefined || !isWithinScope(element, scopeRoot);
    })
    .map(candidate => candidate.ref);

  registerProjectedActionTargets(request, candidates, candidateByRef);

  return Object.freeze({
    identity: request.identity,
    scopeRef,
    requestedRole: request.requestedRole,
    candidates,
    outsideScopeRefs: Object.freeze(outsideScopeRefs),
    coverage,
  });
}

/**
 * Resolve one request in the page main world and return the serialized
 * response. This is the only page-side entry the CDP runtime invokes.
 */
export function handleBA1RealSiteBrowserProjectionRequest(
  raw: unknown,
): BA1RealSiteBrowserProjectionResponse {
  let requestId = "";
  try {
    const request = validateRequest(raw);
    requestId = request.requestId;
    if (request.requestedRole !== SEARCH_INPUT_HOST_ROLE) {
      return failure(
        requestId,
        "invalid_request",
        "request",
        `unsupported requested role: ${request.requestedRole}`,
      );
    }
    const projection = measureProjection(request);
    return {
      schema: BA1_REAL_SITE_BROWSER_PROJECTION_RESPONSE_SCHEMA,
      requestId,
      ok: true,
      projection,
    };
  } catch (error) {
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      const rawRequestId = (raw as Record<string, unknown>).requestId;
      if (typeof rawRequestId === "string") requestId = rawRequestId;
    }
    const typed = error as Error & {
      projectionCode?: BA1RealSiteBrowserProjectionFailure["error"]["code"];
      projectionStage?: BA1RealSiteBrowserProjectionFailure["error"]["stage"];
    };
    return failure(
      requestId,
      typed.projectionCode ?? "projection_failed",
      typed.projectionStage ?? "request",
      typed.message ?? String(error),
    );
  }
}

function actionObservationKey(identity: BA1Identity): string {
  return `${identity.documentRef}|${identity.observationId}|${identity.revision}`;
}

function retireActionTargetsExcept(observationKey: string | null): void {
  for (const [key, record] of actionTargetRegistry) {
    if (record.observationKey !== observationKey) actionTargetRegistry.delete(key);
  }
}

function registerProjectedActionTargets(
  request: BA1RealSiteBrowserProjectionRequest,
  candidates: readonly SearchInputHostCandidate[],
  elements: ReadonlyMap<string, Element>,
): void {
  const observationKey = actionObservationKey(request.identity);
  retireActionTargetsExcept(observationKey);
  for (const candidate of candidates) {
    const element = elements.get(candidate.ref);
    if (element === undefined) continue;
    actionTargetRegistry.set(`${observationKey}|${candidate.ref}`, {
      observationKey,
      weak: new WeakRef(element),
      scopeSelector: request.scopeSelector,
      recipeSelector: null,
    });
  }
}

function actionFailure(
  requestId: string,
  code: BA1RealSiteBrowserActionErrorCode,
  message: string,
): BA1RealSiteBrowserActionFailure {
  return {
    schema: BA1_REAL_SITE_BROWSER_ACTION_RESPONSE_SCHEMA,
    requestId,
    ok: false,
    error: { code, message },
  };
}

function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return false;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const checkVisibility = (element as Element & { checkVisibility?: () => boolean }).checkVisibility;
  return typeof checkVisibility === "function" ? checkVisibility.call(element) : true;
}

function isEnabled(element: Element): boolean {
  if (
    element instanceof HTMLInputElement
    || element instanceof HTMLButtonElement
    || element instanceof HTMLSelectElement
    || element instanceof HTMLTextAreaElement
  ) {
    return !element.disabled;
  }
  return element.getAttribute("aria-disabled") !== "true";
}

function accessibleNameOf(element: Element): string {
  const ariaLabel = element.getAttribute("aria-label")?.trim();
  if (ariaLabel !== undefined && ariaLabel.length > 0) return ariaLabel;
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy !== null) {
    const text = labelledBy
      .split(/\s+/)
      .map(id => document.getElementById(id)?.textContent?.trim() ?? "")
      .join(" ")
      .trim();
    if (text.length > 0) return text;
  }
  const labels = (element as Element & { labels?: ArrayLike<HTMLLabelElement> | null }).labels;
  if (labels !== null && labels !== undefined) {
    const text = Array.from(labels)
      .map(label => label.textContent?.trim() ?? "")
      .join(" ")
      .trim();
    if (text.length > 0) return text;
  }
  const text = element.textContent?.trim();
  if (text !== undefined && text.length > 0) return text;
  return element.getAttribute("title")?.trim()
    ?? element.getAttribute("placeholder")?.trim()
    ?? "";
}

function implicitRoleOf(element: Element): string {
  const explicit = element.getAttribute("role")?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit.split(/\s+/)[0]!;
  if (element instanceof HTMLInputElement) {
    if (element.type === "search") return "searchbox";
    if (element.type === "text" || element.type === "email"
      || element.type === "tel" || element.type === "url") return "textbox";
    if (element.type === "button" || element.type === "submit" || element.type === "reset") return "button";
  }
  if (element instanceof HTMLButtonElement) return "button";
  if (element instanceof HTMLTextAreaElement) return "textbox";
  if (element instanceof HTMLAnchorElement && element.hasAttribute("href")) return "link";
  return element.tagName.toLowerCase();
}

function readTargetFacts(element: Element, elementRef: string): ActionTargetFacts {
  const rect = element.getBoundingClientRect();
  const inputType = element instanceof HTMLInputElement
    ? (element.type === "search" ? "search" : element.type === "text" ? "text" : null)
    : null;
  const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
    ? element.value
    : element.getAttribute("contenteditable") === "true" || (element as HTMLElement).isContentEditable === true
      ? element.textContent ?? ""
      : null;
  const editable = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
    ? !element.disabled && !element.readOnly
    : (element as HTMLElement).isContentEditable === true;
  return {
    elementRef,
    tag: element instanceof HTMLInputElement
      ? "input"
      : element instanceof HTMLButtonElement ? "button" : "other",
    type: inputType,
    geometry: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    },
    visible: isVisible(element),
    enabled: isEnabled(element),
    editable,
    focused: document.activeElement === element,
    value,
  };
}

function scopeMatchCount(scopeSelector: string): number | null {
  try {
    return document.querySelectorAll(scopeSelector).length;
  } catch {
    return null;
  }
}

function isEligibleInput(element: Element): boolean {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return !element.disabled && !element.readOnly && isVisible(element) && isEnabled(element);
  }
  return (element as HTMLElement).isContentEditable === true && isVisible(element) && isEnabled(element);
}

function rerenderMutationIsRelevant(scopeSelector: string, mutation: MutationRecord): boolean {
  const scopeMatches = document.querySelectorAll(scopeSelector);
  const scopeRoot = scopeMatches.length === 1 ? scopeMatches[0]! : null;
  if (scopeRoot !== null && mutation.target instanceof Element && isWithinScope(mutation.target, scopeRoot)) {
    return true;
  }
  for (const node of [
    ...Array.from(mutation.addedNodes),
    ...Array.from(mutation.removedNodes),
  ]) {
    if (!(node instanceof Element)) continue;
    if (node.matches(scopeSelector) || node.querySelector(scopeSelector) !== null) return true;
  }
  return false;
}

function scopeState(scopeSelector: string): {
  readonly scopeCount: number;
  readonly eligibleInputCount: number;
} | null {
  try {
    const matches = document.querySelectorAll(scopeSelector);
    if (matches.length !== 1) {
      return { scopeCount: matches.length, eligibleInputCount: 0 };
    }
    const scopeRoot = matches[0]!;
    let eligibleInputCount = 0;
    for (const element of Array.from(
      scopeRoot.querySelectorAll("input, textarea, [contenteditable]"),
    )) {
      if (isEligibleInput(element)) eligibleInputCount += 1;
    }
    return { scopeCount: matches.length, eligibleInputCount };
  } catch {
    return null;
  }
}

function resolveProjectedActionTarget(
  scopeSelector: string,
  identity: BA1Identity,
  candidateRef: string,
): Element {
  const observationKey = actionObservationKey(identity);
  const key = `${observationKey}|${candidateRef}`;
  const record = actionTargetRegistry.get(key);
  if (record === undefined) {
    throw Object.assign(new Error("target is not registered for the current observation"), {
      actionCode: "target_missing" as const,
    });
  }
  const element = record.weak.deref();
  if (element === undefined || !element.isConnected) {
    actionTargetRegistry.delete(key);
    throw Object.assign(new Error("target is disconnected or replaced"), {
      actionCode: "target_stale" as const,
    });
  }
  const scopeCount = scopeMatchCount(scopeSelector);
  if (scopeCount === null) {
    throw Object.assign(new Error("scope selector is invalid"), {
      actionCode: "invalid_request" as const,
    });
  }
  if (scopeCount === 0) {
    throw Object.assign(new Error("scope is no longer present"), {
      actionCode: "target_stale" as const,
    });
  }
  if (scopeCount !== 1) {
    throw Object.assign(new Error("scope selector is ambiguous"), {
      actionCode: "scope_ambiguous" as const,
    });
  }
  const scopeRoot = document.querySelector(scopeSelector)!;
  if (!isWithinScope(element, scopeRoot)) {
    throw Object.assign(new Error("target is outside the declared scope"), {
      actionCode: "target_stale" as const,
    });
  }
  return element;
}

function resolveRecipeActionTarget(input: {
  readonly selector: string;
  readonly expectedTag: string;
  readonly expectedRole: string;
  readonly expectedAccessibleName: string;
}): Element {
  let matches: NodeListOf<Element>;
  try {
    matches = document.querySelectorAll(input.selector);
  } catch {
    throw Object.assign(new Error("recipe selector is invalid"), {
      actionCode: "invalid_request" as const,
    });
  }
  if (matches.length === 0) {
    throw Object.assign(new Error("recipe selector matched no element"), {
      actionCode: "target_missing" as const,
    });
  }
  if (matches.length !== 1) {
    throw Object.assign(new Error("recipe selector matched more than one element"), {
      actionCode: "target_not_unique" as const,
    });
  }
  const element = matches[0]!;
  if (element.tagName.toLowerCase() !== input.expectedTag.toLowerCase()
    || implicitRoleOf(element) !== input.expectedRole
    || accessibleNameOf(element) !== input.expectedAccessibleName
    || !isVisible(element)
    || !isEnabled(element)) {
    throw Object.assign(new Error("recipe target does not match the expected tag, role or name"), {
      actionCode: "target_mismatch" as const,
    });
  }
  return element;
}

function resolveActionElement(target: unknown): { readonly element: Element; readonly elementRef: string } {
  const value = requireRecord(target, "action target");
  const kind = requireNonEmptyString(value.kind, "action target.kind");
  if (kind === "projected-candidate") {
    requireExactKeys(value, ["kind", "scopeSelector", "identity", "candidateRef"], "projected action target");
    const identity = parseIdentity(value.identity, "projected action target.identity");
    const scopeSelector = requireNonEmptyString(
      value.scopeSelector,
      "projected action target.scopeSelector",
    );
    const candidateRef = requireNonEmptyString(value.candidateRef, "projected action target.candidateRef");
    const element = resolveProjectedActionTarget(scopeSelector, identity, candidateRef);
    return {
      element,
      elementRef: `${actionObservationKey(identity)}|${candidateRef}`,
    };
  }
  if (kind === "unique-recipe-selector") {
    requireExactKeys(
      value,
      ["kind", "selector", "expectedTag", "expectedRole", "expectedAccessibleName"],
      "recipe action target",
    );
    const element = resolveRecipeActionTarget({
      selector: requireNonEmptyString(value.selector, "recipe action target.selector"),
      expectedTag: requireNonEmptyString(value.expectedTag, "recipe action target.expectedTag"),
      expectedRole: requireNonEmptyString(value.expectedRole, "recipe action target.expectedRole"),
      expectedAccessibleName: requireNonEmptyString(
        value.expectedAccessibleName,
        "recipe action target.expectedAccessibleName",
      ),
    });
    const elementRef = `recipe|${nextActionSequence++}`;
    retireActionTargetsExcept(null);
    actionTargetRegistry.set(elementRef, {
      observationKey: elementRef,
      weak: new WeakRef(element),
      scopeSelector: null,
      recipeSelector: requireNonEmptyString(value.selector, "recipe action target.selector"),
    });
    return { element, elementRef };
  }
  throw Object.assign(new Error(`unsupported action target kind: ${kind}`), {
    actionCode: "invalid_request" as const,
  });
}

type ScopeObserverOutcome = {
  readonly appeared: boolean;
  readonly scopeCount: number;
  readonly eligibleInputCount: number;
  readonly url: string;
};

function armScopeObserver(
  scopeSelector: string,
  timeoutMs: number,
  mode: "appearance" | "rerender",
): ScopeObserverRecord {
  const scopeRoot = mode === "rerender" ? document.querySelector(scopeSelector) : null;
  if (mode === "rerender" && scopeRoot === null) {
    throw Object.assign(new Error("rerender scope is not present"), {
      actionCode: "scope_not_found" as const,
    });
  }
  const observerTarget = mode === "appearance"
    ? document.documentElement
    : scopeRoot!.parentElement ?? document.documentElement;
  const observerId = `scope-observer-${nextActionSequence++}`;
  let resolvePromise!: (value: ScopeObserverOutcome) => void;
  const promise = new Promise<ScopeObserverOutcome>(resolve => {
    resolvePromise = resolve;
  });
  let finished = false;
  const finish = (state: ScopeObserverOutcome): void => {
    if (finished) return;
    finished = true;
    record.observer.disconnect();
    clearTimeout(record.timer);
    resolvePromise(state);
  };
  const observer = new MutationObserver(mutations => {
    if (mode === "rerender" && !mutations.some(mutation => rerenderMutationIsRelevant(scopeSelector, mutation))) {
      return;
    }
    const state = scopeState(scopeSelector);
    if (mode === "appearance") {
      if (state === null) {
        finish({ appeared: false, scopeCount: 0, eligibleInputCount: 0, url: location.href });
        return;
      }
      if (state.scopeCount === 1) {
        finish({
          appeared: state.eligibleInputCount === 1,
          scopeCount: state.scopeCount,
          eligibleInputCount: state.eligibleInputCount,
          url: location.href,
        });
        return;
      }
      if (state.scopeCount > 1) {
        finish({
          appeared: false,
          scopeCount: state.scopeCount,
          eligibleInputCount: 0,
          url: location.href,
        });
      }
      return;
    }
    if (state !== null && state.scopeCount === 1 && state.eligibleInputCount === 1) {
      finish({
        appeared: true,
        scopeCount: 1,
        eligibleInputCount: 1,
        url: location.href,
      });
    }
  });
  const timer = setTimeout(() => {
    const state = scopeState(scopeSelector);
    finish({
      appeared: false,
      scopeCount: state === null ? 0 : state.scopeCount,
      eligibleInputCount: state === null ? 0 : state.eligibleInputCount,
      url: location.href,
    });
  }, timeoutMs);
  const record: ScopeObserverRecord = {
    observerId,
    scopeSelector,
    mode,
    observer,
    timer,
    claimed: false,
    promise,
    resolve: (value) => resolvePromise(value),
  };
  scopeObservers.set(observerId, record);
  observer.observe(observerTarget, {
    childList: true,
    subtree: true,
    ...(mode === "appearance" ? { attributes: true } : {}),
  });
  if (mode === "appearance") {
    const initialState = scopeState(scopeSelector);
    if (initialState !== null && initialState.scopeCount > 0) {
      queueMicrotask(() => finish({
        appeared: initialState.scopeCount === 1 && initialState.eligibleInputCount === 1,
        scopeCount: initialState.scopeCount,
        eligibleInputCount: initialState.eligibleInputCount,
        url: location.href,
      }));
    }
  }
  return record;
}

function releaseScopeObserver(observerId: string): boolean {
  const record = scopeObservers.get(observerId);
  if (record === undefined) return false;
  record.observer.disconnect();
  clearTimeout(record.timer);
  scopeObservers.delete(observerId);
  const state = scopeState(record.scopeSelector);
  record.resolve({
    appeared: false,
    scopeCount: state === null ? 0 : state.scopeCount,
    eligibleInputCount: state === null ? 0 : state.eligibleInputCount,
    url: location.href,
  });
  return true;
}

/**
 * Resolve a typed native-action target in the page main world. The registry
 * keeps only the current bounded observation. No live DOM identity or
 * execution geometry enters the student projection payload.
 */
export function handleBA1RealSiteBrowserActionRequest(
  raw: unknown,
): BA1RealSiteBrowserActionResponse | Promise<BA1RealSiteBrowserActionResponse> {
  let requestId = "";
  try {
    const request = requireRecord(raw, "action request");
    const schema = request.schema;
    if (schema !== BA1_REAL_SITE_BROWSER_ACTION_REQUEST_SCHEMA) {
      throw Object.assign(new Error("action request schema is invalid"), {
        actionCode: "invalid_request" as const,
      });
    }
    requestId = requireNonEmptyString(request.requestId, "action request.requestId");
    const op = requireNonEmptyString(request.op, "action request.op");
    if (op === "resolve-target") {
      requireExactKeys(request, ["schema", "requestId", "op", "target"], "resolve-target request");
      const resolved = resolveActionElement(request.target);
      return {
        schema: BA1_REAL_SITE_BROWSER_ACTION_RESPONSE_SCHEMA,
        requestId,
        ok: true,
        result: {
          kind: "target_resolved",
          facts: readTargetFacts(resolved.element, resolved.elementRef),
        },
      };
    }
    if (op === "read-target") {
      requireExactKeys(request, ["schema", "requestId", "op", "elementRef"], "read-target request");
      const elementRef = requireNonEmptyString(request.elementRef, "read-target request.elementRef");
      const record = actionTargetRegistry.get(elementRef);
      const element = record?.weak.deref();
      if (element === undefined || !element.isConnected) {
        throw Object.assign(new Error("target is disconnected or replaced"), {
          actionCode: "target_stale" as const,
        });
      }
      return {
        schema: BA1_REAL_SITE_BROWSER_ACTION_RESPONSE_SCHEMA,
        requestId,
        ok: true,
        result: { kind: "target_read", facts: readTargetFacts(element, elementRef) },
      };
    }
    if (op === "scope-presence") {
      requireExactKeys(request, ["schema", "requestId", "op", "scopeSelector"], "scope-presence request");
      const selector = requireNonEmptyString(request.scopeSelector, "scope-presence request.scopeSelector");
      const count = scopeMatchCount(selector);
      if (count === null) {
        throw Object.assign(new Error("scope selector is invalid"), {
          actionCode: "invalid_request" as const,
        });
      }
      const state = scopeState(selector);
      return {
        schema: BA1_REAL_SITE_BROWSER_ACTION_RESPONSE_SCHEMA,
        requestId,
        ok: true,
        result: {
          kind: "scope_presence",
          scopeCount: count,
          eligibleInputCount: state?.eligibleInputCount ?? 0,
          url: location.href,
        },
      };
    }
    if (op === "arm-scope-observer") {
      requireExactKeys(
        request,
        ["schema", "requestId", "op", "scopeSelector", "timeoutMs", "mode"],
        "arm-scope-observer request",
      );
      const selector = requireNonEmptyString(request.scopeSelector, "arm-scope-observer request.scopeSelector");
      const timeoutMs = request.timeoutMs;
      if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw Object.assign(new Error("arm-scope-observer request.timeoutMs must be positive"), {
          actionCode: "invalid_request" as const,
        });
      }
      const mode = request.mode;
      if (mode !== "appearance" && mode !== "rerender") {
        throw Object.assign(new Error("arm-scope-observer request.mode is invalid"), {
          actionCode: "invalid_request" as const,
        });
      }
      const record = armScopeObserver(selector, timeoutMs, mode);
      return {
        schema: BA1_REAL_SITE_BROWSER_ACTION_RESPONSE_SCHEMA,
        requestId,
        ok: true,
        result: { kind: "scope_observer_armed", observerId: record.observerId },
      };
    }
    if (op === "await-scope-observer") {
      requireExactKeys(
        request,
        ["schema", "requestId", "op", "observerId", "timeoutMs"],
        "await-scope-observer request",
      );
      const observerId = requireNonEmptyString(
        request.observerId,
        "await-scope-observer request.observerId",
      );
      const timeoutMs = request.timeoutMs;
      if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw Object.assign(new Error("await-scope-observer request.timeoutMs must be positive"), {
          actionCode: "invalid_request" as const,
        });
      }
      const record = scopeObservers.get(observerId);
      if (record === undefined) {
        throw Object.assign(new Error("scope observer is not armed"), {
          actionCode: "invalid_request" as const,
        });
      }
      if (record.claimed) {
        throw Object.assign(new Error("scope observer is already claimed"), {
          actionCode: "invalid_request" as const,
        });
      }
      record.claimed = true;
      return record.promise.then(value => ({
        schema: BA1_REAL_SITE_BROWSER_ACTION_RESPONSE_SCHEMA,
        requestId,
        ok: true as const,
        result: {
          kind: "scope_observer_result" as const,
          mode: record.mode,
          appeared: value.appeared,
          scopeCount: value.scopeCount,
          eligibleInputCount: value.eligibleInputCount,
          url: value.url,
        },
      })).finally(() => {
        scopeObservers.delete(observerId);
      });
    }
    if (op === "release-scope-observer") {
      requireExactKeys(
        request,
        ["schema", "requestId", "op", "observerId"],
        "release-scope-observer request",
      );
      const observerId = requireNonEmptyString(
        request.observerId,
        "release-scope-observer request.observerId",
      );
      const released = releaseScopeObserver(observerId);
      return {
        schema: BA1_REAL_SITE_BROWSER_ACTION_RESPONSE_SCHEMA,
        requestId,
        ok: true,
        result: { kind: "scope_observer_released", observerId, released },
      };
    }
    throw Object.assign(new Error(`unsupported action op: ${op}`), {
      actionCode: "invalid_request" as const,
    });
  } catch (error) {
    if (requestId.length === 0 && typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      const rawRequestId = (raw as Record<string, unknown>).requestId;
      if (typeof rawRequestId === "string") requestId = rawRequestId;
    }
    const typed = error as Error & { actionCode?: BA1RealSiteBrowserActionErrorCode };
    return actionFailure(
      requestId,
      typed.actionCode ?? "action_failed",
      typed.message ?? String(error),
    );
  }
}
