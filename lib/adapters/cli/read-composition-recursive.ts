import {
  readAtomicReceipt,
  readRecursiveGoalContinuation,
  type AdapterDiagnostic,
  type AtomicReceipt,
  type DerivationInput,
  type EnabledEvaluator,
  type EnabledSkill,
  type EvaluationInput,
  type EvaluationReceipt,
  type FactSnapshot,
  type RecursiveGoalAdapter,
  type RecursiveGoalComparators,
  type RecursiveGoalDependencies,
  type RecursiveGoalRequestEnvelope,
  type SelectorBinding,
  type SelectionInput,
  type SupportsInput,
} from "../../workflow/recursive-goal/contracts.js";
import type {
  PlanningDecisionBinding,
  PlanningDecisionInput,
  PlanningDecisionInputCandidate,
} from "../../workflow/recursive-goal/decision-contracts.js";
import type { PathRanking } from "../../workflow/recursive-goal/planning-contracts.js";
import { createDefaultPlanningDecisionBinding } from "../../filters/bounded-planning-decision.js";
import { relative } from "node:path";
import { join } from "node:path";
import {
  createCliCommandPolicy,
  type CliCommandPolicy,
} from "../../cli-goal.js";
import type { DirectoryObjectRef } from "./entry-search-contract.js";
import {
  readReadCompositionCursor,
  readReadCompositionEffectFact,
  readReadCompositionEvidencePayload,
  readReadCompositionGoal,
  readReadCompositionReceiptPayload,
  readReadCompositionState,
  readCompositionDirectoryKey,
  type ReadCompositionListingFact,
  type ReadCompositionBindings,
  type ReadCompositionCandidate,
  type ReadCompositionEffectFact,
  type ReadCompositionEvidencePayload,
  type ReadCompositionFileRef,
  type ReadCompositionGoal,
  type ReadCompositionInspectGoal,
  type ReadCompositionInspectedFact,
  type ReadCompositionListGoal,
  type ReadCompositionReadFact,
  type ReadCompositionReadGoal,
  type ReadCompositionReceiptPayload,
  type ReadCompositionRequest,
  type ReadCompositionSourceSpec,
  type ReadCompositionDecisionRecord,
  type ReadCompositionSourceState,
  type ReadCompositionState,
} from "./read-composition-contract.js";
import { decideReadRoot, readListingFacts, readRootFact, type ReadListingFacts } from "../../filters/cli-read-composition.js";
import type { ExplicitFileState } from "../../filters/cli-state.js";
import type { CliCommandProfile } from "../../filters/cli-command-policy.js";
import type { CliCommandSample, CliCommandTransition } from "../../nodes/cli-command.js";
import type { PathRef } from "../../filters/cli-file-property.js";
import type { CliFilesystemSandbox, DirectoryRef, SemanticCallReceipt, SessionRef } from "./filesystem-sandbox.js";
import type { ObservedObjectRef } from "./entry-inspection.js";
import type {
  MultiSourceFact,
} from "../../filters/cli-read-composition.js";
import { classifyMultiSources } from "../../filters/cli-read-composition.js";

export const READ_ROOT_COMPOSITE_SKILL = "read-composition.composite";
export const READ_LIST_ATOMIC_SKILL = "read-composition.list";
export const READ_INSPECT_ATOMIC_SKILL = "read-composition.inspect";
export const READ_READ_ATOMIC_SKILL = "read-composition.read";
export const READ_ROOT_EVALUATOR = "read-composition-root";
export const READ_LIST_EVALUATOR = "read-composition-list";
export const READ_INSPECT_EVALUATOR = "read-composition-inspect";
export const READ_READ_EVALUATOR = "read-composition-read";
export const READ_ROOT_SELECTOR = "read-composition-root-selector";
export const READ_LIST_SELECTOR = "read-composition-list-selector";
export const READ_INSPECT_SELECTOR = "read-composition-inspect-selector";
export const READ_READ_SELECTOR = "read-composition-read-selector";
export const READ_MULTI_COMPOSITE_SKILL = "read-composition.multi.composite";
export const READ_MULTI_ROOT_EVALUATOR = "read-composition-multi-root";
export const READ_MULTI_ROOT_SELECTOR = "read-composition-multi-root-selector";

const EFFECTS = Object.freeze(["filesystem.read", "process.exec"] as const);

export const READ_COMPOSITION_SKILLS = Object.freeze([
  Object.freeze({
    id: READ_ROOT_COMPOSITE_SKILL,
    version: "1.0.0",
    mode: "composite",
    capability: "cli.read-composition",
    evaluatorId: READ_ROOT_EVALUATOR,
    requiredEffects: Object.freeze([]),
    allowedEffects: Object.freeze([...EFFECTS]),
    retry: "never",
    effectClass: "none",
  }),
  Object.freeze({
    id: READ_LIST_ATOMIC_SKILL,
    version: "1.0.0",
    mode: "atomic",
    capability: "entry.list",
    evaluatorId: READ_LIST_EVALUATOR,
    requiredEffects: Object.freeze([...EFFECTS]),
    allowedEffects: Object.freeze([...EFFECTS]),
    retry: "never",
    effectClass: "read_only",
  }),
  Object.freeze({
    id: READ_INSPECT_ATOMIC_SKILL,
    version: "1.0.0",
    mode: "atomic",
    capability: "entry.inspect",
    evaluatorId: READ_INSPECT_EVALUATOR,
    requiredEffects: Object.freeze([...EFFECTS]),
    allowedEffects: Object.freeze([...EFFECTS]),
    retry: "never",
    effectClass: "read_only",
  }),
  Object.freeze({
    id: READ_READ_ATOMIC_SKILL,
    version: "1.0.0",
    mode: "atomic",
    capability: "file.read",
    evaluatorId: READ_READ_EVALUATOR,
    requiredEffects: Object.freeze(["filesystem.read"]),
    allowedEffects: Object.freeze(["filesystem.read"]),
    retry: "never",
    effectClass: "read_only",
  }),
]);

export const READ_MULTI_COMPOSITION_SKILL = Object.freeze({
  id: READ_MULTI_COMPOSITE_SKILL,
  version: "1.0.0",
  mode: "composite",
  capability: "cli.read-composition.multisource",
  evaluatorId: READ_MULTI_ROOT_EVALUATOR,
  requiredEffects: Object.freeze([]),
  allowedEffects: Object.freeze([...EFFECTS]),
  retry: "never",
  effectClass: "none",
});

export const READ_COMPOSITION_EVALUATORS = Object.freeze([
  Object.freeze({
    id: READ_ROOT_EVALUATOR,
    goalType: "file.property.content.bytes.equals",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  }),
  Object.freeze({
    id: READ_LIST_EVALUATOR,
    goalType: "file.property.directory.entries.observed",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  }),
  Object.freeze({
    id: READ_INSPECT_EVALUATOR,
    goalType: "file.property.type.observed",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  }),
  Object.freeze({
    id: READ_READ_EVALUATOR,
    goalType: "file.property.content.bytes.observed",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  }),
]);

export const READ_MULTI_ROOT_EVALUATOR_DECL = Object.freeze({
  id: READ_MULTI_ROOT_EVALUATOR,
  goalType: "file.property.content.bytes.equals",
  thresholdContract: "0..100",
  allowsPartialSatisfaction: false,
});

export const READ_COMPOSITION_SELECTORS = Object.freeze([
  Object.freeze({ id: READ_ROOT_SELECTOR, skillIds: Object.freeze([READ_ROOT_COMPOSITE_SKILL]) }),
  Object.freeze({ id: READ_LIST_SELECTOR, skillIds: Object.freeze([READ_LIST_ATOMIC_SKILL]) }),
  Object.freeze({ id: READ_INSPECT_SELECTOR, skillIds: Object.freeze([READ_INSPECT_ATOMIC_SKILL]) }),
  Object.freeze({ id: READ_READ_SELECTOR, skillIds: Object.freeze([READ_READ_ATOMIC_SKILL]) }),
]);

export const READ_MULTI_ROOT_SELECTOR_DECL = Object.freeze({
  id: READ_MULTI_ROOT_SELECTOR,
  skillIds: Object.freeze([READ_MULTI_COMPOSITE_SKILL]),
});

export const READ_COMPOSITION_COMPARATORS: RecursiveGoalComparators<
  unknown,
  unknown,
  ReadCompositionState,
  ReadCompositionEvidencePayload
> = Object.freeze({
  sameGoal: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
  sameBindings: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
  sameFacts: (
    left: FactSnapshot<ReadCompositionState, ReadCompositionEvidencePayload>,
    right: FactSnapshot<ReadCompositionState, ReadCompositionEvidencePayload>,
  ) => JSON.stringify(left) === JSON.stringify(right),
});

export type ReadCompositionAdapterInput = Readonly<{
  sandbox: CliFilesystemSandbox;
  session: SessionRef;
  profile: CliCommandProfile;
  decision?: PlanningDecisionBinding;
  onSample?: (sample: CliCommandSample) => void | Promise<void>;
}>;

export type ReadCompositionAdapter = RecursiveGoalAdapter<
  unknown,
  ReadCompositionState,
  unknown,
  ReadCompositionEvidencePayload,
  ReadCompositionEffectFact,
  ReadCompositionReceiptPayload,
  unknown
>;

