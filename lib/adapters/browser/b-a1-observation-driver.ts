// B-A1 selection-contrast observation driver.
//
// This module owns only read-only page observation and provisional scope
// discovery. It must not score candidates, approve supervision, or emit TRAIN
// rows. Raw projection coverage and derived harness coverage stay separate.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  isMeasuredSearchInputHostCandidate,
  type SearchInputHostCandidate,
  type SearchInputHostCoverage,
} from "./search-input-host-contract.js";
import {
  BA1RealSiteCdpRuntimeError,
  createBA1RealSiteCdpRuntime,
  type BA1RealSiteCdpRuntime,
  type BA1RealSiteControlRead,
} from "./b-a1-real-site-cdp-runtime.js";
import type { BA1RealSiteProjectedObservation } from "./b-a1-real-site-browser-projection.js";
import type { BA1HarnessObservationRecord } from "../../training/b-a1-sample-converter.js";

export const BA1_OBSERVATION_DRIVER_SOURCE_PLAN_SCHEMA =
  "nnanything.b-a1.selection-contrast-source-plan.v1" as const;
export const BA1_OBSERVATION_DRIVER_RESULT_SCHEMA =
  "nnanything.b-a1.observation-driver-result.v1" as const;
export const BA1_OBSERVATION_DRIVER_TIMING_SCHEMA =
  "nnanything.b-a1.observation-driver-timing.v1" as const;

const MAX_SELECTOR_CANDIDATES = 3;
const TARGET_CAPTURE_COUNT = 2;
const SEARCH_HOST_KINDS = new Set(["input", "textarea", "contenteditable"]);

export type BA1ObservationDriverErrorCode = "invalid_plan";

export class BA1ObservationDriverError extends Error {
  readonly code: BA1ObservationDriverErrorCode;

  constructor(code: BA1ObservationDriverErrorCode, message: string) {
    super(message);
    this.name = "BA1ObservationDriverError";
    this.code = code;
  }
}

export type BA1ObservationDriverSlot = "A" | "B";

export interface BA1ObservationDriverSource {
  readonly slot?: BA1ObservationDriverSlot;
  readonly sourceFamily: string;
  readonly siteId: string;
  readonly entryUrl: string;
  readonly selectorCandidates: readonly string[];
  readonly scopeSelector?: string;
}

export interface BA1ObservationDriverSourcePlan {
  readonly schema: typeof BA1_OBSERVATION_DRIVER_SOURCE_PLAN_SCHEMA;
  readonly status: "pre_registered_not_observed";
  readonly partition: "TRAIN";
  readonly trainSlots: readonly BA1ObservationDriverSource[];
  readonly reserves: readonly BA1ObservationDriverSource[];
}

export type BA1DerivedHarnessCoverage =
  BA1HarnessObservationRecord["observation"]["coverage"];

export type BA1DiscoveryRejection =
  | "coverage_incomplete"
  | "no_search_host_candidate"
  | "no_hidden_measured_candidate"
  | "projection_failed"
  | "scope_not_found"
  | "scope_ambiguous"
  | "scope_shadow_root_unavailable"
  | "scope_stale";

export interface BA1ObservationDiscoveryAttempt {
  readonly selector: string;
  readonly rawCoverage: SearchInputHostCoverage | null;
  readonly derivedCoverage: BA1DerivedHarnessCoverage | null;
  readonly candidateRefs: readonly string[];
  readonly candidateCount: number;
  readonly provisionalSearchHostCount: number;
  readonly hiddenMeasuredCandidateCount: number;
  readonly passed: boolean;
  readonly rejection: BA1DiscoveryRejection | null;
  readonly error: BA1ObservationDriverFailureReceipt | null;
}

export interface BA1ObservationDiscoveryResult {
  readonly passedSelector: string | null;
  readonly attempts: readonly BA1ObservationDiscoveryAttempt[];
}

export interface BA1RawObservationRecord {
  readonly navigation: {
    readonly url: string;
    readonly documentRef: string;
  };
  readonly operation: BA1RealSiteControlRead;
  readonly projection: BA1RealSiteProjectedObservation;
}

export type BA1ObservationSourceStatus =
  | "captured"
  | "navigation_failed"
  | "no_contrast"
  | "observation_missing"
  | "no_provisional_scope"
  | "projection_failed";

export type BA1ObservationSourceRejection =
  | "contrast_missing"
  | "incomplete_coverage"
  | "navigation_failed"
  | "no_provisional_scope"
  | "projection_failed";

export type BA1ObservationFailureStage =
  | "discovery"
  | "navigation"
  | "admitted_projection"
  | "family";

export interface BA1ObservationDriverFailureReceipt {
  readonly stage: BA1ObservationFailureStage;
  readonly selector: string | null;
  readonly name: string;
  readonly code: string | null;
  readonly message: string;
  readonly detail: unknown;
}

