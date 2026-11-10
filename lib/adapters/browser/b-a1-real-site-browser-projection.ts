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
