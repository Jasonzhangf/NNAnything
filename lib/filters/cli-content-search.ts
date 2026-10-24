import type {
  ContentSearchCandidateFact,
  ContentSearchDomainProjection,
  ContentSearchHitFact,
  ContentSearchListingFact,
  ContentSearchNegativeFact,
  ContentSearchOrder,
  ContentSearchRootFact,
  ContentSearchState,
} from "../adapters/cli/content-search-contract.js";
import type { EntryKind } from "../adapters/cli/entry-inspection.js";
import type { CliCommandTransition } from "../nodes/cli-command.js";

export type ContentSearchRootDecision =
  | Readonly<{ result: "satisfied"; satisfaction: 100 }>
  | Readonly<{ result: "unsatisfied"; satisfaction: 0 }>
  | Readonly<{ result: "unknown"; satisfaction: null }>;

export function byteIndexOf(bytes: Buffer, needle: Buffer): number {
  return bytes.indexOf(needle);
}

export function contains(
  bytes: Buffer,
  needle: Buffer,
): Readonly<{ found: boolean; start: number; end: number }> {
  const start = byteIndexOf(bytes, needle);
  if (start === -1) return Object.freeze({ found: false, start: -1, end: -1 });
  return Object.freeze({ found: true, start, end: start + needle.length });
}

export function lineColumn(
  bytes: Buffer,
  start: number,
): Readonly<{ line: number; column: number }> {
  let line = 1;
  for (let index = 0; index < start; index += 1) {
    if (bytes[index] === 0x0a) line += 1;
  }
  const lineStart = bytes.lastIndexOf(0x0a, Math.max(0, start - 1)) + 1;
  return Object.freeze({ line, column: start - lineStart + 1 });
}

export function candidateNameSatisfies(
  name: string,
  fileCondition: Readonly<{ type: "regular"; name?: string; suffix?: string }> | null,
): boolean {
  if (fileCondition === null) return true;
  if (fileCondition.name !== undefined) return name === fileCondition.name;
  if (fileCondition.suffix !== undefined) return name.endsWith(fileCondition.suffix);
  return true;
}

export type ContentSearchCandidateOrder = Readonly<{
  name: string;
  path: string;
  listedType: ContentSearchCandidateFact["listedType"];
}>;