export interface BA1ObservationAdmissionPredicates {
  readonly provisionalSearchHostCount: number;
  readonly hiddenMeasuredCandidateCount: number;
}

export interface BA1ObservationSourceOutcome {
  readonly sourceFamily: string;
  readonly siteId: string;
  readonly entryUrl: string;
  readonly partition: "TRAIN";
  readonly status: BA1ObservationSourceStatus;
  readonly pinnedSelector: string | null;
  readonly discovery: BA1ObservationDiscoveryResult;
  readonly rawObservation?: BA1RawObservationRecord;
  readonly derivedCoverage?: BA1DerivedHarnessCoverage;
  readonly admissionPredicates?: BA1ObservationAdmissionPredicates;
  readonly candidateGroupEnumerationComplete?: boolean;
  readonly rejection: BA1ObservationSourceRejection | null;
  readonly error?: BA1ObservationDriverFailureReceipt;
}

export interface BA1ObservationDriverResult {
  readonly schema: typeof BA1_OBSERVATION_DRIVER_RESULT_SCHEMA;
  readonly status: BA1ObservationSourceStatus;
  readonly capturedCount: number;
  readonly sources: readonly BA1ObservationSourceOutcome[];
}

export interface BA1ObservationApprovedSplitDecision {
  readonly sourceFamily: string;
  readonly sourceGroupId: string;
  readonly splitAuthority: string;
  readonly splitDecisionRef: string;
  readonly evidenceRefs: readonly string[];
}

export type BA1ObservationDriverRuntime = Pick<
  BA1RealSiteCdpRuntime,
  "installProjectionBundle" | "navigate" | "beginProjection"
>;

export interface BA1ObservationDriverOptions {
  readonly sourcePlan: unknown;
  readonly outDir: string;
  readonly approvedSplitDecisions?: readonly BA1ObservationApprovedSplitDecision[];
  /**
   * Test and caller injection point. An injected runtime stays owned by the
   * caller; the driver closes only the runtime it creates.
   */
  readonly runtime?: BA1ObservationDriverRuntime;
}

function assertAllowedKeys(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
): void {
  const offenders = Object.keys(record).filter(key => !allowed.includes(key));
  if (offenders.length > 0) {
    throw new BA1ObservationDriverError(
      "invalid_plan",
      `${label} carries unsupported field(s): ${offenders.join(", ")}`,
    );
  }
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BA1ObservationDriverError("invalid_plan", `${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new BA1ObservationDriverError("invalid_plan", `${label} must be an array`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BA1ObservationDriverError("invalid_plan", `${label} must be a non-empty string`);
  }
  return value;
}

function requireFileSafeName(value: unknown, label: string): string {
  const name = requireNonEmptyString(value, label);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new BA1ObservationDriverError(
      "invalid_plan",
      `${label} must use lowercase letters, digits, and hyphens`,
    );
  }
  return name;
}

function requireEntryUrl(value: unknown, label: string): string {
  const text = requireNonEmptyString(value, label);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new BA1ObservationDriverError("invalid_plan", `${label} must be a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BA1ObservationDriverError("invalid_plan", `${label} must use http or https`);
  }
  return text;
}

function parseSource(value: unknown, label: string, allowSlot: boolean): BA1ObservationDriverSource {
  const source = requireRecord(value, label);
  assertAllowedKeys(
    source,
    allowSlot
      ? ["slot", "sourceFamily", "siteId", "entryUrl", "selectorCandidates", "scopeSelector"]
      : ["sourceFamily", "siteId", "entryUrl", "selectorCandidates", "scopeSelector"],
    label,
  );

  let slot: BA1ObservationDriverSlot | undefined;
  if (source.slot !== undefined) {
    if (source.slot !== "A" && source.slot !== "B") {
      throw new BA1ObservationDriverError("invalid_plan", `${label}.slot must be A or B`);
    }
    slot = source.slot;
  }

  const selectors = requireArray(source.selectorCandidates, `${label}.selectorCandidates`)
    .map((entry, index) => requireNonEmptyString(entry, `${label}.selectorCandidates[${index}]`));
  if (selectors.length === 0 || selectors.length > MAX_SELECTOR_CANDIDATES) {
    throw new BA1ObservationDriverError(
      "invalid_plan",
      `${label}.selectorCandidates must contain between 1 and ${MAX_SELECTOR_CANDIDATES} selectors`,
    );
  }
  if (new Set(selectors).size !== selectors.length) {
    throw new BA1ObservationDriverError("invalid_plan", `${label}.selectorCandidates must be unique`);
  }

  const scopeSelector = source.scopeSelector === undefined
    ? undefined
    : requireNonEmptyString(source.scopeSelector, `${label}.scopeSelector`);
  if (scopeSelector !== undefined && !selectors.includes(scopeSelector)) {
    throw new BA1ObservationDriverError(
      "invalid_plan",
      `${label}.scopeSelector must be one of selectorCandidates`,
    );
  }

  return Object.freeze({
    ...(slot === undefined ? {} : { slot }),
    sourceFamily: requireFileSafeName(source.sourceFamily, `${label}.sourceFamily`),
    siteId: requireNonEmptyString(source.siteId, `${label}.siteId`),
    entryUrl: requireEntryUrl(source.entryUrl, `${label}.entryUrl`),
    selectorCandidates: Object.freeze(selectors),
    ...(scopeSelector === undefined ? {} : { scopeSelector }),
  });
}

