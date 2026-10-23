import type {
  ReadCompositionCandidate,
  ReadCompositionDomainProjection,
  ReadCompositionFileRef,
  ReadCompositionInspectedFact,
  ReadCompositionListingFact,
  ReadCompositionReadFact,
  ReadCompositionRequest,
  ReadCompositionRootFact,
  ReadCompositionState,
} from "../adapters/cli/read-composition-contract.js";
import type { ObservedObjectRef } from "../adapters/cli/entry-inspection.js";
import type { CliCommandTransition } from "../nodes/cli-command.js";
import { findExactEntry, listingIntegrityErrors } from "./cli-entry-search.js";
import { join } from "node:path";
import type {
  ReadCompositionSourceState,
} from "../adapters/cli/read-composition-contract.js";

export type ReadRootDecision =
  | Readonly<{ result: "satisfied"; satisfaction: 100 }>
  | Readonly<{
      result: "unsatisfied";
      satisfaction: 0;
      reason: "not_found" | "type_mismatch" | "byte_mismatch";
    }>
  | Readonly<{
      result: "unknown";
      satisfaction: null;
      reason: "no_listing" | "partial" | "unverified" | "stale" | "short";
    }>;

export type MultiSourceDecision = Readonly<{
  kind: "ranked" | "defer";
  chosen: "source:0" | "source:1" | null;
  missingKeys: readonly string[];
} | null>;

export type MultiSourceSourceProjection = Readonly<{
  sourceId: "source:0" | "source:1";
  attempt:
    | "not_attempted"
    | "in_progress"
    | "matched"
    | "definitive_negative"
    | "unknown";
  negative: "not_found" | "type_mismatch" | "byte_mismatch" | null;
}>;

export type MultiSourceFact = Readonly<{
  sourceId: "source:0" | "source:1";
  sourceIndex: 0 | 1;
  coverage: "complete" | "partial" | null;
  candidate: ReadCompositionCandidate | null;
  attempted: boolean;
  attempt:
    | "not_attempted"
    | "in_progress"
    | "matched"
    | "definitive_negative"
    | "unknown";
  negative: "not_found" | "type_mismatch" | "byte_mismatch" | null;
  unknownReason: "partial" | "short" | "stale" | "unverified" | "in_progress" | null;
}>;

export function classifyMultiSources(
  state: ReadCompositionState,
  name: string,
  expectedBytes: Uint8Array,
  range: Readonly<{ offset: number; length: number }>,
): readonly MultiSourceFact[] {
  if (state.sources === null) {
    return Object.freeze([
      multiSourceFact("source:0", 0, null, null, false, "not_attempted", null, null),
      multiSourceFact("source:1", 1, null, null, false, "not_attempted", null, null),
    ]);
  }
  return Object.freeze(
    state.sources.map((source, index) =>
      classifyMultiSource(
        source,
        index as 0 | 1,
        name,
        expectedBytes,
        range,
      ),
    ),
  );
}

function multiSourceFact(
  sourceId: "source:0" | "source:1",
  sourceIndex: 0 | 1,
  coverage: "complete" | "partial" | null,
  candidate: ReadCompositionCandidate | null,
  attempted: boolean,
  attempt: MultiSourceFact["attempt"],
  negative: MultiSourceFact["negative"],
  unknownReason: MultiSourceFact["unknownReason"],
): MultiSourceFact {
  return Object.freeze({
    sourceId,
    sourceIndex,
    coverage,
    candidate,
    attempted,
    attempt,
    negative,
    unknownReason,
  });
}

