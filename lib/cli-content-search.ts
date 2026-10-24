import { runRecursiveGoal } from "./workflow/recursive-goal/module.js";
import {
  createContentSearchAdapter,
  createContentSearchDependencies,
  CONTENT_ROOT_EVALUATOR,
  CONTENT_ROOT_SELECTOR,
} from "./adapters/cli/content-search-recursive.js";
import {
  validateContentSearchOrder,
  validateContentSearchRequest,
  validateContentSearchScan,
  type ContentSearchCandidateFact,
  type ContentSearchDomainProjection,
  type ContentSearchFileRef,
  type ContentSearchListingFact,
  type ContentSearchOrder,
  type ContentSearchRequest,
  type ContentSearchResources,
  type ContentSearchRunResult,
  type ContentSearchState,
} from "./adapters/cli/content-search-contract.js";
import {
  buildRootFact,
  contains,
  coverageOf,
  decideContentSearchRoot,
  deliberateSuboptimal,
  initialCandidates,
  inspectedFactFromTransition,
  isStaleReadCode,
  lineColumn,
  listingFactFromTransition,
  matchesOf,
  negativesOf,
} from "./filters/cli-content-search.js";
import type { CliFilesystemSandbox, SessionRef, SessionSnapshot } from "./adapters/cli/filesystem-sandbox.js";
import type { CliCommandTransition } from "./nodes/cli-command.js";

const RECURSIVE_REQUEST_SCHEMA = "nnanything.recursive-goal.request.v1" as const;

function initialState(
  sandbox: CliFilesystemSandbox,
  session: SessionRef,
  stateId: string,
): ContentSearchState {
  const snapshot: SessionSnapshot = sandbox.getSession(session);
  return Object.freeze({
    stateId,
    session: Object.freeze({
      id: snapshot.id,
      cwd: snapshot.cwd,
      revision: snapshot.revision,
      grantedEffects: Object.freeze([...snapshot.grantedEffects]),
    }),
    cli: Object.freeze({
      session: session.sessionId,
      cwdObservation: null,
      directoryListing: null,
    }),
    listing: null,
    candidates: Object.freeze([]),
    duplicateReads: 0,
  });
}

type SourceView = Readonly<{ tag: string | null; value: unknown }>;

function sourceView(value: unknown): SourceView {
  const input = value as { tag?: unknown; value?: unknown } | null;
  return Object.freeze({
    tag: typeof input?.tag === "string" ? input.tag : null,
    value: input?.value ?? null,
  });
}

function transitionOf(source: SourceView): CliCommandTransition | null {
  return source.tag === "cli.command.transition.v1" ? (source.value as CliCommandTransition) : null;
}

type ReadReceiptView = Readonly<{
  receipt: Awaited<ReturnType<CliFilesystemSandbox["execute"]>>;
  ref: ContentSearchFileRef;
}>;

function readReceiptOf(source: SourceView): ReadReceiptView | null {
  if (source.tag !== "cli.file.read.receipt.v1") return null;
  const value = source.value as { receipt: unknown; ref: unknown } | null;
  if (value === null || typeof value !== "object") return null;
  return Object.freeze({
    receipt: value.receipt as ReadReceiptView["receipt"],
    ref: value.ref as ContentSearchFileRef,
  });
}

function listTransitions(report: unknown): readonly CliCommandTransition[] {
  const input = report as { atomicResults?: readonly { sourceResult?: unknown }[] } | null;
  if (input === null || !Array.isArray(input.atomicResults)) return Object.freeze([]);
  return Object.freeze(input.atomicResults
    .map(result => transitionOf(sourceView(result.sourceResult)))
    .filter((transition): transition is CliCommandTransition => transition !== null));
}

function readReceipts(report: unknown): readonly ReadReceiptView[] {
  const input = report as { atomicResults?: readonly { sourceResult?: unknown }[] } | null;
  if (input === null || !Array.isArray(input.atomicResults)) return Object.freeze([]);
  return Object.freeze(input.atomicResults
    .map(result => readReceiptOf(sourceView(result.sourceResult)))
    .filter((receipt): receipt is ReadReceiptView => receipt !== null));
}

function latestState(report: unknown): ContentSearchState | null {
  const input = report as { states?: readonly { value?: unknown }[] } | null;
  if (input === null || !Array.isArray(input.states) || input.states.length === 0) return null;
  const last = input.states[input.states.length - 1];
  const value = last?.value;
  if (value === null || typeof value !== "object") return null;
  const candidate = value as ContentSearchState;
  if (typeof candidate.stateId !== "string" || !Array.isArray(candidate.candidates)) return null;
  return candidate;
}