function parseApprovedSplitDecision(
  value: unknown,
  label: string,
): BA1ObservationApprovedSplitDecision {
  const decision = requireRecord(value, label);
  assertAllowedKeys(
    decision,
    ["sourceFamily", "sourceGroupId", "splitAuthority", "splitDecisionRef", "evidenceRefs"],
    label,
  );
  const evidenceRefs = requireArray(decision.evidenceRefs, `${label}.evidenceRefs`)
    .map((entry, index) => requireNonEmptyString(entry, `${label}.evidenceRefs[${index}]`));
  if (evidenceRefs.length === 0) {
    throw new BA1ObservationDriverError(
      "invalid_plan",
      `${label}.evidenceRefs must not be empty`,
    );
  }
  return Object.freeze({
    sourceFamily: requireFileSafeName(decision.sourceFamily, `${label}.sourceFamily`),
    sourceGroupId: requireFileSafeName(decision.sourceGroupId, `${label}.sourceGroupId`),
    splitAuthority: requireNonEmptyString(decision.splitAuthority, `${label}.splitAuthority`),
    splitDecisionRef: requireNonEmptyString(decision.splitDecisionRef, `${label}.splitDecisionRef`),
    evidenceRefs: Object.freeze(evidenceRefs),
  });
}

function parseApprovedSplitDecisions(value: unknown): readonly BA1ObservationApprovedSplitDecision[] {
  if (value === undefined) return Object.freeze([]);
  const decisions = requireArray(value, "approvedSplitDecisions")
    .map((entry, index) => parseApprovedSplitDecision(entry, `approvedSplitDecisions[${index}]`));
  if (new Set(decisions.map(decision => decision.sourceFamily)).size !== decisions.length) {
    throw new BA1ObservationDriverError(
      "invalid_plan",
      "approvedSplitDecisions sourceFamily values must be unique",
    );
  }
  if (new Set(decisions.map(decision => decision.sourceGroupId)).size !== decisions.length) {
    throw new BA1ObservationDriverError(
      "invalid_plan",
      "approvedSplitDecisions sourceGroupId values must be unique",
    );
  }
  return Object.freeze(decisions);
}

export function validateBA1ObservationDriverSourcePlan(value: unknown): BA1ObservationDriverSourcePlan {
  const plan = requireRecord(value, "source-plan");
  assertAllowedKeys(
    plan,
    ["schema", "status", "partition", "trainSlots", "reserves"],
    "source-plan",
  );
  if (plan.schema !== BA1_OBSERVATION_DRIVER_SOURCE_PLAN_SCHEMA) {
    throw new BA1ObservationDriverError(
      "invalid_plan",
      `source-plan.schema must be ${BA1_OBSERVATION_DRIVER_SOURCE_PLAN_SCHEMA}`,
    );
  }
  if (plan.status !== "pre_registered_not_observed") {
    throw new BA1ObservationDriverError(
      "invalid_plan",
      "source-plan.status must be pre_registered_not_observed",
    );
  }
  if (plan.partition !== "TRAIN") {
    throw new BA1ObservationDriverError("invalid_plan", "source-plan.partition must be TRAIN");
  }
  const trainSlots = requireArray(plan.trainSlots, "source-plan.trainSlots")
    .map((entry, index) => parseSource(entry, `source-plan.trainSlots[${index}]`, true));
  const reserves = requireArray(plan.reserves, "source-plan.reserves")
    .map((entry, index) => parseSource(entry, `source-plan.reserves[${index}]`, false));
  if (trainSlots.length === 0) {
    throw new BA1ObservationDriverError("invalid_plan", "source-plan.trainSlots must not be empty");
  }

  const families = [...trainSlots, ...reserves].map(source => source.sourceFamily);
  if (new Set(families).size !== families.length) {
    throw new BA1ObservationDriverError("invalid_plan", "source families must be unique");
  }
  const slots = trainSlots.map(source => source.slot);
  if (slots.some(slot => slot === undefined) || new Set(slots).size !== slots.length) {
    throw new BA1ObservationDriverError("invalid_plan", "train slots must carry unique A/B slot labels");
  }

  return Object.freeze({
    schema: BA1_OBSERVATION_DRIVER_SOURCE_PLAN_SCHEMA,
    status: "pre_registered_not_observed",
    partition: "TRAIN",
    trainSlots: Object.freeze(trainSlots),
    reserves: Object.freeze(reserves),
  });
}