export type ReadCompositionAdapterHandle = Readonly<{
  adapter: ReadCompositionAdapter;
  calls: Readonly<{
    validateRequest: number;
    supports: number;
    evaluate: number;
    select: number;
    derive: number;
    executeAtomic: number;
    validateAtomicReceipt: number;
    measureProgress: number;
  }>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty string without NUL`);
  }
  return value;
}

function absolutePath(value: unknown, label: string): string {
  const path = nonEmpty(value, label);
  if (!path.startsWith("/")) throw new TypeError(`${label} must be absolute`);
  return path;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function readGoal(value: unknown): unknown {
  return readReadCompositionGoal(value);
}

function readBindings(value: unknown): unknown {
  if (!isRecord(value)) throw new TypeError("read composition bindings must be an object");
  if (!Object.hasOwn(value, "sources")) {
    return readSingleBindings(value);
  }
  return readMultiBindings(value);
}

function readSingleBindings(value: Record<string, unknown>): unknown {
  exactKeys(value, ["session", "directory", "name", "requiredType", "range", "expectedBase64"], "read composition bindings");
  return Object.freeze({
    session: value.session,
    directory: value.directory,
    name: nonEmpty(value.name, "read composition bindings.name"),
    requiredType: requiredTypeOf(value.requiredType, "read composition bindings.requiredType"),
    range: readBindingsRange(value),
    expectedBase64: readBindingsExpected(value, "read composition bindings"),
  });
}

function readMultiBindings(value: Record<string, unknown>): unknown {
  exactKeys(value, ["session", "sources", "name", "requiredType", "range", "expectedBase64"], "read composition bindings");
  if (!Array.isArray(value.sources) || value.sources.length !== 2) {
    throw new TypeError("read composition bindings.sources must contain exactly two sources");
  }
  const sources = value.sources.map((entry, index) => {
    const source = isRecord(entry) ? entry : null;
    if (source === null || !Object.hasOwn(source, "directory")) {
      throw new TypeError(`read composition bindings.sources[${index}] must contain directory and optional order`);
    }
    if (Object.hasOwn(source, "order") && Object.keys(source).length !== 2) {
      throw new TypeError(`read composition bindings.sources[${index}] must contain directory and optional order`);
    }
    if (!Object.hasOwn(source, "order") && Object.keys(source).length !== 1) {
      throw new TypeError(`read composition bindings.sources[${index}] must contain directory and optional order`);
    }
    const order = Object.hasOwn(source, "order") && source.order !== null
      ? nonnegativeInteger(source.order, `read composition bindings.sources[${index}].order`)
      : null;
    return Object.freeze({ directory: source.directory, order });
  });
  return Object.freeze({
    session: value.session,
    sources: Object.freeze([sources[0], sources[1]]),
    name: nonEmpty(value.name, "read composition bindings.name"),
    requiredType: requiredTypeOf(value.requiredType, "read composition bindings.requiredType"),
    range: readBindingsRange(value),
    expectedBase64: readBindingsExpected(value, "read composition bindings"),
  });
}

function requiredTypeOf(value: unknown, label: string): "regular" {
  if (value !== "regular") throw new TypeError(`${label} must be regular`);
  return "regular";
}

function readBindingsRange(value: Record<string, unknown>): Readonly<{ offset: number; length: number }> {
  const range = value.range;
  if (!isRecord(range)) throw new TypeError("read composition bindings.range must be an object");
  return Object.freeze({
    offset: nonnegativeInteger(range.offset, "read composition bindings.range.offset"),
    length: nonnegativeInteger(range.length, "read composition bindings.range.length"),
  });
}

function readBindingsExpected(value: Record<string, unknown>, label: string): string {
  const expectedBase64 = value.expectedBase64;
  if (
    typeof expectedBase64 !== "string" ||
    Buffer.from(expectedBase64, "base64").length !== (value.range as Record<string, unknown>).length ||
    Buffer.from(Buffer.from(expectedBase64, "base64")).toString("base64") !== expectedBase64
  ) {
    throw new TypeError(`${label}.expectedBase64 must be canonical base64 for the range length`);
  }
  return expectedBase64;
}

function readState(value: unknown): ReadCompositionState {
  if (!isRecord(value)) throw new TypeError("read composition state must be an object");
  return readReadCompositionState(value);
}

function readSessionSnapshot(value: unknown): ReadCompositionState["session"] {
  if (!isRecord(value)) throw new TypeError("read composition session snapshot must be an object");
  exactKeys(value, ["id", "cwd", "revision", "grantedEffects"], "read composition session snapshot");
  const grantedEffects = value.grantedEffects;
  if (!Array.isArray(grantedEffects) || grantedEffects.some(effect => typeof effect !== "string")) {
    throw new TypeError("read composition session snapshot grantedEffects must be a string array");
  }
  return Object.freeze({
    id: nonEmpty(value.id, "read composition session snapshot id"),
    cwd: absolutePath(value.cwd, "read composition session snapshot cwd"),
    revision: nonnegativeInteger(value.revision, "read composition session snapshot revision"),
    grantedEffects: Object.freeze([...grantedEffects]),
  });
}

const DOMAIN_GUARDS = Object.freeze({
  goal: readGoal,
  state: readState,
  bindings: readBindings,
  evidencePayload: readReadCompositionEvidencePayload,
  effectFact: readReadCompositionEffectFact,
  sameEffectFact: (left: ReadCompositionEffectFact, right: ReadCompositionEffectFact) =>
    JSON.stringify(left) === JSON.stringify(right),
  receiptPayload: readReadCompositionReceiptPayload,
  cursor: readReadCompositionCursor,
  sameGoal: READ_COMPOSITION_COMPARATORS.sameGoal,
  sameBindings: READ_COMPOSITION_COMPARATORS.sameBindings,
  sameFacts: READ_COMPOSITION_COMPARATORS.sameFacts,
  sameCursor: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
});

function stateEvidenceRefs(state: ReadCompositionState, evidence: readonly { id: string; stateRef: string; validity: string }[]): readonly string[] {
  return evidence
    .filter(item => item.validity === "valid" && item.stateRef === state.stateId)
    .map(item => item.id);
}

function evaluation(evaluatorId: string, result: "satisfied" | "unsatisfied" | "unknown", satisfaction: number | null, evidenceRefs: readonly string[]): EvaluationReceipt {
  return Object.freeze({
    evaluatorId,
    result,
    satisfaction,
    necessaryConditionsMet: result === "satisfied",
    evidenceRefs: Object.freeze([...evidenceRefs]),
  });
}

function listingKnowledge(state: ReadCompositionState, bindings: ReadCompositionBindings): {
  coverage: "complete" | "partial" | null;
  candidate: ReadCompositionCandidate | null;
} {
  const listing = state.listing;
  if (listing === null) {
    return { coverage: null, candidate: null };
  }
  return {
    coverage: listing.coverage,
    candidate: candidateFromListing(listing, bindings.name),
  };
}

function sourceKnowledge(
  source: ReadCompositionSourceState,
  name: string,
): {
  coverage: "complete" | "partial" | null;
  candidate: ReadCompositionCandidate | null;
} {
  const listing = source.listing;
  if (listing === null) {
    return { coverage: null, candidate: null };
  }
  return {
    coverage: listing.coverage,
    candidate: candidateFromListing(listing, name),
  };
}

type SourceClass =
  | { kind: "legal"; index: 0 | 1; candidate: ReadCompositionCandidate }
  | { kind: "matched"; index: 0 | 1; candidate: ReadCompositionCandidate }
  | { kind: "definitive_negative"; index: 0 | 1; negative: "not_found" | "type_mismatch" | "byte_mismatch" }
  | { kind: "unknown"; index: 0 | 1; reason: "partial" | "short" | "stale" | "unverified" | "in_progress" };

function classifySources(state: ReadCompositionState, bindings: Readonly<{ name: string; range: Readonly<{ offset: number; length: number }>; expectedBase64: string }>): {
  classes: readonly SourceClass[];
  negatives: readonly ("not_found" | "type_mismatch" | "byte_mismatch")[];
  unknowns: readonly { ref: string; reason: string }[];
  anyUnknown: boolean;
} {
  if (state.sources === null) throw new TypeError("multi-source composition state requires sources");
  const classes: SourceClass[] = [];
  const negatives: ("not_found" | "type_mismatch" | "byte_mismatch")[] = [];
  const unknowns: { ref: string; reason: string }[] = [];
  let anyUnknown = false;
  state.sources.forEach((source, index) => {
    const knowledge = sourceKnowledge(source, bindings.name);
    if (knowledge.coverage === null) {
      anyUnknown = true;
      classes.push({ kind: "unknown", index: index as 0 | 1, reason: "in_progress" });
      return;
    }
    if (knowledge.coverage === "partial") {
      anyUnknown = true;
      unknowns.push({ ref: source.sourceId, reason: "partial listing" });
      classes.push({ kind: "unknown", index: index as 0 | 1, reason: "partial" });
      return;
    }
    if (knowledge.candidate === null) {
      negatives.push("not_found");
      classes.push({ kind: "definitive_negative", index: index as 0 | 1, negative: "not_found" });
      return;
    }
    const inspected = source.inspected;
    if (inspected === null) {
      classes.push({ kind: "legal", index: index as 0 | 1, candidate: knowledge.candidate });
      return;
    }
    if (inspected.type !== null && inspected.type !== "regular") {
      negatives.push("type_mismatch");
      classes.push({ kind: "definitive_negative", index: index as 0 | 1, negative: "type_mismatch" });
      return;
    }
    if (
      inspected.type === null ||
      inspected.identity.dev === null ||
      inspected.identity.ino === null ||
      inspected.sourceRun === null ||
      inspected.sessionRevision === null
    ) {
      anyUnknown = true;
      unknowns.push({ ref: source.sourceId, reason: "inspection evidence is incomplete" });
      classes.push({ kind: "unknown", index: index as 0 | 1, reason: "unverified" });
      return;
    }
    const fileRef = source.fileRef ?? source.read?.ref ?? null;
    if (fileRef === null || !fileRefMatchesInspect(fileRef, inspected)) {
      anyUnknown = true;
      unknowns.push({ ref: source.sourceId, reason: "trusted file reference is unavailable or stale" });
      classes.push({ kind: "unknown", index: index as 0 | 1, reason: "stale" });
      return;
    }
    const read = source.read;
    if (read === null) {
      anyUnknown = true;
      unknowns.push({ ref: source.sourceId, reason: "range read is not yet observed" });
      classes.push({ kind: "unknown", index: index as 0 | 1, reason: "in_progress" });
      return;
    }
    if (
      read.sourceRun === null ||
      read.refSourceRun !== fileRef.sourceRun ||
      read.revision === null ||
      read.offset !== bindings.range.offset ||
      read.length !== bindings.range.length ||
      read.bytes === null ||
      read.bytesRead === null ||
      !sameOsInteger(read.identity.dev, fileRef.identity.dev) ||
      !sameOsInteger(read.identity.ino, fileRef.identity.ino)
    ) {
      anyUnknown = true;
      unknowns.push({ ref: source.sourceId, reason: "range read is stale or incomplete" });
      classes.push({ kind: "unknown", index: index as 0 | 1, reason: "stale" });
      return;
    }
    if (read.bytesRead < bindings.range.length || Buffer.from(read.bytes, "base64").length < bindings.range.length) {
      anyUnknown = true;
      unknowns.push({ ref: source.sourceId, reason: "range read was short of the requested length" });
      classes.push({ kind: "unknown", index: index as 0 | 1, reason: "short" });
      return;
    }
    if (read.bytesRead > bindings.range.length || Buffer.from(read.bytes, "base64").length > bindings.range.length) {
      anyUnknown = true;
      unknowns.push({ ref: source.sourceId, reason: "range read returned more bytes than requested" });
      classes.push({ kind: "unknown", index: index as 0 | 1, reason: "stale" });
      return;
    }
    let decoded: Uint8Array;
    try {
      decoded = Buffer.from(read.bytes, "base64");
    } catch {
      anyUnknown = true;
      unknowns.push({ ref: source.sourceId, reason: "range read bytes are not decodable base64" });
      classes.push({ kind: "unknown", index: index as 0 | 1, reason: "stale" });
      return;
    }
    if (decoded.length !== bindings.range.length) {
      anyUnknown = true;
      unknowns.push({ ref: source.sourceId, reason: "range read returned a mismatched byte count" });
      classes.push({ kind: "unknown", index: index as 0 | 1, reason: "stale" });
      return;
    }
    const expected = Buffer.from(bindings.expectedBase64, "base64");
    if (expected.length !== bindings.range.length || !bytesEqual(decoded, expected)) {
      negatives.push("byte_mismatch");
      classes.push({ kind: "definitive_negative", index: index as 0 | 1, negative: "byte_mismatch" });
      return;
    }
    classes.push({ kind: "matched", index: index as 0 | 1, candidate: knowledge.candidate });
  });
  return Object.freeze({ classes, negatives, unknowns, anyUnknown });
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

function fileRefMatchesInspect(
  ref: ReadCompositionFileRef,
  inspected: ReadCompositionInspectedFact,
): boolean {
  return ref.type === "regular"
    && inspected.type === "regular"
    && ref.absolutePath === inspected.absolutePath
    && sameOsInteger(ref.identity.dev, inspected.identity.dev)
    && sameOsInteger(ref.identity.ino, inspected.identity.ino)
    && ref.sessionRevision === inspected.sessionRevision;
}

function planningInputForSources(
  bindings: Readonly<{
    sources: readonly [ReadCompositionSourceSpec, ReadCompositionSourceSpec];
  }>,
  legal: readonly (0 | 1)[],
  unknowns: readonly { ref: string; reason: string }[],
): PlanningDecisionInput {
  const candidates: PlanningDecisionInputCandidate[] = legal.map(index => ({
    pathId: `source:${index}`,
    rankOrder: bindings.sources[index] === undefined ? null : bindings.sources[index].order,
    projection: Object.freeze({
      terminalSatisfaction: null,
      riskLevels: Object.freeze([]),
      maximumCost: 2,
      costUnit: "step",
      unknownRefs: Object.freeze([]),
      coverage: "covered",
    }),
    attemptOrder: Object.freeze([
      Object.freeze({
        order: 0,
        nodeRef: `source:${index}:inspect`,
        skillRef: Object.freeze({ id: READ_INSPECT_ATOMIC_SKILL, version: "1.0.0" }),
      }),
      Object.freeze({
        order: 1,
        nodeRef: `source:${index}:read`,
        skillRef: Object.freeze({ id: READ_READ_ATOMIC_SKILL, version: "1.0.0" }),
      }),
    ]),
  }));
  return Object.freeze({
    preference: Object.freeze({
      kind: "order_first",
      projectionScaleRef: Object.freeze({ id: "goal.expected-satisfaction", version: "1" }),
    }),
    candidates,
    priorInfluences: Object.freeze([]),
    unknown: Object.freeze(unknowns.map(item => Object.freeze(item))),
  });
}

function sameDirectoryRef(left: ReadCompositionSourceSpec["directory"], right: ReadCompositionSourceSpec["directory"]): boolean {
  const leftKey = readCompositionDirectoryKey(left);
  const rightKey = readCompositionDirectoryKey(right);
  return leftKey === rightKey;
}

function closeMulti(
  classified: ReturnType<typeof classifySources>,
  phase: string,
) {
  return Object.freeze({
    conditions: Object.freeze([]),
    nextCursor: Object.freeze({
      phase: "closed",
      chosen: null,
      decision: cursorDecisionFor(classified, null),
    }),
    expansion: "closed" as const,
  });
}

function closeMultiDefer(
  ranking: PathRanking,
  phase: string,
) {
  return Object.freeze({
    conditions: Object.freeze([]),
    nextCursor: Object.freeze({
      phase: "closed",
      chosen: null,
      decision: Object.freeze({
        kind: "defer",
        chosen: null,
        missingKeys: ranking.kind === "defer" ? ranking.missingKeys : Object.freeze([]),
      }),
    }),
    expansion: "closed" as const,
  });
}

function closeMultiMatched(phase: string) {
  return Object.freeze({
    conditions: Object.freeze([]),
    nextCursor: Object.freeze({
      phase: "closed",
      chosen: null,
      decision: null,
    }),
    expansion: "closed" as const,
  });
}

function closeMultiFinal(
  phase: string,
  fallback: Readonly<{ kind: string; index?: 0 | 1; reason?: string }>,
) {
  return Object.freeze({
    conditions: Object.freeze([]),
    nextCursor: Object.freeze({
      phase: "closed",
      chosen: null,
      decision: null,
    }),
    expansion: "closed" as const,
  });
}

function closeMultiRejected(phase: string) {
  return Object.freeze({
    conditions: Object.freeze([]),
    nextCursor: Object.freeze({
      phase: "rejected",
      chosen: null,
      decision: null,
    }),
    expansion: "closed" as const,
  });
}

function cursorDecisionFor(
  classified: ReturnType<typeof classifySources>,
  chosen: "source:0" | "source:1" | null,
): Readonly<{ kind: "ranked" | "defer"; chosen: "source:0" | "source:1" | null; missingKeys: readonly string[] }> | null {
  return chosen === null
    ? null
    : Object.freeze({ kind: "ranked", chosen, missingKeys: Object.freeze([]) });
}

function inspectConditionFor(
  index: 0 | 1,
  bindings: Readonly<{
    session: SessionRef;
    sources: readonly [ReadCompositionSourceSpec, ReadCompositionSourceSpec];
    name: string;
    requiredType: "regular";
    range: Readonly<{ offset: number; length: number }>;
    expectedBase64: string;
  }>,
  phase: string,
  ranking?: PathRanking | Readonly<{ kind: "ranked" | "defer"; chosen: "source:0" | "source:1" | null; missingKeys: readonly string[] }> | null,
  nextPhase = "inspected",
) {
  const source = bindings.sources[index];
  return Object.freeze({
    conditions: Object.freeze([
      condition(
        `verify-matched-entry-${index}`,
        inspectGoal(
          { directory: source.directory, name: bindings.name },
          join(
            "absolutePath" in source.directory
              ? source.directory.absolutePath
              : source.directory.path,
            bindings.name,
          ),
        ),
        source,
        READ_INSPECT_SELECTOR,
        READ_INSPECT_EVALUATOR,
        EFFECTS,
      ),
    ]),
    nextCursor: Object.freeze({
      phase: nextPhase,
      chosen: index,
      decision: issueDecisionRecord(ranking),
    }),
    expansion: "more" as const,
  });
}

function issueDecisionRecord(
  ranking: PathRanking | Readonly<{ kind: "ranked" | "defer"; chosen: "source:0" | "source:1" | null; missingKeys: readonly string[] }> | null | undefined,
): ReadCompositionDecisionRecord | null {
  if (ranking === null || ranking === undefined) return null;
  if ("chosen" in ranking) {
    return Object.freeze({
      kind: ranking.kind,
      chosen: ranking.chosen,
      missingKeys: ranking.missingKeys,
    });
  }
  if (ranking.kind === "defer") {
    return Object.freeze({ kind: "defer", chosen: null, missingKeys: ranking.missingKeys });
  }
  const first = ranking.pathRefs[0] as "source:0" | "source:1" | undefined;
  return Object.freeze({
    kind: "ranked",
    chosen: first === undefined ? null : first,
    missingKeys: Object.freeze([]),
  });
}


async function evaluateRoot(
  input: EvaluationInput<unknown, ReadCompositionState, unknown, ReadCompositionEvidencePayload>,
  request: ReadCompositionRequest,
): Promise<EvaluationReceipt> {
  const bindings = input.bindings as ReadCompositionBindings;
  const evidenceRefs = stateEvidenceRefs(input.state, input.evidence);
  const decision = decideReadRoot(
    input.state,
    bindings.name,
    Buffer.from(bindings.expectedBase64, "base64"),
    bindings.range,
    transitionsOf(input.evidence),
  );
  if (decision.result === "satisfied") {
    return evaluation(READ_ROOT_EVALUATOR, "satisfied", 100, evidenceRefs);
  }
  if (decision.result === "unsatisfied") {
    return evaluation(READ_ROOT_EVALUATOR, "unsatisfied", 0, []);
  }
  return evaluation(READ_ROOT_EVALUATOR, "unknown", null, []);
}

async function evaluateMultiRoot(
  input: EvaluationInput<unknown, ReadCompositionState, unknown, ReadCompositionEvidencePayload>,
): Promise<EvaluationReceipt> {
  const bindings = input.bindings as Readonly<{
    name: string;
    range: Readonly<{ offset: number; length: number }>;
    expectedBase64: string;
  }>;
  const evidenceRefs = stateEvidenceRefs(input.state, input.evidence);
  const facts = classifySources(input.state, {
    name: bindings.name,
    range: bindings.range,
    expectedBase64: bindings.expectedBase64,
  });
  if (facts.classes.some(item => item.kind === "matched")) {
    return evaluation(READ_MULTI_ROOT_EVALUATOR, "satisfied", 100, evidenceRefs);
  }
  if (
    !facts.anyUnknown
    && facts.classes.length === 2
    && facts.classes.every(item => item.kind === "definitive_negative")
  ) {
    return evaluation(READ_MULTI_ROOT_EVALUATOR, "unsatisfied", 0, []);
  }
  return evaluation(READ_MULTI_ROOT_EVALUATOR, "unknown", null, []);
}

function transitionsOf(evidence: readonly { payload: ReadCompositionEvidencePayload }[]): readonly CliCommandTransition[] {
  const transitions = evidence
    .flatMap(item =>
      item.payload.kind === "cli.read-composition.transition.v1"
        ? [item.payload.transition]
        : [],
    );
  return Object.freeze([...transitions]);
}

async function evaluateList(input: EvaluationInput<unknown, ReadCompositionState, unknown, ReadCompositionEvidencePayload>): Promise<EvaluationReceipt> {
  const sourceBindings = input.bindings as ReadCompositionSourceSpec;
  const sourceIndex = input.state.sources === null
    ? null
    : sourceIndexForDirectory(input.state, sourceBindings.directory);
  const listing = sourceIndex === null
    ? input.state.listing
    : input.state.sources?.[sourceIndex].listing ?? null;
  if (
    listing !== null &&
    listing.coverage === "complete" &&
    listing.errors.length === 0 &&
    listing.sourceRun !== null
  ) {
    const evidenceRefs = stateEvidenceRefs(input.state, input.evidence);
    return evaluation(READ_LIST_EVALUATOR, "satisfied", 100, evidenceRefs);
  }
  return evaluation(READ_LIST_EVALUATOR, "unknown", null, []);
}

async function evaluateInspect(input: EvaluationInput<unknown, ReadCompositionState, unknown, ReadCompositionEvidencePayload>): Promise<EvaluationReceipt> {
  const goal = input.goal as ReadCompositionInspectGoal;
  const knowledge = input.state.cli.entryKnowledge;
  if (
    knowledge !== null &&
    knowledge !== undefined &&
    knowledge.kind === "entry.inspect" &&
    knowledge.query.followSymlinks === false &&
    knowledge.query.ref.kind === "cli.path" &&
    knowledge.query.ref.path === goal.target.ref.path &&
    knowledge.query.ref.scenarioId === goal.target.ref.scenarioId &&
    knowledge.query.ref.sessionId === goal.target.ref.sessionId &&
    knowledge.entryExists === true &&
    knowledge.observedWith !== null &&
    knowledge.type !== null &&
    knowledge.identity.dev !== null &&
    knowledge.identity.ino !== null
  ) {
    const evidenceRefs = stateEvidenceRefs(input.state, input.evidence);
    return evaluation(READ_INSPECT_EVALUATOR, "satisfied", 100, evidenceRefs);
  }
  return evaluation(READ_INSPECT_EVALUATOR, "unknown", null, []);
}

async function evaluateRead(input: EvaluationInput<unknown, ReadCompositionState, unknown, ReadCompositionEvidencePayload>): Promise<EvaluationReceipt> {
  const goal = input.goal as ReadCompositionReadGoal;
  const sourceIndex = sourceIndexForFileRef(
    input.state,
    goal.target.ref as ReadCompositionFileRef,
  );
  const read = sourceIndex === null
    ? input.state.read
    : input.state.sources?.[sourceIndex].read ?? null;
  const staleRefused = read === null && input.evidence.some(item =>
    item.payload.kind === "cli.read-composition.read.v1"
    && item.payload.receipt.execution.status === "failed"
    && staleReadNativeCode(item.payload.receipt.execution.error.code)
    && item.payload.ref.sourceRun === goal.target.ref.sourceRun
    && item.payload.ref.absolutePath === goal.target.ref.absolutePath
    && sameOsInteger(item.payload.ref.identity.dev, goal.target.ref.identity.dev)
    && sameOsInteger(item.payload.ref.identity.ino, goal.target.ref.identity.ino),
  );
  if (staleRefused) {
    // The observed-condition is complete: the target was inspected, then the
    // open refused a changed identity. Root equality stays unknown.
    const evidenceRefs = stateEvidenceRefs(input.state, input.evidence);
    return evaluation(READ_READ_EVALUATOR, "satisfied", 100, evidenceRefs);
  }
  if (process.env.NN_DEBUG_READ_EVAL === "1") {
    console.error("DEBUG_READ_EVAL", JSON.stringify({
      hasRead: read !== null,
      read,
      goalRefSourceRun: goal.target.ref.sourceRun,
      stateFileRef: input.state.fileRef,
    }));
  }
  if (
    read !== null &&
    read.sourceRun !== null &&
    read.refSourceRun === goal.target.ref.sourceRun &&
    read.revision === goal.target.ref.sessionRevision &&
    read.offset === goal.requirement.range.offset &&
    read.length === goal.requirement.range.length &&
    read.bytes !== null &&
    read.bytesRead !== null &&
    read.eof !== null &&
    read.identity.dev !== null &&
    read.identity.ino !== null
  ) {
    const evidenceRefs = stateEvidenceRefs(input.state, input.evidence);
    return evaluation(READ_READ_EVALUATOR, "satisfied", 100, evidenceRefs);
  }
  return evaluation(READ_READ_EVALUATOR, "unknown", null, []);
}

function supports(input: SupportsInput<unknown, unknown>): boolean {
  if (input.skill.id === READ_ROOT_COMPOSITE_SKILL) {
    return isRootGoal(input.goal);
  }
  if (input.skill.id === READ_MULTI_COMPOSITE_SKILL) {
    return isMultiRootGoal(input.goal);
  }
  if (input.skill.id === READ_LIST_ATOMIC_SKILL) {
    return isListGoal(input.goal);
  }
  if (input.skill.id === READ_INSPECT_ATOMIC_SKILL) {
    return isInspectGoal(input.goal);
  }
  if (input.skill.id === READ_READ_ATOMIC_SKILL) {
    return isReadGoal(input.goal);
  }
  return false;
}

function isRootGoal(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.kind === "file.property"
    && value.property === "file.property.content.bytes"
    && isRecord(value.target)
    && value.target.kind === "cli.exact-child"
    && isRecord(value.requirement)
    && value.requirement.kind === "equals";
}

function isMultiRootGoal(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.kind === "file.property"
    && value.property === "file.property.content.bytes"
    && isRecord(value.target)
    && value.target.kind === "cli.exact-child-sources"
    && isRecord(value.requirement)
    && value.requirement.kind === "equals";
}

function isListGoal(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.kind === "file.property"
    && value.property === "file.property.directory.entries"
    && isRecord(value.requirement)
    && value.requirement.kind === "observed";
}

function isInspectGoal(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.kind === "file.property"
    && value.property === "file.property.type"
    && isRecord(value.target)
    && value.target.kind === "cli.entry-query"
    && value.target.followSymlinks === false;
}

function isReadGoal(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.kind === "file.property"
    && value.property === "file.property.content.bytes"
    && isRecord(value.target)
    && value.target.kind === "cli.file"
    && isRecord(value.requirement)
    && value.requirement.kind === "observed";
}

async function select(input: SelectionInput<unknown, ReadCompositionState, unknown, ReadCompositionEvidencePayload>) {
  const first = input.candidates[0];
  const selection = first === undefined
    ? { kind: "no_capability" as const, searchedSkillIds: [] }
    : { kind: "selected" as const, skillId: first.id };
  return selection;
}

function condition(
  id: string,
  goal: unknown,
  bindings: unknown,
  selectorId: string,
  evaluatorId: string,
  allowedEffects: readonly string[],
) {
  return Object.freeze({
    id,
    goal,
    bindings,
    satisfactionThreshold: 100,
    evaluatorId,
    selectorId,
    mode: "atomic" as const,
    dependsOn: Object.freeze([]),
    lifetime: "stage" as const,
    activation: "required" as const,
    allowedEffects: Object.freeze([...allowedEffects]),
  });
}

type MultiChainCategory = "matched" | "negative" | "unknown" | "rejected" | "failed" | "interrupted";

const STALE_READ_NATIVE_CODES = Object.freeze(["READ_TARGET_CHANGED", "STALE_REFERENCE"]);

function staleReadNativeCode(value: unknown): boolean {
  return typeof value === "string" && STALE_READ_NATIVE_CODES.includes(value);
}

function evidenceControlCategory(
  input: Pick<DerivationInput<unknown, ReadCompositionState, unknown, ReadCompositionEvidencePayload, unknown>, "evidence" | "context">,
): MultiChainCategory | null {
  if (input.context.signal?.aborted === true) return "interrupted";
  for (const record of input.evidence) {
    const payload = record.payload;
    if (payload.kind === "cli.read-composition.transition.v1") {
      if (payload.transition.status === "rejected") return "rejected";
      if (payload.transition.status === "failed") return "failed";
      continue;
    }
    if (payload.receipt.execution.status === "failed") {
      return staleReadNativeCode(payload.receipt.execution.error.code) ? "unknown" : "failed";
    }
  }
  return null;
}

function sourceCandidateFor(
  source: ReadCompositionSourceState,
  name: string,
): ReadCompositionCandidate | null {
  if (source.listing === null || source.listing.coverage !== "complete") return null;
  const matches = source.listing.entries.filter(entry => entry.name === name);
  if (matches.length !== 1) return null;
  const entry = matches[0] as ReadCompositionListingFact["entries"][number] | undefined;
  if (entry === undefined) return null;
  return Object.freeze({
    name: entry.name,
    path: entry.path,
    listedType: entry.type,
    listingRun: source.listing.sourceRun,
  });
}

function alternateIndex(
  state: ReadCompositionState,
  bindings: Readonly<{ name: string; sources: readonly [ReadCompositionSourceSpec, ReadCompositionSourceSpec] }>,
  chosen: 0 | 1,
): 0 | 1 | null {
  const alternate = chosen === 0 ? 1 : 0;
  if (state.sources === null) return null;
  const source = state.sources[alternate];
  return source !== undefined && source.inspected === null && sourceCandidateFor(source, bindings.name) !== null
    ? alternate
    : null;
}

function chainStatus(
  input: DerivationInput<unknown, ReadCompositionState, unknown, ReadCompositionEvidencePayload, unknown>,
  bindings: Readonly<{
    name: string;
    range: Readonly<{ offset: number; length: number }>;
    expectedBase64: string;
  }>,
  chosen: 0 | 1,
): Readonly<{ matched: boolean; category: MultiChainCategory }> {
  const control = evidenceControlCategory(input);
  if (control !== null) {
    return Object.freeze({ matched: false, category: control });
  }
  const facts = classifyMultiSources(
    input.state,
    bindings.name,
    Buffer.from(bindings.expectedBase64, "base64"),
    bindings.range,
  );
  const fact = facts.find(item => item.sourceId === `source:${chosen}` as "source:0" | "source:1");
  if (fact === undefined) {
    return Object.freeze({ matched: false, category: "unknown" });
  }
  if (fact.attempt === "matched") {
    return Object.freeze({ matched: true, category: "matched" });
  }
  if (fact.negative !== null) {
    return Object.freeze({ matched: false, category: "negative" });
  }
  return Object.freeze({ matched: false, category: "unknown" });
}

function fallbackState(
  input: DerivationInput<unknown, ReadCompositionState, unknown, ReadCompositionEvidencePayload, unknown>,
  bindings: Readonly<{
    name: string;
    sources: readonly [ReadCompositionSourceSpec, ReadCompositionSourceSpec];
  }>,
  chosen: 0 | 1 | null,
  chain: Readonly<{ matched: boolean; category: MultiChainCategory }>,
): Readonly<{ kind: "fallback"; index: 0 | 1 }> | Readonly<{ kind: "closed"; reason: string }> {
  if (chain.matched) {
    return Object.freeze({ kind: "closed", reason: "matched" });
  }
  if (chain.category === "rejected" || chain.category === "failed" || chain.category === "interrupted") {
    return Object.freeze({ kind: "closed", reason: chain.category });
  }
  if (chosen === null) {
    return Object.freeze({ kind: "closed", reason: "no_chosen_source" });
  }
  const alternate = alternateIndex(input.state, bindings, chosen);
  if (alternate === null) {
    return Object.freeze({ kind: "closed", reason: "no_alternate" });
  }
  return Object.freeze({ kind: "fallback", index: alternate });
}

async function fallbackInspectCondition(
  input: DerivationInput<unknown, ReadCompositionState, unknown, ReadCompositionEvidencePayload, unknown>,
  sandbox: CliFilesystemSandbox,
  bindings: Readonly<{
    session: SessionRef;
    sources: readonly [ReadCompositionSourceSpec, ReadCompositionSourceSpec];
    name: string;
    requiredType: "regular";
    range: Readonly<{ offset: number; length: number }>;
    expectedBase64: string;
  }>,
  phase: string,
  fallback: Readonly<{ kind: "fallback"; index: 0 | 1 }>,
  decision: ReadCompositionDecisionRecord | null,
) {
  try {
    await validateFallbackSource(
      sandbox,
      bindings.session,
      bindings.sources[fallback.index].directory,
      input.state.session.grantedEffects,
    );
  } catch {
    return closeMultiRejected(phase);
  }
  return inspectConditionFor(fallback.index, bindings, phase, decision, "inspected-alt");
}

function policyDirectoryRef(directory: DirectoryObjectRef, cwd: string): DirectoryRef {
  if ("absolutePath" in directory) {
    const path = relative(cwd, directory.absolutePath) || ".";
    return Object.freeze({
      kind: "cli.directory",
      scenarioId: directory.scenarioId,
      sessionId: directory.sessionId,
      path,
    });
  }
  return directory;
}

function listGoal(bindings: unknown, cwd: string): ReadCompositionListGoal {
  const input = bindings as Readonly<{ directory: DirectoryObjectRef }>;
  return Object.freeze({
    kind: "file.property",
    property: "file.property.directory.entries",
    target: policyDirectoryRef(input.directory, cwd),
    requirement: Object.freeze({ kind: "observed", freshness: "this_run" }),
  });
}

function inspectGoal(bindings: unknown, candidatePath: string): ReadCompositionInspectGoal {
  const input = bindings as Readonly<{ directory: { scenarioId: string; sessionId: string } }>;
  const ref: PathRef = Object.freeze({
    kind: "cli.path",
    scenarioId: input.directory.scenarioId,
    sessionId: input.directory.sessionId,
    path: candidatePath,
  });
  return Object.freeze({
    kind: "file.property",
    property: "file.property.type",
    target: Object.freeze({
      kind: "cli.entry-query",
      ref,
      followSymlinks: false,
    }),
    requirement: Object.freeze({ kind: "observed", freshness: "this_run" }),
  });
}

function readGoalFromBindings(bindings: unknown, ref: ObservedObjectRef): ReadCompositionReadGoal {
  const input = bindings as ReadCompositionBindings;
  return Object.freeze({
    kind: "file.property",
    property: "file.property.content.bytes",
    target: Object.freeze({
      kind: "cli.file",
      ref,
      requiredType: "regular",
    }),
    requirement: Object.freeze({
      kind: "observed",
      range: input.range,
    }),
  });
}

async function derive(
  input: DerivationInput<unknown, ReadCompositionState, unknown, ReadCompositionEvidencePayload, unknown>,
  decisionBinding: PlanningDecisionBinding,
  sandbox: CliFilesystemSandbox,
) {
  if (!isRootGoal(input.goal) && !isMultiRootGoal(input.goal)) {
    throw new TypeError("read composition composite derivation received an incompatible frame");
  }
  if (input.skill.id === READ_ROOT_COMPOSITE_SKILL && isRootGoal(input.goal)) {
    const cursor = input.cursor as Readonly<{ phase: "listed" | "inspected" | "read" | "closed" }> | null;
    const phase = cursor === null ? "initial" : cursor.phase;
    const bindings = input.bindings as ReadCompositionBindings;
    const listing = listingKnowledge(input.state, bindings);
    if (phase === "initial") {
      return Object.freeze({
        conditions: Object.freeze([
          condition(
            "observe-direct-entries",
            listGoal(input.bindings, input.state.session.cwd),
            input.bindings,
            READ_LIST_SELECTOR,
            READ_LIST_EVALUATOR,
            EFFECTS,
          ),
        ]),
        nextCursor: Object.freeze({ phase: "listed" }),
        expansion: "more",
      });
    }
    if (
      phase === "listed" &&
      listing.coverage === "complete" &&
      listing.candidate !== null
    ) {
      return Object.freeze({
        conditions: Object.freeze([
          condition(
            "verify-matched-entry",
            inspectGoal(input.bindings, listing.candidate.path),
            input.bindings,
            READ_INSPECT_SELECTOR,
            READ_INSPECT_EVALUATOR,
            EFFECTS,
          ),
        ]),
        nextCursor: Object.freeze({ phase: "inspected" }),
        expansion: "more",
      });
    }
    if (
      phase === "inspected" &&
      input.state.fileRef !== null
    ) {
      return Object.freeze({
        conditions: Object.freeze([
          condition(
            "read-trusted-range",
            readGoalFromBindings(input.bindings, input.state.fileRef),
            input.bindings,
            READ_READ_SELECTOR,
            READ_READ_EVALUATOR,
            ["filesystem.read"],
          ),
        ]),
        nextCursor: Object.freeze({ phase: "read" }),
        expansion: "more",
      });
    }
    return Object.freeze({
      conditions: Object.freeze([]),
      nextCursor: Object.freeze({ phase: "closed" }),
      expansion: "closed",
    });
  }
  if (input.skill.id === READ_MULTI_COMPOSITE_SKILL && isMultiRootGoal(input.goal)) {
    return deriveMulti(input, decisionBinding, sandbox);
  }
  throw new TypeError("read composition composite derivation received an incompatible frame");
}

async function deriveMulti(
  input: DerivationInput<unknown, ReadCompositionState, unknown, ReadCompositionEvidencePayload, unknown>,
  decisionBinding: PlanningDecisionBinding,
  sandbox: CliFilesystemSandbox,
) {
  if (input.state.sources === null) {
    throw new TypeError("multi-source composition state requires sources");
  }
  const bindings = input.bindings as Readonly<{
    session: SessionRef;
    sources: readonly [ReadCompositionSourceSpec, ReadCompositionSourceSpec];
    name: string;
    requiredType: "regular";
    range: Readonly<{ offset: number; length: number }>;
    expectedBase64: string;
  }>;
  const cursor = input.cursor as Readonly<{ phase: string; chosen: 0 | 1 | null; decision: ReadCompositionDecisionRecord | null }> | null;
  const phase = cursor === null ? "initial" : cursor.phase;
  const chosen = cursor?.chosen ?? null;
  const stateSources = input.state.sources;
  if (stateSources === null) {
    throw new TypeError("multi-source composition state requires sources");
  }

  if (phase === "initial") {
    return Object.freeze({
      conditions: Object.freeze([
        condition(
          "observe-direct-entries-0",
          listGoal(bindings.sources[0], input.state.session.cwd),
          bindings.sources[0],
          READ_LIST_SELECTOR,
          READ_LIST_EVALUATOR,
          EFFECTS,
        ),
        condition(
          "observe-direct-entries-1",
          listGoal(bindings.sources[1], input.state.session.cwd),
          bindings.sources[1],
          READ_LIST_SELECTOR,
          READ_LIST_EVALUATOR,
          EFFECTS,
        ),
      ]),
      nextCursor: Object.freeze({ phase: "listed", chosen: null, decision: null }),
      expansion: "more",
    });
  }

  const classified = classifySources(input.state, bindings);
  const legal = classified.classes.filter(item => item.kind === "legal") as Extract<SourceClass, { kind: "legal" }>[];

  if (phase === "listed") {
    if (legal.length === 0) {
      return closeMulti(classified, phase);
    }
    if (legal.length === 1 && legal[0] !== undefined) {
      return inspectConditionFor(
        legal[0].index,
        bindings,
        phase,
        Object.freeze({ kind: "ranked", pathRefs: Object.freeze([`source:${legal[0].index}` as const]) }),
      );
    }
    const ranking = await decisionBinding.infer(
      planningInputForSources(bindings, legal.map(item => item.index), classified.unknowns),
    );
    if (ranking.kind === "defer") {
      return closeMultiDefer(ranking, phase);
    }
    const chosen = ranking.pathRefs[0];
    const chosenIndex = chosen === "source:1" ? 1 : 0;
    const chosenClass = legal.find(item => item.index === chosenIndex);
    if (chosenClass === undefined) {
      throw new TypeError("planning ranking chose a source outside the legal candidate set");
    }
    return inspectConditionFor(chosenIndex, bindings, phase, ranking);
  }

  const attempted = [0, 1].map(index => stateSources[index]);
  const matchedClass = classified.classes.find(item => item.kind === "matched");
  if (matchedClass !== undefined) {
    return closeMultiMatched(phase);
  }

  if (phase === "inspected") {
    const source = chosen === null ? undefined : attempted[chosen];
    if (source !== undefined && source.fileRef !== null) {
      return Object.freeze({
        conditions: Object.freeze([
          condition(
            `read-trusted-range-${source.sourceId}`,
            readGoalFromBindings(bindings, source.fileRef),
            bindings,
            READ_READ_SELECTOR,
            READ_READ_EVALUATOR,
            ["filesystem.read"],
          ),
        ]),
        nextCursor: Object.freeze({
          phase: "read",
          chosen,
          decision: cursor?.decision ?? null,
        }),
        expansion: "more",
      });
    }
    if (chosen !== null) {
      const chain = chainStatus(input, bindings, chosen);
      const fallback = fallbackState(input, bindings, chosen, chain);
      if (fallback.kind === "fallback") {
        return fallbackInspectCondition(input, sandbox, bindings, phase, fallback, cursor?.decision ?? null);
      }
      return closeMultiFinal(phase, fallback);
    }
  }
  if (phase === "inspected-alt") {
    const source = chosen === null ? undefined : attempted[chosen];
    if (source !== undefined && source.fileRef !== null) {
      return Object.freeze({
        conditions: Object.freeze([
          condition(
            `read-trusted-range-${source.sourceId}`,
            readGoalFromBindings(bindings, source.fileRef),
            bindings,
            READ_READ_SELECTOR,
            READ_READ_EVALUATOR,
            ["filesystem.read"],
          ),
        ]),
        nextCursor: Object.freeze({
          phase: "read-alt",
          chosen,
          decision: cursor?.decision ?? null,
        }),
        expansion: "more",
      });
    }
    if (chosen !== null) {
      const chain = chainStatus(input, bindings, chosen);
      return closeMultiFinal(phase, fallbackState(input, bindings, chosen, chain));
    }
  }

  if (phase === "read" || phase === "read-alt") {
    if (chosen === null) {
      return closeMultiFinal(phase, { kind: "no_chosen_source" });
    }
    const chain = chainStatus(input, bindings, chosen);
    if (chain.matched) return closeMultiMatched(phase);
    const fallback = fallbackState(input, bindings, chosen, chain);
    if (fallback.kind === "fallback") {
      return fallbackInspectCondition(input, sandbox, bindings, phase, fallback, cursor?.decision ?? null);
    }
    return closeMultiFinal(phase, fallback);
  }

  if (phase === "fallback-basis") {
    const alt = chosen === null ? null : alternateIndex(input.state, bindings, chosen);
    if (alt === null) return closeMultiFinal("fallback-basis", { kind: "no_fallback" });
    const source = input.state.sources[alt];
    if (source !== undefined && source.fileRef !== null) {
      return Object.freeze({
        conditions: Object.freeze([
          condition(
            `read-trusted-range-${source.sourceId}`,
            readGoalFromBindings(bindings, source.fileRef),
            bindings,
            READ_READ_SELECTOR,
            READ_READ_EVALUATOR,
            ["filesystem.read"],
          ),
        ]),
        nextCursor: Object.freeze({
          phase: "read-alt",
          chosen: alt,
          decision: cursor?.decision ?? null,
        }),
        expansion: "more",
      });
    }
    return closeMultiFinal("fallback-basis", { kind: "no_fallback" });
  }

  return closeMulti(classified, phase);
}

async function validateFallbackSource(
  sandbox: CliFilesystemSandbox,
  session: SessionRef,
  directory: ReadCompositionSourceSpec["directory"],
  recordedEffects: readonly string[],
): Promise<void> {
  const current = sandbox.getSession(session);
  if (
    !current.grantedEffects.includes("filesystem.read")
    || current.grantedEffects.length !== recordedEffects.length
    || current.grantedEffects.some(effect => !recordedEffects.includes(effect))
  ) {
    throw Object.assign(new TypeError("read composition fallback source no longer grants filesystem.read"), {
      code: "EFFECT_DENIED",
    });
  }
  if ("absolutePath" in directory) {
    await sandbox.validateObservedObject(directory);
  } else {
    await sandbox.validateDirectoryRef(directory);
  }
  await sandbox.resolveDirectory(policyDirectoryRef(directory, current.cwd));
}

async function validateDirectoryBinding(
  input: Readonly<{
    sandbox: CliFilesystemSandbox;
    rootBindings: unknown;
  }>,
): Promise<void> {
  const bindings = input.rootBindings as Readonly<{
    session: SessionRef;
    directory?: DirectoryObjectRef;
    sources?: readonly [ReadCompositionSourceSpec, ReadCompositionSourceSpec];
  }>;
  if (
    bindings.sources !== undefined &&
    sameDirectoryRef(bindings.sources[0].directory, bindings.sources[1].directory)
  ) {
    throw new TypeError("read composition request sources directories must differ");
  }
  const directories = bindings.sources !== undefined
    ? bindings.sources.map(source => source.directory)
    : bindings.directory === undefined
      ? []
      : [bindings.directory];
  for (const directory of directories) {
    if ("absolutePath" in directory) {
      await input.sandbox.validateObservedObject(directory);
    } else {
      await input.sandbox.validateDirectoryRef(directory);
    }
    const cwd = input.sandbox.getSession(bindings.session).cwd;
    await input.sandbox.resolveDirectory(policyDirectoryRef(directory, cwd));
  }
}

function executeList(
  policy: CliCommandPolicy,
  input: Readonly<{
    goal: ReadCompositionListGoal;
    satisfactionThreshold: number;
    state: ReadCompositionState;
  }>,
) {
  return policy.step({
    goal: input.goal,
    satisfactionThreshold: input.satisfactionThreshold,
    state: input.state.cli,
  });
}

function executeInspect(
  policy: CliCommandPolicy,
  input: Readonly<{
    goal: ReadCompositionInspectGoal;
    satisfactionThreshold: number;
    state: ReadCompositionState;
  }>,
) {
  return policy.step({
    goal: input.goal,
    satisfactionThreshold: input.satisfactionThreshold,
    state: input.state.cli,
  });
}

async function executeRead(
  sandbox: CliFilesystemSandbox,
  input: Readonly<{
    goal: ReadCompositionReadGoal;
    state: ReadCompositionState;
  }>,
) {
  return sandbox.execute({
    operation: "file.read",
    parameters: {
      ref: input.goal.target.ref,
      offset: input.goal.requirement.range.offset,
      length: input.goal.requirement.range.length,
    },
  });
}

function transitionId(requestId: string, sequence: number): string {
  return `${requestId}:transition-${sequence}`;
}

function evidenceId(requestId: string, sequence: number): string {
  return `${requestId}:evidence-${sequence}`;
}

function transitionDiagnostics(transition: CliCommandTransition, id: string): {
  executionErrors: readonly AdapterDiagnostic[];
  verificationErrors: readonly AdapterDiagnostic[];
} {
  const executionErrors: AdapterDiagnostic[] = [];
  const verificationErrors: AdapterDiagnostic[] = [];
  if (missingEntryObservation(transition)) {
    const knowledge = transition.observed_state_after.entryKnowledge;
    verificationErrors.push({
      diagnosticId: `${id}:postcommit-observation`,
      code: "evidence_unavailable",
      stage: "observation",
      sourceCategory: "cli.entry_inspection",
      message: `matched entry disappeared before inspection: ${knowledge?.errno ?? "ENOENT"}`,
      nativeCode: knowledge?.errno ?? "ENOENT",
      refs: Object.freeze([id]),
    });
    return { executionErrors, verificationErrors };
  }
  if (transition.status === "rejected" && transition.reason !== "unexpected_head") {
    const receipt = transition.execution_result.receipt;
    const failure = receipt?.execution.status === "failed" ? receipt.execution.error : null;
    executionErrors.push({
      diagnosticId: `${id}:binding`,
      code: failure?.code === "EFFECT_DENIED" ? "effect_denied" : "invalid_binding",
      stage: "binding",
      sourceCategory: "cli.directory_binding",
      message: failure?.message ?? (transition.reason.length === 0 ? "read command rejected" : transition.reason),
      nativeCode: failure?.code ?? null,
      refs: Object.freeze([id]),
    });
  } else if (transition.status === "failed") {
    const receipt = transition.execution_result.receipt;
    const failure = receipt?.execution.status === "failed" ? receipt.execution.error : null;
    executionErrors.push({
      diagnosticId: `${id}:execution`,
      code: "execution_failed",
      stage: "execution",
      sourceCategory: "cli.command_execution",
      message: failure?.message ?? (transition.reason.length === 0 ? "read command failed" : transition.reason),
      nativeCode: failure?.code ?? null,
      refs: Object.freeze([id]),
    });
  }
  if (transition.reason === "postcommit_observation_failed") {
    const receipt = transition.postcondition?.receipt ?? null;
    const failure = receipt?.execution.status === "failed" ? receipt.execution.error : null;
    verificationErrors.push({
      diagnosticId: `${id}:postcommit-observation`,
      code: "evidence_unavailable",
      stage: "observation",
      sourceCategory: "cli.postcommit_observation",
      message: failure?.message ?? "postcommit observation failed",
      nativeCode: failure?.code ?? null,
      refs: Object.freeze([id]),
    });
  }
  return { executionErrors, verificationErrors };
}

function missingEntryObservation(transition: CliCommandTransition): boolean {
  if (transition.goal.property !== "file.property.type") return false;
  const knowledge = transition.observed_state_after.entryKnowledge;
  return knowledge?.kind === "entry.inspect" && knowledge.entryExists === false;
}

function outcomeOf(transition: CliCommandTransition): "succeeded" | "failed" | "rejected" | "unknown" {
  if (missingEntryObservation(transition)) return "succeeded";
  if (transition.status === "achieved") return "succeeded";
  if (transition.status === "unknown") return "unknown";
  if (transition.status === "rejected") return "rejected";
  return "failed";
}

function listingFromTransition(transition: CliCommandTransition): ReadCompositionState["listing"] {
  const receipt = transition.execution_result.receipt;
  if (receipt?.execution.status !== "succeeded") return null;
  const observation = receipt.execution.observation;
  if (observation.kind !== "directory.list") return null;
  return Object.freeze({
    sourceRun: receipt.execution.runId,
    coverage: observation.coverage,
    directoryRef: null,
    errors: Object.freeze(
      observation.errors.map(error => `${error.name}:${error.code}:${error.message}`),
    ),
    candidateNames: Object.freeze([]),
    entries: Object.freeze(
      observation.entries.map(entry => Object.freeze({
        name: entry.name,
        path: entry.path,
        type: entry.type,
      })),
    ),
  });
}

function candidateFromListing(
  listing: ReadCompositionState["listing"],
  name: string,
): ReadCompositionCandidate | null {
  if (listing === null || listing.coverage !== "complete") return null;
  const entry = (() => {
    const matches = listing.entries.filter(entry => entry.name === name);
    return matches.length === 1 ? matches[0] : undefined;
  })();
  if (entry === undefined) return null;
  return Object.freeze({
    name: entry.name,
    path: entry.path,
    listedType: entry.type,
    listingRun: listing.sourceRun,
  });
}

let stateSequence = 0;

function nextStateId(requestId: string): string {
  stateSequence += 1;
  return `${requestId}:state-${stateSequence}`;
}

function inspectedFromInspect(transition: CliCommandTransition): ReadCompositionState["inspected"] {
  const receipt = transition.execution_result.receipt;
  if (receipt?.execution.status !== "succeeded") return null;
  const observation = receipt.execution.observation;
  if (observation.kind !== "entry.inspect") return null;
  const snapshot = observation.snapshot;
  return Object.freeze({
    sourceRun: receipt.execution.runId,
    type: snapshot.kind,
    identity: Object.freeze({
      dev: snapshot.dev,
      ino: snapshot.ino,
    }),
    sessionRevision: transition.session_before.revision,
    absolutePath: observation.configuredPath,
  });
}

function readFactFromReceipt(
  receipt: Awaited<ReturnType<CliFilesystemSandbox["execute"]>>,
  refSourceRun: string | null,
  revision: number | null,
  ref: ReadCompositionFileRef,
): ReadCompositionReadFact | null {
  if (receipt.execution.status !== "succeeded") return null;
  const observation = receipt.execution.observation;
  if (observation.kind !== "file.read") return null;
  return Object.freeze({
    ref,
    sourceRun: receipt.execution.runId,
    refSourceRun,
    revision,
    offset: observation.offset,
    length: observation.length,
    bytes: observation.bytes,
    bytesRead: observation.bytesRead,
    size: observation.size,
    eof: observation.eof,
    identity: Object.freeze({
      dev: observation.identity.dev,
      ino: observation.identity.ino,
    }),
  });
}

function atomicReceipt(
  input: Readonly<{
    context: { requestId: string };
    sequence: number;
    transition: CliCommandTransition;
    expectedHead: string;
    session: SessionRef;
    state: ReadCompositionState;
    nextState?: ReadCompositionState | null;
  }>,
): AtomicReceipt<ReadCompositionState, ReadCompositionEvidencePayload, ReadCompositionEffectFact, ReadCompositionReceiptPayload> {
  const transition = input.transition;
  const id = transitionId(input.context.requestId, input.sequence);
  const nextId = nextStateId(input.context.requestId);
  const carried = input.nextState ?? input.state;
  const nextState = Object.freeze({
    id: nextId,
    value: Object.freeze({
      stateId: nextId,
      session: transition.session_after,
      cli: transition.observed_state_after,
      listing: carried.listing,
      candidate: carried.candidate,
      inspected: carried.inspected,
      fileRef: carried.fileRef,
      read: carried.read,
      sources: carried.sources,
    }),
  });
  const evidence = Object.freeze([
    Object.freeze({
      id: evidenceId(input.context.requestId, input.sequence),
      stateRef: nextState.id,
      payload: Object.freeze({
        kind: "cli.read-composition.transition.v1" as const,
        transitionId: id,
        stateId: nextState.id,
        transition,
      }),
      validity: "valid" as const,
    }),
  ]);
  const errors = transitionDiagnostics(transition, id);
  const effect: AtomicReceipt<ReadCompositionState, ReadCompositionEvidencePayload, ReadCompositionEffectFact, ReadCompositionReceiptPayload>["effect"] = Object.freeze({
    knowledge: "none",
    confirmedEffects: Object.freeze([]),
    receiptRef: null,
  });
  return Object.freeze({
    runId: transition.execution_result.receipt?.execution.runId ?? null,
    executorInvoked: transition.execution_result.executorInvoked,
    outcome: outcomeOf(transition),
    sourceResult: Object.freeze({
      tag: "cli.command.transition.v1",
      value: transition,
    }),
    newState: nextState,
    evidence,
    executionErrors: Object.freeze(errors.executionErrors),
    verificationErrors: Object.freeze(errors.verificationErrors),
    effect,
  });
}

function readAtomicReceiptFromSandbox(
  input: Readonly<{
    context: { requestId: string };
    sequence: number;
    receipt: Awaited<ReturnType<CliFilesystemSandbox["execute"]>>;
    session: SessionRef;
    state: ReadCompositionState;
    ref: ObservedObjectRef;
    expectedHead: "file.read";
    range: Readonly<{ offset: number; length: number }>;
    read: ReadCompositionReadFact | null;
  }>,
): AtomicReceipt<ReadCompositionState, ReadCompositionEvidencePayload, ReadCompositionEffectFact, ReadCompositionReceiptPayload> {
  const receipt = input.receipt;
  const id = transitionId(input.context.requestId, input.sequence);
  const nextId = nextStateId(input.context.requestId);
  const nextState = Object.freeze({
    id: nextId,
    value: Object.freeze({
      stateId: nextId,
      session: receipt.session_after,
      cli: input.state.cli,
      listing: input.state.listing,
      candidate: input.state.candidate,
      inspected: input.state.inspected,
      fileRef: null,
      read: input.read,
      sources: input.state.sources,
    }),
  });
  const failure = receipt.execution.status === "failed" ? receipt.execution.error : null;
  const stale = failure !== null && staleReadNativeCode(failure.code);
  // A stale target is an observed refusal, not a fatal command failure: keep the
  // refused receipt as evidence so the composition can try the alternate source.
  const executionErrors = failure === null || stale
    ? Object.freeze([])
    : Object.freeze([
        Object.freeze({
          diagnosticId: `${id}:execution`,
          code: "execution_failed" as const,
          stage: "execution" as const,
          sourceCategory: "cli.command_execution",
          message: failure.message,
          nativeCode: failure.code,
          refs: Object.freeze([id]),
        }),
      ]);
  const effect: AtomicReceipt<ReadCompositionState, ReadCompositionEvidencePayload, ReadCompositionEffectFact, ReadCompositionReceiptPayload>["effect"] = Object.freeze({
    knowledge: "none",
    confirmedEffects: Object.freeze([]),
    receiptRef: null,
  });
  const readReceipt = Object.freeze({
    kind: "cli.file.read.receipt.v1" as const,
    receipt,
    ref: input.ref as ReadCompositionFileRef,
  });
  return Object.freeze({
    runId: receipt.execution.runId,
    executorInvoked: receipt.execution.executorInvoked,
    outcome: failure === null || stale ? "succeeded" as const : "failed" as const,
    sourceResult: Object.freeze({
      tag: "cli.file.read.receipt.v1",
      value: readReceipt,
    }),
    newState: nextState,
    evidence: Object.freeze([
      Object.freeze({
        id: evidenceId(input.context.requestId, input.sequence),
        stateRef: nextState.id,
        payload: Object.freeze({
          kind: "cli.read-composition.read.v1" as const,
          transitionId: id,
          stateId: nextId,
          receipt,
          ref: input.ref as ReadCompositionFileRef,
        }),
        validity: "valid" as const,
      }),
    ]),
    executionErrors,
    verificationErrors: Object.freeze([]),
    effect,
  });
}

async function issueObservedRef(
  sandbox: CliFilesystemSandbox,
  session: SessionRef,
  transition: CliCommandTransition,
): Promise<ObservedObjectRef | null> {
  const receipt = transition.execution_result.receipt;
  if (receipt === null || receipt.execution.status !== "succeeded") return null;
  const observation = receipt.execution.observation;
  if (observation.kind !== "entry.inspect") return null;
  const snapshot = observation.snapshot;
  if (snapshot.entryExists !== true || snapshot.kind === null || snapshot.dev === null || snapshot.ino === null) {
    return null;
  }
  let ref: ObservedObjectRef;
  try {
    ref = await sandbox.bindFile(session, observation.configuredPath);
  } catch {
    return null;
  }
  if (
    ref.kind !== "cli.file" ||
    ref.type !== "regular" ||
    ref.absolutePath !== observation.configuredPath ||
    String(ref.identity.dev) !== String(snapshot.dev) ||
    String(ref.identity.ino) !== String(snapshot.ino) ||
    ref.sessionRevision !== transition.session_before.revision
  ) {
    return null;
  }
  return ref;
}

function stateWithListing(state: ReadCompositionState, listing: ReadCompositionState["listing"]): ReadCompositionState {
  return Object.freeze({
    stateId: state.stateId,
    session: state.session,
    cli: state.cli,
    listing,
    candidate: state.candidate,
    inspected: state.inspected,
    fileRef: state.fileRef,
    read: state.read,
    sources: state.sources,
  });
}

function stateWithInspected(state: ReadCompositionState, inspected: ReadCompositionState["inspected"]): ReadCompositionState {
  return Object.freeze({
    stateId: state.stateId,
    session: state.session,
    cli: state.cli,
    listing: state.listing,
    candidate: state.candidate,
    inspected,
    fileRef: state.fileRef,
    read: state.read,
    sources: state.sources,
  });
}

function stateWithFileRef(state: ReadCompositionState, fileRef: ReadCompositionFileRef | null): ReadCompositionState {
  return Object.freeze({
    stateId: state.stateId,
    session: state.session,
    cli: state.cli,
    listing: state.listing,
    candidate: state.candidate,
    inspected: state.inspected,
    fileRef,
    read: state.read,
    sources: state.sources,
  });
}

function stateWithRead(state: ReadCompositionState, read: ReadCompositionState["read"]): ReadCompositionState {
  return Object.freeze({
    stateId: state.stateId,
    session: state.session,
    cli: state.cli,
    listing: state.listing,
    candidate: state.candidate,
    inspected: state.inspected,
    fileRef: read === null ? state.fileRef : null,
    read,
    sources: state.sources,
  });
}

function stateWithSource(
  state: ReadCompositionState,
  index: 0 | 1,
  patch: Partial<Pick<ReadCompositionSourceState, "listing" | "candidate" | "inspected" | "fileRef" | "read">>,
): ReadCompositionState {
  if (state.sources === null) return state;
  const updated = state.sources.map((source, sourceIndex) =>
    sourceIndex === index
      ? Object.freeze({ ...source, ...patch })
      : source,
  );
  const first = (updated[0] ?? state.sources[0]) as ReadCompositionSourceState;
  const second = (updated[1] ?? state.sources[1]) as ReadCompositionSourceState;
  return Object.freeze({
    ...state,
    sources: Object.freeze([first, second]) as readonly [ReadCompositionSourceState, ReadCompositionSourceState],
  });
}

function sourceIndexForDirectory(
  state: ReadCompositionState,
  directory: ReadCompositionSourceSpec["directory"],
): 0 | 1 | null {
  if (state.sources === null) return null;
  if (sameDirectoryRef(state.sources[0].directory, directory)) return 0;
  if (sameDirectoryRef(state.sources[1].directory, directory)) return 1;
  return null;
}

function sourceIndexForCandidatePath(
  state: ReadCompositionState,
  path: string,
): 0 | 1 | null {
  if (state.sources === null) return null;
  if (state.sources[0].candidate?.path === path) return 0;
  if (state.sources[1].candidate?.path === path) return 1;
  return null;
}

function sourceIndexForFileRef(
  state: ReadCompositionState,
  ref: ReadCompositionFileRef,
): 0 | 1 | null {
  if (state.sources === null) return null;
  for (let index = 0; index < state.sources.length; index += 1) {
    const source = state.sources[index];
    if (source === undefined) continue;
    const sourceRef = source.fileRef;
    if (
      sourceRef !== null
      && sourceRef.absolutePath === ref.absolutePath
      && sameOsInteger(sourceRef.identity.dev, ref.identity.dev)
      && sameOsInteger(sourceRef.identity.ino, ref.identity.ino)
    ) {
      return index as 0 | 1;
    }
  }
  return null;
}

function listingCandidate(
  listing: ReadCompositionListingFact | null,
  name: string | null,
): ReadCompositionCandidate | null {
  if (listing === null || name === null || listing.coverage !== "complete") return null;
  const matches = listing.entries.filter(entry => entry.name === name);
  if (matches.length !== 1) return null;
  const entry = matches[0] as ReadCompositionListingFact["entries"][number] | undefined;
  if (entry === undefined) return null;
  return Object.freeze({
    name: entry.name,
    path: entry.path,
    listedType: entry.type,
    listingRun: listing.sourceRun,
  });
}

export function createReadCompositionAdapter(input: ReadCompositionAdapterInput) {
  const decisionBinding = input.decision ?? createDefaultPlanningDecisionBinding();
  const policy = createCliCommandPolicy({
    profile: input.profile,
    sandbox: input.sandbox,
    session: input.session,
    ...(input.onSample === undefined ? {} : { onSample: input.onSample }),
  });
  const calls = {
    validateRequest: 0,
    supports: 0,
    evaluate: 0,
    select: 0,
    derive: 0,
    executeAtomic: 0,
    validateAtomicReceipt: 0,
    measureProgress: 0,
  };
  let sequence = 0;
  let debugSeq = 0;
  let requestName: string | null = null;

  const adapter: ReadCompositionAdapter = {
    async validateRequest(request: RecursiveGoalRequestEnvelope) {
      calls.validateRequest += 1;
      const rootGoal = readReadCompositionGoal(request.rootGoal);
      const rootBindings = readBindings(request.rootBindings);
      await validateDirectoryBinding({
        sandbox: input.sandbox,
        rootBindings,
      });
      const state = readReadCompositionState(request.state);
      const root = rootGoal as ReadCompositionGoal;
      const session = input.session;
      const boundSession = input.sandbox.getSession(session);
      if (
        root.kind !== "file.property" ||
        root.property !== "file.property.content.bytes" ||
        root.requirement.kind !== "equals"
      ) {
        throw new TypeError("read composition root goal must be a content.bytes equals goal");
      }
      if (
        !boundSession.grantedEffects.includes("filesystem.read") ||
        state.session.id !== session.sessionId
      ) {
        throw new TypeError("read composition request requires filesystem.read for the bound session");
      }
      if (root.target.kind === "cli.exact-child") {
        if (
          root.target.directory.scenarioId !== session.scenarioId ||
          root.target.directory.sessionId !== session.sessionId
        ) {
          throw new TypeError("read composition request must identify the bound session");
        }
        if (
          request.rootEvaluatorId !== READ_ROOT_EVALUATOR ||
          request.rootSelectorId !== READ_ROOT_SELECTOR
        ) {
          throw new TypeError("read composition request evaluator or selector is unsupported");
        }
      } else {
        for (const source of root.target.sources) {
          if (
            source.directory.scenarioId !== session.scenarioId ||
            source.directory.sessionId !== session.sessionId
          ) {
            throw new TypeError("read composition request must identify the bound session");
          }
        }
        if (
          request.rootEvaluatorId !== READ_MULTI_ROOT_EVALUATOR ||
          request.rootSelectorId !== READ_MULTI_ROOT_SELECTOR
        ) {
          throw new TypeError("read composition request evaluator or selector is unsupported");
        }
      }
      requestName = root.target.name;
      const continuation =
        request.continuation === undefined || request.continuation === null
          ? null
          : readRecursiveGoalContinuation(request.continuation, DOMAIN_GUARDS);
      return Object.freeze({
        requestId: request.requestId,
        rootGoal: rootGoal as unknown,
        satisfactionThreshold: request.satisfactionThreshold,
        rootBindings,
        state,
        rootEvaluatorId: request.rootEvaluatorId,
        rootSelectorId: request.rootSelectorId,
        limits: request.limits,
        continuation,
      });
    },

    supports(callback) {
      calls.supports += 1;
      return supports(callback);
    },

    async evaluate(callback) {
      calls.evaluate += 1;
      debugSeq += 1;
      if (process.env.NN_DEBUG_READ_EVAL === "1") {
        const debugGoal = callback.goal as { property?: unknown; requirement?: unknown };
        const debugState = callback.state as ReadCompositionState;
        console.error("DEBUG_EVAL_CALL", JSON.stringify({
          seq: debugSeq,
          property: debugGoal.property,
          requirement: debugGoal.requirement,
          hasRead: debugState.read !== null,
          hasListing: debugState.listing !== null,
          hasFileRef: debugState.fileRef !== null,
        }));
      }
      const input = callback as EvaluationInput<unknown, ReadCompositionState, unknown, ReadCompositionEvidencePayload>;
      const goal = input.goal as Readonly<{ property: string; requirement: Readonly<{ kind: string }> }>;
      if (input.state.sources !== null) {
        if (goal.property === "file.property.directory.entries" && goal.requirement.kind === "observed") {
          return evaluateList(input);
        }
        if (goal.property === "file.property.type") {
          return evaluateInspect(input);
        }
        if (goal.property === "file.property.content.bytes" && goal.requirement.kind === "observed") {
          return evaluateRead(input);
        }
        if (goal.property === "file.property.content.bytes" && goal.requirement.kind === "equals") {
          return evaluateMultiRoot(input);
        }
        throw new TypeError("read composition evaluator received an unsupported goal");
      }
      if (goal.property === "file.property.content.bytes" && goal.requirement.kind === "equals") {
        return evaluateRoot(input, input.bindings as unknown as ReadCompositionRequest);
      }
      if (goal.property === "file.property.directory.entries" && goal.requirement.kind === "observed") {
        return evaluateList(input);
      }
      if (goal.property === "file.property.type") {
        return evaluateInspect(input);
      }
      if (goal.property === "file.property.content.bytes" && goal.requirement.kind === "observed") {
        return evaluateRead(input);
      }
      throw new TypeError("read composition evaluator received an unsupported goal");
    },

    async select(callback) {
      calls.select += 1;
      debugSeq += 1;
      if (process.env.NN_DEBUG_READ_EVAL === "1") {
        console.error("DEBUG_SELECT", JSON.stringify({ seq: debugSeq }));
      }
      return select(callback);
    },

    async derive(callback) {
      calls.derive += 1;
      debugSeq += 1;
      if (process.env.NN_DEBUG_READ_EVAL === "1") {
        console.error("DEBUG_DERIVE", JSON.stringify({ seq: debugSeq }));
      }
      return derive(callback, decisionBinding, input.sandbox);
    },

    async executeAtomic(callback) {
      calls.executeAtomic += 1;
      debugSeq += 1;
      if (process.env.NN_DEBUG_READ_EVAL === "1") {
        console.error("DEBUG_EXECUTE", JSON.stringify({ seq: debugSeq, skillId: callback.skill.id }));
      }
      sequence += 1;
      const current = sequence;
      const listSelected = callback.skill.id === READ_LIST_ATOMIC_SKILL;
      const inspectSelected = callback.skill.id === READ_INSPECT_ATOMIC_SKILL;
      const readSelected = callback.skill.id === READ_READ_ATOMIC_SKILL;
      if (!listSelected && !inspectSelected && !readSelected) {
        throw new TypeError("read composition executeAtomic received an unsupported skill");
      }
      if (listSelected) {
        const transition = await executeList(policy, {
          goal: callback.goal as ReadCompositionListGoal,
          satisfactionThreshold: callback.satisfactionThreshold,
          state: callback.state,
        });
        const expectedHead = "ls";
        if (transition.policy_error !== null || transition.policy.selectedHead !== expectedHead) {
          const receipt = atomicReceipt({
            context: callback.context,
            sequence: current,
            transition,
            expectedHead,
            session: input.session,
            state: callback.state,
          });
          const selectedHead = transition.policy.selectedHead;
          const policyError: AdapterDiagnostic = Object.freeze({
            diagnosticId: `${transitionId(callback.context.requestId, current)}:policy`,
            code: "policy_error",
            stage: "selection",
            sourceCategory: "cli.command_policy",
            message: `command policy selected ${selectedHead}, expected ${expectedHead}`,
            nativeCode: null,
            refs: Object.freeze([transitionId(callback.context.requestId, current)]),
          });
          return Object.freeze({
            ...receipt,
            outcome: "rejected",
            executionErrors: Object.freeze([...receipt.executionErrors, policyError]),
          });
        }
        const listing = listingFromTransition(transition);
        const sourceIndex = sourceIndexForDirectory(callback.state, (callback.bindings as ReadCompositionSourceSpec).directory);
        const baseState = sourceIndex === null
          ? callback.state
          : stateWithSource(callback.state, sourceIndex, {
              listing,
              candidate: listingCandidate(listing, requestName),
            });
        const nextState = sourceIndex === null
          ? stateWithListing(callback.state, listing)
          : baseState;
        const receipt = atomicReceipt({
          context: callback.context,
          sequence: current,
          transition,
          expectedHead,
          session: input.session,
          state: baseState,
          nextState,
        });
        return receipt;
      }
      if (inspectSelected) {
        const transition = await executeInspect(policy, {
          goal: callback.goal as ReadCompositionInspectGoal,
          satisfactionThreshold: callback.satisfactionThreshold,
          state: callback.state,
        });
        const expectedHead = "entry.inspect";
        if (transition.policy_error !== null || transition.policy.selectedHead !== expectedHead) {
          const receipt = atomicReceipt({
            context: callback.context,
            sequence: current,
            transition,
            expectedHead,
            session: input.session,
            state: callback.state,
          });
          const selectedHead = transition.policy.selectedHead;
          const policyError: AdapterDiagnostic = Object.freeze({
            diagnosticId: `${transitionId(callback.context.requestId, current)}:policy`,
            code: "policy_error",
            stage: "selection",
            sourceCategory: "cli.command_policy",
            message: `command policy selected ${selectedHead}, expected ${expectedHead}`,
            nativeCode: null,
            refs: Object.freeze([transitionId(callback.context.requestId, current)]),
          });
          return Object.freeze({
            ...receipt,
            outcome: "rejected",
            executionErrors: Object.freeze([...receipt.executionErrors, policyError]),
          });
        }
        const inspected = inspectedFromInspect(transition);
        const ref = await issueObservedRef(input.sandbox, input.session, transition);
        let fileRef: ReadCompositionFileRef | null = null;
        if (ref !== null && inspected !== null && inspected.type === "regular") {
          fileRef = Object.freeze({
            kind: "cli.file",
            scenarioId: ref.scenarioId,
            sessionId: ref.sessionId,
            type: "regular",
            identity: Object.freeze({
              dev: ref.identity.dev,
              ino: ref.identity.ino,
            }),
            sourceRun: ref.sourceRun,
            sessionRevision: ref.sessionRevision,
            absolutePath: ref.absolutePath,
          });
        }
        const inspectBindings = callback.bindings as ReadCompositionSourceSpec;
        const sourceIndex = sourceIndexForDirectory(callback.state, inspectBindings.directory);
        const baseState = sourceIndex === null
          ? stateWithFileRef(stateWithInspected(callback.state, inspected), fileRef)
          : stateWithSource(callback.state, sourceIndex, { inspected, fileRef });
        const nextState = baseState;
        const receipt = atomicReceipt({
          context: callback.context,
          sequence: current,
          transition,
          expectedHead,
          session: input.session,
          state: callback.state,
          nextState,
        });
        return receipt;
      }
      const goal = callback.goal as ReadCompositionReadGoal;
      const sandboxReceipt = await executeRead(input.sandbox, {
        goal,
        state: callback.state,
      });
      const read = sandboxReceipt.status === "succeeded"
        ? readFactFromReceipt(
            sandboxReceipt,
            goal.target.ref.sourceRun,
            sandboxReceipt.session_before.revision,
            goal.target.ref as ReadCompositionFileRef,
          )
        : null;
      const sourceIndex = sourceIndexForFileRef(
        callback.state,
        goal.target.ref as ReadCompositionFileRef,
      );
      const nextState = sourceIndex === null
        ? stateWithRead(callback.state, read)
        : stateWithSource(callback.state, sourceIndex, { read });
      const receipt = readAtomicReceiptFromSandbox({
        context: callback.context,
        sequence: current,
        receipt: sandboxReceipt,
        session: input.session,
        state: callback.state,
        ref: goal.target.ref,
        expectedHead: "file.read",
        range: goal.requirement.range,
        read,
      });
      if (sourceIndex !== null) {
        return Object.freeze({ ...receipt, newState: Object.freeze({ id: receipt.newState!.id, value: nextState }) });
      }
      return receipt;
    },

    validateAtomicReceipt(raw: unknown) {
      calls.validateAtomicReceipt += 1;
      return readAtomicReceipt(raw, DOMAIN_GUARDS);
    },

    measureProgress() {
      calls.measureProgress += 1;
      return { improved: false, reason: "none" as const, comparable: true };
    },
  };

  return Object.freeze({
    adapter,
    calls,
  });
}

function listingEntriesOf(transition: CliCommandTransition): readonly { name: string; path: string; type: "file" | "directory" | "symlink" | "other" | "unknown" }[] {
  const receipt = transition.execution_result.receipt;
  if (receipt?.execution.status !== "succeeded") return Object.freeze([]);
  const observation = receipt.execution.observation;
  return observation.kind === "directory.list"
    ? Object.freeze(observation.entries.map(entry => Object.freeze({
        name: entry.name,
        path: entry.path,
        type: entry.type as "file" | "directory" | "symlink" | "other" | "unknown",
      })))
    : Object.freeze([]);
}

export function createReadCompositionDependencies(
  created: { adapter: ReadCompositionAdapter },
  signal?: AbortSignal,
): RecursiveGoalDependencies<
  unknown,
  ReadCompositionState,
  unknown,
  ReadCompositionEvidencePayload,
  ReadCompositionEffectFact,
  ReadCompositionReceiptPayload,
  unknown
> {
  return Object.freeze({
    adapter: created.adapter,
    enabledSkills: READ_COMPOSITION_SKILLS as unknown as readonly EnabledSkill[],
    enabledEvaluators: READ_COMPOSITION_EVALUATORS as unknown as readonly EnabledEvaluator[],
    selectors: READ_COMPOSITION_SELECTORS as unknown as readonly SelectorBinding[],
    comparators: READ_COMPOSITION_COMPARATORS,
    grantedEffects: new Set(EFFECTS),
    ...(signal === undefined ? {} : { signal }),
  });
}

export function createReadMultiCompositionDependencies(
  created: { adapter: ReadCompositionAdapter },
  signal?: AbortSignal,
): RecursiveGoalDependencies<
  unknown,
  ReadCompositionState,
  unknown,
  ReadCompositionEvidencePayload,
  ReadCompositionEffectFact,
  ReadCompositionReceiptPayload,
  unknown
> {
  return Object.freeze({
    adapter: created.adapter,
    enabledSkills: [
      ...READ_COMPOSITION_SKILLS,
      READ_MULTI_COMPOSITION_SKILL,
    ] as unknown as readonly EnabledSkill[],
    enabledEvaluators: [
      ...READ_COMPOSITION_EVALUATORS,
      READ_MULTI_ROOT_EVALUATOR_DECL,
    ] as unknown as readonly EnabledEvaluator[],
    selectors: [
      ...READ_COMPOSITION_SELECTORS,
      READ_MULTI_ROOT_SELECTOR_DECL,
    ] as unknown as readonly SelectorBinding[],
    comparators: READ_COMPOSITION_COMPARATORS,
    grantedEffects: new Set(EFFECTS),
    ...(signal === undefined ? {} : { signal }),
  });
}
