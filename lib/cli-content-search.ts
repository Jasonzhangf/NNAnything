import { randomUUID } from "node:crypto";
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
  type ContentSearchCardinality,
  type ContentSearchDomainProjection,
  type ContentSearchFileRef,
  type ContentSearchListingFact,
  type ContentSearchOrder,
  type ContentSearchRecursion,
  type ContentSearchRequest,
  type ContentSearchResources,
  type ContentSearchRunResult,
  type ContentSearchScan,
  type ContentSearchState,
} from "./adapters/cli/content-search-contract.js";
import {
  buildRootFact,
  contains,
  coverageOf,
  deliberateSuboptimal,
  denominatorsOf,
  historicalMatchesOf,
  initialCandidates,
  inspectedFactFromTransition,
  isStaleReadCode,
  lineColumn,
  listingFactFromTransition,
  matchesOf,
  negativesOf,
} from "./filters/cli-content-search.js";
import {
  readSemanticCliCall,
  type CliFilesystemSandbox,
  type DirectoryRef,
  type EntryInspectObservation,
  type SemanticCallReceipt,
  type SemanticCliCall,
  type SemanticDirectoryListCall,
  type SemanticEntryInspectCall,
  type SessionRef,
  type SessionSnapshot,
} from "./adapters/cli/filesystem-sandbox.js";
import { runDirectoryListHelper } from "./adapters/cli/directory-listing.js";
import { runEntryInspectHelper } from "./adapters/cli/entry-inspection.js";
import type { ObservedObjectRef, PathRef } from "./adapters/cli/entry-inspection.js";
import type { CliCommandTransition } from "./nodes/cli-command.js";

const RECURSIVE_REQUEST_SCHEMA = "nnanything.recursive-goal.request.v1" as const;

function sessionOfRef(ref: Readonly<{ scenarioId: string; sessionId: string }>): SessionRef {
  return Object.freeze({
    kind: "cli.session" as const,
    scenarioId: ref.scenarioId,
    sessionId: ref.sessionId,
  });
}

function failedSearchReceipt(
  call: SemanticCliCall,
  before: SessionSnapshot,
  runId: string,
  code: string,
  message: string,
): SemanticCallReceipt {
  return Object.freeze({
    call,
    status: "failed",
    session_before: before,
    session_after: before,
    execution: Object.freeze({
      status: "failed",
      runId,
      executorInvoked: false,
      error: Object.freeze({
        operation: call.operation,
        stage: "observe" as const,
        code,
        message,
      }),
    }),
  });
}