async function buildProjectionBundleScript(): Promise<string> {
  const entryPoint = fileURLToPath(
    new URL("./b-a1-real-site-browser-projection.js", import.meta.url),
  );
  const projectionBundle = await build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "BA1Projection",
    platform: "browser",
    target: "es2022",
  });
  return `${projectionBundle.outputFiles[0]?.text ?? ""}
globalThis.__nnanythingBA1RealSiteProjection = BA1Projection.handleBA1RealSiteBrowserProjectionRequest;`;
}

function identityMatchesProjection(
  candidate: SearchInputHostCandidate,
  projection: BA1RealSiteProjectedObservation,
): boolean {
  return candidate.documentRef === projection.identity.documentRef
    && candidate.observationId === projection.identity.observationId
    && candidate.revision === projection.identity.revision;
}

function evidenceRefsForCoverage(
  projection: BA1RealSiteProjectedObservation,
  partialReasons: readonly string[],
  unmeasuredRefs: readonly string[],
): readonly string[] {
  if (partialReasons.length > 0) return Object.freeze([...new Set(partialReasons)]);
  if (unmeasuredRefs.length > 0) return Object.freeze([...new Set(unmeasuredRefs)]);
  return Object.freeze(projection.candidates.map(candidate => candidate.ref));
}

export function deriveBA1HarnessCoverage(
  operation: BA1RealSiteControlRead,
  projection: BA1RealSiteProjectedObservation,
): BA1DerivedHarnessCoverage {
  const evaluatedCount = projection.candidates.length;
  const expectedCount = projection.coverage.observedCandidateCount;
  const partialReasons: string[] = [];
  if (evaluatedCount !== expectedCount) partialReasons.push("coverage.count_mismatch");
  if (projection.coverage.unassessedIframeCount !== 0) partialReasons.push("coverage.iframe_unassessed");
  if (projection.coverage.unassessedObjectCount !== 0) partialReasons.push("coverage.object_unassessed");
  if (projection.coverage.unassessedOpenShadowRootCount !== 0) {
    partialReasons.push("coverage.open_shadow_root_unassessed");
  }
  if (projection.coverage.excluded.length !== 0) partialReasons.push("coverage.excluded_present");

  const scopeMismatchRefs = projection.candidates
    .filter(candidate => candidate.scopeRef !== projection.coverage.scopeRef)
    .map(candidate => `candidate:${candidate.ref}:scope_mismatch`);
  if (scopeMismatchRefs.length > 0) partialReasons.push(...scopeMismatchRefs);

  const identityMismatchRefs = projection.candidates
    .filter(candidate => !identityMatchesProjection(candidate, projection))
    .map(candidate => `candidate:${candidate.ref}:identity_mismatch`);
  if (identityMismatchRefs.length > 0) partialReasons.push(...identityMismatchRefs);

  const unmeasuredRefs = projection.candidates
    .filter(candidate => !isMeasuredSearchInputHostCandidate(candidate))
    .map(candidate => `candidate:${candidate.ref}:unmeasured`);

  const status = partialReasons.length > 0
    ? "partial" as const
    : unmeasuredRefs.length > 0
      ? "unverified" as const
      : "complete" as const;

  return Object.freeze({
    status,
    scopeRef: projection.scopeRef,
    documentRef: operation.identity.documentRef,
    observationId: operation.identity.observationId,
    revision: operation.identity.revision,
    evaluatedCount,
    expectedCount,
    unassessedIframeCount: projection.coverage.unassessedIframeCount,
    unassessedObjectCount: projection.coverage.unassessedObjectCount,
    unassessedOpenShadowRootCount: projection.coverage.unassessedOpenShadowRootCount,
    evidenceRefs: evidenceRefsForCoverage(projection, partialReasons, unmeasuredRefs),
  });
}

function provisionalSearchHostCount(candidates: readonly SearchInputHostCandidate[]): number {
  return candidates.filter(candidate =>
    candidate.host !== null
    && SEARCH_HOST_KINDS.has(candidate.host)
    && candidate.disabled === false
    && candidate.editable === true
    && candidate.cssHidden === false
    && candidate.intersectsViewport === true
    && candidate.access === "available"
  ).length;
}

function hiddenMeasuredCandidateCount(candidates: readonly SearchInputHostCandidate[]): number {
  return candidates.filter(candidate =>
    candidate.cssHidden === true || candidate.intersectsViewport === false
  ).length;
}

function discoveryRejection(
  derivedCoverage: BA1DerivedHarnessCoverage,
  searchHostCount: number,
  hiddenCount: number,
): BA1DiscoveryRejection | null {
  if (derivedCoverage.status !== "complete") return "coverage_incomplete";
  if (searchHostCount === 0) return "no_search_host_candidate";
  if (hiddenCount === 0) return "no_hidden_measured_candidate";
  return null;
}