function primaryErrorCode(response: unknown): string | null {
  const input = response as {
    error?: { code?: unknown } | null;
    fault?: { code?: unknown } | null;
    report?: { primaryErrorId?: unknown; errors?: readonly { errorId?: unknown; code?: unknown }[] } | null;
  } | null;
  if (input === null || typeof input !== "object") return null;
  if (typeof input.error?.code === "string") return input.error.code;
  if (typeof input.fault?.code === "string") return input.fault.code;
  const report = input.report;
  if (report === null || report === undefined || typeof report.primaryErrorId !== "string") return null;
  const match = report.errors?.find(error => error.errorId === report.primaryErrorId);
  return typeof match?.code === "string" ? match.code : null;
}

function updatedCandidate(
  candidates: readonly ContentSearchCandidateFact[],
  path: string,
  patch: Partial<ContentSearchCandidateFact>,
): readonly ContentSearchCandidateFact[] {
  return Object.freeze(candidates.map(candidate => candidate.path === path
    ? Object.freeze({ ...candidate, ...patch })
    : candidate));
}

function replay(
  request: ContentSearchRequest,
  response: unknown,
  order: ContentSearchOrder,
): Readonly<{
  listing: ContentSearchListingFact | null;
  candidates: readonly ContentSearchCandidateFact[];
  duplicateReads: number;
}> {
  const report = (response as { report?: unknown } | null)?.report ?? null;
  const transitions = listTransitions(report);
  const receipts = readReceipts(report);
  const needle = Buffer.from(request.goal.requirement.predicate.needle, "utf8");

  const listTransition = [...transitions].reverse().find(transition =>
    transition.goal.property === "file.property.directory.entries",
  );
  const listing = listTransition === undefined ? null : listingFactFromTransition(listTransition);
  let candidates = initialCandidates(listing, request.goal.target.fileCondition, order);
  let duplicateReads = 0;
  const readAttempts = new Map<string, number>();

  const inspectTransitions = transitions.filter(transition =>
    transition.goal.property === "file.property.type",
  );
  for (const transition of inspectTransitions) {
    const inspected = inspectedFactFromTransition(transition);
    if (inspected === null) continue;
    const target = transition.goal.target as { ref?: { path?: string } };
    const path = target.ref?.path ?? inspected.absolutePath;
    const type = inspected.type;
    const outcome: ContentSearchCandidateFact["outcome"] =
      type !== "regular" ? "type_mismatch" : "pending";
    candidates = updatedCandidate(candidates, path, {
      inspected: Object.freeze({
        sourceRun: transition.execution_result.receipt?.execution.runId ?? null,
        absolutePath: inspected.absolutePath,
        type: inspected.type as ContentSearchCandidateFact["inspected"] extends infer T | null ? T extends { type: infer K } ? K : never : never,
        size: inspected.size,
        identity: Object.freeze({ dev: inspected.identity.dev, ino: inspected.identity.ino }),
        sessionRevision: inspected.sessionRevision,
        errno: inspected.errno,
      }),
      fileRef: null,
      outcome,
      reason: outcome === "type_mismatch" ? "type_mismatch" : null,
    });
  }

  for (const entry of receipts) {
    const receipt = entry.receipt;
    const path = entry.ref.absolutePath;
    const current = candidates.find(candidate => candidate.path === path);
    if (receipt.execution.status !== "succeeded") {
      const error = receipt.execution.error;
      candidates = updatedCandidate(candidates, path, {
        read: null,
        contains: null,
        outcome: isStaleReadCode(error.code) ? "stale" : "read_error",
        failureCode: error.code,
        reason: error.code,
      });
      continue;
    }
    const observation = receipt.execution.observation;
    if (observation.kind !== "file.read") continue;
    const bytes = Buffer.from(observation.bytes, "base64");
    const full = observation.offset === 0 && observation.length === observation.size && observation.bytesRead === observation.size;
    const match = full ? contains(bytes, needle) : { found: false, start: -1, end: -1 };
    const wasNegative = current?.outcome === "negative";
    const duplicate = wasNegative && current !== undefined && !current.duplicateRead;
    const attempt = (readAttempts.get(path) ?? 0) + 1;
    readAttempts.set(path, attempt);
    const readFact = Object.freeze({
      ref: entry.ref,
      sourceRun: receipt.execution.runId,
      refSourceRun: entry.ref.sourceRun,
      revision: entry.ref.sessionRevision,
      offset: observation.offset,
      length: observation.length,
      size: observation.size,
      attempt,
      bytes: observation.bytes,
      bytesRead: observation.bytesRead,
      eof: observation.eof,
      identity: Object.freeze({ dev: observation.identity.dev, ino: observation.identity.ino }),
    });
    candidates = updatedCandidate(candidates, path, {
      fileRef: entry.ref,
      read: readFact,
      contains: match.found ? true : full ? false : null,
      outcome: match.found ? "matched" : full ? "negative" : "unknown",
      byteSpan: match.found ? Object.freeze({ start: match.start, end: match.end }) : null,
      line: match.found ? lineColumn(bytes, match.start).line : null,
      column: match.found ? lineColumn(bytes, match.start).column : null,
      reason: match.found ? null : full ? "no_match" : "short_read",
      duplicateRead: duplicate,
    });
    if (duplicate) duplicateReads += 1;
  }

  return Object.freeze({ listing, candidates, duplicateReads });
}

