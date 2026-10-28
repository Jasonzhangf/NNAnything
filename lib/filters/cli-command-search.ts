import {
  CLI_HYBRID_PACKAGE_SCHEMA,
  E19_FEATURES,
  HybridContractError,
  createHybridPackageResource,
  loadHybridPackageFromFile,
  validateCliHybridPackage,
  type CliHybridPackageV1,
  type HybridEInferRequest,
  type HybridEInferResult,
  type HybridPackageResource,
} from "../training/l2-hybrid-package.js";
import type {
  L2Head,
  L2MlpProfile,
  L2Prediction,
} from "../adapters/l2/contracts.js";
import type { CommandMatchedLineRecord } from "../adapters/cli/directory-command-search.js";
import {
  readVersionedRef,
  type VersionedRef,
} from "../workflow/recursive-goal/planning-contracts.js";
import {
  COMMAND_SEARCH_A_FEATURE_COUNT,
  COMMAND_SEARCH_A_LABELS,
  COMMAND_SEARCH_D_FEATURE_COUNT,
  COMMAND_SEARCH_D_LABELS,
  COMMAND_SEARCH_E_FEATURE_COUNT,
  COMMAND_SEARCH_E_LABELS,
  COMMAND_SEARCH_R_FEATURE_COUNT,
  COMMAND_SEARCH_R_LABELS,
  commandSearchGoalMeta,
  readCommandSearchState,
  validateCommandSearchRequest,
  type CommandSearchCardinality,
  type CommandSearchDomainProjection,
  type CommandSearchEEvaluation,
  type CommandSearchFollowUpRead,
  type CommandSearchGoalKind,
  type CommandSearchHeadEvaluation,
  type CommandSearchReadFact,
  type CommandSearchRequest,
  type CommandSearchRdeaStep,
  type CommandSearchSlot,
  type CommandSearchSlotFact,
  type CommandSearchState,
  type CommandSearchStepReceipt,
} from "../adapters/cli/command-search-contract.js";

export const DEFAULT_CLI_HYBRID_SEARCH_REF: VersionedRef = Object.freeze({
  id: "cli.hybrid-search",
  version: "cli.hybrid-package.v1",
});

export type CliHybridSearchModel = Readonly<{
  kind: "cli.hybrid-search.model";
  ref: VersionedRef;
  schema: typeof CLI_HYBRID_PACKAGE_SCHEMA;
  calibration: "uncalibrated";
  adoption: "not_applied";
  handwiredRoot: string;
  packagePath: string | null;
  package: CliHybridPackageV1;
  profile: L2MlpProfile;
  inferE: (request: HybridEInferRequest) => HybridEInferResult;
  inferHead: (head: L2Head, features: readonly number[]) => L2Prediction;
}>;