function orderedCandidates(
  entries: readonly Readonly<{ name: string; path: string; type: string }>[],
  fileCondition: Readonly<{ type: "regular"; name?: string; suffix?: string }> | null,
  order: ContentSearchOrder,
): readonly ContentSearchCandidateOrder[] {
  const eligible = entries
    .filter(entry => entry.type === "file")
    .filter(entry => candidateNameSatisfies(entry.name, fileCondition))
    .map(entry => Object.freeze({
      name: entry.name,
      path: entry.path,
      listedType: "file" as const,
    }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  if (order.kind !== "injected-first") return Object.freeze(eligible);
  return Object.freeze([
    ...eligible.filter(entry => entry.name === order.name),
    ...eligible.filter(entry => entry.name !== order.name),
  ]);
}

export function initialCandidates(
  listing: ContentSearchListingFact | null,
  fileCondition: Readonly<{ type: "regular"; name?: string; suffix?: string }> | null,
  order: ContentSearchOrder,
): readonly ContentSearchCandidateFact[] {
  if (listing === null) return Object.freeze([]);
  return Object.freeze(orderedCandidates(listing.entries, fileCondition, order).map(entry =>
    Object.freeze({
      name: entry.name,
      path: entry.path,
      listedType: entry.listedType,
      inspected: null,
      fileRef: null,
      read: null,
      contains: null,
      outcome: "pending" as const,
      byteSpan: null,
      line: null,
      column: null,
      reason: null,
      failureCode: null,
      duplicateRead: false,
    }),
  ));
}

export function listingFactFromTransition(
  transition: CliCommandTransition,
): ContentSearchListingFact | null {
  const receipt = transition.execution_result.receipt;
  if (receipt === null || receipt.execution.status !== "succeeded") return null;
  const observation = receipt.execution.observation;
  if (observation.kind !== "directory.list") return null;
  return Object.freeze({
    sourceRun: receipt.execution.runId,
    physicalDirectory: observation.physicalDirectory,
    coverage: observation.coverage,
    errors: Object.freeze(observation.errors.map(error => `${error.name}:${error.code}:${error.message}`)),
    entries: Object.freeze(observation.entries.map(entry => Object.freeze({
      name: entry.name,
      path: entry.path,
      type: entry.type as ContentSearchListingFact["entries"][number]["type"],
    }))),
  });
}

export type ContentSearchInspectedTransition = Readonly<{
  absolutePath: string;
  type: EntryKind | null;
  size: number | null;
  identity: Readonly<{ dev: number | string | null; ino: number | string | null }>;
  sessionRevision: number;
  errno: string | null;
}>;

export function inspectedFactFromTransition(
  transition: CliCommandTransition,
): ContentSearchInspectedTransition | null {
  const receipt = transition.execution_result.receipt;
  if (receipt === null || receipt.execution.status !== "succeeded") return null;
  const observation = receipt.execution.observation;
  if (observation.kind !== "entry.inspect") return null;
  const snapshot = observation.snapshot;
  return Object.freeze({
    absolutePath: observation.configuredPath,
    type: snapshot.kind,
    size: snapshot.size === null ? null : Number(snapshot.size),
    identity: Object.freeze({ dev: snapshot.dev, ino: snapshot.ino }),
    sessionRevision: transition.session_before.revision,
    errno: snapshot.errno,
  });
}

export function isStaleReadCode(code: string): boolean {
  return code === "STALE_REFERENCE" || code === "READ_TARGET_CHANGED" || code === "ENOENT";
}

function negativeOf(candidate: ContentSearchCandidateFact, needle: string): ContentSearchNegativeFact | null {
  if (candidate.outcome !== "negative" || candidate.read === null || candidate.fileRef === null) return null;
  return Object.freeze({
    path: candidate.path,
    fileRef: candidate.fileRef,
    needle,
    offset: candidate.read.offset,
    length: candidate.read.length,
    size: candidate.read.size,
    sessionRevision: candidate.fileRef.sessionRevision,
    observedAtSourceRun: candidate.read.sourceRun,
    reason: "complete_read_no_match" as const,
  });
}

function hitOf(candidate: ContentSearchCandidateFact, needle: string): ContentSearchHitFact | null {
  if (candidate.outcome !== "matched" || candidate.read === null || candidate.fileRef === null ||
    candidate.byteSpan === null || candidate.line === null || candidate.column === null) return null;
  return Object.freeze({
    fileRef: candidate.fileRef,
    path: candidate.path,
    needle,
    byteSpan: candidate.byteSpan,
    line: candidate.line,
    column: candidate.column,
    size: candidate.read.size,
    bytesRead: candidate.read.bytesRead,
  });
}

export function decideContentSearchRoot(state: ContentSearchState): ContentSearchRootDecision {
  if (state.listing === null) return Object.freeze({ result: "unknown", satisfaction: null });
  const candidates = state.candidates;
  if (candidates.some(candidate => candidate.outcome === "matched" || candidate.contains === true)) {
    return Object.freeze({ result: "satisfied", satisfaction: 100 });
  }
  if (state.listing.coverage !== "complete") return Object.freeze({ result: "unknown", satisfaction: null });
  if (candidates.length === 0) return Object.freeze({ result: "unsatisfied", satisfaction: 0 });
  const unresolved = candidates.some(candidate =>
    candidate.outcome === "pending" ||
    candidate.outcome === "unknown" ||
    candidate.outcome === "read_error" ||
    candidate.outcome === "stale",
  );
  if (unresolved) return Object.freeze({ result: "unknown", satisfaction: null });
  const negatives = candidates.filter(candidate => candidate.outcome === "negative");
  const mismatches = candidates.filter(candidate => candidate.outcome === "type_mismatch");
  if (mismatches.length === 0 && negatives.length === candidates.length) {
    return Object.freeze({ result: "unsatisfied", satisfaction: 0 });
  }
  return Object.freeze({ result: "unknown", satisfaction: null });
}

export function matchesOf(state: ContentSearchState, needle: string): readonly ContentSearchHitFact[] {
  return Object.freeze(state.candidates
    .filter(candidate => candidate.outcome === "matched")
    .map(candidate => hitOf(candidate, needle))
    .filter((hit): hit is ContentSearchHitFact => hit !== null));
}

export function negativesOf(state: ContentSearchState, needle: string): readonly ContentSearchNegativeFact[] {
  const seen = new Set<string>();
  const negatives: ContentSearchNegativeFact[] = [];
  for (const candidate of state.candidates) {
    if (candidate.outcome !== "negative" || candidate.fileRef === null) continue;
    const key = `${candidate.fileRef.identity.dev}:${candidate.fileRef.identity.ino}:${needle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const negative = negativeOf(candidate, needle);
    if (negative !== null) negatives.push(negative);
  }
  return Object.freeze(negatives);
}

export function deliberateSuboptimal(state: ContentSearchState, order: ContentSearchOrder): boolean {
  if (order.kind !== "injected-first") return false;
  const first = state.candidates[0];
  if (first === undefined || first.name !== order.name || first.outcome !== "negative") return false;
  return state.candidates.some(candidate => candidate.name !== order.name && candidate.outcome === "matched");
}

export function coverageOf(
  state: ContentSearchState,
  status: ContentSearchDomainProjection["status"],
  resolution: ContentSearchDomainProjection["resolution"],
): ContentSearchDomainProjection["coverage"] {
  if (state.listing === null) return null;
  if (state.listing.coverage !== "complete") return "partial";
  if ((status === "achieved" && resolution === "matched") ||
    (status === "unmet" && resolution === "not_found")) return "complete";
  return "partial";
}

export function buildRootFact(
  state: ContentSearchState,
  status: Readonly<{
    status: ContentSearchDomainProjection["status"];
    resolution: ContentSearchDomainProjection["resolution"];
    satisfaction: number | null;
  }>,
  primaryCode: string | null,
  needle: string,
): ContentSearchRootFact {
  const listing = state.listing;
  if (status.status === "achieved" && status.resolution === "matched") {
    const match = state.candidates.find(candidate => candidate.outcome === "matched");
    if (match !== undefined && match.byteSpan !== null && match.fileRef !== null &&
      match.read !== null && match.line !== null && match.column !== null) {
      return Object.freeze({
        kind: "matched",
        needle,
        listing: Object.freeze({ sourceRun: listing?.sourceRun ?? null, coverage: "complete" as const }),
        match: Object.freeze({
          fileRef: match.fileRef,
          path: match.path,
          needle,
          byteSpan: match.byteSpan,
          line: match.line,
          column: match.column,
          size: match.read.size,
          bytesRead: match.read.bytesRead,
        }),
        candidateNames: Object.freeze(state.candidates.map(candidate => candidate.name)),
      });
    }
  }
  if (status.status === "unmet" && status.resolution === "not_found") {
    return Object.freeze({
      kind: "not_found",
      needle,
      listing: Object.freeze({ sourceRun: listing?.sourceRun ?? null, coverage: "complete" as const }),
      negativePaths: Object.freeze(state.candidates.filter(candidate => candidate.outcome === "negative").map(candidate => candidate.path)),
      candidateNames: Object.freeze(state.candidates.map(candidate => candidate.name)),
    });
  }
  if (status.status === "unknown" && status.resolution === "interrupted") {
    return Object.freeze({ kind: "interrupted" });
  }
  if (status.status === "rejected") {
    return Object.freeze({ kind: "rejected" });
  }
  if (status.status === "failed") {
    const failures = state.candidates
      .filter(candidate => candidate.failureCode !== null)
      .map(candidate => Object.freeze({ path: candidate.path, code: candidate.failureCode ?? "EIO" }));
    return Object.freeze({
      kind: "failed",
      errors: failures.length > 0 ? failures : Object.freeze([Object.freeze({ path: null, code: primaryCode ?? "execution_failed" })]),
    });
  }
  return Object.freeze({
    kind: "insufficient_evidence",
    needle,
    listing: Object.freeze({
      sourceRun: listing?.sourceRun ?? null,
      coverage: listing?.coverage ?? null,
      errors: Object.freeze(listing?.errors ?? []),
    }),
    candidateNames: Object.freeze(state.candidates.map(candidate => candidate.name)),
    reasons: Object.freeze(state.candidates.filter(candidate => candidate.reason !== null).map(candidate => candidate.reason ?? "")),
    matchPaths: Object.freeze([]),
    negativePaths: Object.freeze(state.candidates.filter(candidate => candidate.outcome === "negative").map(candidate => candidate.path)),
  });
}