function classifyMultiSource(
  source: ReadCompositionSourceState,
  sourceIndex: 0 | 1,
  name: string,
  expectedBytes: Uint8Array,
  range: Readonly<{ offset: number; length: number }>,
): MultiSourceFact {
  const listing = source.listing;
  const coverage = listing === null ? null : listing.coverage;
  const candidate = coverage === "complete" ? candidateFromListing(listing, name) : null;
  if (coverage === null) {
    return multiSourceFact(source.sourceId, sourceIndex, coverage, null, false, "not_attempted", null, null);
  }
  if (coverage === "partial") {
    return multiSourceFact(source.sourceId, sourceIndex, coverage, null, false, "unknown", null, "partial");
  }
  if (candidate === null) {
    return multiSourceFact(source.sourceId, sourceIndex, coverage, null, false, "definitive_negative", "not_found", null);
  }
  const inspected = source.inspected;
  if (inspected === null) {
    return multiSourceFact(source.sourceId, sourceIndex, coverage, candidate, false, "not_attempted", null, null);
  }
  if (inspected.type !== null && inspected.type !== "regular") {
    return multiSourceFact(source.sourceId, sourceIndex, coverage, candidate, true, "definitive_negative", "type_mismatch", null);
  }
  const ref = source.fileRef ?? source.read?.ref ?? null;
  if (
    inspected.type === null ||
    inspected.identity.dev === null ||
    inspected.identity.ino === null ||
    inspected.sourceRun === null ||
    inspected.sessionRevision === null ||
    ref === null ||
    !fileRefMatchesInspect(ref, inspected)
  ) {
    return multiSourceFact(source.sourceId, sourceIndex, coverage, candidate, true, "unknown", null, "unverified");
  }
  const read = source.read;
  if (read === null) {
    return multiSourceFact(source.sourceId, sourceIndex, coverage, candidate, true, "unknown", null, "in_progress");
  }
  if (
    read.sourceRun === null ||
    read.refSourceRun !== ref.sourceRun ||
    read.revision === null ||
    read.offset !== range.offset ||
    read.length !== range.length ||
    read.bytes === null ||
    read.bytesRead === null ||
    !sameOsInteger(read.identity.dev, ref.identity.dev) ||
    !sameOsInteger(read.identity.ino, ref.identity.ino)
  ) {
    return multiSourceFact(source.sourceId, sourceIndex, coverage, candidate, true, "unknown", null, "stale");
  }
  if (read.bytesRead < range.length || Buffer.from(read.bytes, "base64").length < range.length) {
    return multiSourceFact(source.sourceId, sourceIndex, coverage, candidate, true, "unknown", null, "short");
  }
  if (read.bytesRead > range.length || Buffer.from(read.bytes, "base64").length > range.length) {
    return multiSourceFact(source.sourceId, sourceIndex, coverage, candidate, true, "unknown", null, "stale");
  }
  let decoded: Uint8Array;
  try {
    decoded = Buffer.from(read.bytes, "base64");
  } catch {
    return multiSourceFact(source.sourceId, sourceIndex, coverage, candidate, true, "unknown", null, "stale");
  }
  if (decoded.length !== range.length) {
    return multiSourceFact(source.sourceId, sourceIndex, coverage, candidate, true, "unknown", null, "stale");
  }
  return bytesEqual(decoded, expectedBytes)
    ? multiSourceFact(source.sourceId, sourceIndex, coverage, candidate, true, "matched", null, null)
    : multiSourceFact(source.sourceId, sourceIndex, coverage, candidate, true, "definitive_negative", "byte_mismatch", null);
}

function candidateFromListing(
  listing: ReadCompositionState["listing"],
  name: string,
): ReadCompositionCandidate | null {
  if (listing === null || listing.coverage !== "complete") return null;
  const matches = listing.entries.filter(entry => entry.name === name);
  const single = matches.length === 1 ? matches[0] : undefined;
  return single === undefined
    ? null
    : Object.freeze({
        name: single.name,
        path: single.path,
        listedType: single.type,
        listingRun: listing.sourceRun,
      });
}

export type ReadListingFacts = Readonly<{
  coverage: "complete" | "partial" | null;
  sourceRun: string | null;
  errors: readonly string[];
  candidateNames: readonly string[];
  candidate: ReadCompositionCandidate | null;
}>;