function telemetry(
  report: unknown,
): Readonly<{ invocationCount: number; observationCount: number; bytesReadTotal: number }> {
  const transitions = listTransitions(report);
  const receipts = readReceipts(report);
  let observationCount = 0;
  let bytesReadTotal = 0;
  for (const transition of transitions) {
    if (transition.execution_result.receipt?.execution.status === "succeeded") observationCount += 1;
  }
  for (const receipt of receipts) {
    if (receipt.receipt.execution.status === "succeeded") {
      observationCount += 1;
      const observation = receipt.receipt.execution.observation;
      if (observation.kind === "file.read") bytesReadTotal += observation.bytesRead;
    }
  }
  return Object.freeze({
    invocationCount: transitions.length + receipts.length,
    observationCount,
    bytesReadTotal,
  });
}

function projectionStatus(
  decision: ReturnType<typeof decideContentSearchRoot>,
  primaryCode: string | null,
): Readonly<{
  status: ContentSearchDomainProjection["status"];
  resolution: ContentSearchDomainProjection["resolution"];
  satisfaction: number | null;
}> {
  if (primaryCode === "budget_exceeded" || primaryCode === "cancelled" || primaryCode === "no_progress" || primaryCode === "stalled") {
    return Object.freeze({ status: "unknown", resolution: "interrupted", satisfaction: null });
  }
  if (primaryCode === "invalid_request" || primaryCode === "invalid_binding" || primaryCode === "effect_denied" ||
    primaryCode === "capability_missing" || primaryCode === "policy_error" || primaryCode === "policy_deferred") {
    return Object.freeze({ status: "rejected", resolution: "rejected", satisfaction: null });
  }
  if (primaryCode === "execution_failed") {
    return Object.freeze({ status: "failed", resolution: "failed", satisfaction: null });
  }
  if (decision.result === "satisfied") return Object.freeze({ status: "achieved", resolution: "matched", satisfaction: 100 });
  if (decision.result === "unsatisfied") return Object.freeze({ status: "unmet", resolution: "not_found", satisfaction: 0 });
  return Object.freeze({ status: "unknown", resolution: "insufficient_evidence", satisfaction: null });
}

function budgetUsed(response: unknown): ContentSearchDomainProjection["budgetUsed"] {
  const report = (response as { report?: { budgetUsed?: { transitionsUsed?: number; derivedGoalsUsed?: number } } | null } | null)?.report;
  if (report === null || report === undefined || typeof report.budgetUsed !== "object" || report.budgetUsed === null) return null;
  return Object.freeze({
    transitionsUsed: typeof report.budgetUsed.transitionsUsed === "number" ? report.budgetUsed.transitionsUsed : 0,
    derivedGoalsUsed: typeof report.budgetUsed.derivedGoalsUsed === "number" ? report.budgetUsed.derivedGoalsUsed : 0,
  });
}

