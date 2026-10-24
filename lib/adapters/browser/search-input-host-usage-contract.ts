// B-A1 m2 R1: usage-relation observation and formal-feature contract.
//
// This is the contract for the proposed relation sub-unit
// (browser.search-input-usage-relation.v1). It is NOT wired into the binder and
// does not change the binder's 34 wires. The binder keeps consuming its current
// contract until the representation is accepted.
//
// Two shapes live here:
//
// 1. UsageObservation — what the adapter really read from one control. Every
//    unread fact stays null or "unmeasured"; nothing is defaulted.
// 2. UsageFormFeatures — the finite 26-dim formal vector described in
//    m2-representation-plan.md section 4. Each entry is a form fact about
//    observable text, never a claim about intent.
//
// Token tables are caller-declared. The plan requires the exact field/write/
// negation table to be declared with its own provenance before any new
// collection, so this contract accepts the table as input rather than baking in
// an unreviewed list.

import { expectRecord } from "../../core/schema.js";

export const USAGE_RELATION_CONTRACT = "browser.search-input-usage-relation.v1";

/**
 * How much of one text channel was really read.
 *
 * "complete" is the only value that lets the extractor score the channel.
 * "truncated" and "unavailable" are partial reads and must not be scored as
 * complete. "unmeasured" means no read happened at all.
 */
export type UsageChannelCoverage = "complete" | "truncated" | "unavailable" | "unmeasured";
export type UsageAssociationCoverage = "complete" | "unmeasured";

export interface UsageTextChannelCoverage<T> {
  readonly value: T;
  readonly coverage: UsageChannelCoverage;
}

export interface UsageLabelChannel {
  /** Every label that really associates with the control, in document order. */
  readonly labels: readonly string[] | null;
  readonly coverage: UsageChannelCoverage;
}

export interface UsageOwnedSubmit {
  /** Human-visible caption. Null means the caption could not be read. */
  readonly caption: string | null;
  /** Only real form-owner association is recorded; visual proximity is not used. */
  readonly association: "same_form_owner";
  readonly captionCoverage: UsageChannelCoverage;
}

export interface UsageObservation {
  readonly ref: string;
  readonly scopeRef: string;
  readonly documentRef: string;
  readonly observationId: string;
  readonly revision: number;
  readonly labels: readonly string[] | null;
  readonly labelCoverage: UsageChannelCoverage;
  readonly placeholder: string | null;
  readonly placeholderCoverage: UsageChannelCoverage;
  readonly accessibleName: string | null;
  readonly accessibleNameCoverage: UsageChannelCoverage;
  readonly ownedSubmits: readonly UsageOwnedSubmit[] | null;
  readonly associationCoverage: UsageAssociationCoverage;
  /** False only when a form reference existed but could not be resolved. */
  readonly formResolved: boolean;
  readonly access: "available" | "login_required" | "challenge" | "unknown" | null;
}

export interface UsageObserveInput {
  readonly nodeRef: string;
  readonly scopeRef: string;
  readonly documentRef: string;
  readonly observationId: string;
  readonly revision: number;
  readonly scopeRoot: Element;
  readonly element: Element;
  readonly properties: Record<string, unknown> | null;
  /**
   * The live-dom evidence entry for this control, which is where observeLiveDom
   * reports the accessible name. Pass null when the caller has no evidence map.
   */
  readonly evidence?: Record<string, unknown> | null;
  readonly access: UsageObservation["access"];
}

/** Caller-declared token tables. Each table must have a declared provenance. */
export interface UsageTokenTable {
  readonly query: readonly string[];
  readonly field: readonly string[];
  readonly negation: readonly string[];
  readonly writeSubmit: readonly string[];
}

const TEXT_CHANNELS = ["label", "placeholder", "accessibleName"] as const;
type UsageTextChannel = (typeof TEXT_CHANNELS)[number];

/**
 * The 26 formal features, in declared order.
 *
 * Eight per text channel plus two owned-submit existence bits. A feature is
 * null exactly when its channel is unmeasured; an empty string is measured
 * empty evidence, not a missing value.
 */
export const USAGE_FORM_FEATURE_NAMES = Object.freeze([
  ...TEXT_CHANNELS.flatMap(channel => [
    `${channel}.queryTokenPresent`,
    `${channel}.queryTokenBeforeText`,
    `${channel}.queryTokenAfterText`,
    `${channel}.queryTokenParenthesized`,
    `${channel}.queryTokenQuoted`,
    `${channel}.negationTokenBeforeQuery`,
    `${channel}.fieldTokenPresent`,
    `${channel}.fieldTokenAfterQuery`,
  ]),
  "ownedSubmit.queryTokenPresent",
  "ownedSubmit.writeTokenPresent",
] as const);