export function readListingFacts(
  state: ReadCompositionState,
  name: string,
  transitions: readonly CliCommandTransition[],
): ReadListingFacts {
  const listing = state.listing;
  if (listing !== null) {
    const matches = listing.entries.filter(entry => entry.name === name);
    const single = matches.length === 1 ? matches[0] : undefined;
    const candidate =
      listing.coverage === "complete" && single !== undefined
        ? Object.freeze({
            name: single.name,
            path: single.path,
            listedType: single.type,
            listingRun: listing.sourceRun,
          })
        : null;
    return Object.freeze({
      coverage: listing.coverage,
      sourceRun: listing.sourceRun,
      errors: listing.errors,
      candidateNames: Object.freeze(matches.map(entry => entry.name)),
      candidate,
    });
  }
  const transition = listingTransition(transitions);
  if (transition === null) {
    return Object.freeze({
      coverage: null,
      sourceRun: null,
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
      errors: Object.freeze([]),
      candidateNames: Object.freeze([]),
      candidate: null,
    });
  }
  const integrity = listingIntegrityErrors(observation.entries, observation.physicalDirectory);
  const coverage = integrity.length === 0 ? observation.coverage : "partial";
  const found = integrity.length === 0 ? findExactEntry(observation.entries, name) : null;
  const sourceRun = transition.execution_result.receipt?.execution.runId ?? null;
  const candidate = found === null
    ? null
    : Object.freeze({
        name: found.name,
        path: found.path,
        listedType: found.listedType,
        listingRun: sourceRun,
      });
  return Object.freeze({
    coverage,
    sourceRun,
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

export function decideReadRoot(
  state: ReadCompositionState,
  name: string,
  expectedBytes: Uint8Array,
  range: Readonly<{ offset: number; length: number }>,
  transitions: readonly CliCommandTransition[],
): ReadRootDecision {
  const listing = readListingFacts(state, name, transitions);
  if (listing.coverage === null) {
    return Object.freeze({ result: "unknown", satisfaction: null, reason: "no_listing" });
  }
  if (listing.coverage === "partial") {
    return Object.freeze({ result: "unknown", satisfaction: null, reason: "partial" });
  }
  if (listing.candidate === null) {
    return Object.freeze({ result: "unsatisfied", satisfaction: 0, reason: "not_found" });
  }
  if (state.inspected === null) {
    return Object.freeze({ result: "unknown", satisfaction: null, reason: "unverified" });
  }
  const inspected = state.inspected;
  if (
    inspected.type === null ||
    inspected.identity.dev === null ||
    inspected.identity.ino === null ||
    inspected.sourceRun === null ||
    inspected.sessionRevision === null
  ) {
    return Object.freeze({ result: "unknown", satisfaction: null, reason: "unverified" });
  }
  if (inspected.type !== "regular") {
    return Object.freeze({ result: "unsatisfied", satisfaction: 0, reason: "type_mismatch" });
  }
  const ref = state.fileRef ?? state.read?.ref ?? null;
  if (ref === null) {
    return Object.freeze({ result: "unknown", satisfaction: null, reason: "unverified" });
  }
  if (!fileRefMatchesInspect(ref, inspected)) {
    return Object.freeze({ result: "unknown", satisfaction: null, reason: "unverified" });
  }
  if (state.read === null) {
    return Object.freeze({ result: "unknown", satisfaction: null, reason: "unverified" });
  }
  const read = state.read;
  if (
    read.sourceRun === null ||
    read.refSourceRun === null ||
    read.revision === null ||
    read.offset !== range.offset ||
    read.length !== range.length ||
    read.bytes === null ||
    read.bytesRead === null ||
    !sameOsInteger(read.identity.dev, ref.identity.dev) ||
    !sameOsInteger(read.identity.ino, ref.identity.ino) ||
    read.refSourceRun !== ref.sourceRun
  ) {
    return Object.freeze({ result: "unknown", satisfaction: null, reason: "stale" });
  }
  if (read.bytesRead < range.length) {
    return Object.freeze({ result: "unknown", satisfaction: null, reason: "short" });
  }
  if (read.bytesRead > range.length) {
    return Object.freeze({ result: "unknown", satisfaction: null, reason: "stale" });
  }
  let decoded: Uint8Array;
  try {
    decoded = Buffer.from(read.bytes, "base64");
  } catch {
    return Object.freeze({ result: "unknown", satisfaction: null, reason: "stale" });
  }
  if (decoded.length < range.length) {
    return Object.freeze({ result: "unknown", satisfaction: null, reason: "short" });
  }
  if (decoded.length > range.length) {
    return Object.freeze({ result: "unknown", satisfaction: null, reason: "stale" });
  }
  return bytesEqual(decoded, expectedBytes)
    ? Object.freeze({ result: "satisfied", satisfaction: 100 })
    : Object.freeze({ result: "unsatisfied", satisfaction: 0, reason: "byte_mismatch" });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameOsInteger(left: number | string | null, right: number | string | null): boolean {
  if (left === null || right === null) return false;
  try {
    return BigInt(left) === BigInt(right);
  } catch {
    return false;
  }
}

function fileRefMatchesInspect(ref: ReadCompositionFileRef, inspected: ReadCompositionInspectedFact): boolean {
  return ref.type === "regular"
    && inspected.type === "regular"
    && ref.absolutePath === inspected.absolutePath
    && sameOsInteger(ref.identity.dev, inspected.identity.dev)
    && sameOsInteger(ref.identity.ino, inspected.identity.ino)
    && ref.sessionRevision === inspected.sessionRevision;
}

export function readRootFact(
  request: ReadCompositionRequest,
  state: ReadCompositionState,
  transitions: readonly CliCommandTransition[],
  primaryCode: string | null,
): ReadCompositionRootFact {
  const name = request.goal.target.name;
  const listing = readListingFacts(state, name, transitions);
  const listingFact: ReadCompositionListingFact = Object.freeze({
    sourceRun: listing.sourceRun,
    coverage: listing.coverage,
    directoryRef: state.listing === null ? null : state.listing.directoryRef,
    errors: listing.errors,
    candidateNames: listing.candidateNames,
    entries: state.listing === null ? Object.freeze([]) : state.listing.entries,
  });
  if (listing.coverage === "partial") {
    return Object.freeze({
      kind: "insufficient_evidence",
      listing: listingFact,
      inspected: state.inspected,
      fileRef: state.fileRef,
      read: state.read,
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
      listing: listingFact,
      inspected: state.inspected,
      fileRef: state.fileRef,
      read: state.read,
    });
  }
  if (listing.candidate === null) {
    return Object.freeze({ kind: "not_found", listing: listingFact });
  }
  const inspected = state.inspected;
  if (inspected === null) {
    return Object.freeze({
      kind: "stale_or_unverified",
      listing: listingFact,
      inspected,
      fileRef: state.fileRef,
      read: state.read,
    });
  }
  if (
    inspected.type !== null &&
    inspected.type !== "regular"
  ) {
    return Object.freeze({
      kind: "type_mismatch",
      listing: listingFact,
      inspected,
      fileRef: state.fileRef,
    });
  }
  if (
    inspected.type === null ||
    inspected.identity.dev === null ||
    inspected.identity.ino === null ||
    inspected.sourceRun === null ||
    inspected.sessionRevision === null
  ) {
    return Object.freeze({
      kind: "stale_or_unverified",
      listing: listingFact,
      inspected,
      fileRef: state.fileRef,
      read: state.read,
    });
  }
  const fileRef = state.fileRef ?? state.read?.ref ?? null;
  if (fileRef === null || !fileRefMatchesInspect(fileRef, inspected)) {
    return Object.freeze({
      kind: "stale_or_unverified",
      listing: listingFact,
      inspected,
      fileRef,
      read: state.read,
    });
  }
  const read = state.read;
  if (read === null) {
    return Object.freeze({
      kind: "stale_or_unverified",
      listing: listingFact,
      inspected,
      fileRef,
      read: null,
    });
  }
  if (
    read.sourceRun === null || read.refSourceRun !== fileRef.sourceRun
    || read.revision === null || read.offset !== request.goal.requirement.range.offset
    || read.length !== request.goal.requirement.range.length
    || read.bytes === null || read.bytesRead === null
    || !sameOsInteger(read.identity.dev, fileRef.identity.dev)
    || !sameOsInteger(read.identity.ino, fileRef.identity.ino)
  ) {
    return Object.freeze({
      kind: "stale_or_unverified",
      listing: listingFact,
      inspected,
      fileRef,
      read,
    });
  }
  if (read.bytesRead < request.goal.requirement.range.length) {
    return Object.freeze({
      kind: "insufficient_evidence",
      listing: listingFact,
      inspected,
      fileRef,
      read,
    });
  }
  if (read.bytesRead > request.goal.requirement.range.length) {
    return Object.freeze({
      kind: "stale_or_unverified",
      listing: listingFact,
      inspected,
      fileRef,
      read,
    });
  }
  let decoded: Uint8Array;
  try {
    decoded = Buffer.from(read.bytes, "base64");
  } catch {
    return Object.freeze({
      kind: "stale_or_unverified",
      listing: listingFact,
      inspected,
      fileRef,
      read,
    });
  }
  if (decoded.length < request.goal.requirement.range.length) {
    return Object.freeze({
      kind: "insufficient_evidence",
      listing: listingFact,
      inspected,
      fileRef,
      read,
    });
  }
  if (decoded.length > request.goal.requirement.range.length) {
    return Object.freeze({
      kind: "stale_or_unverified",
      listing: listingFact,
      inspected,
      fileRef,
      read,
    });
  }
  const expected = request.goal.requirement.expectedBase64;
  let expectedBytes: Uint8Array;
  try {
    expectedBytes = Buffer.from(expected, "base64");
  } catch {
    return Object.freeze({ kind: "rejected" });
  }
  return bytesEqual(decoded, expectedBytes)
    ? Object.freeze({
        kind: "matched",
        listing: listingFact,
        inspected,
        fileRef,
        read,
      })
    : Object.freeze({
        kind: "byte_mismatch",
        listing: listingFact,
        inspected,
        fileRef,
        read,
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

function listingObservation(transition: CliCommandTransition): Readonly<{
  entries: readonly { name: string; path: string; type: string }[];
  physicalDirectory: string;
  coverage: "complete" | "partial";
  errors: readonly { name: string; code: string; message: string }[];
}> | null {
  const receipt = transition.execution_result.receipt;
  if (receipt?.execution.status !== "succeeded") return null;
  const observation = receipt.execution.observation;
  return observation.kind === "directory.list"
    ? observation
    : null;
}

function transitionView(value: unknown): {
  kind: string | null;
  requestId: string | null;
  report: ReportView | null;
  error: Readonly<{ code: string }> | null;
  fault: Readonly<{ code: string }> | null;
} {
  const input = value as { kind?: unknown; requestId?: unknown; report?: unknown; error?: unknown; fault?: unknown };
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

type ReportView = Readonly<{
  rootEvaluation: Readonly<{
    state: string;
    result: string | undefined;
    satisfaction: number | null | undefined;
  }> | null;
  control: Readonly<{ outcome: string; stopReason: string }> | null;
  primaryErrorId: string | null;
  errors: readonly Readonly<{ errorId: string; code: string; nativeCode: string | null }>[];
  states: readonly Readonly<{ value: ReadCompositionState }>[];
  atomicResults: readonly Readonly<{ sourceResult: unknown }>[];
  frames: unknown;
  effects: unknown;
  budgetUsed: unknown;
}>;

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
          const error = item as {
            errorId?: unknown;
            code?: unknown;
            nativeCode?: unknown;
            source?: { nativeCode?: unknown };
          };
          const nativeCode =
            error.source?.nativeCode ?? error.nativeCode;
          return Object.freeze({
            errorId: String(error.errorId ?? ""),
            code: String(error.code ?? "unknown"),
            nativeCode: nativeCode === null || nativeCode === undefined
              ? null
              : String(nativeCode),
          });
        }))
      : Object.freeze([]),
    states: Array.isArray(states)
      ? Object.freeze(states.map(item => Object.freeze({ value: (item as { value: ReadCompositionState }).value })))
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

function latestState(report: ReportView): ReadCompositionState | null {
  const last = report.states[report.states.length - 1];
  return last === undefined ? null : last.value;
}

function primaryError(view: ReturnType<typeof transitionView>): string | null {
  if (view.error !== null) return view.error.code;
  if (view.fault !== null) return view.fault.code;
  const report = view.report;
  if (report === null || report.primaryErrorId === null) return null;
  const error = report.errors.find(item => item.errorId === report.primaryErrorId);
  return error === undefined ? null : error.code;
}

function nativeErrors(view: ReturnType<typeof transitionView>): readonly string[] {
  if (view.report === null) {
    if (view.error !== null) return Object.freeze([view.error.code]);
    if (view.fault !== null) return Object.freeze([view.fault.code]);
    return Object.freeze([]);
  }
  return Object.freeze(
    view.report.errors
      .map(error => error.nativeCode)
      .filter((code): code is string => code !== null && code.length > 0),
  );
}

function noStateStatus(primaryCode: string | null): Readonly<{
  status: ReadCompositionDomainProjection["status"];
  resolution: ReadCompositionDomainProjection["resolution"];
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

function noStateRootFact(primaryCode: string | null): ReadCompositionRootFact {
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

function preserve(view: ReturnType<typeof transitionView>): ReadCompositionDomainProjection["preserve"] {
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

function preserveFromReport(report: ReportView | null): ReadCompositionDomainProjection["preserve"] {
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

function rootEvaluationCompleted(report: ReportView | null): boolean {
  return report !== null
    && report.rootEvaluation !== null
    && report.rootEvaluation.state === "evaluated";
}

function readAtomicNativeError(report: ReportView | null, nativeCode: string): boolean {
  if (report === null) return false;
  for (const result of report.atomicResults) {
    const source = result.sourceResult as { tag?: unknown; value?: unknown } | null;
    if (source === null || typeof source !== "object" || source.tag !== "cli.file.read.receipt.v1") {
      continue;
    }
    const receipt = (source.value as { receipt?: unknown } | null)?.receipt;
    if (typeof receipt !== "object" || receipt === null) continue;
    const execution = (receipt as { execution?: unknown }).execution;
    if (typeof execution !== "object" || execution === null) continue;
    if ((execution as { status?: unknown }).status !== "failed") continue;
    const error = (execution as { error?: unknown }).error;
    if (
      typeof error === "object"
      && error !== null
      && (error as { code?: unknown }).code === nativeCode
    ) {
      return true;
    }
  }
  return false;
}

export function projectReadDomain(
  request: ReadCompositionRequest,
  response: unknown,
): ReadCompositionDomainProjection {
  if (request.goal.target.kind === "cli.exact-child-sources") {
    return projectMultiReadDomain(request, response);
  }
  const view = transitionView(response);
  const report = view.report;
  const transitions = report === null ? [] : transitionsOf(report);
  const state = report === null ? null : latestState(report);
  const primaryCode = primaryError(view);
  const name = request.goal.target.name;
  const range = request.goal.requirement.range;

  if (state === null) {
    const status = noStateStatus(primaryCode);
    return Object.freeze({
      status: status.status,
      resolution: status.resolution,
      satisfaction: null,
      match: null,
      coverage: null,
      sources: Object.freeze([]),
      decision: null,
      rootFact: noStateRootFact(primaryCode),
      preserve: preserve(view),
    });
  }

  const listing = readListingFacts(state, name, transitions);
  const decision = decideReadRoot(state, name, Buffer.from(request.goal.requirement.expectedBase64, "base64"), range, transitions);
  const coverage = listing.coverage;
  const completed = rootEvaluationCompleted(report);
  const rootResult = completed ? report?.rootEvaluation?.result ?? null : null;
  if (decision.result === "satisfied" && rootResult === "satisfied") {
    return achieved(request, state, transitions, report);
  }
  if (decision.result === "unsatisfied" && rootResult === "unsatisfied") {
    return Object.freeze({
      status: "unmet",
      resolution:
        decision.reason === "type_mismatch"
          ? "type_mismatch"
          : decision.reason === "byte_mismatch"
            ? "byte_mismatch"
            : "not_found",
      satisfaction: 0,
      match: null,
      coverage,
      sources: Object.freeze([]),
      decision: null,
      rootFact: readRootFact(request, state, transitions, primaryCode),
      preserve: preserve(view),
    });
  }

  if (coverage === "partial") {
    return Object.freeze({
      status: "unknown",
      resolution: "insufficient_evidence",
      satisfaction: null,
      match: null,
      coverage,
      sources: Object.freeze([]),
      decision: null,
      rootFact: readRootFact(request, state, transitions, primaryCode),
      preserve: preserve(view),
    });
  }

  const read = state.read;
  const staleRead =
    readAtomicNativeError(report, "STALE_REFERENCE")
    || (read !== null && nativeErrors(view).includes("STALE_REFERENCE"));
  if (staleRead) {
    return Object.freeze({
      status: "unknown",
      resolution: "stale_or_unverified",
      satisfaction: null,
      match: null,
      coverage,
      sources: Object.freeze([]),
      decision: null,
      rootFact: readRootFact(request, state, transitions, primaryCode),
      preserve: preserve(view),
    });
  }
  if (read !== null && read.bytesRead !== null && read.bytesRead < (read.length ?? 0)) {
    return Object.freeze({
      status: "unknown",
      resolution: "insufficient_evidence",
      satisfaction: null,
      match: null,
      coverage,
      sources: Object.freeze([]),
      decision: null,
      rootFact: readRootFact(request, state, transitions, primaryCode),
      preserve: preserve(view),
    });
  }
  if (
    primaryCode === "budget_exceeded"
    || primaryCode === "cancelled"
    || primaryCode === "no_progress"
    || primaryCode === "stalled"
  ) {
    return Object.freeze({
      status: "unknown",
      resolution: "interrupted",
      satisfaction: null,
      match: null,
      coverage,
      sources: Object.freeze([]),
      decision: null,
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
      coverage,
      sources: Object.freeze([]),
      decision: null,
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
      coverage,
      sources: Object.freeze([]),
      decision: null,
      rootFact: Object.freeze({ kind: "failed" }),
      preserve: preserve(view),
    });
  }

  const fact = readRootFact(request, state, transitions, primaryCode);
  const resolution =
    fact.kind === "stale_or_unverified"
      ? "stale_or_unverified"
      : "insufficient_evidence";
  return Object.freeze({
    status: "unknown",
    resolution,
    satisfaction: null,
    match: null,
    coverage,
    sources: Object.freeze([]),
    decision: null,
    rootFact: fact,
    preserve: preserve(view),
  });
}

function achieved(
  request: ReadCompositionRequest,
  state: ReadCompositionState,
  transitions: readonly CliCommandTransition[],
  report: ReportView | null,
): ReadCompositionDomainProjection {
  const fact = readRootFact(request, state, transitions, null);
  if (fact.kind !== "matched") {
    return Object.freeze({
      status: "unknown",
      resolution: "stale_or_unverified",
      satisfaction: null,
      match: null,
      coverage: "complete",
      sources: Object.freeze([]),
      decision: null,
      rootFact: fact,
      preserve: preserveFromReport(report),
    });
  }
  return Object.freeze({
    status: "achieved",
    resolution: "matched",
    satisfaction: 100,
    match: fact.fileRef,
    coverage: "complete",
    sources: Object.freeze([]),
    decision: null,
    rootFact: fact,
    preserve: preserveFromReport(report),
  });
}

function multiDecisionFromReport(
  report: ReportView | null,
): ReadCompositionDomainProjection["decision"] {
  if (report === null || !Array.isArray(report.frames)) return null;
  const frames = report.frames as unknown[];
  for (const raw of frames) {
    if (typeof raw !== "object" || raw === null) continue;
    const frame = raw as Record<string, unknown>;
    if (frame.parentFrameId !== null && frame.parentFrameId !== undefined) continue;
    const cursor = frame.cursor;
    if (typeof cursor !== "object" || cursor === null) continue;
    const decision = (cursor as Record<string, unknown>).decision;
    if (typeof decision !== "object" || decision === null) continue;
    const record = decision as Record<string, unknown>;
    if (record.kind !== "ranked" && record.kind !== "defer") continue;
    return Object.freeze({
      kind: record.kind,
      chosen:
        record.chosen === "source:0" || record.chosen === "source:1"
          ? record.chosen
          : null,
      missingKeys: Object.freeze(
        Array.isArray(record.missingKeys)
          ? record.missingKeys.filter(key => typeof key === "string")
          : Object.freeze([]),
      ),
    });
  }
  return null;
}

function multiCoverage(state: ReadCompositionState): "complete" | "partial" | null {
  if (state.sources === null) return null;
  const listings = state.sources.map(source => source.listing);
  if (listings.every(listing => listing !== null && listing.coverage === "complete")) {
    return "complete";
  }
  if (listings.some(listing => listing !== null && listing.coverage === "partial")) {
    return "partial";
  }
  return null;
}

function multiMatchedSource(
  state: ReadCompositionState,
  facts: readonly MultiSourceFact[],
): ReadCompositionSourceState | null {
  if (state.sources === null) return null;
  const fact = facts.find(item => item.attempt === "matched");
  if (fact === undefined) return null;
  return state.sources.find(source => source.sourceId === fact.sourceId) ?? null;
}

function multiNegativePriority(
  facts: readonly MultiSourceFact[],
): "byte_mismatch" | "type_mismatch" | "not_found" {
  if (facts.some(fact => fact.negative === "byte_mismatch")) return "byte_mismatch";
  if (facts.some(fact => fact.negative === "type_mismatch")) return "type_mismatch";
  return "not_found";
}

function multiNegativeSource(
  state: ReadCompositionState,
  facts: readonly MultiSourceFact[],
  priority: "byte_mismatch" | "type_mismatch" | "not_found",
): ReadCompositionSourceState | null {
  if (state.sources === null) return null;
  const fact = facts.find(item => item.negative === priority);
  if (fact === undefined) return null;
  return state.sources.find(source => source.sourceId === fact.sourceId) ?? null;
}

function multiRejected(view: ReturnType<typeof transitionView>): boolean {
  const frames = view.report?.frames;
  if (!Array.isArray(frames)) return false;
  return frames.some(frame => {
    if (typeof frame !== "object" || frame === null) return false;
    const cursor = (frame as { cursor?: unknown }).cursor;
    return typeof cursor === "object"
      && cursor !== null
      && (cursor as { phase?: unknown }).phase === "rejected";
  });
}

function multiRootFact(
  source: ReadCompositionSourceState | null,
  kind: "matched" | "not_found" | "type_mismatch" | "byte_mismatch" | "stale_or_unverified" | "insufficient_evidence",
): ReadCompositionRootFact {
  if (source === null) {
    if (kind === "not_found") {
      return Object.freeze({
        kind: "not_found",
        listing: Object.freeze({
          sourceRun: null,
          coverage: "complete",
          directoryRef: null,
          errors: Object.freeze([]),
          candidateNames: Object.freeze([]),
          entries: Object.freeze([]),
        }),
      });
    }
    return Object.freeze({
      kind: "insufficient_evidence",
      listing: Object.freeze({
        sourceRun: null,
        coverage: null,
        directoryRef: null,
        errors: Object.freeze([]),
        candidateNames: Object.freeze([]),
        entries: Object.freeze([]),
      }),
      inspected: null,
      fileRef: null,
      read: null,
    });
  }
  const listing = source.listing ?? Object.freeze({
    sourceRun: null,
    coverage: null,
    directoryRef: null,
    errors: Object.freeze([]),
    candidateNames: Object.freeze([]),
    entries: Object.freeze([]),
  });
  if (kind === "matched" && source.inspected !== null && source.fileRef !== null && source.read !== null) {
    return Object.freeze({
      kind: "matched",
      listing,
      inspected: source.inspected,
      fileRef: source.fileRef,
      read: source.read,
    });
  }
  if (kind === "not_found") {
    return Object.freeze({ kind: "not_found", listing });
  }
  if (kind === "type_mismatch" && source.inspected !== null) {
    return Object.freeze({
      kind: "type_mismatch",
      listing,
      inspected: source.inspected,
      fileRef: source.fileRef,
    });
  }
  if (kind === "byte_mismatch" && source.inspected !== null && source.fileRef !== null && source.read !== null) {
    return Object.freeze({
      kind: "byte_mismatch",
      listing,
      inspected: source.inspected,
      fileRef: source.fileRef,
      read: source.read,
    });
  }
  if (kind === "stale_or_unverified") {
    return Object.freeze({
      kind: "stale_or_unverified",
      listing,
      inspected: source.inspected,
      fileRef: source.fileRef,
      read: source.read,
    });
  }
  return Object.freeze({
    kind: "insufficient_evidence",
    listing,
    inspected: source.inspected,
    fileRef: source.fileRef,
    read: source.read,
  });
}

function projectMultiReadDomain(
  request: ReadCompositionRequest,
  response: unknown,
): ReadCompositionDomainProjection {
  const view = transitionView(response);
  const report = view.report;
  const state = report === null ? null : latestState(report);
  const primaryCode = primaryError(view);

  if (state === null) {
    const status = noStateStatus(primaryCode);
    return Object.freeze({
      status: status.status,
      resolution: status.resolution,
      satisfaction: null,
      match: null,
      coverage: null,
      sources: Object.freeze([]),
      decision: null,
      rootFact: noStateRootFact(primaryCode),
      preserve: preserve(view),
    });
  }
  if (state.sources === null) {
    return Object.freeze({
      status: "unknown",
      resolution: "insufficient_evidence",
      satisfaction: null,
      match: null,
      coverage: null,
      sources: Object.freeze([]),
      decision: null,
      rootFact: multiRootFact(null, "insufficient_evidence"),
      preserve: preserve(view),
    });
  }

  const facts = classifyMultiSources(
    state,
    request.goal.target.name,
    Buffer.from(request.goal.requirement.expectedBase64, "base64"),
    request.goal.requirement.range,
  );
  const coverage = multiCoverage(state);
  const decision = multiDecisionFromReport(report);
  const completed = rootEvaluationCompleted(report);
  const rootResult = completed ? report?.rootEvaluation?.result ?? null : null;
  const sources = Object.freeze(
    facts.map(fact => Object.freeze({
      sourceId: fact.sourceId,
      attempt: fact.attempt,
      negative: fact.negative,
    })),
  );

  const matchedSource = multiMatchedSource(state, facts);
  if (matchedSource !== null && rootResult === "satisfied") {
    return Object.freeze({
      status: "achieved",
      resolution: "matched",
      satisfaction: 100,
      match: matchedSource.fileRef,
      coverage: "complete",
      sources,
      decision,
      rootFact: multiRootFact(matchedSource, "matched"),
      preserve: preserveFromReport(report),
    });
  }

  if (multiRejected(view)) {
    return Object.freeze({
      status: "rejected",
      resolution: "rejected",
      satisfaction: null,
      match: null,
      coverage,
      sources,
      decision,
      rootFact: Object.freeze({ kind: "rejected" }),
      preserve: preserve(view),
    });
  }

  const hasUnknown =
    facts.some(fact => fact.attempt === "unknown" || fact.attempt === "in_progress" || fact.attempt === "not_attempted")
    || decision?.kind === "defer";
  if (
    completed === true
    && rootResult === "unsatisfied"
    && !hasUnknown
    && facts.some(fact => fact.negative !== null)
    && facts.every(fact => fact.negative !== null)
  ) {
    const priority = multiNegativePriority(facts);
    return Object.freeze({
      status: "unmet",
      resolution: priority,
      satisfaction: 0,
      match: null,
      coverage,
      sources,
      decision,
      rootFact: multiRootFact(multiNegativeSource(state, facts, priority), priority),
      preserve: preserve(view),
    });
  }

  const staleRead =
    readAtomicNativeError(report, "READ_TARGET_CHANGED")
    || readAtomicNativeError(report, "STALE_REFERENCE")
    || nativeErrors(view).includes("READ_TARGET_CHANGED")
    || nativeErrors(view).includes("STALE_REFERENCE");
  if (staleRead) {
    const unknown = state.sources.find(source => {
      const fact = facts.find(item => item.sourceId === source.sourceId);
      return fact !== undefined && (fact.attempt === "unknown" || fact.attempt === "in_progress");
    });
    return Object.freeze({
      status: "unknown",
      resolution: "stale_or_unverified",
      satisfaction: null,
      match: null,
      coverage,
      sources,
      decision,
      rootFact: multiRootFact(unknown ?? null, "stale_or_unverified"),
      preserve: preserve(view),
    });
  }

  if (
    primaryCode === "budget_exceeded"
    || primaryCode === "cancelled"
    || primaryCode === "no_progress"
    || primaryCode === "stalled"
  ) {
    return Object.freeze({
      status: "unknown",
      resolution: "interrupted",
      satisfaction: null,
      match: null,
      coverage,
      sources,
      decision,
      rootFact: Object.freeze({ kind: "interrupted" }),
      preserve: preserve(view),
    });
  }
  if (
    primaryCode === "effect_denied"
    || primaryCode === "capability_missing"
    || primaryCode === "invalid_binding"
    || primaryCode === "invalid_request"
  ) {
    return Object.freeze({
      status: "rejected",
      resolution: "rejected",
      satisfaction: null,
      match: null,
      coverage,
      sources,
      decision,
      rootFact: Object.freeze({ kind: "rejected" }),
      preserve: preserve(view),
    });
  }
  if (
    primaryCode === "execution_failed"
    || primaryCode === "policy_error"
    || nativeErrors(view).includes("EACCES")
  ) {
    return Object.freeze({
      status: "failed",
      resolution: "failed",
      satisfaction: null,
      match: null,
      coverage,
      sources,
      decision,
      rootFact: Object.freeze({ kind: "failed" }),
      preserve: preserve(view),
    });
  }

  const unknownSource = facts.find(fact => fact.attempt === "unknown" || fact.attempt === "in_progress")
    ? state.sources.find(source => {
        const fact = facts.find(item => item.sourceId === source.sourceId);
        return fact !== undefined && (fact.attempt === "unknown" || fact.attempt === "in_progress");
      })
    : null;
  const stale =
    unknownSource !== null
    && facts.some(fact => fact.unknownReason === "stale" || fact.unknownReason === "unverified");
  const resolution = stale ? "stale_or_unverified" : "insufficient_evidence";
  return Object.freeze({
    status: "unknown",
    resolution,
    satisfaction: null,
    match: null,
    coverage,
    sources,
    decision,
    rootFact: multiRootFact(unknownSource ?? null, resolution === "stale_or_unverified" ? "stale_or_unverified" : "insufficient_evidence"),
    preserve: preserve(view),
  });
}

export function issuedRefMatchesInspect(
  ref: ObservedObjectRef,
  inspected: ReadCompositionInspectedFact,
): boolean {
  return ref.kind === "cli.file"
    && ref.type === "regular"
    && inspected.type === "regular"
    && ref.absolutePath === inspected.absolutePath
    && sameOsInteger(ref.identity.dev, inspected.identity.dev)
    && sameOsInteger(ref.identity.ino, inspected.identity.ino)
    && ref.sessionRevision === inspected.sessionRevision;
}
