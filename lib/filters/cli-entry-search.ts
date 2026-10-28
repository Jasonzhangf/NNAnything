import type {
  EntrySearchCandidate,
  EntrySearchCandidateFact,
  EntrySearchDirectoryFact,
  EntrySearchDomainProjection,
  EntrySearchInspectFact,
  EntrySearchPredicate,
  EntrySearchRequest,
  EntrySearchRootFact,
  EntrySearchState,
} from "../adapters/cli/entry-search-contract.js";
import type { ObservedObjectRef } from "../adapters/cli/entry-inspection.js";
import type { CliCommandTransition } from "../nodes/cli-command.js";
import type { DirectoryListObservation } from "../adapters/cli/directory-listing.js";
import { join } from "node:path";

export type ListingFacts = Readonly<{
  coverage: "complete" | "partial" | null;
  sourceRun: string | null;
  physicalDirectory: string | null;
  errors: readonly string[];
  candidateNames: readonly string[];
  candidate: EntrySearchCandidate | null;
}>;

export function findExactEntry(
  entries: readonly Readonly<{ name: string; path: string; type: string }>[],
  name: string,
): EntrySearchCandidate | null {
  const matches = entries.filter(entry => entry.name === name);
  if (matches.length !== 1 || matches[0] === undefined) return null;
  const match = matches[0];
  return Object.freeze({
    name: match.name,
    path: match.path,
    listedType: match.type as EntrySearchCandidate["listedType"],
  });
}

/**
 * A complete listing is only trustworthy when names are unique and every
 * entry path is the direct child implied by its name. Controlled listing
 * observations otherwise could smuggle in another scope or duplicate facts.
 */
export function listingIntegrityErrors(
  entries: readonly Readonly<{ name: string; path: string }>[],
  physicalDirectory: string,
): readonly string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      errors.push(`invalid_listing_contract:duplicate_name:${entry.name}`);
      continue;
    }
    seen.add(entry.name);
    if (entry.path !== join(physicalDirectory, entry.name)) {
      errors.push(`invalid_listing_contract:path_name_mismatch:${entry.name}`);
    }
  }
  return Object.freeze(errors);
}

export function compareByAbsolutePath(
  left: { readonly absolutePath: string },
  right: { readonly absolutePath: string },
): number {
  return left.absolutePath < right.absolutePath ? -1 : left.absolutePath > right.absolutePath ? 1 : 0;
}

export function listingFactFromTransition(transition: CliCommandTransition): DirectoryListObservation | null {
  const receipt = transition.execution_result.receipt;
  if (receipt?.execution.status !== "succeeded") return null;
  const observation = receipt.execution.observation;
  return observation.kind === "directory.list" ? observation : null;
}

export function inspectFactFromTransition(transition: CliCommandTransition): EntrySearchInspectFact | null {
  const receipt = transition.execution_result.receipt;
  if (receipt === null || receipt.execution.status !== "succeeded") return null;
  const observation = receipt.execution.observation.kind === "entry.inspect"
    ? receipt.execution.observation
    : null;
  if (observation === null) return null;
  const snapshot = observation.snapshot;
  return Object.freeze({
    absolutePath: observation.configuredPath,
    observedWith: snapshot.observedWith,
    entryExists: snapshot.entryExists,
    resolvedTargetExists: snapshot.resolvedTargetExists,
    type: snapshot.kind,
    identity: Object.freeze({
      dev: snapshot.dev,
      ino: snapshot.ino,
      nlink: snapshot.nlink,
      rdev: snapshot.rdev,
    }),
    errno: snapshot.errno,
    linkTarget: snapshot.linkTarget,
    sourceRun: receipt.execution.runId,
    sessionRevision: transition.session_before.revision,
  });
}

export function issuedRefMatchesInspect(ref: ObservedObjectRef, inspect: EntrySearchInspectFact): boolean {
  const expectedKind = inspect.type === "regular"
    ? "cli.file"
    : inspect.type === "directory"
      ? "cli.directory"
      : "cli.entry";
  return ref.kind === expectedKind
    && ref.type === inspect.type
    && ref.absolutePath === inspect.absolutePath
    && String(ref.identity.dev) === String(inspect.identity.dev)
    && String(ref.identity.ino) === String(inspect.identity.ino)
    && ref.sessionRevision === inspect.sessionRevision;
}

