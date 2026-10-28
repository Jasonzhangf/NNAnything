import type {
  ContentSearchCandidateFact,
  ContentSearchCardinality,
  ContentSearchDenominators,
  ContentSearchDirectoryFact,
  ContentSearchDomainProjection,
  ContentSearchFileRef,
  ContentSearchHistoricalHitFact,
  ContentSearchHitFact,
  ContentSearchIdentityKey,
  ContentSearchListingFact,
  ContentSearchNegativeFact,
  ContentSearchOrder,
  ContentSearchReadFact,
  ContentSearchRootFact,
  ContentSearchScanFact,
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

export function chunkCount(size: number, chunkSize: number): number {
  if (size === 0) return 1;
  return Math.max(1, Math.ceil(size / chunkSize));
}

export function lineColumnOfFirstMatch(
  previous: ContentSearchScanFact | null,
  currentBytes: Buffer,
  readOffset: number,
  absoluteStart: number,
): Readonly<{ line: number; column: number }> {
  if (previous === null) {
    let line = 1;
    let lineStartAbs = 0;
    const endInChunk = Math.max(0, Math.min(currentBytes.length, absoluteStart - readOffset));
    for (let index = 0; index < endInChunk; index += 1) {
      if (currentBytes[index] === 0x0a) {
        line += 1;
        lineStartAbs = readOffset + index + 1;
      }
    }
    return Object.freeze({ line, column: absoluteStart - lineStartAbs + 1 });
  }
  if (absoluteStart >= readOffset) {
    let line = previous.prefixNewlines + 1;
    let lineStartAbs = previous.lastNewlineAbs + 1;
    const endInChunk = Math.max(0, Math.min(currentBytes.length, absoluteStart - readOffset));
    for (let index = 0; index < endInChunk; index += 1) {
      if (currentBytes[index] === 0x0a) {
        line += 1;
        lineStartAbs = readOffset + index + 1;
      }
    }
    return Object.freeze({ line, column: absoluteStart - lineStartAbs + 1 });
  }
  const carry = Buffer.from(previous.carry, "base64");
  const carryStartAbs = readOffset - carry.length;
  const localStart = Math.max(0, absoluteStart - carryStartAbs);
  let line = previous.prefixNewlines + 1;
  let lineStartAbs = previous.carryLineStartAbs;
  for (let index = localStart; index < carry.length; index += 1) {
    if (carry[index] === 0x0a) line -= 1;
  }
  for (let index = 0; index < localStart; index += 1) {
    if (carry[index] === 0x0a) lineStartAbs = carryStartAbs + index + 1;
  }
  return Object.freeze({ line, column: absoluteStart - lineStartAbs + 1 });
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
    .filter(entry => entry.type !== "directory")
    .filter(entry => candidateNameSatisfies(entry.name, fileCondition))
    .map(entry => Object.freeze({
      name: entry.name,
      path: entry.path,
      listedType: entry.type as ContentSearchCandidateFact["listedType"],
    }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  if (order.kind !== "injected-first") return Object.freeze(eligible);
  return Object.freeze([
    ...eligible.filter(entry => entry.name === order.name),
    ...eligible.filter(entry => entry.name !== order.name),
  ]);
}

function candidateFactFromOrder(
  entry: ContentSearchCandidateOrder,
): ContentSearchCandidateFact {
  const mismatch = entry.listedType !== "file";
  return Object.freeze({
    name: entry.name,
    path: entry.path,
    listedType: entry.listedType,
    inspected: null,
    fileRef: null,
    read: null,
    scan: null,
    history: Object.freeze([]),
    contains: null,
    outcome: mismatch ? ("type_mismatch" as const) : ("pending" as const),
    byteSpan: null,
    line: null,
    column: null,
    reason: mismatch ? ("type_mismatch" as const) : null,
    failureCode: null,
    duplicateRead: false,
    staleRetries: 0,
  });
}

export function candidatesFromListings(
  directories: readonly ContentSearchDirectoryFact[],
  fileCondition: Readonly<{ type: "regular"; name?: string; suffix?: string }> | null,
  order: ContentSearchOrder,
): readonly ContentSearchCandidateFact[] {
  const eligible = directories
    .flatMap(directory => directory.listing === null ? [] : orderedCandidates(directory.listing.entries, fileCondition, order))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  if (order.kind === "injected-first") {
    return Object.freeze([
      ...eligible.filter(entry => entry.name === order.name),
      ...eligible.filter(entry => entry.name !== order.name),
    ].map(entry => candidateFactFromOrder(entry)));
  }
  return Object.freeze(eligible.map(entry => candidateFactFromOrder(entry)));
}

export function initialCandidates(
  listing: ContentSearchListingFact | null,
  fileCondition: Readonly<{ type: "regular"; name?: string; suffix?: string }> | null,
  order: ContentSearchOrder,
): readonly ContentSearchCandidateFact[] {
  if (listing === null) return Object.freeze([]);
  return Object.freeze(orderedCandidates(listing.entries, fileCondition, order).map(entry =>
    candidateFactFromOrder(entry),
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
    errors: Object.freeze(observation.errors.map(error => error.code)),
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

/** A transient read failure that can become a candidate read_error fact instead of aborting the run. */
export function isRecoverableReadCode(code: string): boolean {
  return code === "EIO";
}

export function identityKeyOfRef(ref: ContentSearchFileRef): ContentSearchIdentityKey {
  return Object.freeze({
    scenarioId: ref.scenarioId,
    sessionId: ref.sessionId,
    dev: ref.identity.dev,
    ino: ref.identity.ino,
    sessionRevision: ref.sessionRevision,
    sourceRun: ref.sourceRun,
  });
}

function sameIdentityKey(left: ContentSearchIdentityKey, right: ContentSearchIdentityKey): boolean {
  return left.scenarioId === right.scenarioId &&
    left.sessionId === right.sessionId &&
    String(left.dev) === String(right.dev) &&
    String(left.ino) === String(right.ino) &&
    left.sessionRevision === right.sessionRevision &&
    left.sourceRun === right.sourceRun;
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
    observedAtSourceRun: candidate.scan?.firstReadSourceRun ?? candidate.read.sourceRun,
    completedAtSourceRun: candidate.scan?.lastReadSourceRun ?? candidate.read.sourceRun,
    reason: "complete_read_no_match" as const,
  });
}

function hitOf(candidate: ContentSearchCandidateFact, needle: string): ContentSearchHitFact | null {
  if (candidate.outcome !== "matched" || candidate.read === null || candidate.fileRef === null ||
    candidate.byteSpan === null || candidate.line === null || candidate.column === null) return null;
  return Object.freeze({
    kind: "current_hit",
    historical: false,
    identityKey: identityKeyOfRef(candidate.fileRef),
    fileRef: candidate.fileRef,
    path: candidate.path,
    needle,
    byteSpan: candidate.byteSpan,
    line: candidate.line,
    column: candidate.column,
    size: candidate.read.size,
    bytesRead: candidate.scan?.bytesRead ?? candidate.read.bytesRead,
    scanComplete: candidate.scan?.complete ?? false,
  });
}

function allCovered(state: ContentSearchState): boolean {
  if (state.cardinality !== "all") return false;
  if (state.directories.some(directory => directory.listing !== null && directory.listing.coverage !== "complete")) return false;
  if (state.directories.some(directory => directory.uncoveredReason !== null)) return false;
  if (state.pendingDirectories.length > 0) return false;
  const unresolved = state.candidates.some(candidate =>
    candidate.outcome === "pending" ||
    candidate.outcome === "unknown" ||
    candidate.outcome === "read_error" ||
    candidate.outcome === "stale",
  );
  if (unresolved) return false;
  if (state.candidates.some(candidate =>
    candidate.outcome === "matched" && (candidate.scan === null || !candidate.scan.complete))) return false;
  if (state.candidates.some(candidate =>
    candidate.outcome === "pending" && (candidate.scan === null || !candidate.scan.complete))) return false;
  if (state.candidates.some(candidate => candidate.outcome === "negative" &&
    (candidate.scan === null || !candidate.scan.complete ||
      candidate.scan.identityAtStart === null ||
      candidate.fileRef === null ||
      candidate.scan.nextOffset !== candidate.scan.sizeAtStart ||
      !candidate.scan.lastEndObserved ||
      candidate.scan.shortRead))) {
    return false;
  }
  return true;
}

export function decideContentSearchRoot(state: ContentSearchState): ContentSearchRootDecision {
  if (state.listing === null && state.directories.length === 0) return Object.freeze({ result: "unknown", satisfaction: null });
  if (state.cardinality === "one") {
    if (state.candidates.some(candidate => candidate.outcome === "matched" || candidate.contains === true)) {
      return Object.freeze({ result: "satisfied", satisfaction: 100 });
    }
    const listing = state.directories[0]?.listing ?? state.listing;
    if (listing === null) return Object.freeze({ result: "unknown", satisfaction: null });
    if (listing.coverage !== "complete") return Object.freeze({ result: "unknown", satisfaction: null });
    const unresolved = state.candidates.some(candidate =>
      candidate.outcome === "pending" || candidate.outcome === "unknown" ||
      candidate.outcome === "read_error" || candidate.outcome === "stale");
    if (unresolved) return Object.freeze({ result: "unknown", satisfaction: null });
    if (state.candidates.every(candidate => candidate.outcome === "negative" || candidate.outcome === "type_mismatch")) {
      return Object.freeze({ result: "unsatisfied", satisfaction: 0 });
    }
    return Object.freeze({ result: "unknown", satisfaction: null });
  }
  if (allCovered(state)) {
    const currentMatches = state.candidates.filter(candidate => candidate.outcome === "matched");
    if (currentMatches.length > 0) {
      if (currentMatches.every(candidate => candidate.scan !== null && candidate.scan.complete)) {
        return Object.freeze({ result: "satisfied", satisfaction: 100 });
      }
    }
    if (currentMatches.length === 0) {
      return Object.freeze({ result: "unsatisfied", satisfaction: 0 });
    }
  }
  return Object.freeze({ result: "unknown", satisfaction: null });
}

export function matchesOf(state: ContentSearchState, needle: string): readonly ContentSearchHitFact[] {
  return Object.freeze(state.candidates
    .filter(candidate => candidate.outcome === "matched")
    .map(candidate => hitOf(candidate, needle))
    .filter((hit): hit is ContentSearchHitFact => hit !== null));
}

export function historicalMatchesOf(state: ContentSearchState): readonly ContentSearchHistoricalHitFact[] {
  return Object.freeze(state.candidates.flatMap(candidate => candidate.history));
}

export function negativesOf(state: ContentSearchState, needle: string): readonly ContentSearchNegativeFact[] {
  const seen = new Set<string>();
  const negatives: ContentSearchNegativeFact[] = [];
  for (const candidate of state.candidates) {
    if (candidate.outcome !== "negative" || candidate.fileRef === null) continue;
    const key = `${candidate.fileRef.scenarioId}:${candidate.fileRef.sessionId}:${candidate.fileRef.identity.dev}:${candidate.fileRef.identity.ino}:${candidate.fileRef.sessionRevision}:${candidate.fileRef.sourceRun}:${needle}`;
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
  if (state.listing === null && state.directories.length === 0) return null;
  if ((status === "achieved" && resolution === "matched") ||
    (status === "unmet" && resolution === "not_found")) return "complete";
  return "partial";
}

export function denominatorFields(
  state: ContentSearchState,
  needle: string,
): Readonly<{
  candidatesScanned: number;
  candidatesMatched: number;
  candidatesNegative: number;
  candidatesUnresolved: number;
  typeMismatches: number;
}> {
  let candidatesScanned = 0;
  let candidatesMatched = 0;
  let candidatesNegative = 0;
  let candidatesUnresolved = 0;
  let typeMismatches = 0;
  for (const candidate of state.candidates) {
    if (candidate.outcome === "type_mismatch") {
      typeMismatches += 1;
      continue;
    }
    if (candidate.scan !== null && candidate.scan.complete) {
      candidatesScanned += 1;
      if (candidate.outcome === "matched") candidatesMatched += 1;
      else if (candidate.outcome === "negative") candidatesNegative += 1;
      else candidatesUnresolved += 1;
    } else {
      candidatesUnresolved += 1;
      if (candidate.outcome === "matched") candidatesMatched += 1;
    }
  }
  void needle;
  return Object.freeze({ candidatesScanned, candidatesMatched, candidatesNegative, candidatesUnresolved, typeMismatches });
}

export function denominatorsOf(
  state: ContentSearchState,
  needle: string,
): ContentSearchDenominators {
  const fields = denominatorFields(state, needle);
  const listedDirectories = state.directories.filter(directory => directory.listed).length;
  const directoriesComplete = state.directories.filter(directory =>
    directory.listed && directory.listing !== null && directory.listing.coverage === "complete").length;
  const directoriesUncovered = state.directories.filter(directory => directory.uncoveredReason !== null).length;
  return Object.freeze({
    listedDirectories,
    directoriesComplete,
    directoriesUncovered,
    candidatesTotal: state.candidates.filter(candidate => candidate.outcome !== "type_mismatch").length,
    candidatesScanned: fields.candidatesScanned,
    candidatesMatched: fields.candidatesMatched,
    candidatesNegative: fields.candidatesNegative,
    candidatesUnresolved: fields.candidatesUnresolved,
    typeMismatches: fields.typeMismatches,
  });
}

function sourceRunsOf(state: ContentSearchState): readonly string[] {
  return Object.freeze(state.directories
    .filter(directory => directory.observedAtSourceRun !== null)
    .map(directory => directory.observedAtSourceRun as string)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
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
  const listing = state.directories[0]?.listing ?? state.listing;
  if (status.status === "achieved" && status.resolution === "matched") {
    const matches = matchesOf(state, needle);
    const match = matches[0];
    if (match !== undefined) {
      return Object.freeze({
        kind: "matched",
        needle,
        listing: Object.freeze({
          sourceRun: listing?.sourceRun ?? null,
          sourceRuns: sourceRunsOf(state),
          coverage: "complete" as const,
        }),
        match,
        matches,
        candidateNames: Object.freeze(state.candidates.map(candidate => candidate.name)),
      });
    }
  }
  if (status.status === "unmet" && status.resolution === "not_found") {
    return Object.freeze({
      kind: "not_found",
      needle,
      listing: Object.freeze({
        sourceRun: listing?.sourceRun ?? null,
        sourceRuns: sourceRunsOf(state),
        coverage: "complete" as const,
      }),
      negativePaths: Object.freeze(state.candidates.filter(candidate => candidate.outcome === "negative").map(candidate => candidate.path)),
      candidateNames: Object.freeze(state.candidates.map(candidate => candidate.name)),
    });
  }
  if (status.status === "unknown" && status.resolution === "interrupted") {
    return Object.freeze({ kind: "interrupted" });
  }
  if (status.status === "unknown" && status.resolution === "budget_exhausted") {
    // Budget stops preserve every observed partial fact; they must not be
    // confused with cancellation, failure, or a decisive match/not-found.
    const matchPaths = matchesOf(state, needle).map(match => match.path);
    const negativePaths = state.candidates.filter(candidate => candidate.outcome === "negative").map(candidate => candidate.path);
    const reasons = state.candidates
      .filter(candidate => candidate.reason !== null && candidate.reason !== "no_match")
      .map(candidate => candidate.reason ?? "")
      .concat(state.directories
        .filter(directory => directory.uncoveredReason !== null)
        .map(directory => directory.uncoveredReason ?? "")
      );
    if (matchPaths.length > 0) {
      return Object.freeze({
        kind: "partial",
        needle,
        listing: Object.freeze({
          sourceRun: listing?.sourceRun ?? null,
          sourceRuns: sourceRunsOf(state),
          coverage: listing?.coverage ?? null,
          errors: Object.freeze(listing?.errors ?? []),
        }),
        candidateNames: Object.freeze(state.candidates.map(candidate => candidate.name)),
        matchPaths: Object.freeze(matchPaths),
        negativePaths: Object.freeze(negativePaths),
        reasons: Object.freeze([...new Set(reasons)]),
      });
    }
    return Object.freeze({
      kind: "insufficient_evidence",
      needle,
      listing: Object.freeze({
        sourceRun: listing?.sourceRun ?? null,
        sourceRuns: sourceRunsOf(state),
        coverage: listing?.coverage ?? null,
        errors: Object.freeze(listing?.errors ?? []),
      }),
      candidateNames: Object.freeze(state.candidates.map(candidate => candidate.name)),
      reasons: Object.freeze([...new Set(reasons)]),
      matchPaths: Object.freeze([]),
      negativePaths: Object.freeze(negativePaths),
    });
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
  const matchPaths = matchesOf(state, needle).map(match => match.path);
  const negativePaths = state.candidates.filter(candidate => candidate.outcome === "negative").map(candidate => candidate.path);
  const reasons = state.candidates
    // A completed negative is a decisive per-candidate fact, not a reason the
    // root coverage is incomplete; only unresolved evidence belongs here.
    .filter(candidate => candidate.reason !== null && candidate.reason !== "no_match")
    .map(candidate => candidate.reason ?? "")
    .concat(state.directories
      .filter(directory => directory.uncoveredReason !== null)
      .map(directory => directory.uncoveredReason ?? "")
    );
  const reasonsSet = new Set(reasons);
  if (matchPaths.length > 0) {
    return Object.freeze({
      kind: "partial",
      needle,
      listing: Object.freeze({
        sourceRun: listing?.sourceRun ?? null,
        sourceRuns: sourceRunsOf(state),
        coverage: listing?.coverage ?? null,
        errors: Object.freeze(listing?.errors ?? []),
      }),
      candidateNames: Object.freeze(state.candidates.map(candidate => candidate.name)),
      matchPaths: Object.freeze(matchPaths),
      negativePaths: Object.freeze(negativePaths),
      reasons: Object.freeze([...new Set(reasons)]),
    });
  }
  return Object.freeze({
    kind: "insufficient_evidence",
    needle,
    listing: Object.freeze({
      sourceRun: listing?.sourceRun ?? null,
      sourceRuns: sourceRunsOf(state),
      coverage: listing?.coverage ?? null,
      errors: Object.freeze(listing?.errors ?? []),
    }),
    candidateNames: Object.freeze(state.candidates.map(candidate => candidate.name)),
    reasons: Object.freeze([...new Set(reasons)]),
    matchPaths: Object.freeze([]),
    negativePaths: Object.freeze(negativePaths),
  });
}

export function updateCandidate(
  candidates: readonly ContentSearchCandidateFact[],
  path: string,
  patch: Partial<ContentSearchCandidateFact>,
): readonly ContentSearchCandidateFact[] {
  return Object.freeze(candidates.map(candidate => candidate.path === path
    ? Object.freeze({ ...candidate, ...patch })
    : candidate));
}

export function readFactEndObserved(read: ContentSearchReadFact | null): boolean {
  if (read === null) return false;
  return read.offset + read.bytesRead >= read.size;
}

export function applyReadToScan(
  scan: ContentSearchScanFact | null,
  candidate: ContentSearchCandidateFact,
  read: ContentSearchReadFact,
  needle: Buffer,
): ContentSearchScanFact {
  const previousConsumedBytes = scan?.bytesRead ?? 0;
  const previousTail = scan === null ? Buffer.alloc(0) : Buffer.from(scan.carry, "base64");
  const currentBytes = Buffer.from(read.bytes, "base64");
  const carryLength = Math.min(needle.length - 1, Math.max(0, previousConsumedBytes));
  const window = Buffer.concat([previousTail.subarray(Math.max(0, previousTail.length - carryLength)), currentBytes]);
  const match = contains(window, needle);
  let found = scan?.found ?? false;
  let firstMatch = scan?.firstMatch ?? null;
  if (match.found && match.start + needle.length > carryLength) {
    found = true;
    if (firstMatch === null) {
      const start = read.offset - carryLength + match.start;
      const location = lineColumnOfFirstMatch(scan, currentBytes, read.offset, start);
      firstMatch = Object.freeze({
        start,
        end: start + needle.length,
        line: location.line,
        column: location.column,
      });
    }
  }
  const previousNewlines = scan?.prefixNewlines ?? 0;
  const previousLastNewlineAbs = scan?.lastNewlineAbs ?? -1;
  let newlines = previousNewlines;
  let lastNewlineAbs = previousLastNewlineAbs;
  for (let index = 0; index < currentBytes.length; index += 1) {
    if (currentBytes[index] === 0x0a) {
      newlines += 1;
      lastNewlineAbs = read.offset + index;
    }
  }
  const nextOffset = read.offset + read.bytesRead;
  const carryBytes = Buffer.from(window.subarray(Math.max(0, window.length - (needle.length - 1))));
  const carryStartAbs = nextOffset - carryBytes.length;
  const carryLocation = lineColumnOfFirstMatch(scan, currentBytes, read.offset, carryStartAbs);
  return Object.freeze({
    nextOffset,
    carry: carryBytes.toString("base64"),
    carryLineStartAbs: carryStartAbs - carryLocation.column + 1,
    found,
    firstMatch,
    complete: read.offset + read.bytesRead >= read.size && !(read.eof && read.offset + read.bytesRead < read.size) && !scan?.shortRead,
    bytesRead: previousConsumedBytes + read.bytesRead,
    chunks: (scan?.chunks ?? 0) + 1,
    sizeAtStart: scan?.sizeAtStart ?? read.size,
    identityAtStart: scan?.identityAtStart ?? identityKeyOfRef(read.ref),
    firstReadSourceRun: scan?.firstReadSourceRun ?? read.sourceRun,
    lastReadSourceRun: read.sourceRun,
    lastEndObserved: read.offset + read.bytesRead >= read.size,
    shortRead: (scan?.shortRead ?? false) || (read.eof && read.offset + read.bytesRead < read.size),
    prefixNewlines: newlines,
    lastNewlineAbs,
  });
}
