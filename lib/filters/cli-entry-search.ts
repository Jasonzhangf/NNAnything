import type {
  EntrySearchCandidate,
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
import type { ExplicitFileState } from "./cli-state.js";
import { join } from "node:path";

export type ListingFacts = Readonly<{
  coverage: "complete" | "partial" | null;
  sourceRun: string | null;
  physicalDirectory: string | null;
  errors: readonly string[];
  candidateNames: readonly string[];
  candidate: EntrySearchCandidate | null;
}>;

function issuedRefMatchesInspect(ref: ObservedObjectRef, inspect: EntrySearchInspectFact): boolean {
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

export type RootDecision =
  | Readonly<{ result: "satisfied"; satisfaction: 100 }>
  | Readonly<{ result: "unsatisfied"; satisfaction: 0; reason: "not_found" | "type_mismatch" }>
  | Readonly<{ result: "unknown"; satisfaction: null; reason: "no_listing" | "partial" | "unverified" }>;

type TransitionView = Readonly<{
  kind: string | null;
  requestId: string | null;
  report: ReportView | null;
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

export function listingFacts(
  cli: ExplicitFileState,
  name: string,
  transitions: readonly CliCommandTransition[],
): ListingFacts {
  if (cli.directoryListing !== null) {
    const listing = cli.directoryListing;
    const integrity = listingIntegrityErrors(listing.entries, listing.physicalDirectory);
    const coverage = integrity.length === 0 ? listing.coverage : "partial";
    const errors = Object.freeze([
      ...listing.errors.map(error => `${error.name}:${error.code}:${error.message}`),
      ...integrity,
    ]);
    const candidate = integrity.length === 0 ? findExactEntry(listing.entries, name) : null;
    return Object.freeze({
      coverage,
      sourceRun: listing.sourceRun,
      physicalDirectory: listing.physicalDirectory,
      errors,
      candidateNames: Object.freeze(
        candidate === null
          ? []
          : [name],
      ),
      candidate,
    });
  }
  const transition = listingTransition(transitions);
  if (transition === null) {
    return Object.freeze({
      coverage: null,
      sourceRun: null,
      physicalDirectory: null,
      errors: Object.freeze([]),
      candidateNames: Object.freeze([]),
      candidate: null,
    });
  }
  const observation = listingObservation(transition);
  if (observation === null) {
    return Object.freeze({
      coverage: null,
      sourceRun: transition.execution_result.receipt?.execution.runId ?? null,
      physicalDirectory: null,
      errors: Object.freeze([]),
      candidateNames: Object.freeze([]),
      candidate: null,
    });
  }
  const integrity = listingIntegrityErrors(observation.entries, observation.physicalDirectory);
  const coverage = integrity.length === 0 ? observation.coverage : "partial";
  const candidate = integrity.length === 0 ? findExactEntry(observation.entries, name) : null;
  return Object.freeze({
    coverage,
    sourceRun: transition.execution_result.receipt?.execution.runId ?? null,
    physicalDirectory: observation.physicalDirectory,
    errors: Object.freeze([
      ...observation.errors.map(error => `${error.name}:${error.code}:${error.message}`),
      ...integrity,
    ]),
    candidateNames: Object.freeze(
      candidate === null
        ? observation.entries.filter(entry => entry.name === name).map(entry => entry.name)
        : [candidate.name],
    ),
    candidate,
  });
}

export function inspectFact(
  cli: ExplicitFileState,
  expectedPath: string | null,
  transitions: readonly CliCommandTransition[],
): EntrySearchInspectFact | null {
  const knowledge = cli.entryKnowledge;
  if (
    knowledge !== null &&
    knowledge !== undefined &&
    knowledge.kind === "entry.inspect" &&
    knowledge.query.followSymlinks === false &&
    knowledge.query.ref.kind === "cli.path" &&
    (expectedPath === null || knowledge.absolutePath === expectedPath)
  ) {
    return factFromKnowledge(knowledge);
  }
  const transition = inspectTransition(transitions);
  if (transition === null) return null;
  const receipt = transition.execution_result.receipt;
  if (receipt === null || receipt.execution.status !== "succeeded") return null;
  const observation = receipt.execution.observation.kind === "entry.inspect"
    ? receipt.execution.observation
    : null;
  if (observation === null) return null;
  const path = observation.configuredPath;
  if (expectedPath !== null && path !== expectedPath) return null;
  const snapshot = observation.snapshot;
  return Object.freeze({
    absolutePath: path,
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

export function decideRoot(
  cli: ExplicitFileState,
  name: string,
  predicateType: "regular" | "directory",
  transitions: readonly CliCommandTransition[],
  issuedRef: ObservedObjectRef | null,
): RootDecision {
  const listing = listingFacts(cli, name, transitions);
  if (listing.coverage === null) {
    return Object.freeze({ result: "unknown", satisfaction: null, reason: "no_listing" });
  }
  if (listing.coverage === "partial") {
    return Object.freeze({ result: "unknown", satisfaction: null, reason: "partial" });
  }
  if (listing.candidate === null) {
    return Object.freeze({ result: "unsatisfied", satisfaction: 0, reason: "not_found" });
  }
  const inspect = inspectFact(cli, listing.candidate.path, transitions);
  if (inspect === null) {
    return Object.freeze({ result: "unknown", satisfaction: null, reason: "unverified" });
  }
  if (
    inspect.type === null ||
    inspect.entryExists !== true ||
    inspect.identity.dev === null ||
    inspect.identity.ino === null
  ) {
    return Object.freeze({ result: "unknown", satisfaction: null, reason: "unverified" });
  }
  if (inspect.type !== predicateType) {
    return Object.freeze({ result: "unsatisfied", satisfaction: 0, reason: "type_mismatch" });
  }
  if (issuedRef === null || !issuedRefMatchesInspect(issuedRef, inspect)) {
    return Object.freeze({ result: "unknown", satisfaction: null, reason: "unverified" });
  }
  return Object.freeze({ result: "satisfied", satisfaction: 100 });
}

export function rootFact(
  predicate: EntrySearchPredicate,
  cli: ExplicitFileState,
  transitions: readonly CliCommandTransition[],
  primaryCode: string | null,
  issuedRef: ObservedObjectRef | null,
): EntrySearchRootFact {
  const listing = listingFacts(cli, predicate.name, transitions);
  if (listing.coverage === "partial") {
    return Object.freeze({
      kind: "insufficient_evidence",
      predicate,
      listing: Object.freeze({
        sourceRun: listing.sourceRun,
        coverage: "partial",
        errors: listing.errors,
        candidateNames: listing.candidateNames,
      }),
    });
  }
  if (listing.coverage === null) {
    if (primaryCode === "budget_exceeded" || primaryCode === "cancelled" || primaryCode === "no_progress") {
      return Object.freeze({ kind: "interrupted" });
    }
    if (primaryCode === "effect_denied" || primaryCode === "capability_missing" || primaryCode === "invalid_binding") {
      return Object.freeze({ kind: "rejected" });
    }
    if (primaryCode === "execution_failed" || primaryCode === "policy_error") {
      return Object.freeze({ kind: "failed" });
    }
    return Object.freeze({
      kind: "insufficient_evidence",
      predicate,
      listing: Object.freeze({
        sourceRun: null,
        coverage: null,
        errors: listing.errors,
        candidateNames: listing.candidateNames,
      }),
    });
  }
  if (listing.sourceRun === null) {
    return Object.freeze({
      kind: "insufficient_evidence",
      predicate,
      listing: Object.freeze({
        sourceRun: null,
        coverage: listing.coverage,
        errors: listing.errors,
        candidateNames: listing.candidateNames,
      }),
    });
  }
  if (listing.candidate === null) {
    return Object.freeze({
      kind: "not_found",
      predicate,
      listing: Object.freeze({ sourceRun: listing.sourceRun, coverage: "complete" }),
    });
  }
  const inspect = inspectFact(cli, listing.candidate.path, transitions);
  if (inspect === null) {
    return Object.freeze({
      kind: "stale_or_unverified",
      predicate,
      listing: Object.freeze({ sourceRun: listing.sourceRun, coverage: "complete" }),
      inspect: null,
      ref: null,
    });
  }
  if (
    inspect.type === null ||
    inspect.entryExists !== true ||
    inspect.identity.dev === null ||
    inspect.identity.ino === null
  ) {
    return Object.freeze({
      kind: "stale_or_unverified",
      predicate,
      listing: Object.freeze({ sourceRun: listing.sourceRun, coverage: "complete" }),
      inspect,
      ref: null,
    });
  }
  if (inspect.type !== predicate.type) {
    const ref = issuedRef !== null && issuedRefMatchesInspect(issuedRef, inspect)
      ? issuedRef
      : null;
    return Object.freeze({
      kind: "type_mismatch",
      predicate,
      listing: Object.freeze({ sourceRun: listing.sourceRun, coverage: "complete" }),
      inspect,
      ref,
    });
  }
  if (issuedRef === null || !issuedRefMatchesInspect(issuedRef, inspect)) {
    return Object.freeze({
      kind: "stale_or_unverified",
      predicate,
      listing: Object.freeze({ sourceRun: listing.sourceRun, coverage: "complete" }),
      inspect,
      ref: null,
    });
  }
  return Object.freeze({
    kind: "matched",
    predicate,
    listing: Object.freeze({ sourceRun: listing.sourceRun, coverage: "complete" }),
    inspect,
    ref: issuedRef,
  });
}

export function projectDomain(
  request: EntrySearchRequest,
  response: unknown,
  issuedRef: ObservedObjectRef | null,
): EntrySearchDomainProjection {
  const view = transitionView(response);
  const report = view.report;
  const transitions = report === null ? [] : transitionsOf(report);
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
      coverage: null,
      rootFact: noStateRootFact(primaryCode),
      preserve: preserve(view),
    });
  }

  const decision = decideRoot(state.cli, predicate.name, predicate.type, transitions, issuedRef);
  if (decision.result === "satisfied") {
    return achieved(request, state, transitions, report, issuedRef);
  }
  if (decision.result === "unsatisfied") {
    const resolution = decision.reason === "type_mismatch" ? "type_mismatch" : "not_found";
    return Object.freeze({
      status: "unmet",
      resolution,
      satisfaction: 0,
      match: null,
      coverage: listingFacts(state.cli, predicate.name, transitions).coverage,
      rootFact: rootFact(predicate, state.cli, transitions, primaryCode, issuedRef),
      preserve: preserve(view),
    });
  }

  // A partial or contract-invalid listing is always insufficient evidence.
  // It must not be re-labelled as an interruption, rejection or failure merely
  // because the controller stopped early after an unverifiable child goal.
  const coverage = listingFacts(state.cli, predicate.name, transitions).coverage;
  if (coverage === "partial") {
    return Object.freeze({
      status: "unknown",
      resolution: "insufficient_evidence",
      satisfaction: null,
      match: null,
      coverage,
      rootFact: rootFact(predicate, state.cli, transitions, primaryCode, issuedRef),
      preserve: preserve(view),
    });
  }

  if (primaryCode === "budget_exceeded" || primaryCode === "cancelled" || primaryCode === "no_progress") {
    return Object.freeze({
      status: "unknown",
      resolution: "interrupted",
      satisfaction: null,
      match: null,
      coverage: listingFacts(state.cli, predicate.name, transitions).coverage,
      rootFact: Object.freeze({ kind: "interrupted" }),
      preserve: preserve(view),
    });
  }
  if (primaryCode === "effect_denied" || primaryCode === "capability_missing" || primaryCode === "invalid_binding") {
    return Object.freeze({
      status: "rejected",
      resolution: "rejected",
      satisfaction: null,
      match: null,
      coverage: listingFacts(state.cli, predicate.name, transitions).coverage,
      rootFact: Object.freeze({ kind: "rejected" }),
      preserve: preserve(view),
    });
  }
  if (primaryCode === "execution_failed" || primaryCode === "policy_error") {
    return Object.freeze({
      status: "failed",
      resolution: "failed",
      satisfaction: null,
      match: null,
      coverage: listingFacts(state.cli, predicate.name, transitions).coverage,
      rootFact: Object.freeze({ kind: "failed" }),
      preserve: preserve(view),
    });
  }

  const fact = rootFact(predicate, state.cli, transitions, primaryCode, issuedRef);
  const resolution =
    fact.kind === "stale_or_unverified"
      ? "stale_or_unverified"
      : "insufficient_evidence";
  return Object.freeze({
    status: "unknown",
    resolution,
    satisfaction: null,
    match: null,
    coverage: listingFacts(state.cli, predicate.name, transitions).coverage,
    rootFact: fact,
    preserve: preserve(view),
  });
}

function achieved(
  request: EntrySearchRequest,
  state: EntrySearchState,
  transitions: readonly CliCommandTransition[],
  report: ReportView | null,
  issuedRef: ObservedObjectRef | null,
): EntrySearchDomainProjection {
  const predicate = request.goal.requirement.predicate;
  const listing = listingFacts(state.cli, predicate.name, transitions);
  const inspect = inspectFact(state.cli, listing.candidate?.path ?? null, transitions);
  const rootFactValue = rootFact(predicate, state.cli, transitions, null, issuedRef);
  if (
    listing.sourceRun === null ||
    listing.physicalDirectory === null ||
    inspect === null
  ) {
    throw new TypeError("satisfied entry search root lost its verified evidence");
  }
  if (rootFactValue.kind !== "matched") {
    return Object.freeze({
      status: "unknown",
      resolution: "stale_or_unverified",
      satisfaction: null,
      match: null,
      coverage: "complete",
      rootFact: rootFactValue,
      preserve: preserveFromReport(report),
    });
  }
  return Object.freeze({
    status: "achieved",
    resolution: "matched",
    satisfaction: 100,
    match: rootFactValue.ref,
    coverage: "complete",
    rootFact: rootFactValue,
    preserve: preserveFromReport(report),
  });
}

function factFromKnowledge(knowledge: NonNullable<ExplicitFileState["entryKnowledge"]>): EntrySearchInspectFact {
  return Object.freeze({
    absolutePath: knowledge.absolutePath,
    observedWith: knowledge.observedWith,
    entryExists: knowledge.entryExists,
    resolvedTargetExists: knowledge.resolvedTargetExists,
    type: knowledge.type,
    identity: Object.freeze({
      dev: knowledge.identity.dev,
      ino: knowledge.identity.ino,
      nlink: knowledge.identity.nlink,
      rdev: knowledge.identity.rdev,
    }),
    errno: knowledge.errno,
    linkTarget: knowledge.linkTarget,
    sourceRun: knowledge.sourceRun,
    sessionRevision: knowledge.sessionRevision,
  });
}

function listingTransition(transitions: readonly CliCommandTransition[]): CliCommandTransition | null {
  for (let index = transitions.length - 1; index >= 0; index -= 1) {
    const transition = transitions[index];
    if (
      transition !== undefined &&
      transition.goal.property === "file.property.directory.entries" &&
      transition.goal.requirement.kind === "observed"
    ) {
      return transition;
    }
  }
  return null;
}

function inspectTransition(transitions: readonly CliCommandTransition[]): CliCommandTransition | null {
  for (let index = transitions.length - 1; index >= 0; index -= 1) {
    const transition = transitions[index];
    if (
      transition !== undefined &&
      transition.goal.property === "file.property.type" &&
      transition.goal.target.kind === "cli.entry-query" &&
      transition.goal.target.followSymlinks === false
    ) {
      return transition;
    }
  }
  return null;
}

function listingObservation(transition: CliCommandTransition): DirectoryListObservation | null {
  const receipt = transition.execution_result.receipt;
  if (receipt?.execution.status !== "succeeded") return null;
  const observation = receipt.execution.observation;
  return observation.kind === "directory.list" ? observation : null;
}

function transitionView(value: unknown): TransitionView {
  const input = value as {
    kind?: unknown;
    requestId?: unknown;
    report?: unknown;
    error?: unknown;
    fault?: unknown;
  };
  return Object.freeze({
    kind: typeof input.kind === "string" ? input.kind : null,
    requestId: typeof input.requestId === "string" ? input.requestId : null,
    report: reportView(input.report),
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
  });
}

function transitionsOf(report: ReportView): readonly CliCommandTransition[] {
  const transitions: CliCommandTransition[] = [];
  for (const result of report.atomicResults) {
    const source = result.sourceResult as { tag?: unknown; value?: unknown } | null;
    if (source !== null && typeof source === "object" && source.tag === "cli.command.transition.v1") {
      transitions.push(source.value as CliCommandTransition);
    }
  }
  return Object.freeze(transitions);
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
    });
  }
  return preserveFromReport(view.report);
}

function preserveFromReport(report: ReportView | null): EntrySearchDomainProjection["preserve"] {
  if (report === null) {
    return Object.freeze({
      rootEvaluation: null,
      control: null,
      frames: null,
      atomicResults: null,
      effects: null,
      errors: null,
      primaryErrorId: null,
      budgetUsed: null,
    });
  }
  return Object.freeze({
    rootEvaluation: report.rootEvaluation,
    control: report.control,
    frames: report.frames,
    atomicResults: report.atomicResults,
    effects: report.effects,
    errors: report.errors,
    primaryErrorId: report.primaryErrorId,
    budgetUsed: report.budgetUsed,
  });
}