function directoriesOf(state: EntrySearchState): readonly EntrySearchDirectoryFact[] {
  return state.directories ?? Object.freeze([]);
}

function candidatesOf(state: EntrySearchState): readonly EntrySearchCandidateFact[] {
  return state.candidates ?? Object.freeze([]);
}

function pendingDirectoriesOf(state: EntrySearchState): readonly Readonly<{ path: string; depth: number }>[] {
  return state.pendingDirectories ?? Object.freeze([]);
}

function isCompleteListing(directory: EntrySearchDirectoryFact): boolean {
  return directory.listed
    && directory.listing !== null
    && directory.listing.coverage === "complete"
    && directory.uncoveredReason === null
    && listingIntegrityErrors(directory.listing.entries, directory.listing.physicalDirectory).length === 0;
}

export function candidatesFromDirectories(
  directories: readonly EntrySearchDirectoryFact[],
  predicate: EntrySearchPredicate,
): readonly EntrySearchCandidateFact[] {
  const candidates: EntrySearchCandidateFact[] = [];
  for (const directory of directories) {
    if (!isCompleteListing(directory) || directory.listing === null || directory.observedAtSourceRun === null) {
      continue;
    }
    const named = directory.listing.entries
      .filter(entry => entry.name === predicate.name)
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    for (const entry of named) {
      candidates.push(Object.freeze({
        name: entry.name,
        path: entry.path,
        parentDirectoryPath: directory.path,
        depth: directory.depth,
        listedType: entry.type as EntrySearchCandidateFact["listedType"],
        listedAtSourceRun: directory.observedAtSourceRun,
        inspected: null,
        issuedRef: null,
        outcome: "pending" as const,
        reason: null,
      }));
    }
  }
  return Object.freeze(candidates);
}

export function mergeCandidates(
  previous: readonly EntrySearchCandidateFact[],
  fresh: readonly EntrySearchCandidateFact[],
): readonly EntrySearchCandidateFact[] {
  return Object.freeze(fresh.map(candidate => {
    const existing = previous.find(item => item.path === candidate.path);
    return existing === undefined ? candidate : Object.freeze({
      ...candidate,
      inspected: existing.inspected,
      issuedRef: existing.issuedRef,
      outcome: existing.outcome,
      reason: existing.reason,
    });
  }));
}

export function verifiedMatches(state: EntrySearchState): readonly ObservedObjectRef[] {
  return Object.freeze(candidatesOf(state)
    .filter(candidate => candidate.outcome === "matched" && candidate.issuedRef !== null)
    .map(candidate => candidate.issuedRef as ObservedObjectRef)
    .sort(compareByAbsolutePath));
}