export type UsageFormFeatureName = (typeof USAGE_FORM_FEATURE_NAMES)[number];

/** One measured form fact per name. Null is "unmeasured", never false. */
export type UsageFormFeatures = Readonly<Record<UsageFormFeatureName, boolean | null>>;

export function validateUsageTokenTable(value: unknown, label = "usage token table"): UsageTokenTable {
  const table = expectRecord(value, label);
  const read = (key: string): readonly string[] => {
    const raw = table[key];
    if (!Array.isArray(raw)) throw new TypeError(`${label}.${key} must be an array of strings`);
    return Object.freeze(raw.map((entry, index) => {
      if (typeof entry !== "string" || entry.length === 0) {
        throw new TypeError(`${label}.${key}[${index}] must be a non-empty string`);
      }
      return entry;
    }));
  };
  return Object.freeze({
    query: read("query"),
    field: read("field"),
    negation: read("negation"),
    writeSubmit: read("writeSubmit"),
  });
}

function lower(value: string): string {
  return value.toLowerCase();
}

function firstIndex(text: string, tokens: readonly string[]): number {
  let best = -1;
  for (const token of tokens) {
    const needle = lower(token);
    // An empty needle matches at offset 0 forever. The declared table is
    // validated, but the extractor accepts any table, so an empty entry must be
    // skipped rather than allowed to fabricate a match or loop.
    if (needle.length === 0) continue;
    const at = text.indexOf(needle);
    if (at !== -1 && (best === -1 || at < best)) best = at;
  }
  return best;
}

function anyIndex(text: string, tokens: readonly string[]): readonly number[] {
  const found: number[] = [];
  for (const token of tokens) {
    const needle = lower(token);
    if (needle.length === 0) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(needle, from);
      if (at === -1) break;
      found.push(at);
      from = at + needle.length;
    }
  }
  return found;
}

/** Paired brackets only: an unclosed bracket is not a boundary. */
function insidePair(text: string, open: string, close: string): readonly string[] {
  const inner: string[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf(open, from);
    if (start === -1) break;
    const end = text.indexOf(close, start + open.length);
    if (end === -1) break;
    inner.push(text.slice(start + open.length, end));
    from = end + close.length;
  }
  return inner;
}

/**
 * Compute the eight per-channel form facts for one text channel.
 *
 * "before/after" is the character order of a query token relative to the other
 * non-empty text in the same source. The name is deliberately a form fact: it
 * does not assert query intent.
 */
function channelFeatures(
  raw: string | null,
  coverage: UsageChannelCoverage,
  tokens: UsageTokenTable,
): readonly (boolean | null)[] {
  // Only a complete read can produce facts. A truncated or unavailable channel
  // stays unmeasured so a partial name never scores as a complete one.
  if (coverage !== "complete" || raw === null) {
    return [null, null, null, null, null, null, null, null];
  }
  const text = raw.trim();
  if (text.length === 0) {
    // Measured empty evidence: no token is present anywhere in this channel.
    return [false, false, false, false, false, false, false, false];
  }
  const lowered = lower(text);
  const queryHits = anyIndex(lowered, tokens.query);
  const present = queryHits.length > 0;
  // Mark every character that belongs to a query token. Everything else that is
  // not whitespace is "other text", which is what before/after compares against.
  const inQuery = new Array<boolean>(lowered.length).fill(false);
  for (const token of tokens.query) {
    const needle = lower(token);
    if (needle.length === 0) continue;
    let from = 0;
    for (;;) {
      const at = lowered.indexOf(needle, from);
      if (at === -1) break;
      for (let index = at; index < at + needle.length; index += 1) inQuery[index] = true;
      from = at + needle.length;
    }
  }
  // Every match is kept: the facts below are existential over matches, so one
  // sandwiched occurrence is enough. Collapsing to the first/last query and the
  // first/last other character would report two false facts for a text like
  // 搜索备注搜索, where text sits after the first query and before the last.
  let minQueryEnd = -1;
  let lastQueryStart = -1;
  for (let index = 0; index < lowered.length; index += 1) {
    if (!inQuery[index]) continue;
    if (index === 0 || !inQuery[index - 1]) lastQueryStart = index;
  }
  for (let index = 0; index < lowered.length; index += 1) {
    if (!inQuery[index]) continue;
    if (index + 1 < lowered.length && inQuery[index + 1]) continue;
    // This index ends some query span; the smallest end is the one a following
    // other character can sit after.
    if (minQueryEnd === -1 || index < minQueryEnd) minQueryEnd = index;
  }
  let firstOther = -1;
  let lastOther = -1;
  for (let index = 0; index < lowered.length; index += 1) {
    if (inQuery[index]) continue;
    if (lowered[index]?.trim() === "") continue;
    if (firstOther === -1) firstOther = index;
    lastOther = index;
  }
  // "Query before text" holds when some query occurrence is followed by other
  // text; "query after text" holds when some occurrence is preceded by it.
  const queryTokenBeforeText = present && lastOther > minQueryEnd;
  const queryTokenAfterText = present && firstOther !== -1 && firstOther < lastQueryStart;
  const fieldHits = anyIndex(lowered, tokens.field);
  const negationHits = anyIndex(lowered, tokens.negation);
  const queryInsideParens = insidePair(text, "(", ")").concat(insidePair(text, "（", "）"))
    .some(inner => firstIndex(lower(inner), tokens.query) !== -1);
  const queryInsideQuotes = insidePair(text, "\"", "\"").concat(insidePair(text, "'", "'"))
    .concat(insidePair(text, "「", "」")).concat(insidePair(text, "“", "”"))
    .some(inner => firstIndex(lower(inner), tokens.query) !== -1);
  return [
    present,
    queryTokenBeforeText,
    queryTokenAfterText,
    queryInsideParens,
    queryInsideQuotes,
    // Some negation precedes some query occurrence.
    present && minQueryEnd !== -1 && negationHits.some(at => at < lastQueryStart),
    fieldHits.length > 0,
    // Some field occurrence follows some query occurrence.
    present && minQueryEnd !== -1 && fieldHits.some(at => at > minQueryEnd),
  ];
}