function preserve(response: unknown): ContentSearchDomainProjection["preserve"] {
  const input = response as {
    report?: {
      rootEvaluation?: unknown; control?: unknown; frames?: unknown; atomicResults?: unknown;
      effects?: unknown; errors?: unknown; primaryErrorId?: unknown; budgetUsed?: unknown;
    } | null;
  } | null;
  const report = input?.report;
  return Object.freeze({
    rootEvaluation: report?.rootEvaluation ?? null,
    control: report?.control ?? null,
    frames: report?.frames ?? null,
    atomicResults: report?.atomicResults ?? null,
    effects: report?.effects ?? null,
    errors: report?.errors ?? null,
    primaryErrorId: typeof report?.primaryErrorId === "string" ? report.primaryErrorId : null,
    budgetUsed: report?.budgetUsed ?? null,
  });
}

export async function runCliContentSearchGoal(
  request: unknown,
  resources: ContentSearchResources,
): Promise<ContentSearchRunResult> {
  const order = validateContentSearchOrder(resources.order ?? { kind: "lexicographic" });
  const scan = validateContentSearchScan(resources.scan);
  let validated: ContentSearchRequest;
  try {
    validated = validateContentSearchRequest(request, resources.session);
  } catch {
    return Object.freeze({
      request: request as ContentSearchRequest,
      response: null,
      domain: Object.freeze({
        status: "rejected",
        resolution: "rejected",
        satisfaction: null,
        matches: Object.freeze([]),
        negatives: Object.freeze([]),
        coverage: null,
        ordering: order,
        deliberateSuboptimal: false,
        invocationCount: 0,
        observationCount: 0,
        bytesReadTotal: 0,
        duplicateReads: 0,
        budgetUsed: null,
        rootFact: Object.freeze({ kind: "rejected" }),
        preserve: Object.freeze({
          rootEvaluation: null,
          control: null,
          frames: null,
          atomicResults: null,
          effects: null,
          errors: null,
          primaryErrorId: null,
          budgetUsed: null,
        }),
      }),
    });
  }

  const created = createContentSearchAdapter({
    sandbox: resources.sandbox,
    session: resources.session,
    profile: resources.profile,
    scan,
    order,
    ...(resources.duplicateReadProbe === undefined ? {} : { duplicateReadProbe: resources.duplicateReadProbe }),
    ...(resources.onSample === undefined ? {} : { onSample: resources.onSample }),
  });
  const state = initialState(resources.sandbox, resources.session, `${validated.requestId}:state:initial`);
  const response = await runRecursiveGoal(
    {
      schema: RECURSIVE_REQUEST_SCHEMA,
      requestId: validated.requestId,
      rootGoal: validated.goal,
      satisfactionThreshold: 100,
      rootBindings: Object.freeze({
        session: resources.session,
        directory: validated.goal.target.directory,
        fileCondition: validated.goal.target.fileCondition,
        cardinality: "one",
        needle: validated.goal.requirement.predicate.needle,
      }),
      state,
      rootEvaluatorId: CONTENT_ROOT_EVALUATOR,
      rootSelectorId: CONTENT_ROOT_SELECTOR,
      limits: resources.limits,
    },
    createContentSearchDependencies(created, resources.signal),
  );
  const primaryCode = primaryErrorCode(response);
  const replayed = replay(validated, response, order);
  const synthesized: ContentSearchState = Object.freeze({
    stateId: state.stateId,
    session: state.session,
    cli: state.cli,
    listing: replayed.listing,
    candidates: replayed.candidates,
    duplicateReads: replayed.duplicateReads,
  });
  const decision = decideContentSearchRoot(synthesized);
  const status = projectionStatus(decision, primaryCode);
  const metrics = telemetry((response as { report?: unknown } | null)?.report ?? null);
  const needle = validated.goal.requirement.predicate.needle;
  return Object.freeze({
    request: validated,
    response,
    domain: Object.freeze({
      status: status.status,
      resolution: status.resolution,
      satisfaction: status.satisfaction,
      matches: matchesOf(synthesized, needle),
      negatives: negativesOf(synthesized, needle),
      coverage: coverageOf(synthesized, status.status, status.resolution),
      ordering: order,
      deliberateSuboptimal: deliberateSuboptimal(synthesized, order),
      invocationCount: metrics.invocationCount,
      observationCount: metrics.observationCount,
      bytesReadTotal: metrics.bytesReadTotal,
      duplicateReads: replayed.duplicateReads,
      budgetUsed: budgetUsed(response),
      rootFact: buildRootFact(synthesized, decision, primaryCode, needle),
      preserve: preserve(response),
    }),
  });
}

export { createCliFilesystemSandbox } from "./adapters/cli/filesystem-sandbox.js";
export { createCliCommandPolicy } from "./cli-goal.js";