function projectionRejection(error: unknown): BA1DiscoveryRejection {
  if (error instanceof BA1RealSiteCdpRuntimeError) {
    const code = error.detail.code;
    if (code === "scope_not_found"
      || code === "scope_ambiguous"
      || code === "scope_shadow_root_unavailable"
      || code === "scope_stale") {
      return code;
    }
  }
  return "projection_failed";
}

function failureReceipt(
  error: unknown,
  stage: BA1ObservationFailureStage,
  selector: string | null = null,
): BA1ObservationDriverFailureReceipt {
  const record = error !== null && typeof error === "object"
    ? error as Readonly<Record<string, unknown>>
    : null;
  return Object.freeze({
    stage,
    selector,
    name: error instanceof Error ? error.name : "Error",
    code: typeof record?.code === "string" ? record.code : null,
    message: error instanceof Error ? error.message : String(error),
    detail: record?.detail ?? null,
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

type BA1ObservationTimingStageName =
  | "launch"
  | "bundle_install"
  | "navigation"
  | "discovery"
  | "admitted_projection"
  | "save";

interface BA1ObservationTimingStage {
  readonly stage: BA1ObservationTimingStageName;
  readonly sourceFamily: string | null;
  readonly selector: string | null;
  readonly artifact: string | null;
  readonly started_at_ns: string;
  readonly ended_at_ns: string;
  readonly duration_ns: string;
}

interface BA1ObservationTimingReceipt {
  readonly schema: typeof BA1_OBSERVATION_DRIVER_TIMING_SCHEMA;
  readonly clock: "process.hrtime.bigint";
  readonly origin: "run_start";
  readonly stages: readonly BA1ObservationTimingStage[];
}

class BA1ObservationDriverTiming {
  readonly outDir: string;
  readonly startedNs: bigint;
  readonly stages: BA1ObservationTimingStage[] = [];

  constructor(outDir: string, startedNs: bigint) {
    this.outDir = outDir;
    this.startedNs = startedNs;
  }

  async measure<T>(
    stage: BA1ObservationTimingStageName,
    metadata: {
      readonly sourceFamily?: string;
      readonly selector?: string;
      readonly artifact?: string;
    },
    action: () => Promise<T>,
  ): Promise<T> {
    const startedNs = process.hrtime.bigint();
    try {
      return await action();
    } finally {
      const endedNs = process.hrtime.bigint();
      this.stages.push(Object.freeze({
        stage,
        sourceFamily: metadata.sourceFamily ?? null,
        selector: metadata.selector ?? null,
        artifact: metadata.artifact ?? null,
        started_at_ns: String(startedNs - this.startedNs),
        ended_at_ns: String(endedNs - this.startedNs),
        duration_ns: String(endedNs - startedNs),
      }));
      await this.persist();
    }
  }

  async persist(): Promise<void> {
    const receipt: BA1ObservationTimingReceipt = Object.freeze({
      schema: BA1_OBSERVATION_DRIVER_TIMING_SCHEMA,
      clock: "process.hrtime.bigint",
      origin: "run_start",
      stages: Object.freeze([...this.stages]),
    });
    await writeJson(join(this.outDir, "timing.json"), receipt);
  }
}

async function saveArtifact(
  timing: BA1ObservationDriverTiming,
  path: string,
  artifact: string,
  value: unknown,
  sourceFamily?: string,
): Promise<void> {
  await timing.measure(
    "save",
    {
      artifact,
      ...(sourceFamily === undefined ? {} : { sourceFamily }),
    },
    () => writeJson(path, value),
  );
}

function splitDecision(
  source: BA1ObservationDriverSource,
  approved: BA1ObservationApprovedSplitDecision | null,
) {
  if (approved !== null) {
    return Object.freeze({
      sourceFamily: approved.sourceFamily,
      sourceGroupId: approved.sourceGroupId,
      siteId: source.siteId,
      entryUrl: source.entryUrl,
      partition: "TRAIN" as const,
      priorExposure: "unseen" as const,
      splitAuthority: approved.splitAuthority,
      splitDecisionRef: approved.splitDecisionRef,
      evidenceRefs: approved.evidenceRefs,
    });
  }
  return Object.freeze({
    sourceFamily: source.sourceFamily,
    sourceGroupId: source.sourceFamily,
    siteId: source.siteId,
    entryUrl: source.entryUrl,
    partition: "TRAIN" as const,
    priorExposure: "unseen" as const,
    splitAuthority: null,
    splitDecisionRef: null,
    evidenceRefs: Object.freeze([]),
  });
}

function pinSelector(
  plan: BA1ObservationDriverSourcePlan,
  sourceFamily: string,
  selector: string,
): BA1ObservationDriverSourcePlan {
  const pin = (source: BA1ObservationDriverSource): BA1ObservationDriverSource =>
    source.sourceFamily === sourceFamily
      ? Object.freeze({ ...source, scopeSelector: selector })
      : source;
  return Object.freeze({
    ...plan,
    trainSlots: Object.freeze(plan.trainSlots.map(pin)),
    reserves: Object.freeze(plan.reserves.map(pin)),
  });
}

function sourceSelectors(source: BA1ObservationDriverSource): readonly string[] {
  return source.scopeSelector === undefined
    ? source.selectorCandidates
    : [source.scopeSelector];
}

async function captureSource(
  runtime: BA1ObservationDriverRuntime,
  plan: BA1ObservationDriverSourcePlan,
  source: BA1ObservationDriverSource,
  outDir: string,
  timing: BA1ObservationDriverTiming,
  approvedSplitDecision: BA1ObservationApprovedSplitDecision | null,
): Promise<{ readonly plan: BA1ObservationDriverSourcePlan; readonly outcome: BA1ObservationSourceOutcome }> {
  const documentRef = `b-a1-observation-${source.sourceFamily}`;
  const decision = splitDecision(source, approvedSplitDecision);
  await saveArtifact(
    timing,
    join(outDir, "split-decisions", `${decision.sourceGroupId}.json`),
    `split-decisions/${decision.sourceGroupId}.json`,
    decision,
    source.sourceFamily,
  );

  const attempts: BA1ObservationDiscoveryAttempt[] = [];
  let passedSelector: string | null = null;
  let currentPlan = plan;

  try {
    await timing.measure("navigation", { sourceFamily: source.sourceFamily }, () =>
      runtime.navigate(source.entryUrl, documentRef));
  } catch (error) {
    const failure = failureReceipt(error, "navigation");
    const discovery = Object.freeze({
      passedSelector: null,
      attempts: Object.freeze(attempts),
    });
    const outcome: BA1ObservationSourceOutcome = Object.freeze({
      sourceFamily: source.sourceFamily,
      siteId: source.siteId,
      entryUrl: source.entryUrl,
      partition: "TRAIN",
      status: "navigation_failed",
      pinnedSelector: null,
      discovery,
      rejection: "navigation_failed",
      error: failure,
    });
    await saveArtifact(
      timing,
      join(outDir, "rejected", `${source.sourceFamily}.json`),
      `rejected/${source.sourceFamily}.json`,
      outcome,
      source.sourceFamily,
    );
    return { plan: currentPlan, outcome };
  }

  for (const selector of sourceSelectors(source)) {
    let operation: BA1RealSiteControlRead;
    let projection: BA1RealSiteProjectedObservation;
    try {
      const observed = await timing.measure(
        "discovery",
        { sourceFamily: source.sourceFamily, selector },
        () => runtime.beginProjection({
          scopeSelector: selector,
          requestedRole: "search-input-host",
          access: "available",
        }),
      );
      operation = observed.operation;
      projection = observed.projection;
    } catch (error) {
      const failure = failureReceipt(error, "discovery", selector);
      attempts.push(Object.freeze({
        selector,
        rawCoverage: null,
        derivedCoverage: null,
        candidateRefs: Object.freeze([]),
        candidateCount: 0,
        provisionalSearchHostCount: 0,
        hiddenMeasuredCandidateCount: 0,
        passed: false,
        rejection: projectionRejection(error),
        error: failure,
      }));
      continue;
    }

    const derivedCoverage = deriveBA1HarnessCoverage(operation, projection);
    const searchHostCount = provisionalSearchHostCount(projection.candidates);
    const hiddenCount = hiddenMeasuredCandidateCount(projection.candidates);
    const discoveryRejectionResult = discoveryRejection(
      derivedCoverage,
      searchHostCount,
      hiddenCount,
    );
    const passed = discoveryRejectionResult === null;
    attempts.push(Object.freeze({
      selector,
      rawCoverage: projection.coverage,
      derivedCoverage,
      candidateRefs: Object.freeze(projection.candidates.map(candidate => candidate.ref)),
      candidateCount: projection.candidates.length,
      provisionalSearchHostCount: searchHostCount,
      hiddenMeasuredCandidateCount: hiddenCount,
      passed,
      rejection: discoveryRejectionResult,
      error: null,
    }));

    if (!passed) continue;
    passedSelector = selector;
    currentPlan = pinSelector(currentPlan, source.sourceFamily, selector);
    await saveArtifact(
      timing,
      join(outDir, "source-plan.json"),
      "source-plan.json",
      currentPlan,
      source.sourceFamily,
    );
    const discovery = Object.freeze({
      passedSelector,
      attempts: Object.freeze(attempts),
    });
    await saveArtifact(
      timing,
      join(outDir, "discovery", `${source.sourceFamily}.json`),
      `discovery/${source.sourceFamily}.json`,
      discovery,
      source.sourceFamily,
    );

    let admitted: {
      readonly operation: BA1RealSiteControlRead;
      readonly projection: BA1RealSiteProjectedObservation;
    };
    try {
      admitted = await timing.measure(
        "admitted_projection",
        { sourceFamily: source.sourceFamily, selector },
        () => runtime.beginProjection({
          scopeSelector: selector,
          requestedRole: "search-input-host",
          access: "available",
        }),
      );
    } catch (error) {
      const failure = failureReceipt(error, "admitted_projection", selector);
      const outcome: BA1ObservationSourceOutcome = Object.freeze({
        sourceFamily: source.sourceFamily,
        siteId: source.siteId,
        entryUrl: source.entryUrl,
        partition: "TRAIN",
        status: "projection_failed",
        pinnedSelector: passedSelector,
        discovery,
        candidateGroupEnumerationComplete: false,
        rejection: "projection_failed",
        error: failure,
      });
      await saveArtifact(
        timing,
        join(outDir, "rejected", `${source.sourceFamily}.json`),
        `rejected/${source.sourceFamily}.json`,
        outcome,
        source.sourceFamily,
      );
      return { plan: currentPlan, outcome };
    }

    const admittedCoverage = deriveBA1HarnessCoverage(admitted.operation, admitted.projection);
    const admittedSearchHostCount = provisionalSearchHostCount(admitted.projection.candidates);
    const admittedHiddenCount = hiddenMeasuredCandidateCount(admitted.projection.candidates);
    const admittedRejection = discoveryRejection(
      admittedCoverage,
      admittedSearchHostCount,
      admittedHiddenCount,
    );
    const admissionPredicates: BA1ObservationAdmissionPredicates = Object.freeze({
      provisionalSearchHostCount: admittedSearchHostCount,
      hiddenMeasuredCandidateCount: admittedHiddenCount,
    });
    const rawObservation: BA1RawObservationRecord = Object.freeze({
      navigation: Object.freeze({ url: source.entryUrl, documentRef }),
      operation: admitted.operation,
      projection: admitted.projection,
    });

    if (admittedRejection === null) {
      await saveArtifact(
        timing,
        join(outDir, "raw", source.sourceFamily, "admitted.json"),
        `raw/${source.sourceFamily}/admitted.json`,
        rawObservation,
        source.sourceFamily,
      );
      return {
        plan: currentPlan,
        outcome: Object.freeze({
          sourceFamily: source.sourceFamily,
          siteId: source.siteId,
          entryUrl: source.entryUrl,
          partition: "TRAIN",
          status: "captured",
          pinnedSelector: passedSelector,
          discovery,
          rawObservation,
          derivedCoverage: admittedCoverage,
          admissionPredicates,
          candidateGroupEnumerationComplete: true,
          rejection: null,
        }),
      };
    }

    await saveArtifact(
      timing,
      join(outDir, "raw", source.sourceFamily, "recapture.json"),
      `raw/${source.sourceFamily}/recapture.json`,
      rawObservation,
      source.sourceFamily,
    );
    const status: BA1ObservationSourceStatus = admittedRejection === "coverage_incomplete"
      ? "observation_missing"
      : "no_contrast";
    const finalRejection: BA1ObservationSourceRejection = status === "observation_missing"
      ? "incomplete_coverage"
      : "contrast_missing";
    const outcome: BA1ObservationSourceOutcome = Object.freeze({
      sourceFamily: source.sourceFamily,
      siteId: source.siteId,
      entryUrl: source.entryUrl,
      partition: "TRAIN",
      status,
      pinnedSelector: passedSelector,
      discovery,
      rawObservation,
      derivedCoverage: admittedCoverage,
      admissionPredicates,
      candidateGroupEnumerationComplete: false,
      rejection: finalRejection,
    });
    await saveArtifact(
      timing,
      join(outDir, "rejected", `${source.sourceFamily}.json`),
      `rejected/${source.sourceFamily}.json`,
      outcome,
      source.sourceFamily,
    );
    return {
      plan: currentPlan,
      outcome,
    };
  }

  const discovery = Object.freeze({
    passedSelector: null,
    attempts: Object.freeze(attempts),
  });
  const hasIncompleteCoverage = attempts.some(attempt => attempt.rejection === "coverage_incomplete");
  const hasProvisionalFailure = attempts.some(attempt =>
    attempt.rejection === "no_search_host_candidate"
    || attempt.rejection === "no_hidden_measured_candidate"
  );
  const status: BA1ObservationSourceStatus = hasIncompleteCoverage
    ? "observation_missing"
    : hasProvisionalFailure
      ? "no_provisional_scope"
      : "projection_failed";
  const rejection: BA1ObservationSourceRejection = status === "observation_missing"
    ? "incomplete_coverage"
    : status === "no_provisional_scope"
      ? "no_provisional_scope"
      : "projection_failed";
  const firstError = attempts.find(attempt => attempt.error !== null)?.error;
  const outcome: BA1ObservationSourceOutcome = Object.freeze({
    sourceFamily: source.sourceFamily,
    siteId: source.siteId,
    entryUrl: source.entryUrl,
    partition: "TRAIN",
    status,
    pinnedSelector: null,
    discovery,
    rejection,
    ...(firstError === undefined || firstError === null ? {} : { error: firstError }),
  });
  await saveArtifact(
    timing,
    join(outDir, "discovery", `${source.sourceFamily}.json`),
    `discovery/${source.sourceFamily}.json`,
    discovery,
    source.sourceFamily,
  );
  await saveArtifact(
    timing,
    join(outDir, "rejected", `${source.sourceFamily}.json`),
    `rejected/${source.sourceFamily}.json`,
    outcome,
    source.sourceFamily,
  );
  return {
    plan: currentPlan,
    outcome,
  };
}

export async function runBA1ObservationDriver(
  options: BA1ObservationDriverOptions,
): Promise<BA1ObservationDriverResult> {
  const runStartedNs = process.hrtime.bigint();
  if (typeof options.outDir !== "string" || options.outDir.length === 0) {
    throw new BA1ObservationDriverError("invalid_plan", "outDir must be a non-empty string");
  }
  const initialPlan = validateBA1ObservationDriverSourcePlan(options.sourcePlan);
  const approvedSplitDecisions = parseApprovedSplitDecisions(options.approvedSplitDecisions);
  const planSourceFamilies = new Set(
    [...initialPlan.trainSlots, ...initialPlan.reserves].map(source => source.sourceFamily),
  );
  const unknownApprovedSourceFamily = approvedSplitDecisions.find(
    decision => !planSourceFamilies.has(decision.sourceFamily),
  );
  if (unknownApprovedSourceFamily !== undefined) {
    throw new BA1ObservationDriverError(
      "invalid_plan",
      `approvedSplitDecisions sourceFamily ${unknownApprovedSourceFamily.sourceFamily} is not in sourcePlan`,
    );
  }
  await mkdir(options.outDir, { recursive: true });
  const timing = new BA1ObservationDriverTiming(options.outDir, runStartedNs);
  await saveArtifact(
    timing,
    join(options.outDir, "source-plan.json"),
    "source-plan.json",
    initialPlan,
  );

  const ownedRuntime = options.runtime === undefined
    ? await timing.measure("launch", {}, () => createBA1RealSiteCdpRuntime())
    : null;
  if (options.runtime !== undefined) {
    await timing.measure("launch", {}, async () => undefined);
  }
  const runtime: BA1ObservationDriverRuntime = options.runtime ?? ownedRuntime as BA1RealSiteCdpRuntime;
  try {
    await timing.measure("bundle_install", {}, async () =>
      runtime.installProjectionBundle(await buildProjectionBundleScript()));
    const candidates = [...initialPlan.trainSlots, ...initialPlan.reserves];
    const targetCaptureCount = Math.min(TARGET_CAPTURE_COUNT, candidates.length);
    const outcomes: BA1ObservationSourceOutcome[] = [];
    let plan = initialPlan;
    let capturedCount = 0;

    for (const source of candidates) {
      if (capturedCount >= targetCaptureCount) break;
      try {
        const approvedSplitDecision = approvedSplitDecisions.find(
          decision => decision.sourceFamily === source.sourceFamily,
        ) ?? null;
        const captured = await captureSource(
          runtime,
          plan,
          source,
          options.outDir,
          timing,
          approvedSplitDecision,
        );
        plan = captured.plan;
        outcomes.push(captured.outcome);
        if (captured.outcome.status === "captured") capturedCount += 1;
      } catch (error) {
        const failure = failureReceipt(error, "family");
        const discovery = Object.freeze({
          passedSelector: null,
          attempts: Object.freeze([]),
        });
        const outcome: BA1ObservationSourceOutcome = Object.freeze({
          sourceFamily: source.sourceFamily,
          siteId: source.siteId,
          entryUrl: source.entryUrl,
          partition: "TRAIN",
          status: "projection_failed",
          pinnedSelector: null,
          discovery,
          rejection: "projection_failed",
          error: failure,
        });
        outcomes.push(outcome);
        await saveArtifact(
          timing,
          join(options.outDir, "rejected", `${source.sourceFamily}.json`),
          `rejected/${source.sourceFamily}.json`,
          outcome,
          source.sourceFamily,
        );
      }
    }

    const status = capturedCount > 0
      ? "captured"
      : outcomes[0]?.status ?? "projection_failed";
    const result = Object.freeze({
      schema: BA1_OBSERVATION_DRIVER_RESULT_SCHEMA,
      status,
      capturedCount,
      sources: Object.freeze(outcomes),
    });
    await saveArtifact(
      timing,
      join(options.outDir, "driver-report.json"),
      "driver-report.json",
      result,
    );
    return result;
  } finally {
    if (ownedRuntime !== null) await ownedRuntime.close();
  }
}