/**
 * Extract the 26-dim formal vector from one observation.
 *
 * Unmeasured channels yield null for their eight entries, so an all-zero vector
 * can never be mistaken for "measured, nothing found".
 */
export function extractUsageFormFeatures(
  observation: UsageObservation,
  tokens: UsageTokenTable,
): UsageFormFeatures {
  // A null label list means the labels were not readable, whatever the coverage
  // field claims. Folding it to "" would emit eight confident false facts.
  const labelText = observation.labels === null
    ? null
    : observation.labels.length === 0 ? "" : observation.labels.join(" ");
  const labelCoverage: UsageChannelCoverage = observation.labels === null
    ? "unmeasured"
    : observation.labelCoverage;
  const placeholderCoverage = observation.placeholderCoverage;
  const accessibleCoverage = observation.accessibleNameCoverage;

  const label = channelFeatures(labelText, labelCoverage, tokens);
  const placeholder = channelFeatures(observation.placeholder, placeholderCoverage, tokens);
  const accessible = channelFeatures(observation.accessibleName, accessibleCoverage, tokens);

  let ownedQuery: boolean | null = null;
  let ownedWrite: boolean | null = null;
  if (observation.ownedSubmits === null || observation.associationCoverage === "unmeasured") {
    ownedQuery = null;
    ownedWrite = null;
  } else {
    // A declared empty evidence set is measured: no submit control exists.
    ownedQuery = false;
    ownedWrite = false;
    let unreadable = false;
    for (const submit of observation.ownedSubmits) {
      if (submit.caption === null || submit.captionCoverage === "unmeasured") {
        // One unreadable caption makes the ABSENCE of a token unknown. It must
        // not erase a hit another control already proved: a definite hit is real
        // evidence regardless of what the unreadable control says.
        unreadable = true;
        continue;
      }
      if (firstIndex(lower(submit.caption), tokens.query) !== -1) ownedQuery = true;
      if (firstIndex(lower(submit.caption), tokens.writeSubmit) !== -1) ownedWrite = true;
    }
    if (unreadable) {
      if (ownedQuery === false) ownedQuery = null;
      if (ownedWrite === false) ownedWrite = null;
    }
  }

  const values = [...label, ...placeholder, ...accessible, ownedQuery, ownedWrite];
  const features = {} as Record<UsageFormFeatureName, boolean | null>;
  USAGE_FORM_FEATURE_NAMES.forEach((name, index) => {
    features[name] = values[index] ?? null;
  });
  return Object.freeze(features);
}

/**
 * The 26-dim vector as a plain array in the declared order.
 *
 * Null entries are kept as null so a consumer cannot read "unmeasured" as zero.
 */
export function usageFormFeatureVector(
  observation: UsageObservation,
  tokens: UsageTokenTable,
): readonly (boolean | null)[] {
  const features = extractUsageFormFeatures(observation, tokens);
  return Object.freeze(USAGE_FORM_FEATURE_NAMES.map(name => features[name] ?? null));
}