async function executeListReceipt(
  base: CliFilesystemSandbox,
  call: SemanticDirectoryListCall,
  before: SessionSnapshot,
  runId: string,
): Promise<SemanticCallReceipt> {
  try {
    const target = await base.resolveDirectory(call.parameters.directory as DirectoryRef);
    const result = await runDirectoryListHelper({
      configuredDirectory: target.configuredPath,
      physicalDirectory: target.physicalPath,
    });
    if (!result.ok) {
      return failedSearchReceipt(call, before, runId, result.error.code, result.error.message);
    }
    return Object.freeze({
      call,
      status: "succeeded",
      session_before: before,
      session_after: before,
      execution: Object.freeze({
        status: "succeeded",
        runId,
        executorInvoked: true,
        observation: result.observation,
      }),
    });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "EINVAL";
    return failedSearchReceipt(
      call,
      before,
      runId,
      code,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function executeInspectReceipt(
  base: CliFilesystemSandbox,
  call: SemanticEntryInspectCall,
  before: SessionSnapshot,
  runId: string,
): Promise<SemanticCallReceipt> {
  const ref = call.parameters.ref;
  try {
    if (ref.kind === "cli.directory" && !("absolutePath" in ref)) {
      return failedSearchReceipt(
        call,
        before,
        runId,
        "binding_identity_missing",
        "Legacy directory references cannot be inspected",
      );
    }
    const inspectRef = ref as PathRef | ObservedObjectRef;
    const absolutePath = inspectRef.kind === "cli.path" ? inspectRef.path : inspectRef.absolutePath;
    const observed = await base.bindEntry(sessionOfRef(ref), absolutePath);
    const result = await runEntryInspectHelper({
      absolutePath: observed.absolutePath,
      followSymlinks: call.parameters.followSymlinks,
    });
    if (!result.ok) {
      return failedSearchReceipt(call, before, runId, result.error.code, result.error.message);
    }
    if (result.observation.snapshot.errno !== null && result.observation.snapshot.errno !== "ENOENT") {
      return failedSearchReceipt(
        call,
        before,
        runId,
        result.observation.snapshot.errno,
        `Entry inspection failed with ${result.observation.snapshot.errno}`,
      );
    }
    const observation: EntryInspectObservation = Object.freeze({
      kind: "entry.inspect",
      ref: inspectRef,
      entryKind: result.observation.entryKind,
      followSymlinks: call.parameters.followSymlinks,
      configuredPath: observed.absolutePath,
      executable: result.observation.executable,
      helperPath: result.observation.helperPath,
      argv: result.observation.argv,
      stdin: result.observation.stdin,
      stdout: result.observation.stdout,
      stderr: result.observation.stderr,
      exitCode: 0,
      snapshot: result.observation.snapshot,
    });
    return Object.freeze({
      call,
      status: "succeeded",
      session_before: before,
      session_after: before,
      execution: Object.freeze({
        status: "succeeded",
        runId,
        executorInvoked: true,
        observation,
      }),
    });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "EINVAL";
    return failedSearchReceipt(
      call,
      before,
      runId,
      code,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Read-only content-search capability bridge.
 *
 * `createReadOnlyCliFilesystemSandbox` intentionally grants only
 * `filesystem.read`, while the existing content-search contract requires
 * `filesystem.read + process.exec` for `directory.list` and `entry.inspect`.
 * The recursive search engine still owns traversal, candidate selection, scan
 * state and read orchestration. This wrapper only supplies those two semantic
 * observations through their existing adapters (`runDirectoryListHelper`,
 * `runEntryInspectHelper`) so the read-only call-depth sandbox can reuse the
 * same content-search contract instead of writing a second traversal loop.
 */
export function createReadOnlyContentSearchSandbox(base: CliFilesystemSandbox): CliFilesystemSandbox {
  return Object.freeze({
    ...base,
    async execute(value: unknown): Promise<SemanticCallReceipt> {
      const call = readSemanticCliCall(value);
      if (call.operation === "directory.list") {
        return executeListReceipt(base, call, base.getSession(call.parameters.session), randomUUID());
      }
      if (call.operation === "entry.inspect") {
        return executeInspectReceipt(base, call, base.getSession(sessionOfRef(call.parameters.ref)), randomUUID());
      }
      return base.execute(call);
    },
  });
}

function initialState(
  sandbox: CliFilesystemSandbox,
  session: SessionRef,
  stateId: string,
  cardinality: ContentSearchCardinality,
  recursion: ContentSearchRecursion,
  scan: ContentSearchScan,
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
    cardinality,
    recursion,
    maxDirectoryDepth: scan.maxDirectoryDepth,
    maxStaleRetries: scan.maxStaleRetries,
    directories: Object.freeze([]),
    pendingDirectories: Object.freeze([]),
    candidates: Object.freeze([]),
    provenNegatives: Object.freeze([]),
    typeMismatches: Object.freeze([]),
    duplicateReads: 0,
    bytesReadTotal: 0,
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
  const input = report as { states?: readonly { value?: unknown }[] } | null | undefined;
  if (
    input === null ||
    input === undefined ||
    !Array.isArray(input.states) ||
    input.states.length === 0
  ) {
    return null;
  }
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

type AuthoritativeRoot =
  | Readonly<{ kind: "evaluated"; result: "satisfied" | "unsatisfied" | "unknown"; satisfaction: number | null }>
  | Readonly<{ kind: "not_evaluated" }>;

const BUDGET_CODES = new Set(["budget_exceeded"]);
const INTERRUPT_CODES = new Set(["cancelled", "no_progress", "stalled"]);
const PARTIAL_CODES = new Set([
  "evidence_unavailable",
  "precondition_unsatisfied",
  "effect_outcome_unknown",
  "derivation_cycle",
  "adapter_contract_invalid",
]);
const REJECT_CODES = new Set([
  "invalid_request", "invalid_binding", "effect_denied",
  "capability_missing", "policy_error", "policy_deferred",
]);

function authoritativeRoot(response: unknown): Readonly<{
  root: AuthoritativeRoot;
  interrupted: boolean;
  budgetStopped: boolean;
}> {
  const report = (response as {
    report?: {
      rootEvaluation?: { state?: unknown; result?: unknown; satisfaction?: unknown } | null;
      control?: { outcome?: unknown; stopReason?: unknown } | null;
    } | null;
  } | null)?.report;
  const budgetStopped =
    report?.control?.outcome === "exceeded" &&
    (report?.control?.stopReason === "budget" ||
      report?.control?.stopReason === "too_many_attempts");
  const interrupted = !budgetStopped && (
    report?.control?.outcome === "exceeded" ||
    report?.control?.outcome === "cancelled" ||
    report?.control?.outcome === "stalled" ||
    report?.control?.stopReason === "budget" ||
    report?.control?.stopReason === "cancel" ||
    report?.control?.stopReason === "no_progress"
  );
  const evaluation = report?.rootEvaluation;
  if (evaluation === null || evaluation === undefined || evaluation.state !== "evaluated") {
    return Object.freeze({ root: Object.freeze({ kind: "not_evaluated" as const }), interrupted, budgetStopped });
  }
  const result = evaluation.result;
  if (result !== "satisfied" && result !== "unsatisfied" && result !== "unknown") {
    return Object.freeze({ root: Object.freeze({ kind: "not_evaluated" as const }), interrupted, budgetStopped });
  }
  const satisfaction = typeof evaluation.satisfaction === "number" ? evaluation.satisfaction : null;
  return Object.freeze({
    root: Object.freeze({ kind: "evaluated" as const, result, satisfaction }),
    interrupted,
    budgetStopped,
  });
}

function projectionStatus(
  root: AuthoritativeRoot,
  interrupted: boolean,
  budgetStopped: boolean,
  primaryCode: string | null,
  hasMatches: boolean,
): Readonly<{
  status: ContentSearchDomainProjection["status"];
  resolution: ContentSearchDomainProjection["resolution"];
  satisfaction: number | null;
}> {
  if (budgetStopped || (primaryCode !== null && BUDGET_CODES.has(primaryCode))) {
    return Object.freeze({ status: "unknown", resolution: "budget_exhausted", satisfaction: null });
  }
  if (interrupted) {
    return Object.freeze({ status: "unknown", resolution: "interrupted", satisfaction: null });
  }
  if (primaryCode !== null && INTERRUPT_CODES.has(primaryCode)) {
    return Object.freeze({ status: "unknown", resolution: "interrupted", satisfaction: null });
  }
  if (root.kind === "evaluated") {
    if (root.result === "satisfied") {
      return Object.freeze({ status: "achieved", resolution: "matched", satisfaction: root.satisfaction ?? 100 });
    }
    if (root.result === "unsatisfied") {
      return Object.freeze({ status: "unmet", resolution: "not_found", satisfaction: root.satisfaction ?? 0 });
    }
  }
  if (primaryCode !== null && REJECT_CODES.has(primaryCode)) {
    return Object.freeze({ status: "rejected", resolution: "rejected", satisfaction: null });
  }
  if (primaryCode === "execution_failed") {
    return Object.freeze({ status: "failed", resolution: "failed", satisfaction: null });
  }
  if (primaryCode !== null && PARTIAL_CODES.has(primaryCode)) {
    return Object.freeze({ status: "unknown", resolution: hasMatches ? "partial" : "insufficient_evidence", satisfaction: null });
  }
  if (hasMatches) {
    return Object.freeze({ status: "unknown", resolution: "partial", satisfaction: null });
  }
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

function emptyDenominators(): ContentSearchDomainProjection["denominators"] {
  return Object.freeze({
    listedDirectories: 0,
    directoriesComplete: 0,
    directoriesUncovered: 0,
    candidatesTotal: 0,
    candidatesScanned: 0,
    candidatesMatched: 0,
    candidatesNegative: 0,
    candidatesUnresolved: 0,
    typeMismatches: 0,
  });
}

function observationBoundary(): ContentSearchDomainProjection["observationBoundary"] {
  return Object.freeze({
    directoryListing: "per_list_dispatch",
    fileBytes: "per_read_range",
    atomicTreeSnapshot: false,
    atomicFileSnapshot: false,
  });
}

function preserve(response: unknown): ContentSearchDomainProjection["preserve"] {
  const input = response as {
    report?: {
      rootEvaluation?: unknown; control?: unknown; frames?: unknown; atomicResults?: unknown;
      effects?: unknown; errors?: unknown; primaryErrorId?: unknown; budgetUsed?: unknown;
      continuation?: unknown;
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
    continuation: report?.continuation ?? null,
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
        cardinality: ((request as Readonly<{goal?: Readonly<{target?: Readonly<{cardinality?: unknown}>}>}> | null)?.goal?.target?.cardinality === "all")
          ? "all" as const
          : "one" as const,
        recursion: ((request as Readonly<{goal?: Readonly<{target?: Readonly<{recursion?: unknown}>}>}> | null)?.goal?.target?.recursion === "nested")
          ? "nested" as const
          : "flat" as const,
        matches: Object.freeze([]),
        historicalMatches: Object.freeze([]),
        negatives: Object.freeze([]),
        coverage: null,
        denominators: emptyDenominators(),
        observationBoundary: observationBoundary(),
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
          continuation: null,
        }),
      }),
    });
  }

  const needleBytes = Buffer.byteLength(validated.goal.requirement.predicate.needle, "utf8");
  if (needleBytes > scan.chunkSize) {
    throw new TypeError("content search needle byte length must not exceed scan.chunkSize");
  }
  const rawScan = resources.scan as Readonly<Record<string, unknown>> | undefined;
  const rawRecursion = (request as Readonly<{ goal?: Readonly<{ target?: Readonly<{ recursion?: unknown }> }> }> | null)
    ?.goal?.target?.recursion;
  if (validated.goal.target.recursion === "flat" &&
      rawScan !== undefined &&
      Object.hasOwn(rawScan, "maxDirectoryDepth") &&
      scan.maxDirectoryDepth !== 0) {
    throw new TypeError("content search flat recursion requires scan.maxDirectoryDepth to be 0");
  }
  void rawRecursion;

  const created = createContentSearchAdapter({
    sandbox: resources.sandbox,
    session: resources.session,
    profile: resources.profile,
    scan,
    order,
    ...(resources.duplicateReadProbe === undefined ? {} : { duplicateReadProbe: resources.duplicateReadProbe }),
    ...(resources.onSample === undefined ? {} : { onSample: resources.onSample }),
    ...(resources.onDecision === undefined ? {} : { onDecision: resources.onDecision }),
  });
  const state = initialState(
    resources.sandbox,
    resources.session,
    `${validated.requestId}:state:initial`,
    validated.goal.target.cardinality,
    validated.goal.target.recursion,
    scan,
  );
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
        cardinality: validated.goal.target.cardinality,
        recursion: validated.goal.target.recursion,
        needle: validated.goal.requirement.predicate.needle,
      }),
      state,
      rootEvaluatorId: CONTENT_ROOT_EVALUATOR,
      rootSelectorId: CONTENT_ROOT_SELECTOR,
      ...(resources.limits === undefined ? {} : { limits: resources.limits }),
      ...(resources.continuation === undefined ? {} : { continuation: resources.continuation }),
    },
    createContentSearchDependencies(created, resources.signal),
  );
  const primaryCode = primaryErrorCode(response);
  const replayed = replay(validated, response, order);
  const synthesized: ContentSearchState = latestState((response as { report?: unknown } | null)?.report) ?? Object.freeze({
    stateId: state.stateId,
    session: state.session,
    cli: state.cli,
    listing: replayed.listing,
    cardinality: state.cardinality,
    recursion: state.recursion,
    maxDirectoryDepth: state.maxDirectoryDepth,
    maxStaleRetries: state.maxStaleRetries,
    directories: Object.freeze([]),
    pendingDirectories: Object.freeze([]),
    candidates: replayed.candidates,
    provenNegatives: Object.freeze([]),
    typeMismatches: Object.freeze([]),
    duplicateReads: replayed.duplicateReads,
    bytesReadTotal: 0,
  });
  const authoritative = authoritativeRoot(response);
  const needle = validated.goal.requirement.predicate.needle;
  const currentMatches = matchesOf(synthesized, needle);
  const status = projectionStatus(
    authoritative.root,
    authoritative.interrupted,
    authoritative.budgetStopped,
    primaryCode,
    currentMatches.length > 0,
  );
  const metrics = telemetry((response as { report?: unknown } | null)?.report ?? null);
  return Object.freeze({
    request: validated,
    response,
    domain: Object.freeze({
      status: status.status,
      resolution: status.resolution,
      satisfaction: status.satisfaction,
      cardinality: state.cardinality,
      recursion: state.recursion,
      matches: matchesOf(synthesized, needle),
      historicalMatches: historicalMatchesOf(synthesized),
      negatives: negativesOf(synthesized, needle),
      coverage: coverageOf(synthesized, status.status, status.resolution),
      denominators: denominatorsOf(synthesized, needle),
      observationBoundary: observationBoundary(),
      ordering: order,
      deliberateSuboptimal: deliberateSuboptimal(synthesized, order),
      invocationCount: metrics.invocationCount,
      observationCount: metrics.observationCount,
      bytesReadTotal: metrics.bytesReadTotal,
      duplicateReads: replayed.duplicateReads,
      budgetUsed: budgetUsed(response),
      rootFact: buildRootFact(synthesized, status, primaryCode, needle),
      preserve: preserve(response),
    }),
  });
}

export { createCliFilesystemSandbox } from "./adapters/cli/filesystem-sandbox.js";
export { createCliCommandPolicy } from "./cli-goal.js";
export {
  detectCliCommandProfileSchema,
  validateCliCommandProfile,
} from "./filters/cli-command-policy.js";