export type LoadCliHybridSearchModelOptions = Readonly<{
  packagePath: string;
  handwiredRoot?: string;
  ref?: VersionedRef;
}>;

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(object as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function featureNamesFor(model: CliHybridSearchModel, head: L2Head): readonly string[] {
  const headProfile = model.profile.heads[head];
  if (headProfile === undefined) {
    throw new TypeError(`cli.hybrid-search model is missing head ${head}`);
  }
  return headProfile.spec.features;
}

function labelsFor(model: CliHybridSearchModel, head: L2Head): readonly string[] {
  return model.profile.heads[head].spec.labels;
}

/**
 * Build a feature vector strictly in the model's declared feature order.
 * Missing named features are 0, matching the offline runner contract.
 */
export function buildFeatureVector(
  featureNames: readonly string[],
  named: Readonly<Record<string, number>>,
): number[] {
  return featureNames.map(name => Number(named[name] ?? 0));
}

function roundedLogits(logits: readonly number[], labels: readonly string[]): Record<string, number> {
  return Object.fromEntries(labels.map((label, index) => [label, Number(logits[index]!.toFixed(6))]));
}

export function evaluateCommandSearchHead(
  model: CliHybridSearchModel,
  head: "R" | "D" | "A",
  named: Readonly<Record<string, number>>,
): CommandSearchHeadEvaluation {
  const featureNames = featureNamesFor(model, head);
  const features = buildFeatureVector(featureNames, named);
  const out = model.inferHead(head, features);
  return Object.freeze({
    features: Object.freeze(features),
    namedFeatures: Object.freeze(Object.fromEntries(featureNames.map((name, index) => [name, features[index]!]))),
    logits: Object.freeze([...out.logits]),
    logitsByLabel: Object.freeze(roundedLogits(out.logits, labelsFor(model, head))),
    predictedLabel: out.label,
  });
}

export type CommandSearchSlotRResult = CommandSearchHeadEvaluation & Readonly<{
  rawPartialDiagnostic: CommandSearchHeadEvaluation | null;
}>;

/**
 * Port of the reference runner `computeSlotR`. The probe uses the model's own
 * `R` feature order; extra feature names are ignored and missing ones stay 0.
 */
export function computeCommandSearchSlotR(
  model: CliHybridSearchModel,
  slotReceipt: CommandSearchSlotFact | null,
  goalKind: CommandSearchGoalKind,
): CommandSearchSlotRResult {
  const isLiteral = goalKind === "g3.literal-search";
  const evalR = (named: Record<string, number>) => evaluateCommandSearchHead(model, "R", named);
  if (slotReceipt === null) {
    if (isLiteral) {
      return Object.freeze({
        ...evalR({
          "type.known": 1,
          "type.isRegular": 1,
          "goal.isLiteral": 1,
          "grep.present": 0,
        }),
        rawPartialDiagnostic: null,
      });
    }
    return Object.freeze({
      ...evalR({ "list.known": 0 }),
      rawPartialDiagnostic: null,
    });
  }
  const hasHit = slotReceipt.matchedEntries.length > 0 && slotReceipt.queryMatches === 1;
  const isComplete = slotReceipt.normalCompleted && slotReceipt.coverage === "complete";
  if (isLiteral) {
    const effectivePresent = isComplete || hasHit ? 1 : 0;
    const head = evalR({
      "type.known": 1,
      "type.isRegular": 1,
      "goal.isLiteral": 1,
      "grep.present": effectivePresent,
      "grep.execError": isComplete ? 0 : 1,
      "grep.queryMatches": slotReceipt.queryMatches ? 1 : 0,
      "grep.rawHit": hasHit ? 1 : 0,
      "grep.rawCompleteNoMatch": isComplete && !hasHit && slotReceipt.queryMatches ? 1 : 0,
    });
    const rawPartialDiagnostic =
      !isComplete && !hasHit
        ? evalR({
            "type.known": 1,
            "type.isRegular": 1,
            "goal.isLiteral": 1,
            "grep.present": 1,
            "grep.execError": 1,
            "grep.queryMatches": 1,
            "grep.rawHit": 0,
            "grep.rawCompleteNoMatch": 0,
          })
        : null;
    return Object.freeze({ ...head, rawPartialDiagnostic });
  }
  return Object.freeze({
    ...evalR({
      "list.known": 1,
      "list.execError": isComplete ? 0 : 1,
      "name.matched": hasHit ? 1 : 0,
      "name.absent": isComplete && !hasHit ? 1 : 0,
      "type.known": hasHit ? 1 : 0,
      "type.isRegular": hasHit ? 1 : 0,
    }),
    rawPartialDiagnostic: null,
  });
}

/**
 * Port of the reference runner `evalE`: build the E19 vector in declared order
 * and route it through the Handwired pre/core/post package owner.
 */
export function evaluateCommandSearchE(
  model: CliHybridSearchModel,
  named: Readonly<Record<string, number>>,
  goalKind: CommandSearchGoalKind,
  receiptFact: Readonly<{ known: boolean; present: boolean | null }>,
): CommandSearchEEvaluation {
  const featureNames = featureNamesFor(model, "E");
  if (
    featureNames.length !== COMMAND_SEARCH_E_FEATURE_COUNT
    || featureNames.some((name, index) => name !== E19_FEATURES[index])
  ) {
    throw new TypeError("cli.hybrid-search E head feature order does not match the fixed E19 profile");
  }
  const features = buildFeatureVector(featureNames, named);
  const out = model.inferE({
    goal: { kind: goalKind === "g3.literal-search" ? "g3.literal-search" : "g2.read" },
    features19: features,
    receiptFact,
  });
  return Object.freeze({
    features: Object.freeze(features),
    namedFeatures: Object.freeze(Object.fromEntries(featureNames.map((name, index) => [name, features[index]!]))),
    readGate: out.readGate === 1 ? 1 : 0,
    literalGate: out.literalGate === 1 ? 1 : 0,
    predictedLabel: out.label,
    rawPredictedLabel: out.rawLabel,
    rawLogits: Object.freeze([...out.rawLogits]),
    routedLogits: Object.freeze([...out.logits]),
  });
}

export type CommandSearchRdeaInput = Readonly<{
  goalKind: CommandSearchGoalKind;
  cardinality: CommandSearchCardinality;
  s1Enabled: boolean;
  lastSearchedSlot: CommandSearchSlot | null;
  slotReceipts: Readonly<{
    s0: CommandSearchSlotFact | null;
    s1: CommandSearchSlotFact | null;
  }>;
  readReceipt: CommandSearchReadFact | null;
  followUpRead: CommandSearchFollowUpRead | null;
}>;

export type CommandSearchRdeaEvaluation = Readonly<{
  R: Readonly<{
    s0: CommandSearchSlotRResult;
    s1: CommandSearchSlotRResult | null;
  }>;
  E: CommandSearchEEvaluation;
  D: CommandSearchHeadEvaluation;
  A: CommandSearchHeadEvaluation;
}>;

/**
 * One pure R -> E -> D -> A decision step, transcribed from
 * `executeSingleCommandGoal`. It reads state facts only; it never executes.
 */
export function evaluateCommandSearchRdea(
  model: CliHybridSearchModel,
  input: CommandSearchRdeaInput,
): CommandSearchRdeaEvaluation {
  const isLiteral = input.goalKind === "g3.literal-search";
  const isLiteralFlag = isLiteral ? 1 : 0;
  const r0 = computeCommandSearchSlotR(model, input.slotReceipts.s0, input.goalKind);
  const r1 = input.s1Enabled
    ? computeCommandSearchSlotR(model, input.slotReceipts.s1, input.goalKind)
    : null;

  const s0ValidHit = Boolean(
    input.slotReceipts.s0
    && input.slotReceipts.s0.queryMatches
    && input.slotReceipts.s0.matchedEntries.length > 0,
  );
  const s1ValidHit = Boolean(
    input.s1Enabled
    && input.slotReceipts.s1
    && input.slotReceipts.s1.queryMatches
    && input.slotReceipts.s1.matchedEntries.length > 0,
  );
  const activeSlot: CommandSearchSlot = s0ValidHit
    ? "s0"
    : s1ValidHit
      ? "s1"
      : input.lastSearchedSlot ?? "s0";
  const activeReceipt = activeSlot === "s1" ? input.slotReceipts.s1 : input.slotReceipts.s0;

  let eResult: CommandSearchEEvaluation;
  if (!isLiteral) {
    if (input.followUpRead !== null) {
      const readDone = input.readReceipt !== null;
      eResult = evaluateCommandSearchE(model, {
        "goal.head": 1,
        "goal.N/16": 1,
        "receipt.present": readDone ? 1 : 0,
        "actual.head": readDone ? 1 : 0,
        "execution.succeeded": readDone ? 1 : 0,
        "output.linesKnown": readDone ? 1 : 0,
        "output.logicalLines/16": readDone ? 1 : 0,
        "actual.N/16": readDone ? 1 : 0,
      }, "g2.read", { known: true, present: readDone });
    } else {
      const isComplete = Boolean(
        activeReceipt
        && activeReceipt.queryMatches
        && activeReceipt.normalCompleted
        && activeReceipt.coverage === "complete",
      );
      const hasHit = Boolean(
        activeReceipt && activeReceipt.queryMatches && activeReceipt.matchedEntries.length > 0,
      );
      const canConclude = isComplete || (input.cardinality === "one" && hasHit);
      eResult = evaluateCommandSearchE(model, {
        "goal.head": 1,
        "goal.N/16": 1,
        "receipt.present": canConclude ? 1 : 0,
        "actual.head": hasHit ? 1 : 0,
        "execution.succeeded": canConclude && hasHit ? 1 : 0,
        "execution.failed": isComplete && !hasHit ? 1 : 0,
        "output.linesKnown": canConclude && hasHit ? 1 : 0,
        "output.logicalLines/16": canConclude && hasHit ? 1 : 0,
        "actual.N/16": canConclude && hasHit ? 1 : 0,
      }, "g2.read", { known: true, present: canConclude });
    }
  } else {
    const hasValidHit = Boolean(
      activeReceipt && activeReceipt.queryMatches && activeReceipt.matchedEntries.length > 0,
    );
    const isComplete = Boolean(
      activeReceipt
      && activeReceipt.queryMatches
      && activeReceipt.normalCompleted
      && activeReceipt.coverage === "complete",
    );
    const canRefuteOrSatisfy = isComplete || (input.cardinality === "one" && hasValidHit);
    eResult = evaluateCommandSearchE(model, {
      "goal.isLiteral": 1,
      "grep.present": canRefuteOrSatisfy ? 1 : 0,
      "grep.normalCompleted": canRefuteOrSatisfy ? 1 : 0,
      "grep.execFailed": activeReceipt && !activeReceipt.normalCompleted ? 1 : 0,
      "grep.queryMatches": activeReceipt?.queryMatches ? 1 : 0,
      "grep.rawHitValid": hasValidHit ? 1 : 0,
      "grep.rawCompleteNoMatch": isComplete && !hasValidHit ? 1 : 0,
    }, "g3.literal-search", { known: true, present: canRefuteOrSatisfy });
  }

  const readPresent = !isLiteral
    && (
      input.readReceipt !== null
      || (input.followUpRead === null && (input.slotReceipts.s0?.matchedEntries.length ?? 0) > 0)
    );
  const dResult = evaluateCommandSearchHead(model, "D", {
    "s0.listing.present": !isLiteral && input.slotReceipts.s0 && input.slotReceipts.s0.queryMatches ? 1 : 0,
    "s0.listing.complete":
      !isLiteral
      && input.slotReceipts.s0
      && input.slotReceipts.s0.queryMatches
      && input.slotReceipts.s0.normalCompleted
        ? 1
        : 0,
    "s0.selectedFile.present":
      isLiteral ? 1 : (input.slotReceipts.s0?.matchedEntries.length ?? 0) > 0 ? 1 : 0,
    "read.present": readPresent ? 1 : 0,
    "readE.unsatisfied": !isLiteral && eResult.predictedLabel === "unsatisfied" ? 1 : 0,
    "readE.satisfied": !isLiteral && eResult.predictedLabel === "satisfied" ? 1 : 0,
    "readE.unknown": !isLiteral && eResult.predictedLabel === "unknown" ? 1 : 0,
    "s0.r.insufficient": r0.predictedLabel === "insufficient" ? 1 : 0,
    "s0.r.holds": r0.predictedLabel === "holds" ? 1 : 0,
    "s0.r.refuted": r0.predictedLabel === "refuted" ? 1 : 0,
    "s1.slotEnabled": input.s1Enabled ? 1 : 0,
    "s1.listing.present":
      input.s1Enabled
      && !isLiteral
      && input.slotReceipts.s1
      && input.slotReceipts.s1.queryMatches
        ? 1
        : 0,
    "s1.listing.complete":
      input.s1Enabled
      && !isLiteral
      && input.slotReceipts.s1
      && input.slotReceipts.s1.queryMatches
      && input.slotReceipts.s1.normalCompleted
        ? 1
        : 0,
    "s1.selectedFile.present": input.s1Enabled && isLiteral ? 1 : 0,
    "s1.r.insufficient": input.s1Enabled && r1?.predictedLabel === "insufficient" ? 1 : 0,
    "s1.r.holds": input.s1Enabled && r1?.predictedLabel === "holds" ? 1 : 0,
    "s1.r.refuted": input.s1Enabled && r1?.predictedLabel === "refuted" ? 1 : 0,
    "read.fromS0": readPresent ? 1 : 0,
    "read.fromS1": 0,
    "goal.isLiteral": isLiteralFlag,
    "grep.present": isLiteral && activeReceipt && activeReceipt.queryMatches ? 1 : 0,
    "grepE.unsatisfied": isLiteral && eResult.predictedLabel === "unsatisfied" ? 1 : 0,
    "grepE.satisfied": isLiteral && eResult.predictedLabel === "satisfied" ? 1 : 0,
    "grepE.unknown": isLiteral && eResult.predictedLabel === "unknown" ? 1 : 0,
    "grep.fromS0": isLiteral && activeReceipt && activeSlot === "s0" ? 1 : 0,
    "grep.fromS1": isLiteral && activeReceipt && activeSlot === "s1" ? 1 : 0,
  });

  const aResult = evaluateCommandSearchHead(model, "A", {
    "goal.head": isLiteral ? 0 : 1,
    "goal.tail": 0,
    "E.unsatisfied": eResult.predictedLabel === "unsatisfied" ? 1 : 0,
    "E.satisfied": eResult.predictedLabel === "satisfied" ? 1 : 0,
    "E.unknown": eResult.predictedLabel === "unknown" ? 1 : 0,
    isLiteral: isLiteralFlag,
  });

  return Object.freeze({
    R: Object.freeze({ s0: r0, s1: r1 }),
    E: eResult,
    D: dResult,
    A: aResult,
  });
}

export type CommandSearchProjectionInput = Readonly<{
  request: CommandSearchRequest;
  model: CliHybridSearchModel;
  response: unknown;
  state?: CommandSearchState | null;
}>;

type ReportShape = Readonly<{
  rootEvaluation: unknown;
  control: Record<string, unknown> | null;
  states: readonly unknown[];
  frames: unknown;
  atomicResults: unknown;
  effects: unknown;
  errors: readonly Record<string, unknown>[];
  primaryErrorId: string | null;
  budgetUsed: unknown;
  continuation: unknown;
}>;

function emptyReport(): ReportShape {
  return Object.freeze({
    rootEvaluation: null,
    control: null,
    states: Object.freeze([]) as readonly unknown[],
    frames: Object.freeze([]),
    atomicResults: Object.freeze([]),
    effects: Object.freeze([]),
    errors: Object.freeze([]) as readonly Record<string, unknown>[],
    primaryErrorId: null,
    budgetUsed: null,
    continuation: null,
  });
}

function readReport(value: unknown, partial: boolean): ReportShape {
  if (value === null || value === undefined) {
    if (partial) return emptyReport();
    throw new TypeError("command search response.report is required");
  }
  if (!isRecord(value)) throw new TypeError("command search response.report must be an object");
  const errors = Array.isArray(value.errors) ? value.errors : [];
  return Object.freeze({
    rootEvaluation: value.rootEvaluation ?? null,
    control: isRecord(value.control) ? value.control : null,
    states: Array.isArray(value.states) ? value.states : [],
    frames: value.frames ?? [],
    atomicResults: value.atomicResults ?? [],
    effects: value.effects ?? [],
    errors: errors.map(error => (isRecord(error) ? error : {})),
    primaryErrorId: typeof value.primaryErrorId === "string" ? value.primaryErrorId : null,
    budgetUsed: value.budgetUsed ?? null,
    continuation: value.continuation ?? null,
  });
}

function derivedState(response: Record<string, unknown>, report: ReportShape): CommandSearchState | null {
  const last = report.states.at(-1);
  if (last === undefined) return null;
  if (isRecord(last) && Object.hasOwn(last, "value")) {
    return readCommandSearchState(last.value);
  }
  // Some callers pass a direct CommandSearchState as the last report state.
  void response;
  return readCommandSearchState(last);
}

function aggregateFacts(state: CommandSearchState | null, s1Enabled: boolean): Readonly<{
  matchedEntries: readonly string[];
  matchedLines: readonly CommandMatchedLineRecord[];
  reasons: readonly string[];
  anyPartial: boolean;
  searchedCount: number;
}> {
  const entries: string[] = [];
  const lines: CommandMatchedLineRecord[] = [];
  const reasons: string[] = [];
  let anyPartial = false;
  let searchedCount = 0;
  const slots = [state?.slotReceipts.s0 ?? null, s1Enabled ? state?.slotReceipts.s1 ?? null : null];
  for (const fact of slots) {
    if (fact === null || fact.queryMatches !== 1) continue;
    searchedCount += 1;
    for (const entry of fact.matchedEntries) {
      if (!entries.includes(entry)) entries.push(entry);
    }
    lines.push(...fact.matchedLines);
    if (!fact.normalCompleted || fact.coverage !== "complete") anyPartial = true;
    for (const reason of fact.reasons) {
      if (!reasons.includes(reason)) reasons.push(reason);
    }
  }
  return Object.freeze({
    matchedEntries: Object.freeze(entries),
    matchedLines: Object.freeze(lines),
    reasons: Object.freeze(reasons),
    anyPartial,
    searchedCount,
  });
}

const STATUSES = new Set([
  "achieved",
  "unmet",
  "unknown",
  "rejected",
  "failed",
]);
const RESOLUTIONS = new Set([
  "matched",
  "not_found",
  "partial",
  "insufficient_evidence",
  "budget_exhausted",
  "interrupted",
  "rejected",
  "failed",
]);

function assertPublicVocabulary(status: string, resolution: string): void {
  if (!STATUSES.has(status) || !RESOLUTIONS.has(resolution)) {
    throw new TypeError(`command search projection produced an unsupported status/resolution ${status}/${resolution}`);
  }
}

function errorCodes(report: ReportShape): readonly string[] {
  const selected = report.primaryErrorId === null
    ? report.errors
    : report.errors.filter(error => error.errorId === report.primaryErrorId);
  const source = selected.length > 0 ? selected : report.errors;
  return source
    .map(error => (typeof error.code === "string" ? error.code : null))
    .filter((code): code is string => code !== null);
}

/**
 * Project the recursive-goal result into the public domain contract. The output
 * uses only the §4.3 vocabulary; offline experiment strings such as
 * "completed"/"incomplete"/"satisfied" never appear here.
 */
export function projectCommandSearchDomain(
  input: CommandSearchProjectionInput,
): CommandSearchDomainProjection {
  const request = validateCommandSearchRequest(input.request);
  const model = validateCliHybridSearchModel(input.model);
  const meta = commandSearchGoalMeta(request);
  if (!isRecord(input.response)) throw new TypeError("command search response must be an object");
  const response = input.response;

  let report = emptyReport();
  let state: CommandSearchState | null = null;
  if (Object.hasOwn(input, "state")) {
    state = input.state === null ? null : readCommandSearchState(input.state);
  }

  let kind: string;
  if (response.kind === "request_rejected") {
    kind = "request_rejected";
    const error = isRecord(response.error) ? response.error : {};
    report = Object.freeze({
      ...emptyReport(),
      errors: Object.freeze([error]),
      primaryErrorId: typeof error.errorId === "string" ? error.errorId : null,
    });
  } else if (response.kind === "module_fault") {
    kind = "module_fault";
    report = readReport(response.report, true);
    if (state === null) {
      try {
        state = derivedState(response, report);
      } catch {
        state = null;
      }
    }
    const fault = isRecord(response.fault) ? response.fault : null;
    if (fault !== null) {
      report = Object.freeze({
        ...report,
        errors: Object.freeze([...report.errors, fault]),
        primaryErrorId:
          report.primaryErrorId
          ?? (typeof fault.errorId === "string" ? fault.errorId : null),
      });
    }
  } else if (response.kind === "run_result") {
    kind = "run_result";
    report = readReport(response.report, false);
    if (state === null) state = derivedState(response, report);
  } else {
    throw new TypeError("command search response.kind must be request_rejected, module_fault or run_result");
  }

  const s1Enabled = state?.s1Enabled ?? meta.scopeRefs.length > 1;
  const facts = aggregateFacts(state, s1Enabled);
  const hasHit = facts.matchedEntries.length > 0;
  const s1UnsearchedEarlyStop =
    s1Enabled
    && meta.cardinality === "one"
    && hasHit
    && (!state?.slotReceipts.s1 || state.slotReceipts.s1.queryMatches !== 1);
  const reasons = [...facts.reasons];
  const addReason = (reason: string) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  let status: CommandSearchDomainProjection["status"];
  let resolution: CommandSearchDomainProjection["resolution"];
  let satisfaction: CommandSearchDomainProjection["satisfaction"];
  let coverage: CommandSearchDomainProjection["coverage"];

  const control = report.control;
  const outcome = typeof control?.outcome === "string" ? control.outcome : null;
  const stopReason = typeof control?.stopReason === "string" ? control.stopReason : null;
  const root = report.rootEvaluation;
  const rootResult =
    isRecord(root) && root.state === "evaluated" && typeof root.result === "string"
      ? root.result
      : null;

  if (kind === "request_rejected") {
    status = "rejected";
    resolution = "rejected";
    satisfaction = null;
    coverage = null;
    addReason("rejected");
    for (const code of errorCodes(report)) addReason(code);
  } else if (kind === "module_fault") {
    status = "failed";
    resolution = "failed";
    satisfaction = null;
    coverage = facts.anyPartial ? "partial" : null;
    addReason("failed");
    for (const code of errorCodes(report)) addReason(code);
  } else if (outcome === "exceeded" && stopReason === "budget") {
    status = "unknown";
    resolution = "budget_exhausted";
    satisfaction = null;
    coverage = "partial";
    addReason("budget_exhausted");
  } else if (outcome === "cancelled" || stopReason === "cancel") {
    status = "unknown";
    resolution = "interrupted";
    satisfaction = null;
    coverage = "partial";
    addReason("interrupted");
  } else if (outcome === "error") {
    const codes = new Set(errorCodes(report));
    const rejected =
      codes.has("effect_denied")
      || codes.has("invalid_binding")
      || codes.has("invalid_request")
      || codes.has("adapter_contract_invalid");
    status = rejected ? "rejected" : "failed";
    resolution = rejected ? "rejected" : "failed";
    satisfaction = null;
    coverage = rejected ? null : facts.anyPartial ? "partial" : null;
    addReason(rejected ? "rejected" : "failed");
    for (const code of codes) addReason(code);
  } else if (outcome === "yielded") {
    status = "unknown";
    resolution = report.continuation !== null ? "budget_exhausted" : "insufficient_evidence";
    satisfaction = null;
    coverage = facts.searchedCount > 0 ? "partial" : null;
    addReason(resolution);
  } else if (outcome === "completed" && rootResult === "satisfied" && hasHit) {
    status = "achieved";
    resolution = "matched";
    satisfaction = 100;
    coverage = facts.anyPartial || s1UnsearchedEarlyStop ? "partial" : "complete";
    if (s1UnsearchedEarlyStop) addReason("unsearched_fallback_scope_early_stop");
  } else if (outcome === "completed" && rootResult === "unsatisfied") {
    status = "unmet";
    resolution = "not_found";
    satisfaction = 0;
    coverage = facts.anyPartial ? "partial" : "complete";
    addReason("no_matching_entries");
  } else {
    // Completed with unknown evidence, a stalled run, or any unclassified
    // non-terminal control outcome stays inconclusive rather than synthesizing
    // a deterministic match decision.
    status = "unknown";
    resolution = facts.anyPartial && hasHit ? "partial" : "insufficient_evidence";
    satisfaction = null;
    coverage = facts.anyPartial || facts.searchedCount > 0 ? "partial" : null;
    addReason(resolution);
  }

  assertPublicVocabulary(status, resolution);

  const ledger = state?.spawnLedger ?? [];
  const searchCommandSpawns = ledger.filter(entry => entry.purpose === "search_command").length;
  const probeCommandSpawns = ledger.filter(entry => entry.purpose !== "search_command").length;
  const finalRead = state?.readReceipt ?? null;

  return Object.freeze({
    status,
    resolution,
    satisfaction,
    coverage,
    reasons: Object.freeze(reasons),
    matchedEntries: facts.matchedEntries,
    matchedLines: facts.matchedLines,
    readReceipt: finalRead,
    issuedRefs: state?.issuedRefs ?? Object.freeze([]),
    searchCommandSpawns,
    probeCommandSpawns,
    totalProcessSpawns: ledger.length,
    spawnLedger: state?.spawnLedger ?? Object.freeze([]),
    stepTrace: state?.stepTrace ?? Object.freeze([]),
    modelMetadata: Object.freeze({
      ref: model.ref,
      schema: CLI_HYBRID_PACKAGE_SCHEMA,
      calibration: model.calibration,
      adoption: model.adoption,
    }),
    preserve: Object.freeze({
      rootEvaluation: report.rootEvaluation,
      control: report.control,
      frames: report.frames,
      atomicResults: report.atomicResults,
      effects: report.effects,
      errors: report.errors,
      primaryErrorId: report.primaryErrorId,
      budgetUsed: report.budgetUsed,
      continuation: report.continuation,
    }),
  });
}

export async function loadCliHybridSearchModel(
  options: LoadCliHybridSearchModelOptions,
): Promise<CliHybridSearchModel> {
  if (!isRecord(options)) throw new TypeError("loadCliHybridSearchModel options must be an object");
  const packagePath = nonEmpty(options.packagePath, "loadCliHybridSearchModel packagePath");
  const handwiredRoot =
    options.handwiredRoot === undefined
      ? process.env.NN_HANDWIRED_ROOT
      : options.handwiredRoot;
  if (typeof handwiredRoot !== "string" || handwiredRoot.length === 0) {
    throw new TypeError(
      "loadCliHybridSearchModel requires handwiredRoot or NN_HANDWIRED_ROOT",
    );
  }
  const ref =
    options.ref === undefined
      ? DEFAULT_CLI_HYBRID_SEARCH_REF
      : readVersionedRef(options.ref, "loadCliHybridSearchModel ref");

  let resource: HybridPackageResource;
  try {
    resource = await loadHybridPackageFromFile(packagePath, handwiredRoot);
  } catch (error) {
    if (error instanceof HybridContractError) {
      throw new TypeError(`cli.hybrid-package.v1 validation failed: ${error.message}`);
    }
    throw error;
  }

  deepFreeze(resource.package);
  deepFreeze(resource.profile);
  const model = deepFreeze<CliHybridSearchModel>({
    kind: "cli.hybrid-search.model",
    ref,
    schema: CLI_HYBRID_PACKAGE_SCHEMA,
    calibration: "uncalibrated",
    adoption: "not_applied",
    handwiredRoot: resource.handwiredRoot,
    packagePath: resource.packagePath,
    package: resource.package,
    profile: resource.profile,
    inferE: resource.inferE,
    inferHead: resource.inferHead,
  });
  return validateCliHybridSearchModel(model);
}

export function validateCliHybridSearchModel(value: unknown): CliHybridSearchModel {
  if (!isRecord(value)) {
    throw new TypeError("cli.hybrid-search model must be an object");
  }
  if (value.kind !== "cli.hybrid-search.model") {
    throw new TypeError("cli.hybrid-search model.kind must be cli.hybrid-search.model");
  }
  const ref = readVersionedRef(value.ref, "cli.hybrid-search model.ref");
  if (value.schema !== CLI_HYBRID_PACKAGE_SCHEMA) {
    throw new TypeError("cli.hybrid-search model.schema must be cli.hybrid-package.v1");
  }
  if (value.calibration !== "uncalibrated" || value.adoption !== "not_applied") {
    throw new TypeError("cli.hybrid-search model must stay uncalibrated and not_applied");
  }
  const handwiredRoot = nonEmpty(value.handwiredRoot, "cli.hybrid-search model.handwiredRoot");
  const packagePath =
    value.packagePath === null ? null : nonEmpty(value.packagePath, "cli.hybrid-search model.packagePath");
  if (typeof value.inferE !== "function" || typeof value.inferHead !== "function") {
    throw new TypeError("cli.hybrid-search model must expose inferE and inferHead");
  }
  let validated;
  try {
    validated = validateCliHybridPackage(value.package);
  } catch (error) {
    if (error instanceof HybridContractError) {
      throw new TypeError(`cli.hybrid-search model package is invalid: ${error.message}`);
    }
    throw error;
  }
  const profile = value.profile;
  if (!isRecord(profile) || profile.schema !== "nnanything.l2.mlp.v1") {
    throw new TypeError("cli.hybrid-search model.profile must be an nnanything.l2.mlp.v1 profile");
  }
  if (profile.calibration !== "uncalibrated" || profile.adoption !== "not_applied") {
    throw new TypeError("cli.hybrid-search model.profile must stay uncalibrated and not_applied");
  }
  const profileHeads = profile.heads;
  if (!isRecord(profileHeads)) {
    throw new TypeError("cli.hybrid-search model.profile.heads is required");
  }
  for (const head of ["R", "D", "E", "A"] as const) {
    const headProfile = profileHeads[head];
    if (!isRecord(headProfile) || !isRecord(headProfile.spec) || !Array.isArray(headProfile.parameters)) {
      throw new TypeError(`cli.hybrid-search model.profile.heads.${head} is invalid`);
    }
    const specFeatures = headProfile.spec.features;
    const specLabels = headProfile.spec.labels;
    if (!Array.isArray(specFeatures) || !Array.isArray(specLabels)) {
      throw new TypeError(`cli.hybrid-search model.profile.heads.${head}.spec is invalid`);
    }
    if (specFeatures.length !== validated.profile.heads[head].spec.features.length) {
      throw new TypeError(`cli.hybrid-search model.profile.heads.${head} feature count disagrees with package`);
    }
    if (
      specFeatures.some(
        (name, index) => name !== validated.profile.heads[head].spec.features[index],
      )
    ) {
      throw new TypeError(`cli.hybrid-search model.profile.heads.${head} feature order disagrees with package`);
    }
    if (specLabels.length !== validated.profile.heads[head].spec.labels.length) {
      throw new TypeError(`cli.hybrid-search model.profile.heads.${head} label count disagrees with package`);
    }
    if (
      specLabels.some(
        (label, index) => label !== validated.profile.heads[head].spec.labels[index],
      )
    ) {
      throw new TypeError(`cli.hybrid-search model.profile.heads.${head} label order disagrees with package`);
    }
    if (headProfile.parameters.length !== validated.profile.heads[head].parameters.length) {
      throw new TypeError(`cli.hybrid-search model.profile.heads.${head} parameter count disagrees with package`);
    }
  }
  if (
    validated.profile.heads.E.spec.features.length !== COMMAND_SEARCH_E_FEATURE_COUNT
    || validated.profile.heads.R.spec.features.length !== COMMAND_SEARCH_R_FEATURE_COUNT
    || validated.profile.heads.D.spec.features.length !== COMMAND_SEARCH_D_FEATURE_COUNT
    || validated.profile.heads.A.spec.features.length !== COMMAND_SEARCH_A_FEATURE_COUNT
  ) {
    throw new TypeError("cli.hybrid-search model head feature counts are invalid");
  }
  // Labels are part of the public stepTrace schema. Refuse a swapped label
  // order instead of silently changing prediction semantics.
  for (const [head, expected] of [
    ["R", COMMAND_SEARCH_R_LABELS],
    ["D", COMMAND_SEARCH_D_LABELS],
    ["E", COMMAND_SEARCH_E_LABELS],
    ["A", COMMAND_SEARCH_A_LABELS],
  ] as const) {
    const actual = validated.profile.heads[head].spec.labels;
    if (actual.length !== expected.length || actual.some((label, index) => label !== expected[index])) {
      throw new TypeError(`cli.hybrid-search model ${head} label order is not the fixed contract`);
    }
  }
  return Object.freeze({
    kind: "cli.hybrid-search.model",
    ref,
    schema: CLI_HYBRID_PACKAGE_SCHEMA,
    calibration: "uncalibrated",
    adoption: "not_applied",
    handwiredRoot,
    packagePath,
    package: value.package as unknown as CliHybridPackageV1,
    profile: value.profile as unknown as L2MlpProfile,
    inferE: value.inferE as CliHybridSearchModel["inferE"],
    inferHead: value.inferHead as CliHybridSearchModel["inferHead"],
  });
}

export function commandSearchStepFromEvaluation(
  stepIndex: number,
  evaluation: CommandSearchRdeaEvaluation,
  commandReceipt: CommandSearchStepReceipt | null,
): CommandSearchRdeaStep {
  return Object.freeze({
    stepIndex,
    R: Object.freeze({
      s0: evaluation.R.s0,
      s1: evaluation.R.s1,
    }),
    E: evaluation.E,
    D: evaluation.D,
    A: evaluation.A,
    commandReceipt,
  });
}

export {
  CLI_HYBRID_PACKAGE_SCHEMA,
  createHybridPackageResource,
};