export function typeMismatchFacts(
  state: EntrySearchState,
): readonly Readonly<{ name: string; path: string }>[] {
  return Object.freeze(candidatesOf(state)
    .filter(candidate => candidate.outcome === "type_mismatch")
    .map(candidate => Object.freeze({ name: candidate.name, path: candidate.path }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

export function treeCoverage(state: EntrySearchState): "complete" | "partial" | null {
  const directories = directoriesOf(state);
  const listedDirectories = directories.filter(directory => directory.listed).length;
  if (listedDirectories === 0) return null;
  const complete = pendingDirectoriesOf(state).length === 0
    && directories.every(directory =>
      directory.listed
      && directory.listing !== null
      && directory.listing.coverage === "complete"
      && directory.uncoveredReason === null)
    && candidatesOf(state).every(candidate =>
      candidate.outcome === "matched" || candidate.outcome === "type_mismatch");
  return complete ? "complete" : "partial";
}

export function reasonsOf(state: EntrySearchState): readonly string[] {
  const reasons: string[] = [];
  for (const candidate of candidatesOf(state)) {
    if (candidate.outcome !== "stale_or_unverified" && candidate.outcome !== "pending") continue;
    reasons.push(candidate.reason ?? "pending_inspect");
  }
  for (const directory of directoriesOf(state)) {
    if (directory.uncoveredReason !== null) reasons.push(directory.uncoveredReason);
  }
  if (pendingDirectoriesOf(state).length > 0) reasons.push("pending_directory");
  return Object.freeze([...new Set(reasons)]);
}

export function denominatorFields(state: EntrySearchState): EntrySearchDomainProjection["denominators"] {
  const directories = directoriesOf(state);
  const candidates = candidatesOf(state);
  return Object.freeze({
    listedDirectories: directories.filter(directory => directory.listed).length,
    directoriesComplete: directories.filter(directory =>
      directory.listed && directory.listing !== null && directory.listing.coverage === "complete").length,
    directoriesUncovered: directories.filter(directory => directory.uncoveredReason !== null).length,
    candidatesScanned: candidates.filter(candidate => candidate.outcome !== "pending").length,
    candidatesMatched: candidates.filter(candidate => candidate.outcome === "matched").length,
    candidatesTypeMismatch: candidates.filter(candidate => candidate.outcome === "type_mismatch").length,
    candidatesUnresolved: candidates.filter(candidate =>
      candidate.outcome === "pending" || candidate.outcome === "stale_or_unverified").length,
  });
}

export type RootDecision =
  | Readonly<{ result: "satisfied"; satisfaction: 100 }>
  | Readonly<{ result: "unsatisfied"; satisfaction: 0; reason: "not_found" | "type_mismatch" }>
  | Readonly<{ result: "unknown"; satisfaction: null }>;

export function decideEntrySearchRoot(state: EntrySearchState): RootDecision {
  const matches = verifiedMatches(state);
  const cardinality = state.cardinality ?? "one";
  const coverage = treeCoverage(state);
  if (cardinality === "one" && matches.length > 0) {
    return Object.freeze({ result: "satisfied", satisfaction: 100 });
  }
  if (cardinality === "all" && coverage === "complete" && matches.length > 0) {
    return Object.freeze({ result: "satisfied", satisfaction: 100 });
  }
  if (coverage === "complete" && matches.length === 0) {
    const stale = candidatesOf(state).some(candidate => candidate.outcome === "stale_or_unverified");
    if (!stale) {
      return Object.freeze({
        result: "unsatisfied",
        satisfaction: 0,
        reason: typeMismatchFacts(state).length > 0 ? "type_mismatch" : "not_found",
      });
    }
  }
  return Object.freeze({ result: "unknown", satisfaction: null });
}

function firstListingSourceRun(directories: readonly EntrySearchDirectoryFact[]): string | null {
  for (const directory of directories) {
    if (directory.observedAtSourceRun !== null) return directory.observedAtSourceRun;
  }
  return null;
}

function listingErrors(directories: readonly EntrySearchDirectoryFact[]): readonly string[] {
  const errors: string[] = [];
  for (const directory of directories) {
    if (directory.listing === null) continue;
    for (const error of directory.listing.errors) {
      errors.push(`${error.name}:${error.code}:${error.message}`);
    }
    for (const error of listingIntegrityErrors(directory.listing.entries, directory.listing.physicalDirectory)) {
      errors.push(error);
    }
  }
  return Object.freeze(errors);
}

function candidateFor(state: EntrySearchState, absolutePath: string): EntrySearchCandidateFact | null {
  return candidatesOf(state).find(candidate => candidate.path === absolutePath) ?? null;
}

export function rootFact(
  predicate: EntrySearchPredicate,
  state: EntrySearchState,
  primaryCode: string | null,
): EntrySearchRootFact {
  const directories = directoriesOf(state);
  const matches = verifiedMatches(state);
  const typeMismatches = typeMismatchFacts(state);
  const reasons = reasonsOf(state);
  const coverage = treeCoverage(state);
  const cardinality = state.cardinality ?? "one";

  if (matches.length > 0) {
    const first = matches[0] as ObservedObjectRef;
    const candidate = candidateFor(state, first.absolutePath);
    return Object.freeze({
      kind: "matched",
      predicate,
      listing: Object.freeze({
        sourceRun: candidate?.listedAtSourceRun ?? firstListingSourceRun(directories) ?? "",
        coverage: coverage ?? "partial",
      }),
      inspect: candidate?.inspected ?? (() => { throw new TypeError("matched entry lost its inspection"); })(),
      ref: first,
    });
  }
  if (
    primaryCode !== null &&
    (primaryCode === "invalid_request" || primaryCode === "invalid_binding" ||
      primaryCode === "effect_denied" || primaryCode === "capability_missing")
  ) {
    return Object.freeze({ kind: "rejected" });
  }
  if (primaryCode === "execution_failed" || primaryCode === "policy_error") {
    return Object.freeze({ kind: "failed" });
  }
  if (primaryCode === "cancelled" || primaryCode === "no_progress" || primaryCode === "stalled") {
    return Object.freeze({ kind: "interrupted" });
  }
  if (coverage === "complete") {
    if (typeMismatches.length > 0) {
      const first = typeMismatches[0] as Readonly<{ name: string; path: string }>;
      const candidate = candidateFor(state, first.path);
      return Object.freeze({
        kind: "type_mismatch",
        predicate,
        listing: Object.freeze({
          sourceRun: firstListingSourceRun(directories) ?? "",
          coverage: "complete",
        }),
        inspect: candidate?.inspected ?? (() => { throw new TypeError("type mismatch lost its inspection"); })(),
        ref: candidate?.issuedRef ?? null,
        typeMismatches,
      });
    }
    return Object.freeze({
      kind: "not_found",
      predicate,
      listing: Object.freeze({
        sourceRun: firstListingSourceRun(directories) ?? "",
        coverage: "complete",
      }),
    });
  }
  if (cardinality === "all" && matches.length > 0) {
    return Object.freeze({
      kind: "partial",
      predicate,
      listing: Object.freeze({
        sourceRun: firstListingSourceRun(directories),
        coverage,
      }),
      matches,
      typeMismatches,
      reasons,
    });
  }
  const stale = candidatesOf(state).find(candidate => candidate.outcome === "stale_or_unverified");
  if (stale !== undefined) {
    return Object.freeze({
      kind: "stale_or_unverified",
      predicate,
      listing: Object.freeze({
        sourceRun: firstListingSourceRun(directories) ?? "",
        coverage: "complete",
      }),
      inspect: stale.inspected,
      ref: null,
      reasons,
      typeMismatches,
    });
  }
  return Object.freeze({
    kind: "insufficient_evidence",
    predicate,
    listing: Object.freeze({
      sourceRun: firstListingSourceRun(directories),
      coverage,
      errors: listingErrors(directories),
      candidateNames: Object.freeze(directories.flatMap(directory =>
        directory.listing === null
          ? []
          : directory.listing.entries
              .filter(entry => entry.name === predicate.name)
              .map(entry => entry.name))),
      typeMismatchPaths: Object.freeze(typeMismatches.map(item => item.path)),
      reasons,
    }),
  });
}

type TransitionView = Readonly<{
  kind: string | null;
  requestId: string | null;
  report: ReportView | null;
  continuation: unknown;
  error: Readonly<{ code: string }> | null;
  fault: Readonly<{ code: string }> | null;
}>;

type ReportView = Readonly<{
  rootEvaluation: Readonly<{
    state: string;
    result: string | undefined;
    satisfaction: number | null | undefined;
  }> | null;
  control: Readonly<{ outcome: string; stopReason: string }> | null;
  primaryErrorId: string | null;
  errors: readonly Readonly<{ errorId: string; code: string }>[];
  states: readonly Readonly<{ value: EntrySearchState }>[];
  atomicResults: readonly Readonly<{ sourceResult: unknown }>[];
  frames: unknown;
  effects: unknown;
  budgetUsed: unknown;
  continuation: unknown;
}>;

export function projectDomain(
  request: EntrySearchRequest,
  response: unknown,
): EntrySearchDomainProjection {
  const view = transitionView(response);
  const report = view.report;
  const state = report === null ? null : latestState(report);
  const primaryCode = primaryError(view);
  const predicate = request.goal.requirement.predicate;

  if (state === null) {
    const status = noStateStatus(primaryCode);
    return Object.freeze({
      status: status.status,
      resolution: status.resolution,
      satisfaction: null,
      match: null,
      matches: Object.freeze([]),
      typeMismatches: Object.freeze([]),
      denominators: emptyDenominators(),
      coverage: null,
      rootFact: noStateRootFact(primaryCode),
      preserve: preserve(view),
    });
  }

  const coverage = treeCoverage(state);
  const matches = verifiedMatches(state);
  const typeMismatches = typeMismatchFacts(state);
  const denominators = denominatorFields(state);
  const decision = decideEntrySearchRoot(state);

  if (decision.result === "satisfied") {
    const fact = rootFact(predicate, state, primaryCode);
    if (fact.kind !== "matched") {
      throw new TypeError("satisfied entry search root lost its verified evidence");
    }
    return Object.freeze({
      status: "achieved",
      resolution: "matched",
      satisfaction: 100,
      match: matches[0] ?? null,
      matches,
      typeMismatches,
      denominators,
      coverage,
      rootFact: fact,
      preserve: preserve(view),
    });
  }

  if (
    primaryCode === "invalid_request" || primaryCode === "invalid_binding" ||
    primaryCode === "effect_denied" || primaryCode === "capability_missing"
  ) {
    return unresolved("rejected", "rejected", state, predicate, primaryCode, view);
  }
  if (primaryCode === "execution_failed" || primaryCode === "policy_error") {
    return unresolved("failed", "failed", state, predicate, primaryCode, view);
  }
  if (
    primaryCode === "budget_exceeded" ||
    primaryCode === "cancelled" ||
    primaryCode === "no_progress" ||
    primaryCode === "stalled"
  ) {
    return unresolved("unknown", "interrupted", state, predicate, primaryCode, view);
  }

  if (decision.result === "unsatisfied") {
    return Object.freeze({
      status: "unmet",
      resolution: decision.reason === "type_mismatch" ? "type_mismatch" : "not_found",
      satisfaction: 0,
      match: null,
      matches,
      typeMismatches,
      denominators,
      coverage,
      rootFact: rootFact(predicate, state, primaryCode),
      preserve: preserve(view),
    });
  }

  const fact = rootFact(predicate, state, primaryCode);
  const resolution = matches.length > 0 && (state.cardinality ?? "one") === "all"
    ? "partial"
    : fact.kind === "stale_or_unverified"
      ? "stale_or_unverified"
      : "insufficient_evidence";
  return Object.freeze({
    status: "unknown",
    resolution,
    satisfaction: null,
    match: null,
    matches,
    typeMismatches,
    denominators,
    coverage,
    rootFact: fact,
    preserve: preserve(view),
  });
}

function unresolved(
  status: EntrySearchDomainProjection["status"],
  resolution: EntrySearchDomainProjection["resolution"],
  state: EntrySearchState,
  predicate: EntrySearchPredicate,
  primaryCode: string | null,
  view: TransitionView,
): EntrySearchDomainProjection {
  return Object.freeze({
    status,
    resolution,
    satisfaction: null,
    match: null,
    matches: verifiedMatches(state),
    typeMismatches: typeMismatchFacts(state),
    denominators: denominatorFields(state),
    coverage: treeCoverage(state),
    rootFact: rootFact(predicate, state, primaryCode),
    preserve: preserve(view),
  });
}

function emptyDenominators(): EntrySearchDomainProjection["denominators"] {
  return Object.freeze({
    listedDirectories: 0,
    directoriesComplete: 0,
    directoriesUncovered: 0,
    candidatesScanned: 0,
    candidatesMatched: 0,
    candidatesTypeMismatch: 0,
    candidatesUnresolved: 0,
  });
}

function transitionView(value: unknown): TransitionView {
  const input = value as {
    kind?: unknown;
    requestId?: unknown;
    report?: unknown;
    continuation?: unknown;
    error?: unknown;
    fault?: unknown;
  };
  return Object.freeze({
    kind: typeof input.kind === "string" ? input.kind : null,
    requestId: typeof input.requestId === "string" ? input.requestId : null,
    report: reportView(input.report),
    continuation: input.continuation ?? null,
    error: errorCodeView(input.error),
    fault: errorCodeView(input.fault),
  });
}

function errorCodeView(value: unknown): Readonly<{ code: string }> | null {
  if (typeof value !== "object" || value === null) return null;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" ? Object.freeze({ code }) : null;
}

function reportView(value: unknown): ReportView | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as {
    rootEvaluation?: unknown;
    control?: unknown;
    primaryErrorId?: unknown;
    errors?: unknown;
    states?: unknown;
    atomicResults?: unknown;
    frames?: unknown;
    effects?: unknown;
    budgetUsed?: unknown;
    continuation?: unknown;
  };
  const rootEvaluation = input.rootEvaluation;
  const control = input.control;
  const errors = input.errors;
  const states = input.states;
  const atomicResults = input.atomicResults;
  return Object.freeze({
    rootEvaluation:
      typeof rootEvaluation === "object" && rootEvaluation !== null
        ? Object.freeze({
            state: String((rootEvaluation as { state?: unknown }).state ?? "not_evaluated"),
            result: (rootEvaluation as { result?: unknown }).result as string | undefined,
            satisfaction: (rootEvaluation as { satisfaction?: unknown }).satisfaction as number | null | undefined,
          })
        : null,
    control:
      typeof control === "object" && control !== null
        ? Object.freeze({
            outcome: String((control as { outcome?: unknown }).outcome ?? "error"),
            stopReason: String((control as { stopReason?: unknown }).stopReason ?? "fatal_error"),
          })
        : null,
    primaryErrorId: typeof input.primaryErrorId === "string" ? input.primaryErrorId : null,
    errors: Array.isArray(errors)
      ? Object.freeze(errors.map(item => {
          const error = item as { errorId?: unknown; code?: unknown };
          return Object.freeze({
            errorId: String(error.errorId ?? ""),
            code: String(error.code ?? "unknown"),
          });
        }))
      : Object.freeze([]),
    states: Array.isArray(states)
      ? Object.freeze(states.map(item => Object.freeze({ value: (item as { value: EntrySearchState }).value })))
      : Object.freeze([]),
    atomicResults: Array.isArray(atomicResults)
      ? Object.freeze(atomicResults.map(item => Object.freeze({ sourceResult: (item as { sourceResult: unknown }).sourceResult })))
      : Object.freeze([]),
    frames: input.frames ?? null,
    effects: input.effects ?? null,
    budgetUsed: input.budgetUsed ?? null,
    continuation: input.continuation ?? null,
  });
}

function latestState(report: ReportView): EntrySearchState | null {
  const last = report.states[report.states.length - 1];
  return last === undefined ? null : last.value;
}

function primaryError(view: TransitionView): string | null {
  if (view.error !== null) return view.error.code;
  if (view.fault !== null) return view.fault.code;
  const report = view.report;
  if (report === null || report.primaryErrorId === null) return null;
  const error = report.errors.find(item => item.errorId === report.primaryErrorId);
  return error === undefined ? null : error.code;
}

function noStateStatus(primaryCode: string | null): Readonly<{
  status: EntrySearchDomainProjection["status"];
  resolution: EntrySearchDomainProjection["resolution"];
}> {
  if (
    primaryCode === "budget_exceeded" ||
    primaryCode === "cancelled" ||
    primaryCode === "no_progress" ||
    primaryCode === "stalled"
  ) {
    return Object.freeze({ status: "unknown", resolution: "interrupted" });
  }
  if (
    primaryCode === "invalid_request" ||
    primaryCode === "invalid_binding" ||
    primaryCode === "effect_denied" ||
    primaryCode === "capability_missing" ||
    primaryCode === "policy_error"
  ) {
    return Object.freeze({ status: "rejected", resolution: "rejected" });
  }
  return Object.freeze({ status: "failed", resolution: "failed" });
}

function noStateRootFact(primaryCode: string | null): EntrySearchRootFact {
  if (
    primaryCode === "budget_exceeded" ||
    primaryCode === "cancelled" ||
    primaryCode === "no_progress" ||
    primaryCode === "stalled"
  ) {
    return Object.freeze({ kind: "interrupted" });
  }
  if (
    primaryCode === "invalid_request" ||
    primaryCode === "invalid_binding" ||
    primaryCode === "effect_denied" ||
    primaryCode === "capability_missing" ||
    primaryCode === "policy_error"
  ) {
    return Object.freeze({ kind: "rejected" });
  }
  return Object.freeze({ kind: "failed" });
}

function preserve(view: TransitionView): EntrySearchDomainProjection["preserve"] {
  if (view.report === null) {
    return Object.freeze({
      rootEvaluation: null,
      control: null,
      frames: null,
      atomicResults: null,
      effects: null,
      errors: view.error === null && view.fault === null ? null : Object.freeze([view.error ?? view.fault]),
      primaryErrorId: null,
      budgetUsed: null,
      continuation: view.continuation,
    });
  }
  const report = view.report;
  return Object.freeze({
    rootEvaluation: report.rootEvaluation,
    control: report.control,
    frames: report.frames,
    atomicResults: report.atomicResults,
    effects: report.effects,
    errors: report.errors,
    primaryErrorId: report.primaryErrorId,
    budgetUsed: report.budgetUsed,
    continuation: view.continuation ?? report.continuation,
  });
}
